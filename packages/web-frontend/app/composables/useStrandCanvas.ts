/**
 * useStrandCanvas — the living views of ONE strand, kept current by the
 * `canvas_view_updated` frame.
 *
 * ## Why a composable and not a reload after every turn
 *
 * Until now the web client learned about a new revision by re-reading the
 * views when a turn ended. That is wrong in exactly the case the canvas exists
 * for: a background task or a cronjob writes a revision hours later, with no
 * turn ending anywhere near the open tab. The server now announces every
 * revision live (see `canvas-view-broadcast.ts`), so the state lives here and
 * the frame is applied to it directly.
 *
 * Two rules from the interaction spec are implemented here and nowhere else,
 * so the Vue side cannot get them subtly different:
 *
 *  - the OPEN view follows automatically — a revision that arrives while its
 *    view is on screen replaces what is shown (`followed`),
 *  - a view that is NOT open collects unseen revisions instead (`unseen`), and
 *    opening it clears that mark.
 */
import { computed, ref, watch, type Ref } from 'vue'
import type { StrandView, ViewRevisionRef } from '~/api/artifacts'

/**
 * Last `canvas_view_updated` frame, exactly like `useBoardSignal()`: the chat
 * socket is the only socket, so it feeds this state and whoever renders a
 * canvas watches it. `seq` is bumped on every frame so two revisions with the
 * same number (a retried write) still wake the watcher.
 */
export interface CanvasLiveSignal {
  update: CanvasViewUpdate
  seq: number
}

export function useCanvasSignal() {
  const signal = useState<CanvasLiveSignal | null>('canvas_view_updated', () => null)
  function receive(update: CanvasViewUpdate | undefined): void {
    if (!update?.viewKey || !update.strandId) return
    if (!Number.isFinite(update.revision)) return
    signal.value = { update, seq: (signal.value?.seq ?? 0) + 1 }
  }
  return { signal, receive }
}

/** The payload of the `canvas_view_updated` frame (wire shape, verbatim). */
export interface CanvasViewUpdate {
  userId?: number
  strandId: string
  viewKey: string
  revision: number
  latestRevision: number
  artifactId: string
  title: string
  note: string | null
  messageId: number
  agentId: string | null
  kind: StrandView['kind'] | 'image'
}

/** `image` is the core spelling of what the web types call `png`. */
function normalizeKind(kind: CanvasViewUpdate['kind']): StrandView['kind'] {
  return kind === 'image' ? 'png' : kind
}

export interface StrandCanvasState {
  views: Ref<StrandView[]>
  /** View key currently on screen, `null` when the canvas is closed. */
  openViewKey: Ref<string | null>
  /** Revision shown for the open view; follows new revisions automatically. */
  openRevision: Ref<number | null>
  /** Keys with revisions the user has not seen, in arrival order. */
  unseen: Ref<string[]>
  /** True while at least one view has an unseen revision. */
  hasUnseen: Ref<boolean>
  open: (viewKey: string, revision?: number) => void
  close: () => void
  setViews: (views: StrandView[]) => void
  receive: (update: CanvasViewUpdate) => void
}

export function createStrandCanvasState(strandId: () => string | null): StrandCanvasState {
  const views = ref<StrandView[]>([])
  const openViewKey = ref<string | null>(null)
  const openRevision = ref<number | null>(null)
  const unseen = ref<string[]>([])

  function setViews(next: StrandView[]): void {
    views.value = next
    // A view that vanished (strand switched, revisions pruned) must not keep
    // the canvas pointing at nothing.
    if (openViewKey.value && !next.some(view => view.viewKey === openViewKey.value)) {
      openViewKey.value = null
      openRevision.value = null
    }
    unseen.value = unseen.value.filter(key => next.some(view => view.viewKey === key))
  }

  function open(viewKey: string, revision?: number): void {
    openViewKey.value = viewKey
    const view = views.value.find(candidate => candidate.viewKey === viewKey)
    openRevision.value = revision ?? view?.latestRevision ?? null
    unseen.value = unseen.value.filter(key => key !== viewKey)
  }

  function close(): void {
    openViewKey.value = null
    openRevision.value = null
  }

  function receive(update: CanvasViewUpdate): void {
    const current = strandId()
    // Frames of other strands are not an error — one socket carries them all.
    if (!current || update.strandId !== current) return
    if (!update.viewKey || !Number.isFinite(update.revision)) return

    const revision: ViewRevisionRef = {
      revision: update.revision,
      artifactId: update.artifactId,
      messageId: update.messageId,
      title: update.title,
      createdAt: new Date().toISOString(),
      note: update.note ?? null,
    }

    const existing = views.value.find(view => view.viewKey === update.viewKey)
    if (existing) {
      const revisions = existing.revisions.filter(entry => entry.revision !== update.revision)
      revisions.push(revision)
      revisions.sort((a, b) => a.revision - b.revision)
      const merged: StrandView = {
        ...existing,
        title: update.title || existing.title,
        kind: normalizeKind(update.kind),
        latestRevision: Math.max(existing.latestRevision, update.latestRevision, update.revision),
        updatedAt: revision.createdAt,
        revisions,
      }
      views.value = [merged, ...views.value.filter(view => view.viewKey !== update.viewKey)]
    } else {
      views.value = [{
        viewKey: update.viewKey,
        title: update.title,
        kind: normalizeKind(update.kind),
        latestRevision: update.latestRevision || update.revision,
        updatedAt: revision.createdAt,
        revisions: [revision],
      }, ...views.value]
    }

    if (openViewKey.value === update.viewKey) {
      // Auto-follow: the open view shows what was just written.
      openRevision.value = update.revision
      return
    }
    if (!unseen.value.includes(update.viewKey)) {
      unseen.value = [...unseen.value, update.viewKey]
    }
  }

  return {
    views,
    openViewKey,
    openRevision,
    unseen,
    hasUnseen: computed(() => unseen.value.length > 0) as unknown as Ref<boolean>,
    open,
    close,
    setViews,
    receive,
  }
}

/**
 * The canvas state of the strand currently on screen. One instance per app:
 * the live frame must reach it whether or not a canvas is mounted, and two
 * instances would each hold half of the unseen marks.
 */
let shared: StrandCanvasState | null = null

export function useStrandCanvas(strandId: () => string | null): StrandCanvasState {
  const { signal } = useCanvasSignal()
  if (!shared) {
    shared = createStrandCanvasState(strandId)
    watch(() => signal.value?.seq, () => {
      const update = signal.value?.update
      if (update) shared?.receive(update)
    })
  }
  return shared
}

/** Test seam: drop the shared instance between tests. */
export function resetStrandCanvasForTest(): void {
  shared = null
}
