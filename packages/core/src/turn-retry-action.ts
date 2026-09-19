import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import { parseTurnErrorMetadata } from './turn-error.js'
import { notifyTurnRetryResolved } from './turn-retry-notifier.js'
import type { StartTurnInput, TurnInfo } from './turn-runner.js'

/**
 * Manual retry of a failed turn, driven by the Retry button that hangs off
 * every persisted `turn_error` row.
 *
 * The decision is made server-side so the button also works after a page
 * reload: a channel only forwards the click, this module validates that the
 * failed turn is still the one the conversation is waiting on and restarts it
 * continue-style (the user message is never re-sent).
 */

/** Handler key in the chat-action registry. */
export const TURN_RETRY_ACTION_KIND = 'turn_retry'

/** The single button an error row carries. */
export const TURN_RETRY_ACTION_ID = 'retry'

export const TURN_RETRY_RESOLUTIONS = {
  started: '\uD83D\uDD04 Retrying\u2026',
  unavailable: '\u26A0\uFE0F Retry is no longer available.',
  sessionEnded: '\u26A0\uFE0F Retry is no longer available \u2014 the session has ended.',
  movedOn: '\u26A0\uFE0F Retry is no longer available \u2014 the conversation moved on.',
  busy: '\u26A0\uFE0F Retry is no longer available \u2014 a turn is already running.',
} as const

/** Mint the id of the Retry button belonging to one error row. */
export function newTurnRetryActionId(): string {
  return `turn-retry-${randomUUID()}`
}

export interface TurnRetryOutcome {
  ok: boolean
  /** Text that replaces the button in every channel. */
  resolution: string
}

/** The slice of {@link TurnRunner} a manual retry needs. */
export interface TurnRetryRunnerLike {
  hasActiveTurn(user: number | string): boolean
  retryTurn(input: StartTurnInput): TurnInfo
}

export interface TurnRetryServiceDeps {
  db: Database
  runner: TurnRetryRunnerLike
}

export interface TurnRetryService {
  /** Re-run the turn that failed with the given `turn_error` row. */
  retry(errorMessageId: number): TurnRetryOutcome
}

interface ErrorRow {
  id: number
  session_id: string
  user_id: number
  metadata: string | null
}

interface SessionRow {
  source: string | null
  ended_at: string | null
}

export function createTurnRetryService(deps: TurnRetryServiceDeps): TurnRetryService {
  const { db, runner } = deps

  /**
   * Every exit path funnels through `retry` below so the outcome is announced
   * exactly once — that broadcast is what disables the button in the channels
   * that did not make the decision.
   */
  function decide(errorMessageId: number): TurnRetryOutcome {
    if (!Number.isFinite(errorMessageId)) return fail(TURN_RETRY_RESOLUTIONS.unavailable)

    const row = db.prepare(
      'SELECT id, session_id, user_id, metadata FROM chat_messages WHERE id = ?'
    ).get(errorMessageId) as ErrorRow | undefined

    if (!row || !parseTurnErrorMetadata(row.metadata)) return fail(TURN_RETRY_RESOLUTIONS.unavailable)

    const session = db.prepare(
      'SELECT source, ended_at FROM sessions WHERE id = ?'
    ).get(row.session_id) as SessionRow | undefined

    // A missing session row is treated like an ended one: without it we
    // cannot tell which conversation the retry would continue.
    if (!session || session.ended_at) return fail(TURN_RETRY_RESOLUTIONS.sessionEnded)

    // Anything the conversation produced after the failure (a newer user
    // message, or the answer of a retry that already ran) means this button
    // no longer matches the context the model would continue from. System
    // rows (stall notices, task results) are not part of the transcript.
    const newer = db.prepare(
      `SELECT COUNT(*) AS count FROM chat_messages
       WHERE session_id = ? AND id > ? AND role IN ('user', 'assistant', 'tool')`
    ).get(row.session_id, row.id) as { count: number }
    if (newer.count > 0) return fail(TURN_RETRY_RESOLUTIONS.movedOn)

    if (runner.hasActiveTurn(row.user_id)) return fail(TURN_RETRY_RESOLUTIONS.busy)

    const lastUserMessage = db.prepare(
      `SELECT content FROM chat_messages
       WHERE session_id = ? AND role = 'user' AND id < ?
       ORDER BY id DESC LIMIT 1`
    ).get(row.session_id, row.id) as { content: string } | undefined
    if (!lastUserMessage) return fail(TURN_RETRY_RESOLUTIONS.unavailable)

    runner.retryTurn({
      userId: row.user_id,
      sessionId: row.session_id,
      // Only a fallback: the runner continues the existing transcript, and
      // re-prompts with this text solely when there is nothing to continue.
      text: lastUserMessage.content,
      source: session.source ?? 'web',
    })

    return { ok: true, resolution: TURN_RETRY_RESOLUTIONS.started }
  }

  return {
    retry(errorMessageId: number): TurnRetryOutcome {
      const outcome = decide(errorMessageId)
      void notifyTurnRetryResolved({ errorMessageId, ...outcome })
      return outcome
    },
  }
}

function fail(resolution: string): TurnRetryOutcome {
  return { ok: false, resolution }
}
