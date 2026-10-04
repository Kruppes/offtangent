/**
 * eco-mode-store.ts: persistence of the per-strand Eco switch and of the last
 * Eco request view metric (plan 2026-10-04-eco-implementation).
 *
 * `sessions.eco_mode` (0/1, default 0) is the ONLY switch. The runtime reads
 * it before every request, so toggling takes effect on the next LLM call and
 * switching it off is the complete rollback.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createHash } from 'node:crypto'
import type { Database } from './database.js'
import { classifyEcoRefusal, EcoBudgetError, estimateEcoFixedTokens, estimateEcoMessageTokens, findLastContextOverflow, resolveEcoBudget } from './eco-policy.js'
import type { EcoRefusalReason } from './eco-policy.js'

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
 * Runtime limits a runner reported in an overflow error. In memory on
 * purpose: it is evidence about the CURRENTLY loaded runner, which can change
 * with a restart. MAJOR-1 (review 1100eb8e): the evidence is scoped to the
 * model that produced it — key = session + model identity (provider, model id
 * and a hash of the base URL as runner signature; the URL itself is never
 * stored or logged). A model switch therefore starts from the declared window
 * again; switching back re-derives the small model's limit from its own
 * overflow in the transcript. Per key it only ever lowers. Bounded.
 */
export interface EcoModelIdentity {
  provider?: string | null
  id?: string | null
  baseUrl?: string | null
}

interface ObservedEntry { sessionId: string; modelId: string; limit: number }
const observedLimits = new Map<string, ObservedEntry>()
const MAX_OBSERVED = 500

function runnerSignature(baseUrl: string | null | undefined): string {
  if (!baseUrl) return '-'
  return createHash('sha256').update(baseUrl).digest('hex').slice(0, 16)
}

/** Stable identity key; null when the model has no id (then no evidence is kept). */
export function ecoModelKey(model: EcoModelIdentity | null | undefined): string | null {
  if (!model?.id) return null
  return `${model.provider ?? '-'}\u0000${model.id}\u0000${runnerSignature(model.baseUrl)}`
}

/**
 * Observed runner limit of `sessionId` for one model. With a full identity
 * (from the request path) the exact key is used; with only a model id (the
 * status API knows provider config id + model id, not the pi-ai identity) the
 * smallest limit recorded for that model id in this session is returned.
 * Without a model: undefined (never another model's evidence).
 */
export function observedEcoContextLimit(sessionId: string, model?: EcoModelIdentity | null): number | undefined {
  if (!model?.id) return undefined
  if (model.provider !== undefined || model.baseUrl !== undefined) {
    const key = ecoModelKey(model)
    return key ? observedLimits.get(`${sessionId}\u0000${key}`)?.limit : undefined
  }
  let min: number | undefined
  for (const e of observedLimits.values()) {
    if (e.sessionId === sessionId && e.modelId === model.id && (min === undefined || e.limit < min)) min = e.limit
  }
  return min
}

function noteObservedLimit(sessionId: string, model: EcoModelIdentity, limit: number): void {
  const key = ecoModelKey(model)
  if (!key || !model.id) return
  const k = `${sessionId}\u0000${key}`
  const prev = observedLimits.get(k)
  if (prev !== undefined && prev.limit <= limit) return
  observedLimits.delete(k)
  observedLimits.set(k, { sessionId, modelId: model.id, limit })
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
  /** Output limit the request carries when no reasoning is active. */
  outputReserve: number
  /** Admission estimate of this request's input (chars/3), for the reasoning check. */
  inputTokens?: number
  /** Safety margin of the budget (same number the admission used). */
  safetyMargin?: number
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
  model: { contextWindow?: number | null; maxTokens?: number | null; provider?: string | null; id?: string | null; baseUrl?: string | null }
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

  // CACHE GATE: Eco is ADMISSION ONLY. The
  // messages that leave this function are the very array that came in — the
  // output of the shared upstream trimming the normal path also gets. Eco
  // never rewrites, shortens, drops or prepends anything, so tools, system
  // prompt and history serialize exactly as in normal mode. A request that
  // does not fit is refused (EcoBudgetError), never compacted or retried.
  let budget: ReturnType<typeof resolveEcoBudget>
  let tokens: number
  let fixedTokens: number
  let observed: number | undefined
  try {
    // Overflow evidence of THIS model only (MAJOR-1): an error another model
    // produced says nothing about the current runner.
    const overflow = findLastContextOverflow(ctx.transcript ?? messages, ctx.model)
    if (overflow?.limit) noteObservedLimit(sessionId, ctx.model, overflow.limit)
    observed = observedEcoContextLimit(sessionId, { provider: ctx.model.provider ?? null, id: ctx.model.id ?? null, baseUrl: ctx.model.baseUrl ?? null })
    budget = resolveEcoBudget({ contextWindow: ctx.model.contextWindow, maxTokens: ctx.model.maxTokens, observedContextLimit: observed })
    const hasSystemMessage = messages.some(m => (m as { role?: string }).role === 'system')
    fixedTokens = estimateEcoFixedTokens(hasSystemMessage ? undefined : ctx.systemPrompt, ctx.tools)
    tokens = fixedTokens
    for (const m of messages) tokens += estimateEcoMessageTokens(m)
  } catch (err) {
    console.error('[eco] admission failed, refusing the request:', err)
    throw new EcoBudgetError('eco_internal_error')
  }

  if (tokens > budget.inputBudget) {
    let reason: EcoRefusalReason
    try {
      reason = budget.inputBudget <= 0 ? 'no_input_budget' : classifyEcoRefusal(messages, fixedTokens, budget.inputBudget)
    } catch {
      reason = 'history_not_reducible'
    }
    recordEcoMetric(db, {
      sessionId,
      contextWindow: budget.contextWindow,
      outputReserve: budget.outputReserve,
      inputBudget: budget.inputBudget,
      observedLimit: observed ?? null,
      tokensBefore: tokens,
      tokensAfter: tokens,
      compacted: 0,
      dropped: 0,
      unrecallable: 0,
      refusalReason: reason,
    })
    throw new EcoBudgetError(reason, tokens, budget.inputBudget)
  }
  // Admitted unchanged: no metric row (as before, only refusals are recorded).
  gate?.stage({
    mode: 'eco',
    limits: { sessionId, contextWindow: budget.contextWindow, outputReserve: budget.outputReserve, inputTokens: tokens, safetyMargin: budget.safetyMargin },
  })
  return messages
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
export function applyEcoStreamLimits<M extends { contextWindow?: number; maxTokens?: number }, O extends { maxTokens?: number; reasoning?: unknown } | undefined>(
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
  // CACHE GATE (thinking): with active reasoning the SDK derives the
  // serialized thinking budget from the output ceiling (anthropic/bedrock:
  // adjustMaxTokensForThinking clamps against model.maxTokens;
  // openai-completions: thinking_token_budget / chat_template_kwargs are
  // clamped to max_tokens − 1024). Lowering the ceiling could change those
  // request fields versus normal mode and so invalidate the message cache
  // (or, via template kwargs, the rendered prompt prefix of a local runner).
  // So Eco leaves a reasoning request byte-identical to normal and only
  // ADMITS it when the uncapped worst-case output still fits the effective
  // window; otherwise it refuses visibly. No silent degradation either way.
  const reasoning = options?.reasoning
  const reasoningActive = typeof reasoning === 'string' && reasoning !== 'off' && (model as { reasoning?: unknown }).reasoning === true
  if (reasoningActive) {
    const callerCap = options?.maxTokens
    const modelMax = isPositiveInt(model.maxTokens) ? model.maxTokens : null
    const worstOutput = Math.max(16, (isPositiveInt(callerCap) ? callerCap : 0), modelMax ?? limits.contextWindow)
    const input = isPositiveInt(limits.inputTokens) ? limits.inputTokens : limits.contextWindow
    const margin = isPositiveInt(limits.safetyMargin) ? limits.safetyMargin : 0
    if (input + worstOutput + margin > contextWindow) {
      throw new EcoBudgetError('reasoning_output_uncapped', input, Math.max(0, contextWindow - worstOutput - margin))
    }
    return { model, options }
  }
  const callerCap = options?.maxTokens
  const maxTokens = isPositiveInt(callerCap) ? Math.min(callerCap, limits.outputReserve) : limits.outputReserve
  return {
    model: { ...model, contextWindow, maxTokens },
    options: { ...(options ?? {}), maxTokens } as O,
  }
}
