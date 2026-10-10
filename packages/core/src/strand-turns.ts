/**
 * strand-turns.ts: exact turn bookkeeping for the strand statistics
 * (Offtangent context panel, phase B).
 *
 * Before this table existed a "turn" could only be reconstructed from message
 * timestamps (user prompt → last assistant/tool row before the next trigger),
 * which is why the statistics mark everything older as `estimated`. From now on
 * every turn the {@link TurnRunner} drives writes one `strand_turns` row:
 * started_at when the runner picks it up, first_token_at on the first streamed
 * chunk, ended_at + status when it finishes. `token_usage` and `tool_calls`
 * rows written while the turn is active carry its `turn_id`.
 *
 * Everything here is additive: new table, nullable columns, no backfill of
 * history (old rows keep `turn_id = NULL` and stay estimated). Writing never
 * throws — the statistics must never break the turn they observe.
 */
import type { Database } from './database.js'

export type StrandTurnTrigger = 'user' | 'task_injection' | 'system'
export type StrandTurnInputMode = 'typed' | 'voice' | 'answer'
/**
 * `interrupted`: the process that ran the turn went away (crash, restart)
 * before it could close the row; set by {@link closeOrphanedStrandTurns}.
 */
export type StrandTurnStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'

/** How a usage row is paid: an OAuth subscription, metered API billing, or a local model. */
export type BillingKind = 'subscription' | 'metered' | 'local'

function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name))
}

/**
 * Idempotent migration for the strand statistics. Safe on every start:
 *  - `strand_turns` (new table)
 *  - `token_usage`: turn_id, billing, agent_id, context_window, error
 *  - `tool_calls`: turn_id, is_internal
 *  - `persona_delegations`: origin_session_id (the strand an ask_agent came from)
 */
/** Marker row in `strand_stats_migrations` once the is_internal backfill committed. */
export const IS_INTERNAL_BACKFILL_KEY = 'tool_calls.is_internal.backfill'

export function ensureStrandStatsSchema(db: Database, internalToolNames: Iterable<string> = []): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strand_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main',
      trigger TEXT NOT NULL DEFAULT 'user',
      input_mode TEXT,
      started_at TEXT NOT NULL,
      first_token_at TEXT,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'running'
    );
    CREATE INDEX IF NOT EXISTS idx_strand_turns_session ON strand_turns(session_id, started_at);
  `)

  const tu = columnNames(db, 'token_usage')
  if (!tu.has('turn_id')) db.exec('ALTER TABLE token_usage ADD COLUMN turn_id TEXT')
  if (!tu.has('billing')) db.exec('ALTER TABLE token_usage ADD COLUMN billing TEXT')
  if (!tu.has('agent_id')) db.exec('ALTER TABLE token_usage ADD COLUMN agent_id TEXT')
  if (!tu.has('context_window')) db.exec('ALTER TABLE token_usage ADD COLUMN context_window INTEGER')
  if (!tu.has('error')) db.exec('ALTER TABLE token_usage ADD COLUMN error TEXT')

  const tc = columnNames(db, 'tool_calls')
  if (!tc.has('turn_id')) db.exec('ALTER TABLE tool_calls ADD COLUMN turn_id TEXT')
  // is_internal: column + one-time backfill run in ONE transaction and end
  // with a persistent marker. The marker, not the mere presence of the
  // column, decides whether the backfill is still due, so a crash between the
  // two steps (or a database a pre-marker build migrated only in part) gets the
  // backfill on the next start. The UPDATE is idempotent, a rerun is harmless.
  db.exec(`CREATE TABLE IF NOT EXISTS strand_stats_migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const backfillDone = !!db.prepare('SELECT 1 FROM strand_stats_migrations WHERE key = ?').get(IS_INTERNAL_BACKFILL_KEY)
  if (!tc.has('is_internal') || !backfillDone) {
    const names = [...internalToolNames]
    db.transaction(() => {
      if (!columnNames(db, 'tool_calls').has('is_internal')) {
        db.exec('ALTER TABLE tool_calls ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0')
      }
      // The internal metric rows are identified by name (the same list
      // readers filtered on so far).
      if (names.length > 0) {
        db.prepare(`UPDATE tool_calls SET is_internal = 1 WHERE is_internal = 0 AND tool_name IN (${names.map(() => '?').join(',')})`).run(...names)
      }
      db.prepare('INSERT OR REPLACE INTO strand_stats_migrations (key, applied_at) VALUES (?, ?)').run(IS_INTERNAL_BACKFILL_KEY, nowIso())
    })()
  }

  const pd = columnNames(db, 'persona_delegations')
  if (pd.size > 0 && !pd.has('origin_session_id')) db.exec('ALTER TABLE persona_delegations ADD COLUMN origin_session_id TEXT')

  // The stats endpoint walks a strand's task tree; these keep that walk on
  // indexes instead of table scans. Additive and idempotent.
  // idx_token_usage_session: EXPLAIN on a copy of the live DB (203k rows)
  // showed a full SCAN per task session; the long strand took ~370 ms, of
  // that ~270 ms in the per-task token_usage aggregate.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_turn ON token_usage(turn_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
  `)
}

// ---------------------------------------------------------------------------
// Active turn registry: logTokenUsage/logToolCall look up the running turn of
// a session here, so the turn id reaches every row without threading it
// through every call site.

const activeTurns = new Map<string, string>()

export function setActiveStrandTurn(sessionId: string, turnId: string): void {
  activeTurns.set(sessionId, turnId)
}

export function clearActiveStrandTurn(sessionId: string, turnId: string): void {
  if (activeTurns.get(sessionId) === turnId) activeTurns.delete(sessionId)
}

export function activeStrandTurnId(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  return activeTurns.get(sessionId) ?? null
}

function nowIso(): string {
  return new Date().toISOString()
}

export interface StartStrandTurnInput {
  id: string
  sessionId: string
  agentId?: string
  trigger?: StrandTurnTrigger
  inputMode?: StrandTurnInputMode | null
  startedAt?: string
}

export function recordStrandTurnStart(db: Database | null | undefined, input: StartStrandTurnInput): void {
  if (!db) return
  try {
    db.prepare(`
      INSERT OR IGNORE INTO strand_turns (id, session_id, agent_id, trigger, input_mode, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'running')
    `).run(input.id, input.sessionId, input.agentId ?? 'main', input.trigger ?? 'user', input.inputMode ?? null, input.startedAt ?? nowIso())
    setActiveStrandTurn(input.sessionId, input.id)
  } catch (err) {
    console.warn('[strand-turns] could not record turn start:', (err as Error).message)
  }
}

/** Sets first_token_at once; later calls are no-ops. */
export function recordStrandTurnFirstToken(db: Database | null | undefined, turnId: string, at: string = nowIso()): void {
  if (!db) return
  try {
    db.prepare('UPDATE strand_turns SET first_token_at = ? WHERE id = ? AND first_token_at IS NULL').run(at, turnId)
  } catch (err) {
    console.warn('[strand-turns] could not record first token:', (err as Error).message)
  }
}

export function recordStrandTurnEnd(db: Database | null | undefined, turnId: string, sessionId: string, status: Exclude<StrandTurnStatus, 'running'>, at: string = nowIso()): void {
  clearActiveStrandTurn(sessionId, turnId)
  if (!db) return
  try {
    db.prepare('UPDATE strand_turns SET ended_at = ?, status = ? WHERE id = ? AND ended_at IS NULL').run(at, status, turnId)
  } catch (err) {
    console.warn('[strand-turns] could not record turn end:', (err as Error).message)
  }
}

/** SQLite `datetime('now')` text and ISO strings, both read as UTC; epoch ms or null. */
function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null
  const s = value.includes('T') ? value : value.replace(' ', 'T')
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Last evidenced activity of a turn (epoch ms): its own token_usage and
 * tool_calls rows, plus assistant/tool messages of the session between its
 * start and the next turn's start. Falls back to started_at.
 */
export function lastStrandTurnActivityMs(db: Database, turn: { id: string; session_id: string; started_at: string }): number | null {
  const start = parseTimeMs(turn.started_at)
  if (start === null) return null
  const candidates: Array<string | null | undefined> = []
  const one = (sql: string, ...args: unknown[]) => {
    try {
      for (const r of db.prepare(sql).all(...args) as Array<{ t: string | null }>) candidates.push(r.t)
    } catch { /* table missing on an odd install: no evidence from it */ }
  }
  // max() per format family: SQLite text and ISO text do not compare as strings.
  one('SELECT max(timestamp) t FROM token_usage WHERE turn_id = ? GROUP BY instr(timestamp, \'T\') > 0', turn.id)
  one('SELECT max(timestamp) t FROM tool_calls WHERE turn_id = ? GROUP BY instr(timestamp, \'T\') > 0', turn.id)
  const next = db.prepare('SELECT started_at FROM strand_turns WHERE session_id = ? AND started_at > ? ORDER BY started_at LIMIT 1')
    .get(turn.session_id, turn.started_at) as { started_at: string } | undefined
  const nextMs = parseTimeMs(next?.started_at) ?? Infinity
  try {
    // Both text formats as lower bound (superset), exact window checked below.
    const startSql = new Date(start).toISOString().slice(0, 19).replace('T', ' ')
    const msgs = db.prepare(`SELECT timestamp t FROM chat_messages WHERE session_id = ? AND role IN ('assistant', 'tool')
      AND (timestamp >= ? OR timestamp >= ?)`).all(turn.session_id, startSql, turn.started_at) as Array<{ t: string }>
    for (const m of msgs) {
      const ms = parseTimeMs(m.t)
      if (ms !== null && ms >= start && ms < nextMs) candidates.push(m.t)
    }
  } catch { /* ignore */ }
  let end = start
  for (const c of candidates) {
    const ms = parseTimeMs(c)
    if (ms !== null && ms > end && ms < nextMs) end = ms
  }
  return end
}

/**
 * Boot step: rows still `running` belong to a process that no longer exists
 * (a turn of THIS process is in the active registry and is skipped). They are
 * closed as `interrupted` with ended_at = last evidenced activity of the turn,
 * so their duration stops growing with the clock. Returns the number closed.
 */
export function closeOrphanedStrandTurns(db: Database): number {
  let closed = 0
  try {
    const open = db.prepare("SELECT id, session_id, started_at FROM strand_turns WHERE ended_at IS NULL").all() as
      Array<{ id: string; session_id: string; started_at: string }>
    const live = new Set(activeTurns.values())
    const close = db.prepare("UPDATE strand_turns SET ended_at = ?, status = 'interrupted' WHERE id = ? AND ended_at IS NULL")
    db.transaction(() => {
      for (const t of open) {
        if (live.has(t.id)) continue
        const end = lastStrandTurnActivityMs(db, t)
        closed += close.run(end === null ? t.started_at : new Date(end).toISOString(), t.id).changes
      }
    })()
    if (closed > 0) console.warn(`[strand-turns] closed ${closed} interrupted turn(s) left open by a previous process`)
  } catch (err) {
    console.warn('[strand-turns] could not close interrupted turns:', (err as Error).message)
  }
  return closed
}

// ---------------------------------------------------------------------------
// Billing mapping. Configurable, not hard-wired: the defaults describe the
// common case (OAuth subscription providers, local runners); an install
// overrides or extends them with `OFFTANGENT_BILLING_MAP` (JSON object
// provider → subscription|metered|local) or {@link configureBillingMapping}.
// Unknown providers are `metered`.

export const DEFAULT_BILLING_MAPPING: Readonly<Record<string, BillingKind>> = Object.freeze({
  'anthropic': 'subscription',
  'openai-codex': 'subscription',
  'github-copilot': 'subscription',
  'ollama': 'local',
  'ollama-native': 'local',
  'lmstudio': 'local',
  'llama-cpp': 'local',
  'image-generation': 'metered',
})

let billingOverrides: Record<string, BillingKind> | null = null

function isBillingKind(v: unknown): v is BillingKind {
  return v === 'subscription' || v === 'metered' || v === 'local'
}

function envOverrides(): Record<string, BillingKind> {
  const raw = process.env.OFFTANGENT_BILLING_MAP
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, BillingKind> = {}
    for (const [k, v] of Object.entries(parsed ?? {})) if (isBillingKind(v)) out[k] = v
    return out
  } catch {
    console.warn('[strand-turns] OFFTANGENT_BILLING_MAP is not valid JSON; ignored')
    return {}
  }
}

/** Replace the configured overrides (null resets to defaults + env). */
export function configureBillingMapping(overrides: Record<string, BillingKind> | null): void {
  billingOverrides = overrides
}

/** The effective provider → billing mapping (defaults, then env, then configured overrides). */
export function billingMapping(): Record<string, BillingKind> {
  return { ...DEFAULT_BILLING_MAPPING, ...envOverrides(), ...(billingOverrides ?? {}) }
}

export function billingForProvider(provider: string | null | undefined, mapping: Record<string, BillingKind> = billingMapping()): BillingKind {
  if (!provider) return 'metered'
  return mapping[provider] ?? 'metered'
}
