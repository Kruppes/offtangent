/**
 * Answering an interactive block (SPEC 7.4c) from the web client.
 *
 * The parser lives in `@axiom/core/contracts` so the card, the Telegram
 * degradation and the backend validation agree on one format. This composable
 * only owns the call and the per-block UI state: pending, answered, error.
 */
import {
  parseInteractionMessage,
  type InteractionBlock,
  type InteractionSegment,
} from '@axiom/core/contracts'
import { ApiError } from './useApi'
import type { InteractionTableRow, InteractionTableStatus } from './useInteractionTable'

export type InteractionByIdOutcome =
  | { status: 'applied'; label: string; interaction: InteractionTableRow | null }
  /** 409: the card is no longer open (answered elsewhere, dismissed, superseded, expired). */
  | { status: 'conflict'; current: InteractionTableStatus | null; label: string | null; interaction: InteractionTableRow | null }
  /** 502 retryable: the answer is saved, the turn did not start; send again with the same key. */
  | { status: 'retryable'; message: string; interaction: InteractionTableRow | null }
  | { status: 'stale'; reason: string }
  | { status: 'error'; message: string }

export type InteractionDismissOutcome =
  | { status: 'dismissed'; interaction: InteractionTableRow | null }
  | { status: 'conflict'; current: InteractionTableStatus | null; interaction: InteractionTableRow | null }
  | { status: 'error'; message: string }

export interface InteractionAnswerResponse {
  applied: boolean
  resumed: boolean
  idempotent: boolean
  value: string | string[]
  label: string
}

export type InteractionAnswerOutcome =
  | { status: 'applied'; label: string; resumed: boolean }
  | { status: 'already_answered'; label: string }
  | { status: 'stale'; reason: string }
  | { status: 'error'; message: string }

/** A per-tap idempotency key; a retry of the same tap reuses it. */
/** The card events a client counts (S0-B/B1); the server counts the rest. */
export type InteractionClientEvent = 'stream_placeholder' | 'stream_cut' | 'click_not_ready' | 'superseded'

export function newClientMessageId(): string {
  const cryptoRef = typeof crypto !== 'undefined' ? crypto : undefined
  return cryptoRef?.randomUUID ? cryptoRef.randomUUID() : `ia-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useInteractions() {
  const { apiFetch } = useApi()

  /** Split one message into text and card segments. Never throws. */
  function segmentsOf(content: string, options: { streaming?: boolean } = {}): InteractionSegment[] {
    try {
      // While the message is live an unterminated card fence is a `pending`
      // segment (placeholder card), never raw JSON (S0-B/QW1).
      return parseInteractionMessage(content ?? '', { streaming: options.streaming === true })
    } catch {
      // Defence in depth: a broken block must never take down the renderer.
      return content ? [{ type: 'text', text: content }] : []
    }
  }

  async function answerBlock(input: {
    messageId: number
    block: InteractionBlock
    value: string | string[]
    clientMessageId: string
  }): Promise<InteractionAnswerOutcome> {
    try {
      const res = await apiFetch<InteractionAnswerResponse>('/api/interactions', {
        method: 'POST',
        body: JSON.stringify({
          messageId: input.messageId,
          blockId: input.block.id,
          value: input.value,
          clientMessageId: input.clientMessageId,
        }),
      })
      return { status: 'applied', label: res.label, resumed: res.resumed }
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body ?? {}
        if (err.status === 409 && body.code === 'already_answered') {
          return { status: 'already_answered', label: typeof body.label === 'string' ? body.label : '' }
        }
        if (err.status === 410 && body.code === 'stale') {
          return { status: 'stale', reason: err.message }
        }
        return { status: 'error', message: err.message }
      }
      return { status: 'error', message: (err as Error).message || 'Network error' }
    }
  }

  /**
   * Count one card event for the S0-B telemetry (`POST /api/interactions/
   * telemetry`). Counters only — never content, never ids. Fire and forget:
   * telemetry must never surface as an error in the chat.
   */
  function reportInteractionEvent(event: InteractionClientEvent): void {
    void apiFetch('/api/interactions/telemetry', {
      method: 'POST',
      body: JSON.stringify({ channel: 'web', event }),
    }).catch(() => {})
  }

  /**
   * S1-C: answer a card by its interaction id (`POST /api/interactions/:id/
   * answer`). ask_user cards send `answers`, fence cards `value`. The
   * `clientRequestId` stays the same for every retry of one submit.
   */
  async function answerById(input: {
    interactionId: string
    clientRequestId: string
    answers?: Record<string, { selected: string[]; comment?: string }>
    value?: string | string[]
  }): Promise<InteractionByIdOutcome> {
    const body: Record<string, unknown> = { clientRequestId: input.clientRequestId }
    if (input.answers) body.answers = input.answers
    else body.value = input.value
    try {
      const res = await apiFetch<InteractionAnswerResponse & { interaction?: InteractionTableRow }>(
        `/api/interactions/${encodeURIComponent(input.interactionId)}/answer`,
        { method: 'POST', body: JSON.stringify(body) },
      )
      return { status: 'applied', label: res.label, interaction: res.interaction ?? null }
    } catch (err) {
      if (err instanceof ApiError) {
        const errBody = (err.body ?? {}) as Record<string, unknown>
        const interaction = (errBody.interaction as InteractionTableRow | undefined) ?? null
        if (err.status === 409) {
          const current = typeof errBody.status === 'string' ? errBody.status as InteractionTableStatus : interaction?.status ?? null
          return { status: 'conflict', current, label: typeof errBody.label === 'string' ? errBody.label : null, interaction }
        }
        if (err.status === 502 && errBody.retryable === true) {
          return { status: 'retryable', message: err.message, interaction }
        }
        if (err.status === 410) return { status: 'stale', reason: err.message }
        return { status: 'error', message: err.message }
      }
      return { status: 'error', message: (err as Error).message || 'Network error' }
    }
  }

  /** S1-C: store partial answers so another device can continue (`PUT /api/interactions/:id/draft`). */
  async function saveDraft(interactionId: string, answers: unknown): Promise<boolean> {
    try {
      await apiFetch(`/api/interactions/${encodeURIComponent(interactionId)}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ answers }),
      })
      return true
    } catch {
      return false
    }
  }

  /** S1-C: close a card without an answer (`POST /api/interactions/:id/dismiss`). */
  async function dismissById(interactionId: string): Promise<InteractionDismissOutcome> {
    try {
      const res = await apiFetch<{ dismissed: boolean; interaction?: InteractionTableRow }>(
        `/api/interactions/${encodeURIComponent(interactionId)}/dismiss`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      return { status: 'dismissed', interaction: res.interaction ?? null }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const errBody = (err.body ?? {}) as Record<string, unknown>
        const interaction = (errBody.interaction as InteractionTableRow | undefined) ?? null
        const current = typeof errBody.status === 'string' ? errBody.status as InteractionTableStatus : interaction?.status ?? null
        return { status: 'conflict', current, interaction }
      }
      return { status: 'error', message: (err as Error).message || 'Network error' }
    }
  }

  return { segmentsOf, answerBlock, answerById, saveDraft, dismissById, newClientMessageId, reportInteractionEvent }
}
