/**
 * eco-mode-store.ts: persistence of the per-strand Eco switch and of the last
 * Eco request view metric (plan 2026-10-04-eco-implementation).
 *
 * `sessions.eco_mode` (0/1, default 0) is the ONLY switch. The runtime reads
 * it before every request, so toggling takes effect on the next LLM call and
 * switching it off is the complete rollback.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Database } from './database.js'
import { buildEcoView, EcoBudgetError, estimateEcoFixedTokens, findLastContextOverflow, resolveEcoBudget } from './eco-policy.js'

/**
 * Tri-state read of the switch. 'unknown' = the read itself failed (DB busy,
 * I/O error): callers on the request path must NOT treat that as "off" —
 * silently sending a full-size request from an Eco strand is exactly the
 * overflow Eco exists to prevent. A missing column (pre-migration DB) is a
 * definite 'off'.
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

/** Kept for API compatibility; Eco metrics no longer go into tool_calls. */
export const ECO_METRIC_TOOL_NAME = 'eco_context'

export interface EcoViewMetric {
  at: string
  /** Estimates (chars/3 calibration), never measured provider tokens. */
  estimatedTokensBefore: number | null
  estimatedTokensAfter: number | null
  inputBudgetTokens: number | null
  compactedResults: number
  droppedMessages: number
  /** True when the request was refused (fail closed), not sent. */
  degraded: boolean
  refused: boolean
  refusalReason: string | null
}

function isoUtc(ts: string): string {
  return /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? new Date(ts).toISOString() : new Date(`${ts.replace(' ', 'T')}Z`).toISOString()
}

/** Dedicated numeric-only metric table: schema lives in database.ts (ECO_METRICS_SCHEMA). */
export interface EcoMetricRow {
  sessionId: string
  contextWindow: number
  outputReserve: number
  inputBudget: number
  observedLimit: number | null
  tokensBefore: number
  tokensAfter: number
  compacted: number
  dropped: number
  unrecallable: number
  refusalReason: string | null
}

/** Test seam: replaced to simulate a failing metrics write. */
export const ecoTelemetry = {
  record(db: Database, m: EcoMetricRow): void {
    db.prepare(
      `INSERT INTO eco_metrics (session_id, context_window, output_reserve, input_budget, observed_limit,
         tokens_before, tokens_after, compacted, dropped, unrecallable, refused, refusal_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.sessionId, m.contextWindow, m.outputReserve, m.inputBudget, m.observedLimit, m.tokensBefore,
      m.tokensAfter, m.compacted, m.dropped, m.unrecallable, m.refusalReason ? 1 : 0, m.refusalReason)
    // Bounded per-session retention: only the newest rows are ever read
    // (lastEcoViewForStrand), so older ones are pruned on write.
    db.prepare(
      `DELETE FROM eco_metrics WHERE session_id = ? AND id <= (
         SELECT id FROM eco_metrics WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    ).run(m.sessionId, m.sessionId, ECO_METRICS_KEEP_PER_SESSION)
  },
}

/** Rows kept per session in eco_metrics (bounded retention). */
export const ECO_METRICS_KEEP_PER_SESSION = 50

/** Telemetry is isolated: a failing metrics write never changes the policy outcome. */
function recordEcoMetric(db: Database, m: EcoMetricRow): void {
  try {
    ecoTelemetry.record(db, m)
  } catch (err) {
    console.error('[eco] metric write failed (request unaffected):', err instanceof Error ? err.message : err)
  }
}

export function lastEcoViewForStrand(db: Database, sessionId: string): EcoViewMetric | null {
  let row: Record<string, unknown> | undefined
  try {
    row = db.prepare(
      `SELECT created_at, tokens_before, tokens_after, input_budget, compacted, dropped, refused, refusal_reason
         FROM eco_metrics WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(sessionId) as Record<string, unknown> | undefined
  } catch {
    return null
  }
  if (!row) return null
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const refused = row.refused === 1
  return {
    at: isoUtc(String(row.created_at)),
    estimatedTokensBefore: num(row.tokens_before),
    estimatedTokensAfter: num(row.tokens_after),
    inputBudgetTokens: num(row.input_budget),
    compactedResults: num(row.compacted) ?? 0,
    droppedMessages: num(row.dropped) ?? 0,
    degraded: refused,
    refused,
    refusalReason: typeof row.refusal_reason === 'string' ? row.refusal_reason : null,
  }
}

/**
 * Runtime limits a runner reported in an overflow error, per strand/task
 * session. In memory on purpose: it is evidence about the CURRENTLY loaded
 * runner, which can change with a restart, and it only ever lowers the
 * budget. Bounded so a long-lived process cannot grow it without limit.
 */
const observedLimits = new Map<string, number>()
const MAX_OBSERVED = 500

export function observedEcoContextLimit(sessionId: string): number | undefined {
  return observedLimits.get(sessionId)
}

function noteObservedLimit(sessionId: string, limit: number): void {
  const prev = observedLimits.get(sessionId)
  if (prev !== undefined && prev <= limit) return
  observedLimits.delete(sessionId)
  observedLimits.set(sessionId, limit)
  while (observedLimits.size > MAX_OBSERVED) {
    const oldest = observedLimits.keys().next().value
    if (oldest === undefined) break
    observedLimits.delete(oldest)
  }
}

/** Test hook. */
export function resetObservedEcoLimits(): void {
  observedLimits.clear()
}

/**
 * Persisted `chat_messages.id` of a tool result in THIS session — the recall
 * reference Eco needs before it may shorten or drop that result. Scoped to
 * the session (and so to its owner/persona): a row of another session never
 * qualifies. Only rows that actually carry the stored result in metadata
 * count, so a reference always resolves to the stored text.
 */
export function findToolResultRowId(db: Database, sessionId: string, toolCallId: string): number | undefined {
  try {
    const row = db.prepare(
      `SELECT id FROM chat_messages
        WHERE session_id = ? AND role = 'tool' AND json_valid(metadata)
          AND json_extract(metadata, '$.toolCallId') = ?
          AND json_type(metadata, '$.toolResult') IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    ).get(sessionId, toolCallId) as { id: number } | undefined
    return row?.id
  } catch {
    return undefined
  }
}

/**
 * The per-request limits Eco budgeted for, handed from the pre-send view
 * (transformContext) to the stream function of the SAME request (B1, review
 * ac775c50): the request must carry exactly the output limit the budget
 * reserved, and the SDK must clamp against the same effective window.
 */
export interface EcoRequestLimits {
  sessionId: string
  /** Effective window: min(declared, observed runner limit). */
  contextWindow: number
  /** Output limit the request carries (answer + reasoning share it). */
  outputReserve: number
}

export type EcoRequestDecision = { mode: 'off' } | { mode: 'eco'; limits: EcoRequestLimits }

/**
 * One-slot handoff owned by ONE agent instance (never module-global): the
 * pre-send hook stages the decision of the request it just built, the
 * stream function of that very request takes it (and so clears it). A
 * request never sees the decision of an earlier one: the slot is cleared
 * at the start of every staging and on every take.
 */
export class EcoRequestGate {
  private pending: EcoRequestDecision | undefined
  clear(): void { this.pending = undefined }
  stage(decision: EcoRequestDecision): void { this.pending = decision }
  take(): EcoRequestDecision | undefined {
    const d = this.pending
    this.pending = undefined
    return d
  }
}

export interface EcoRequestContext {
  db: Database
  sessionId: string | null | undefined
  /** Messages as they go to the provider (already boundary-sanitized). */
  messages: AgentMessage[]
  /** Unsanitized transcript, scanned for an earlier overflow error. Defaults to `messages`. */
  transcript?: readonly AgentMessage[]
  /**
   * The completion limit the request ACTUALLY carries (pi-ai sends
   * `options.maxTokens ?? model.maxTokens`); the output reserve is taken from
   * it, never from an invented cap.
   */
  model: { contextWindow?: number | null; maxTokens?: number | null }
  systemPrompt: string | undefined
  tools: readonly unknown[] | undefined
  /** Receives the limits of this request for the stream function (see EcoRequestGate). */
  gate?: EcoRequestGate
}

/**
 * THE Eco stage, shared by the interactive runtime and the task runner so
 * there is exactly one policy path. Off (default) it returns the input array
 * itself: the normal path stays byte-identical. Never mutates the transcript,
 * so no tool runs twice.
 *
 * FAIL CLOSED (review 5c5f47a6 #1/#5): when no safe view fits, when the
 * switch cannot be read, or when the policy itself fails, it throws a typed
 * EcoBudgetError instead of sending the raw messages. Telemetry is isolated
 * and can never change that outcome.
 */
export function applyEcoRequestView(ctx: EcoRequestContext): AgentMessage[] {
  const { db, sessionId, messages, gate } = ctx
  gate?.clear()
  if (!sessionId) {
    gate?.stage({ mode: 'off' })
    return messages
  }
  const mode = readStrandEcoMode(db, sessionId)
  if (mode === 'off') {
    gate?.stage({ mode: 'off' })
    return messages
  }
  if (mode === 'unknown') throw new EcoBudgetError('eco_state_unreadable')

  let budget: ReturnType<typeof resolveEcoBudget>
  let view: ReturnType<typeof buildEcoView>
  let observed: number | undefined
  try {
    // Overflow recovery: a runner that rejected an earlier request told us its
    // real limit; the next request (this one) is sized against it.
    const overflow = findLastContextOverflow(ctx.transcript ?? messages)
    if (overflow?.limit) noteObservedLimit(sessionId, overflow.limit)
    observed = observedLimits.get(sessionId)
    budget = resolveEcoBudget({ contextWindow: ctx.model.contextWindow, maxTokens: ctx.model.maxTokens, observedContextLimit: observed })
    const hasSystemMessage = messages.some(m => (m as { role?: string }).role === 'system')
    const fixedTokens = estimateEcoFixedTokens(hasSystemMessage ? undefined : ctx.systemPrompt, ctx.tools)
    view = buildEcoView({
      messages,
      budget,
      fixedTokens,
      resolveRecallId: callId => findToolResultRowId(db, sessionId, callId),
    })
  } catch (err) {
    console.error('[eco] request view failed, refusing the request:', err)
    throw new EcoBudgetError('eco_internal_error')
  }

  if (view.changed || view.refusal) {
    recordEcoMetric(db, {
      sessionId,
      contextWindow: budget.contextWindow,
      outputReserve: budget.outputReserve,
      inputBudget: budget.inputBudget,
      observedLimit: observed ?? null,
      tokensBefore: view.tokensBefore,
      tokensAfter: view.tokensAfter,
      compacted: view.compacted,
      dropped: view.dropped,
      unrecallable: view.unrecallable,
      refusalReason: view.refusal,
    })
  }
  if (view.refusal) throw new EcoBudgetError(view.refusal, view.tokensAfter, budget.inputBudget)
  gate?.stage({ mode: 'eco', limits: { sessionId, contextWindow: budget.contextWindow, outputReserve: budget.outputReserve } })
  return view.messages
}

/**
 * Task inheritance: a task spawned from an Eco strand runs in Eco too. The
 * copy is persisted on the task session row at creation (explicit, visible,
 * switchable per task session); later changes on the parent do not leak into
 * a running task.
 */
export function inheritEcoMode(db: Database, parentSessionId: string | null | undefined, childSessionId: string): boolean {
  const mode = readStrandEcoMode(db, parentSessionId)
  if (mode === 'off') return false
  // An unreadable parent switch must not silently start a full-size task:
  // the child is put into Eco (the conservative side) and it is logged.
  if (mode === 'unknown') console.error(`[eco] parent ${parentSessionId} eco_mode unreadable; task session ${childSessionId} starts in Eco`)
  try {
    if (setStrandEcoEnabled(db, childSessionId, true)) return true
  } catch (err) {
    console.error(`[eco] could not persist Eco on task session ${childSessionId}:`, err)
  }
  // Not silent: the task cannot run with the inherited mode, so it fails.
  throw new EcoBudgetError('eco_state_unreadable')
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/**
 * Applies the Eco decision of THIS request to the stream call (B1, review
 * ac775c50). Off → model and options are returned as the same objects, so the
 * normal path (cloud and local) stays byte-identical and gets no shadow cap.
 * Eco → `options.maxTokens` = the budgeted reserve (never raised above an
 * explicit smaller caller cap) and the SDK sees the effective window and the
 * reserve as the model limits. Every later SDK step can then only LOWER the
 * wire value: clampMaxTokensToContext is min(maxTokens, window − est − 4096),
 * adjustMaxTokensForThinking is min(base + thinking, model.maxTokens) and the
 * openai-completions thinking budget is clamped into max_tokens — so answer
 * and reasoning share the one reserve.
 *
 * FAIL CLOSED: no staged decision while the switch is not definitely off, a
 * decision for another session, or unreadable limits → EcoBudgetError, the
 * request is not sent.
 */
export function applyEcoStreamLimits<M extends { contextWindow?: number; maxTokens?: number }, O extends { maxTokens?: number } | undefined>(
  decision: EcoRequestDecision | undefined,
  sessionId: string | undefined,
  readMode: (sessionId: string | undefined) => 'on' | 'off' | 'unknown',
  model: M,
  options: O,
): { model: M; options: O } {
  if (decision === undefined) {
    if (readMode(sessionId) === 'off') return { model, options }
    console.error(`[eco] no staged request limits for session ${sessionId}; refusing the request`)
    throw new EcoBudgetError('eco_internal_error')
  }
  if (decision.mode === 'off') return { model, options }
  const { limits } = decision
  if (limits.sessionId !== sessionId || !isPositiveInt(limits.contextWindow) || !isPositiveInt(limits.outputReserve)
    || limits.outputReserve > limits.contextWindow) {
    console.error(`[eco] unusable request limits for session ${sessionId}:`, limits)
    throw new EcoBudgetError('eco_internal_error')
  }
  const declaredWindow = isPositiveInt(model.contextWindow) ? model.contextWindow : null
  const contextWindow = declaredWindow === null ? limits.contextWindow : Math.min(declaredWindow, limits.contextWindow)
  const callerCap = options?.maxTokens
  const maxTokens = isPositiveInt(callerCap) ? Math.min(callerCap, limits.outputReserve) : limits.outputReserve
  return {
    model: { ...model, contextWindow, maxTokens },
    options: { ...(options ?? {}), maxTokens } as O,
  }
}
