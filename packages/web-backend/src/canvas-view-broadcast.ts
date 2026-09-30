/**
 * canvas-view-broadcast.ts — the bridge from the in-process view event of
 * `@axiom/core` to the `canvas_view_updated` websocket frame.
 *
 * Core cannot import the chat event bus (it is a layer up), and the three
 * writers of an assistant row must not each remember to broadcast. So core
 * emits `artifactViewEvents` where the revision is actually written and this
 * module — subscribed once per process — turns every update into a frame.
 *
 * It is its own file so the wiring can be tested without booting the whole
 * runtime composition.
 */
import { artifactViewEvents } from '@axiom/core'
import type { CanvasViewUpdate } from '@axiom/core'
import type { ChatEventBus } from './chat-event-bus.js'

export interface CanvasViewBroadcastDeps {
  chatEventBus: ChatEventBus
}

/**
 * Forward every new revision of a living view to the chat bus.
 *
 * Returns the unsubscribe function (tests, and a future runtime that can be
 * torn down). `source` is `task` because this path exists for the writers that
 * have no channel streaming their chunks; an interactive turn produces the same
 * frame and a client does not need to tell them apart — `sessionId` and
 * `canvasView.revision` are what it acts on.
 */
export function registerCanvasViewBroadcast(deps: CanvasViewBroadcastDeps): () => void {
  return artifactViewEvents.onViewUpdate((update: CanvasViewUpdate) => {
    deps.chatEventBus.broadcast({
      type: 'canvas_view_updated',
      userId: update.userId,
      source: 'task',
      sessionId: update.strandId,
      agentId: update.agentId ?? 'main',
      messageId: update.messageId,
      canvasView: update,
    })
  })
}
