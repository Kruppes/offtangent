import type { TurnErrorInfo } from '@axiom/core'

/**
 * Rendering + callback-data helpers for the Telegram retry channel.
 * Kept separate from the bot so the formatting can be unit-tested without a
 * grammY instance — same split as `email-approval.ts`.
 */

export const TURN_RETRY_CALLBACK_PREFIX = 'retry:'

/**
 * The `chat_messages` row id of the `turn_error` is the payload: the decision
 * is made server-side against that row, so `retry:<id>` (well under Telegram's
 * 64-byte `callback_data` limit) is all the button needs to carry.
 */
export function buildTurnRetryCallbackData(errorMessageId: number): string {
  return `${TURN_RETRY_CALLBACK_PREFIX}${errorMessageId}`
}

export function parseTurnRetryCallbackData(data: string): { errorMessageId: number } | null {
  if (!data.startsWith(TURN_RETRY_CALLBACK_PREFIX)) return null
  const raw = data.slice(TURN_RETRY_CALLBACK_PREFIX.length)
  if (!/^\d+$/.test(raw)) return null

  const errorMessageId = Number(raw)
  return Number.isSafeInteger(errorMessageId) ? { errorMessageId } : null
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** The error bubble shown together with the Retry inline keyboard. */
export function formatTurnErrorMessage(error: TurnErrorInfo): string {
  const lines = ['\u274C <b>The agent could not finish the turn</b>', '', escapeHtml(error.error)]
  if (error.attempts > 0) {
    const retries = error.attempts === 1 ? 'retry' : 'retries'
    lines.push('', `<i>Gave up after ${error.attempts} automatic ${retries}.</i>`)
  }
  return lines.join('\n')
}

/**
 * What the error message is edited into once any channel answered the button,
 * so a stale keyboard cannot be tapped a second time.
 */
export function formatTurnRetryResolution(error: TurnErrorInfo, resolution: string): string {
  return `${formatTurnErrorMessage(error)}\n\n${escapeHtml(resolution)}`
}
