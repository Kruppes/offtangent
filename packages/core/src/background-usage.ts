import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { getDatabase, type Database } from './database.js'
import { errorTextClass } from './log-safe-error.js'
import { estimateCost } from './provider-config.js'
import { logTokenUsage } from './token-logger.js'

/**
 * Bookkeeping for background LLM calls (background model calls).
 *
 * Every one-shot `completeSimple` call that is not a conversation request
 * (fact extraction, session summary, auto title, router, reviewer, ...) books
 * its usage here as ONE `token_usage` row with `kind = 'background'` and the
 * caller's `purpose`. The own kind keeps every reader that means "a request of
 * the conversation" (`kind = 'request'`) unchanged; cost totals that sum all
 * kinds now include these calls, which is the point of booking them.
 *
 * Booking never throws: a missing database (tests, early boot), a mocked
 * logger or a failing insert is swallowed and counted in
 * {@link backgroundUsageErrorCount}. The model call and its result are never
 * touched.
 */

/** What a background call was for. Fixed vocabulary, never free text. */
export type BackgroundUsagePurpose =
  | 'fact_extraction'
  | 'session_summary'
  | 'auto_title'
  | 'project_assignment'
  | 'speech_summary'
  | 'capture_router'
  | 'capture_split'
  | 'voice_shorten'
  | 'ask_agent'
  | 'isolated_inference'
  | 'stt_rewrite'
  | 'task_review'
  | 'task_plan_draft'
  | 'ha_relay'

export interface BackgroundUsageContext {
  purpose: BackgroundUsagePurpose
  /** Session the call belongs to, when the caller knows it. */
  sessionId?: string | null
  agentId?: string | null
  /** Defaults to the process database. */
  db?: Database
}

let errorCount = 0
let warned = false

/** Swallowed booking failures since process start (diagnostics, tests). */
export function backgroundUsageErrorCount(): number {
  return errorCount
}

/** Test seam. */
export function resetBackgroundUsageErrorCount(): void {
  errorCount = 0
  warned = false
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Book one finished background completion. Call it right after the
 * `completeSimple` promise resolves, before the response is checked, so a
 * rejected request that still reports usage is counted too.
 */
export function logBackgroundUsage(
  model: Model<Api> | null | undefined,
  response: AssistantMessage | null | undefined,
  ctx: BackgroundUsageContext,
): void {
  try {
    if (!response) return
    const usage = response.usage
    const input = num(usage?.input)
    const output = num(usage?.output)
    const cacheRead = num(usage?.cacheRead)
    const cacheWrite = num(usage?.cacheWrite)
    const reported = num(usage?.cost?.total)
    const cost = reported > 0 ? reported : (model ? estimateCost(model, input, output, cacheRead, cacheWrite) : 0)
    const errorMessage = (response as { errorMessage?: string }).errorMessage
    logTokenUsage(ctx.db ?? getDatabase(), {
      provider: response.provider || model?.provider || 'unknown',
      model: response.model || model?.id || 'unknown',
      promptTokens: input,
      completionTokens: output,
      cacheRead,
      cacheWrite,
      estimatedCost: cost,
      sessionId: ctx.sessionId ?? undefined,
      kind: 'background',
      purpose: ctx.purpose,
      agentId: ctx.agentId ?? null,
      contextWindow: model?.contextWindow ?? null,
      // Class only: the provider text can echo the prompt.
      error: errorMessage ? errorTextClass(errorMessage) : (response.stopReason === 'error' ? 'Unknown model error' : null),
    })
  } catch {
    errorCount++
    if (!warned) {
      warned = true
      console.warn("[background-usage] booking skipped; further failures are only counted")
    }
  }
}
