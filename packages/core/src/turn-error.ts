import { TURN_ERROR_CAUSES } from './agent-runtime-types.js'
import type { TurnErrorCause, TurnErrorInfo } from './agent-runtime-types.js'

/** `chat_messages.metadata.kind` marking a persisted terminal turn error. */
export const TURN_ERROR_KIND = 'turn_error'

/**
 * Persisted shape of a terminal turn error. Written once when the turn gives
 * up, so the failure survives a page reload instead of vanishing with the
 * WebSocket. `cause` and `retryable` are what let a channel decide how to
 * present the failure (and whether repeating the turn has a chance).
 */
export interface TurnErrorMetadata {
  kind: typeof TURN_ERROR_KIND
  cause: TurnErrorCause
  /** Full provider error text, never truncated — that is the whole point. */
  error: string
  attempts: number
  retryable: boolean
  occurredAt: string
  /**
   * Chat-action id of the Retry button. Stored on the row so a channel can
   * rebuild the button from history; the in-memory action registry decides
   * whether it still resolves (it does not survive a restart).
   */
  retryActionId?: string
}

export function buildTurnErrorMetadata(info: TurnErrorInfo): TurnErrorMetadata {
  return {
    kind: TURN_ERROR_KIND,
    cause: info.cause,
    error: info.error,
    attempts: info.attempts,
    retryable: info.retryable,
    occurredAt: info.occurredAt,
    ...(info.retryActionId ? { retryActionId: info.retryActionId } : {}),
  }
}

export function parseTurnErrorMetadata(raw: string | null | undefined): TurnErrorMetadata | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const value = parsed as Record<string, unknown>
  if (value.kind !== TURN_ERROR_KIND) return null
  if (typeof value.error !== 'string') return null

  const cause = typeof value.cause === 'string' && (TURN_ERROR_CAUSES as readonly string[]).includes(value.cause)
    ? value.cause as TurnErrorCause
    : 'non_retryable'

  return {
    kind: TURN_ERROR_KIND,
    cause,
    error: value.error,
    attempts: typeof value.attempts === 'number' ? value.attempts : 0,
    retryable: value.retryable === true,
    occurredAt: typeof value.occurredAt === 'string' ? value.occurredAt : '',
    ...(typeof value.retryActionId === 'string' ? { retryActionId: value.retryActionId } : {}),
  }
}

/**
 * Human-readable body of the error row. Channels that can render structured
 * data use `TurnErrorInfo`; this text is the fallback (Telegram, old clients)
 * and what a history reload shows verbatim.
 */
export function formatTurnErrorContent(info: TurnErrorInfo): string {
  if (info.cause === 'agent_unavailable') return `\u274C ${info.error}`
  if (info.attempts > 0) {
    const retries = info.attempts === 1 ? 'retry' : 'retries'
    return `\u274C Provider error after ${info.attempts} ${retries}: ${info.error}`
  }
  return `\u274C Provider error: ${info.error}`
}
