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
export function newClientMessageId(): string {
  const cryptoRef = typeof crypto !== 'undefined' ? crypto : undefined
  return cryptoRef?.randomUUID ? cryptoRef.randomUUID() : `ia-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useInteractions() {
  const { apiFetch } = useApi()

  /** Split one message into text and card segments. Never throws. */
  function segmentsOf(content: string): InteractionSegment[] {
    try {
      return parseInteractionMessage(content ?? '')
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

  return { segmentsOf, answerBlock, newClientMessageId }
}
