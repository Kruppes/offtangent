/**
 * Strand model pins (Offtangent strand isolation, goal 3).
 *
 * The model belongs to the strand, not to the process: the home screen
 * selector picks the model for the strand it creates, and a later global
 * change is only the default for the NEXT strand. That only holds when every
 * strand carries an explicit pin, so:
 *
 *  - new interactive strands are pinned at creation time
 *    (`SessionManagerOptions.resolveDefaultStrandModel`), and
 *  - strands that existed before this change are pinned once by
 *    {@link backfillStrandModelPins} to the model {@link resolveBackfillStrandModel}
 *    picks for their persona (persona pin > configured backfill default >
 *    global default).
 *
 * Both write the same two columns (`sessions.model_provider_id`,
 * `sessions.model_id`), so nothing downstream has to learn a new shape.
 */
import type { Database } from './database.js'

/** The provider/model a strand should be pinned to. */
export interface StrandModelPin {
  providerId: string
  modelId: string
}

/** Where the model of a backfilled strand came from. */
export type BackfillModelSource = 'persona' | 'configured' | 'global' | 'none'

export interface BackfillModelResolution {
  pin: StrandModelPin | null
  source: BackfillModelSource
}

export interface BackfillModelInput {
  /** Model pinned to this persona, already validated, or null. */
  personaPin?: StrandModelPin | null
  /**
   * Configured backfill default as `<providerId>:<modelId>`
   * (`modelPolicy.roles.strandBackfill` in settings.json), or null/empty when
   * the operator configured nothing.
   */
  configuredSpec?: string | null
  /** The model the instance is running on right now. Last resort only. */
  globalDefault?: StrandModelPin | null
  /** Validates the configured spec against the installed providers. */
  resolveSpec: (spec: string) => StrandModelPin | null
  /** Called with the raw spec when it cannot be resolved (provider gone, model not enabled). */
  onUnresolvedSpec?: (spec: string) => void
}

/**
 * Which model an old, unpinned strand is pinned to.
 *
 *   persona pin  >  configured backfill default  >  global default
 *
 * The global default is deliberately last: the strands this touches are
 * historical, and pinning thousands of them to whatever model happened to be
 * selected at boot time is an accident waiting to happen. The operator names
 * the model once in `settings.json`; only when that is missing or no longer
 * resolvable does the current global selection decide.
 *
 * A configured model that does not resolve (provider removed, model not
 * enabled any more) is a configuration mistake, not a reason to abort the
 * boot: it warns and moves on to the next source.
 */
export function resolveBackfillStrandModel(input: BackfillModelInput): BackfillModelResolution {
  if (input.personaPin) return { pin: input.personaPin, source: 'persona' }
  const spec = input.configuredSpec?.trim()
  if (spec) {
    let resolved: StrandModelPin | null = null
    try {
      resolved = input.resolveSpec(spec)
    } catch (err) {
      console.warn(`[strand-pin] Could not resolve the configured backfill model '${spec}':`, err)
      resolved = null
    }
    if (resolved) return { pin: resolved, source: 'configured' }
    input.onUnresolvedSpec?.(spec)
  }
  if (input.globalDefault) return { pin: input.globalDefault, source: 'global' }
  return { pin: null, source: 'none' }
}

export interface BackfillResult {
  /** Rows that had no pin and were looked at. */
  candidates: number
  /** Rows actually pinned. */
  pinned: number
  /** Rows left untouched because no default could be resolved for them. */
  skipped: number
  /** Personas for which no default was resolvable (deduplicated). */
  unresolvedAgents: string[]
  /** False when a previous run had already completed the backfill. */
  ran: boolean
}

/** Marker so the one-time backfill does not scan the table on every boot. */
const BACKFILL_MARKER = 'strand_model_pin_backfill_v1'

function ensureMarkerTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_backfills (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      detail TEXT
    );
  `)
}

/**
 * Pin every interactive strand that has no model pin yet.
 *
 * Idempotent in two layers: the marker row short-circuits repeat runs, and
 * the UPDATE itself is guarded by `model_id IS NULL`, so even a forced rerun
 * (`force: true`) can never overwrite a pin a user chose.
 *
 * Writes only rows whose persona resolves to a concrete provider/model. A
 * persona whose provider disappeared keeps NULL columns and therefore the old
 * "follow the global default" behaviour, which is strictly better than
 * pinning it to a provider that cannot serve it.
 *
 * DB backup: this runs at boot on the live `sessions` table. It touches two
 * nullable columns of rows that are NULL in both, so the inverse is
 * `UPDATE sessions SET model_provider_id = NULL, model_id = NULL WHERE id IN
 * (ids logged below)`. The ids of the affected rows are logged before the
 * write for exactly that reason.
 */
export function backfillStrandModelPins(
  db: Database,
  resolveDefault: (agentId: string) => StrandModelPin | null,
  options: { force?: boolean; dryRun?: boolean } = {},
): BackfillResult {
  ensureMarkerTable(db)
  const already = db.prepare('SELECT id FROM schema_backfills WHERE id = ?').get(BACKFILL_MARKER) as { id: string } | undefined
  if (already && !options.force) {
    return { candidates: 0, pinned: 0, skipped: 0, unresolvedAgents: [], ran: false }
  }

  const rows = db.prepare(
    `SELECT id, COALESCE(agent_id, 'main') AS agent_id
     FROM sessions
     WHERE type = 'interactive' AND (model_id IS NULL OR model_provider_id IS NULL)`
  ).all() as Array<{ id: string; agent_id: string }>

  const resolved = new Map<string, StrandModelPin | null>()
  const unresolved = new Set<string>()
  const updates: Array<{ id: string; pin: StrandModelPin }> = []
  for (const row of rows) {
    if (!resolved.has(row.agent_id)) {
      let pin: StrandModelPin | null = null
      try {
        pin = resolveDefault(row.agent_id)
      } catch (err) {
        console.warn(`[strand-pin] Could not resolve the default model for persona '${row.agent_id}':`, err)
      }
      resolved.set(row.agent_id, pin)
    }
    const pin = resolved.get(row.agent_id) ?? null
    if (!pin) {
      unresolved.add(row.agent_id)
      continue
    }
    updates.push({ id: row.id, pin })
  }

  const result: BackfillResult = {
    candidates: rows.length,
    pinned: updates.length,
    skipped: rows.length - updates.length,
    unresolvedAgents: [...unresolved],
    ran: true,
  }

  if (options.dryRun) return result

  if (updates.length > 0) {
    // Logged BEFORE the write so the rollback statement can be reconstructed
    // from the log even if the process dies mid-migration.
    console.log(`[strand-pin] Backfilling ${updates.length} strand(s) without a model pin: ${updates.map(u => u.id).join(',')}`)
    const stmt = db.prepare(
      `UPDATE sessions SET model_provider_id = ?, model_id = ?
       WHERE id = ? AND model_id IS NULL AND model_provider_id IS NULL`
    )
    const apply = db.transaction((items: typeof updates) => {
      for (const item of items) stmt.run(item.pin.providerId, item.pin.modelId, item.id)
    })
    apply(updates)
  }

  if (!options.force || !already) {
    db.prepare('INSERT OR REPLACE INTO schema_backfills (id, applied_at, detail) VALUES (?, datetime(\'now\'), ?)')
      .run(BACKFILL_MARKER, JSON.stringify({ candidates: result.candidates, pinned: result.pinned, skipped: result.skipped }))
  }
  console.log(`[strand-pin] Backfill done: ${result.pinned} pinned, ${result.skipped} skipped (${result.unresolvedAgents.join(',') || 'none'} unresolved)`)
  return result
}
