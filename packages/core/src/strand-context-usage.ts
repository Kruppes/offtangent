/**
 * strand-context-usage.ts: what the LAST model request of one strand actually
 * carried (SPEC 12.2 read side).
 *
 * The status bar in the app must never show accumulated billing tokens or the
 * length of the visible history — both are wrong by orders of magnitude for
 * "how full is the context". The only honest number is the input side of the
 * last request the provider answered for THIS session:
 *
 *   requestTokens = prompt_tokens + cache_read + cache_write
 *
 * `prompt_tokens` is the uncached input of that request, `cache_read` the part
 * the provider served from the prompt cache and `cache_write` the part it just
 * wrote into it. All three were assembled into the same request, so they add
 * up to the context that was really sent — system prompt, memory, tool
 * definitions, attachments included, because the provider counted them.
 *
 * The three counters are DISJOINT for every provider family this runtime
 * speaks, so the sum never double counts a cached prefix; the adapters
 * normalise before the row is written:
 *   - anthropic-messages.js:418  `cacheRead = cache_read_input_tokens` next to
 *     Anthropic's already separate `input_tokens`
 *   - openai-completions.js:1175 `input = max(0, prompt_tokens - cacheRead - cacheWrite)`
 *   - google-generative-ai.js:170 / google-vertex.js:172
 *     `input = promptTokenCount - cachedContentTokenCount`
 *
 * Every row is written per assistant message by `logTokenUsage` with the
 * session id of the turn, so the read here is strand scoped by construction.
 * Since the isolation merge there is one runtime per strand anyway; the reads
 * here are keyed by `session_id` regardless, so no other strand can bleed in.
 *
 * Not every row under a session id is a conversation request, though: a
 * text-to-speech render of a message is booked on the same session with
 * ESTIMATED counts (`voice-note-runner.ts`). Such a row describes an audio
 * render, not the context of the strand, and picking it up would report a few
 * hundred tokens as "the context" right after a voice note. The query is
 * therefore restricted to `kind = 'request'`.
 */
import type { Database } from './database.js'

export interface StrandLastRequestUsage {
  /** prompt_tokens + cache_read + cache_write of the last request. */
  requestTokens: number
  /** Uncached input part of that request. */
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** ISO-8601 UTC timestamp of the measured request. */
  measuredAt: string
  /** The model that request ran on — NOT necessarily the one selected now. */
  measuredModelId: string
  measuredProviderId: string
}

export interface StrandTranscriptWindow {
  /** ISO-8601 UTC timestamp of the turn that wrote the metric row. */
  at: string
  /**
   * Heuristic estimate of the transcript window that was kept for that turn
   * (`trimMessagesToBudget().keptTokens`). This is the ONLY quantity the trim
   * trigger is applied to — it excludes system prompt, memory and tool
   * definitions, which the provider counts but the trimmer never sees.
   */
  estimatedTokens: number
  /** The trim trigger in force for that turn (`heuristics.strand.windowTokens`). */
  budgetTokens: number
  /**
   * Messages the runtime dropped on that turn. Decisive for the reading of
   * `estimatedTokens`: the value is logged AFTER `trimMessagesToBudget`, so
   * once a trim happened it sits just under the budget by construction and a
   * "nearly full" threshold would latch on forever. `trimmedMessages > 0`
   * therefore means "already trimmed" (a fact to state, not a warning), and
   * only `trimmedMessages === 0` makes a high ratio mean "trim is imminent".
   */
  trimmedMessages: number
}

export interface StrandCompactionEvent {
  at: string
  /** Messages dropped from the model view by that trim. */
  droppedMessages: number
  /** Estimated tokens kept in the window afterwards (heuristic estimate). */
  keptTokens: number | null
  /** The trim trigger that was in force. */
  budgetTokens: number | null
}

interface UsageRow {
  timestamp: string
  provider: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  cache_read: number
  cache_write: number
}

function isoUtc(sqliteTimestamp: string): string {
  // SQLite `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" in UTC without a
  // zone marker. Anything already carrying a zone is passed through.
  const trimmed = sqliteTimestamp.trim()
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(trimmed)) return trimmed
  return `${trimmed.replace(' ', 'T')}Z`
}

/**
 * The last measured model request of a strand, or null when the strand never
 * reached a provider (fresh strand, or every turn failed before a response).
 * Never invents a zero — "no measurement" is a distinct state for the UI.
 */
export function lastRequestUsageForStrand(db: Database, sessionId: string): StrandLastRequestUsage | null {
  const row = db.prepare(
    `SELECT timestamp, provider, model, prompt_tokens, completion_tokens, cache_read, cache_write
       FROM token_usage
      WHERE session_id = ? AND kind = 'request'
      ORDER BY id DESC
      LIMIT 1`,
  ).get(sessionId) as UsageRow | undefined
  if (!row) return null
  const input = Math.max(0, row.prompt_tokens ?? 0)
  const cacheRead = Math.max(0, row.cache_read ?? 0)
  const cacheWrite = Math.max(0, row.cache_write ?? 0)
  return {
    requestTokens: input + cacheRead + cacheWrite,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: Math.max(0, row.completion_tokens ?? 0),
    measuredAt: isoUtc(row.timestamp),
    measuredModelId: row.model,
    measuredProviderId: row.provider,
  }
}

/**
 * The transcript window basis of the last turn that ran the strand context
 * mechanism: kept transcript estimate and the trim trigger it was measured
 * against. Both come from the same `strand_context` metric row, so they are
 * comparable; a percentage built from them is an estimate of the TRANSCRIPT
 * fill, never of the whole request (which also carries system prompt, memory
 * and tool definitions).
 *
 * Null when this strand never wrote such a row (short strand, or the runtime
 * exposes no transcript) — the caller must then show no trim warning at all
 * instead of comparing a request total against a transcript budget.
 */
export function lastTranscriptWindowForStrand(db: Database, sessionId: string): StrandTranscriptWindow | null {
  const rows = db.prepare(
    `SELECT timestamp, input
       FROM tool_calls
      WHERE session_id = ? AND tool_name = 'strand_context'
      ORDER BY id DESC
      LIMIT 10`,
  ).all(sessionId) as Array<{ timestamp: string; input: string | null }>
  for (const row of rows) {
    if (!row.input) continue
    let parsed: { keptTokens?: unknown; budgetTokens?: unknown; trimmed?: unknown }
    try {
      parsed = JSON.parse(row.input) as typeof parsed
    } catch {
      continue
    }
    const kept = typeof parsed.keptTokens === 'number' ? parsed.keptTokens : null
    const budget = typeof parsed.budgetTokens === 'number' ? parsed.budgetTokens : null
    if (kept === null || budget === null || budget <= 0) continue
    const trimmed = typeof parsed.trimmed === 'number' ? Math.max(0, parsed.trimmed) : 0
    return {
      at: isoUtc(row.timestamp),
      estimatedTokens: Math.max(0, kept),
      budgetTokens: budget,
      trimmedMessages: trimmed,
    }
  }
  return null
}

/**
 * The last time the runtime actually trimmed this strand's window. Read from
 * the `strand_context` metric row (SPEC 12.2) that `prepareStrandContext`
 * writes per turn; only rows with `trimmed > 0` are compactions, a row with
 * `trimmed = 0` only means the strand context block was built.
 */
export function lastCompactionForStrand(db: Database, sessionId: string): StrandCompactionEvent | null {
  const rows = db.prepare(
    `SELECT timestamp, input
       FROM tool_calls
      WHERE session_id = ? AND tool_name = 'strand_context'
        AND json_valid(input) AND COALESCE(json_extract(input, '$.trimmed'), 0) > 0
      ORDER BY id DESC
      LIMIT 5`,
  ).all(sessionId) as Array<{ timestamp: string; input: string | null }>
  for (const row of rows) {
    if (!row.input) continue
    let parsed: { trimmed?: unknown; keptTokens?: unknown; budgetTokens?: unknown }
    try {
      parsed = JSON.parse(row.input) as typeof parsed
    } catch {
      continue
    }
    const trimmed = typeof parsed.trimmed === 'number' ? parsed.trimmed : 0
    if (trimmed <= 0) continue
    return {
      at: isoUtc(row.timestamp),
      droppedMessages: trimmed,
      keptTokens: typeof parsed.keptTokens === 'number' ? parsed.keptTokens : null,
      budgetTokens: typeof parsed.budgetTokens === 'number' ? parsed.budgetTokens : null,
    }
  }
  return null
}
