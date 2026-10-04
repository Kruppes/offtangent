/**
 * eco-mode-store.ts: persistence of the per-strand Eco switch and of the last
 * Eco request view metric (plan 2026-10-04-eco-implementation).
 *
 * `sessions.eco_mode` (0/1, default 0) is the ONLY switch. The runtime reads
 * it before every request, so toggling takes effect on the next LLM call and
 * switching it off is the complete rollback.
 */

import type { Database } from './database.js'

export function isStrandEcoEnabled(db: Database, sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  try {
    const row = db.prepare('SELECT eco_mode FROM sessions WHERE id = ?').get(sessionId) as { eco_mode?: number } | undefined
    return row?.eco_mode === 1
  } catch {
    // Column missing (pre-migration test DBs) or DB busy: Eco off = normal path.
    return false
  }
}

/** Returns false when the strand row does not exist. */
export function setStrandEcoEnabled(db: Database, sessionId: string, enabled: boolean): boolean {
  const res = db.prepare('UPDATE sessions SET eco_mode = ? WHERE id = ?').run(enabled ? 1 : 0, sessionId)
  return res.changes > 0
}

export const ECO_METRIC_TOOL_NAME = 'eco_context'

export interface EcoViewMetric {
  at: string
  /** Estimates (chars/3 calibration), never measured provider tokens. */
  estimatedTokensBefore: number | null
  estimatedTokensAfter: number | null
  inputBudgetTokens: number | null
  compactedResults: number
  droppedMessages: number
  degraded: boolean
}

function isoUtc(ts: string): string {
  return /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? new Date(ts).toISOString() : new Date(`${ts.replace(' ', 'T')}Z`).toISOString()
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function lastEcoViewForStrand(db: Database, sessionId: string): EcoViewMetric | null {
  const row = db.prepare(
    `SELECT timestamp, input FROM tool_calls
      WHERE session_id = ? AND tool_name = ? AND json_valid(input)
      ORDER BY id DESC LIMIT 1`,
  ).get(sessionId, ECO_METRIC_TOOL_NAME) as { timestamp: string; input: string } | undefined
  if (!row) return null
  try {
    const p = JSON.parse(row.input) as Record<string, unknown>
    return {
      at: isoUtc(row.timestamp),
      estimatedTokensBefore: num(p.tokensBefore),
      estimatedTokensAfter: num(p.tokensAfter),
      inputBudgetTokens: num(p.inputBudget),
      compactedResults: num(p.compacted) ?? 0,
      droppedMessages: num(p.dropped) ?? 0,
      degraded: p.degraded === true,
    }
  } catch {
    return null
  }
}
