/**
 * artifact-view-events.ts — the one place a new revision of a living view is
 * announced inside the process.
 *
 * ## Why an emitter in core and not a callback per writer
 *
 * Three different code paths persist an assistant row and therefore create
 * view revisions: the interactive `TurnRunner`, `deliverTaskFile()` for a
 * background task and `TaskInjectionTranscript.persist()` for a task
 * injection. All three funnel through {@link recordMessageArtifacts}. A
 * callback would have to be threaded through all three constructors (and the
 * next writer would forget it — that is exactly how the artifact gap of
 * 2026-09-26 happened), while the chat event bus lives one layer up in
 * `web-backend` and cannot be imported from here.
 *
 * So core emits a plain in-process event and `web-backend` subscribes once at
 * bootstrap and turns it into the `canvas_view_updated` websocket frame. A
 * writer that records artifacts gets the live event for free.
 *
 * The event is fire and forget: a listener that throws must never turn a
 * successfully stored revision into a failed delivery.
 */
import { EventEmitter } from 'node:events'

/**
 * A view of a strand reached a new revision. This is the payload the product
 * spec calls `canvas.view_updated`; the websocket frame built from it is
 * `canvas_view_updated` (snake case, like every other frame of this protocol).
 */
export interface CanvasViewUpdate {
  /** Owner of the strand (`users.id`). */
  userId: number
  /** `sessions.id` of the strand the view belongs to. */
  strandId: string
  /** Stable key of the view inside that strand. */
  viewKey: string
  /** Revision that was just written (1-based). */
  revision: number
  /**
   * Highest revision of the view at write time. Equal to {@link revision} for
   * a normal write; kept separate so a client can tell "this is the newest"
   * without a second request.
   */
  latestRevision: number
  /** Artifact id of that revision — what a client fetches to render it. */
  artifactId: string
  /** Display title of the view at this revision. */
  title: string
  /** Half sentence for the chat trail, `null` when the writer gave none. */
  note: string | null
  /** `chat_messages` row the revision hangs on. */
  messageId: number
  /** Persona that wrote it, `null` when unknown. */
  agentId: string | null
  /** Kind of the document, so a client can pick its renderer. */
  kind: 'html' | 'svg' | 'image'
}

class ArtifactViewEvents extends EventEmitter {
  /** Announce a new revision. Never throws, whatever the listeners do. */
  emitViewUpdate(update: CanvasViewUpdate): void {
    try {
      this.emit('view_updated', update)
    } catch (err) {
      console.error('[artifact-views] view_updated listener failed:', err)
    }
  }

  /** Subscribe to new revisions. Returns the unsubscribe function. */
  onViewUpdate(handler: (update: CanvasViewUpdate) => void): () => void {
    const wrapped = (update: CanvasViewUpdate): void => {
      try {
        handler(update)
      } catch (err) {
        console.error('[artifact-views] view_updated handler failed:', err)
      }
    }
    this.on('view_updated', wrapped)
    return () => { this.off('view_updated', wrapped) }
  }
}

/**
 * Process-wide instance. A process has one artifact store and one chat event
 * bus, so a module singleton is the honest shape here; tests subscribe and
 * unsubscribe around themselves.
 */
export const artifactViewEvents = new ArtifactViewEvents()
