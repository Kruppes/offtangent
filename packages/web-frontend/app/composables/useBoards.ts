import { computed, ref, watch } from 'vue'
import type { Board, BoardRevisionEntry, BoardSummary, SeriesPoint } from '~/api/boards'
import { useBoardsApi } from '~/api/boards'

export interface BoardLiveSignal {
  key: string
  revision: number
  asOf: string
  /** Bumped on every frame so a repeated revision still triggers a refetch. */
  seq: number
}

/**
 * Last `board_updated` websocket frame. The chat socket feeds this state, the
 * board pages watch it — the pages never own a socket of their own.
 */
export function useBoardSignal() {
  const signal = useState<BoardLiveSignal | null>('board_updated', () => null)
  function receive(board: { key?: string; revision?: number; asOf?: string } | undefined) {
    if (!board?.key) return
    signal.value = { key: board.key, revision: board.revision ?? 0, asOf: board.asOf ?? '', seq: (signal.value?.seq ?? 0) + 1 }
  }
  return { signal, receive }
}

/** Chooser state: every board of the user, without payloads. */
export function useBoardList() {
  const api = useBoardsApi()
  const { signal } = useBoardSignal()
  const boards = useState<BoardSummary[]>('boards_list', () => [])
  const loading = useState<boolean>('boards_list_loading', () => false)
  const error = useState<string | null>('boards_list_error', () => null)

  async function load() {
    if (loading.value) return
    loading.value = true
    error.value = null
    try {
      boards.value = await api.list()
    } catch {
      error.value = 'boards.loadError'
    } finally {
      loading.value = false
    }
  }

  watch(() => signal.value?.seq, (seq) => { if (seq) void load() })

  return { boards, loading, error, load }
}

/**
 * A historic revision carries the board's identity (`kind`, `title`, `icon`,
 * `agentId`) since the revision endpoint merges the current row. An older
 * backend answers with the bare revision; without `kind` the page would drop
 * to the generic renderer and show an empty header, so the current board
 * fills exactly those gaps — never the revision's own state.
 */
function withBoardIdentity(historic: Partial<Board>, base: Board | null): Board {
  return {
    ...historic,
    key: historic.key ?? base?.key ?? '',
    kind: historic.kind ?? base?.kind ?? '',
    title: historic.title ?? base?.title ?? '',
    icon: historic.icon ?? base?.icon ?? null,
    agentId: historic.agentId ?? base?.agentId ?? null,
    revision: historic.revision ?? base?.revision ?? 0,
    summary: historic.summary ?? null,
    payload: historic.payload,
    asOf: historic.asOf ?? base?.asOf ?? '',
    updatedAt: historic.updatedAt ?? base?.updatedAt ?? '',
  }
}

/** Detail state for one board, including revisions and the total series. */
export function useBoardDetail(key: () => string) {
  const api = useBoardsApi()
  const { signal } = useBoardSignal()
  const board = ref<Board | null>(null)
  const current = ref<Board | null>(null)
  const revisions = ref<BoardRevisionEntry[]>([])
  const series = ref<SeriesPoint[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const viewedRevision = ref<number | null>(null)
  const historyOpen = ref(false)
  const missedSignal = ref(false)
  const isHistoric = computed(() => viewedRevision.value !== null && viewedRevision.value !== current.value?.revision)

  async function load() {
    loading.value = true
    error.value = null
    viewedRevision.value = null
    missedSignal.value = false
    try {
      const loaded = await api.get(key())
      board.value = loaded
      current.value = loaded
      void loadSeries()
      void loadRevisions()
    } catch {
      error.value = 'boards.detailError'
      board.value = null
    } finally {
      loading.value = false
    }
  }

  async function loadSeries() {
    try {
      const result = await api.series(key(), ['total_eur'], 90)
      series.value = result.total_eur ?? []
    } catch {
      series.value = []
    }
  }

  async function loadRevisions() {
    try {
      revisions.value = await api.revisions(key())
    } catch {
      revisions.value = []
    }
  }

  async function openRevision(revision: number) {
    if (revision === current.value?.revision) return backToCurrent()
    loading.value = true
    error.value = null
    try {
      board.value = withBoardIdentity(await api.revision(key(), revision), current.value)
      viewedRevision.value = revision
    } catch {
      error.value = 'boards.revisionError'
    } finally {
      loading.value = false
    }
  }

  function backToCurrent() {
    viewedRevision.value = null
    if (missedSignal.value) {
      missedSignal.value = false
      void load()
      return
    }
    board.value = current.value
  }

  watch(() => signal.value?.seq, (seq) => {
    if (!seq || signal.value?.key !== key()) return
    // While a historic revision is pinned the view must not jump to the new
    // state; the missed update is replayed when the user returns to current.
    if (isHistoric.value) { missedSignal.value = true; return }
    void load()
  })

  return { board, current, revisions, series, loading, error, viewedRevision, isHistoric, historyOpen, load, openRevision, backToCurrent }
}
