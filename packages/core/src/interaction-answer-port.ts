/**
 * The one door for answering, dismissing and drafting a question card from a
 * surface that is not an HTTP client of the server (S1-C: Telegram).
 *
 * The answer logic (state machine, idempotency, the answer row in the strand,
 * the turn after the commit) lives in the web backend's interactions service.
 * The Telegram package must not import the web backend and must not call its
 * own server over HTTP, so the backend registers that very service here once
 * it is built, and the bot looks it up at answer time. There is exactly one
 * implementation; this file only carries the shape and the registry.
 */
import type { InteractionRecord, InteractionSurface } from './interaction-store.js'
import type { AskUserAnswerInput } from './contracts/ask-user.js'

/** Who answers: a non-admin user id, or the user with its admin flag. */
export type InteractionPortActor = number | { userId: number; admin?: boolean }

/** The turn an answer starts, as the interactions service hands it over. */
export interface InteractionAnswerTurnInput {
  userId: number
  sessionId: string
  text: string
  source: string
  agentId: string
  explicitSessionId: string
  inputMode?: 'typed' | 'voice' | 'answer' | null
  replyToInteractionId?: string | null
}

export interface InteractionPortAnswerInput {
  /** Fence card: one option id, or a list for `multi`. */
  value?: string | string[]
  /** ask_user card: one entry per question id. */
  answers?: Record<string, AskUserAnswerInput>
  /** Idempotency key of this answer (Telegram: derived from the callback query id). */
  clientRequestId: string
  surface: InteractionSurface
  /**
   * Run the answer turn here instead of on the server's default runner. A
   * surface that renders the reply itself (Telegram) passes its own starter so
   * the reply lands in the chat the card was answered in.
   */
  startTurn?: (input: InteractionAnswerTurnInput) => unknown
}

export interface InteractionPortAnswerResult {
  resumed: boolean
  idempotent?: boolean
  label?: string
  interaction?: InteractionRecord
}

export interface InteractionAnswerPort {
  answerById: (actor: InteractionPortActor, id: string, input: InteractionPortAnswerInput) => InteractionPortAnswerResult
  dismiss: (actor: InteractionPortActor, id: string, surface: InteractionSurface) => { interaction: InteractionRecord; idempotent: boolean }
  saveDraft: (actor: InteractionPortActor, id: string, draft: unknown) => InteractionRecord
}

/**
 * The error shape the service throws (`InteractionServiceError`): an HTTP-ish
 * status plus a stable code. Matched structurally so core needs no import.
 */
export function interactionPortErrorOf(error: unknown): { status: number; code: string; message: string } | null {
  if (!error || typeof error !== 'object') return null
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown }
  if (typeof status !== 'number' || typeof code !== 'string') return null
  return { status, code, message: typeof message === 'string' ? message : code }
}

let registered: InteractionAnswerPort | null = null

/** Register the server's interactions service. Returns the unregister function. */
export function registerInteractionAnswerPort(port: InteractionAnswerPort): () => void {
  registered = port
  return () => {
    if (registered === port) registered = null
  }
}

/** The registered service, or null when the server did not register one (no web backend, tests). */
export function getInteractionAnswerPort(): InteractionAnswerPort | null {
  return registered
}
