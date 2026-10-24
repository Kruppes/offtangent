/**
 * interaction-broadcast.ts — the bridge from the in-process
 * `interactionEvents` of `@axiom/core` (S1-A) to the `interaction.open`,
 * `interaction.updated` and `interaction.draft` websocket frames.
 *
 * Every write of the `interactions` repository emits one event after the row
 * is persisted, whoever wrote it (live fence hook, answer/dismiss endpoint,
 * draft save, newer-question supersede). The frame goes to every client of
 * the strand's owner, tagged with the strand id, like `canvas_view_updated`.
 * Rows without an owner (legacy cards of an unknown user) are not broadcast.
 *
 * Every frame carries the row with its payload sealed (`interaction-seal.ts`),
 * so no frame echoes an unsealed option label or question (privacy V3).
 */
import { interactionEvents } from '@axiom/core'
import type { InteractionEvent } from '@axiom/core'
import type { ChatEventBus } from './chat-event-bus.js'
import { sealedInteraction } from './interaction-seal.js'

export interface InteractionBroadcastDeps {
  chatEventBus: ChatEventBus
}

export function registerInteractionBroadcast(deps: InteractionBroadcastDeps): () => void {
  return interactionEvents.on((event: InteractionEvent) => {
    const full = event.interaction
    const userId = full.userId
    if (userId == null) return
    const record = sealedInteraction(full)
    deps.chatEventBus.broadcast({
      type: `interaction.${event.type}`,
      userId,
      source: 'web',
      sessionId: record.strandId,
      agentId: record.agent,
      messageId: record.messageId,
      interaction: record,
    })
  })
}

