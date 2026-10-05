/**
 * eco-mode-store.ts: the per-strand Eco switch and its honest status metric
 * (plan 2026-10-05-real-eco).
 *
 * `sessions.eco_mode` (0/1, default 0) is the ONLY switch. It is read when a
 * tool result is CREATED (eco-tool-freeze.ts): on → a new large result is
 * frozen smaller before the model sees it; off → new results stay as the tool
 * returned them. Already frozen results stay frozen either way (cache-safe:
 * nothing that was sent is ever re-rendered). Requests themselves are never
 * refused, cut or re-budgeted by Eco.
 */

import type { Database } from './database.js'
import { parseContextWindowChoice, type ContextWindowChoice } from './ollama-native/context-window.js'

/**
 * Tri-state read of the switch. 'unknown' = the read itself failed; the
 * freeze path treats that like 'off' (keep the original — fail safe, no
 * saving claimed). A missing column (pre-migration DB) is a definite 'off'.
 */
export function readStrandEcoMode(db: Database, sessionId: string | null | undefined): 'on' | 'off' | 'unknown' {
  if (!sessionId) return 'off'
  try {
    const row = db.prepare('SELECT eco_mode FROM sessions WHERE id = ?').get(sessionId) as { eco_mode?: number } | undefined
    return row?.eco_mode === 1 ? 'on' : 'off'
  } catch (err) {
    if (err instanceof Error && /no such column: eco_mode/i.test(err.message)) return 'off'
    console.error('[eco] reading eco_mode failed:', err)
    return 'unknown'
  }
}

/** Display/read helper: true only when the switch is definitely on. */
export function isStrandEcoEnabled(db: Database, sessionId: string | null | undefined): boolean {
  return readStrandEcoMode(db, sessionId) === 'on'
}

/** Returns false when the strand row does not exist. */
export function setStrandEcoEnabled(db: Database, sessionId: string, enabled: boolean): boolean {
  const res = db.prepare('UPDATE sessions SET eco_mode = ? WHERE id = ?').run(enabled ? 1 : 0, sessionId)
  return res.changes > 0
}

/** Kept for API compatibility (exported name); Eco writes no tool_calls rows. */
export const ECO_METRIC_TOOL_NAME = 'eco_context'

/**
 * Status metric, unchanged field names for API/Android compatibility. Since
 * real Eco it describes FROZEN tool results of the strand (measured chars of
 * the stored original vs the stored projection, tokens = chars/3 estimate),
 * never refusals: `refused`/`degraded`/`droppedMessages` are always false/0.
 */
export interface EcoViewMetric {
  at: string
  /** Estimates (chars/3 over the frozen results), never measured provider tokens. */
  estimatedTokensBefore: number | null
  estimatedTokensAfter: number | null
  inputBudgetTokens: number | null
  compactedResults: number
  droppedMessages: number
  degraded: boolean
  refused: boolean
  refusalReason: string | null
}

function isoUtc(ts: string): string {
  return /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? new Date(ts).toISOString() : new Date(`${ts.replace(' ', 'T')}Z`).toISOString()
}

/** Aggregate over the strand's frozen tool rows (bounded: one indexed scan of its own session). */
export function lastEcoViewForStrand(db: Database, sessionId: string): EcoViewMetric | null {
  let row: { n: number; before: number | null; after: number | null; at: string | null } | undefined
  try {
    row = db.prepare(
      `SELECT COUNT(*) AS n,
              SUM(json_extract(metadata, '$.toolResult.details.eco.originalChars')) AS before,
              SUM(json_extract(metadata, '$.toolResult.details.eco.projectedChars')) AS after,
              MAX(timestamp) AS at
         FROM chat_messages WHERE session_id = ? AND role = 'tool' AND eco_original IS NOT NULL`,
    ).get(sessionId) as typeof row
  } catch {
    return null
  }
  if (!row || !row.n || row.at === null) return null
  const tok = (chars: number | null) => (typeof chars === 'number' && Number.isFinite(chars) ? Math.ceil(chars / 3) : null)
  return {
    at: isoUtc(row.at),
    estimatedTokensBefore: tok(row.before),
    estimatedTokensAfter: tok(row.after),
    inputBudgetTokens: null,
    compactedResults: row.n,
    droppedMessages: 0,
    degraded: false,
    refused: false,
    refusalReason: null,
  }
}

/**
 * Real Eco keeps no overflow evidence (it does not budget requests). Kept so
 * the status API shape stays stable; always undefined.
 */
export function observedEcoContextLimit(_sessionId: string, _model?: { id: string } | null): number | undefined {
  return undefined
}

/**
 * Task inheritance: a task spawned from an Eco strand runs in Eco too. The
 * copy is persisted on the task session row at creation (explicit, visible,
 * switchable per task session); later changes on the parent do not leak into
 * a running task. An unreadable parent switch keeps the task in Normal (the
 * fail-safe side for real Eco: originals stay as the tool returned them).
 */
/**
 * Per-strand Eco context-window choice (null = "Unverändert"). Independent of
 * the Eco switch. A persisted value that no longer validates is read as null,
 * so a corrupt row can never turn into a resource request.
 */
export function readStrandContextWindow(db: Database, sessionId: string | null | undefined): ContextWindowChoice {
  if (!sessionId) return null
  try {
    const row = db.prepare('SELECT eco_context_window AS v FROM sessions WHERE id = ?').get(sessionId) as { v?: unknown } | undefined
    if (!row || row.v === null || row.v === undefined) return null
    const parsed = parseContextWindowChoice(row.v)
    return parsed.ok ? parsed.value : null
  } catch (err) {
    if (err instanceof Error && /no such column: eco_context_window/i.test(err.message)) return null
    console.error('[eco] reading eco_context_window failed:', err)
    return null
  }
}

/** Validates before writing; throws on an invalid choice (never coerced). */
export function setStrandContextWindow(db: Database, sessionId: string, choice: ContextWindowChoice): boolean {
  const parsed = parseContextWindowChoice(choice)
  if (!parsed.ok) throw new Error(`invalid context window: ${parsed.error}`)
  return db.prepare('UPDATE sessions SET eco_context_window = ? WHERE id = ?').run(parsed.value, sessionId).changes > 0
}

/**
 * Copy the (validated) context-window choice of `sourceSessionId` onto the
 * child task session. The child keeps its own copy, so a resume — also after a
 * restart — reads the child row and later source changes never leak in.
 */
export function snapshotContextWindow(db: Database, sourceSessionId: string | null | undefined, childSessionId: string): ContextWindowChoice {
  const window = readStrandContextWindow(db, sourceSessionId)
  if (window === null) return null
  try {
    setStrandContextWindow(db, childSessionId, window)
    return window
  } catch (err) {
    console.error(`[eco] could not snapshot the context window on task session ${childSessionId}:`, err)
    return null
  }
}

export function inheritEcoMode(db: Database, parentSessionId: string | null | undefined, childSessionId: string): boolean {
  // Snapshot the parent's context-window choice at task start (independent of
  // the Eco switch).
  snapshotContextWindow(db, parentSessionId, childSessionId)
  const mode = readStrandEcoMode(db, parentSessionId)
  if (mode !== 'on') return false
  try {
    return setStrandEcoEnabled(db, childSessionId, true)
  } catch (err) {
    console.error(`[eco] could not persist Eco on task session ${childSessionId}; it runs in Normal:`, err)
    return false
  }
}
