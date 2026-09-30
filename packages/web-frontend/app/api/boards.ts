/**
 * Read client for boards (`GET /api/boards…`). Boards are written by agents
 * through the `publish_board` tool, never by the web app — this client is
 * read-only by design.
 */
export interface BoardSummary {
  key: string
  kind: string
  title: string
  icon: string | null
  agentId: string | null
  revision: number
  summary: string | null
  asOf: string
  updatedAt: string
}

/**
 * How a sandboxed board document is fetched. Present for `html_view.v1` (the
 * payload IS the document) and for every kind the server has a renderer for
 * (`<DATA_DIR>/board-renderers/<kind>.html`), which is how a new board type
 * arrives without a client update. The URL carries a short lived capability
 * token; the HTML itself is NEVER rendered from the payload — see
 * `app/utils/boardHtmlView.ts`.
 */
export interface BoardContentRef {
  url: string
  expiresAt: string
  embed: {
    iframeSandbox: string
    iframeReferrerPolicy: string
    separateOrigin: boolean
    denies: string[]
  }
  /** True when the page reads `?theme=dark|light` from its own URL. */
  supportsTheme: boolean
  aspectRatio: number | null
  minHeightPx: number | null
}

/** A board including its payload. The payload shape is defined by `kind`. */
export interface Board extends BoardSummary {
  payload: unknown
  /** Present when the server serves this board as a sandboxed document. */
  content?: BoardContentRef
}

export interface BoardRevisionEntry {
  revision: number
  asOf: string
  createdAt: string
  summary: string | null
}

export interface SeriesPoint {
  day: string
  value: number
  meta?: Record<string, unknown>
}

export function useBoardsApi() {
  const { apiFetch } = useApi()
  const path = (key: string, suffix = '') => `/api/boards/${encodeURIComponent(key)}${suffix}`
  return {
    async list(): Promise<BoardSummary[]> {
      return (await apiFetch<{ boards: BoardSummary[] }>('/api/boards')).boards
    },
    get(key: string): Promise<Board> {
      return apiFetch<Board>(path(key))
    },
    async revisions(key: string): Promise<BoardRevisionEntry[]> {
      return (await apiFetch<{ revisions: BoardRevisionEntry[] }>(path(key, '/revisions'))).revisions
    },
    revision(key: string, revision: number): Promise<Board> {
      return apiFetch<Board>(path(key, `/revisions/${encodeURIComponent(String(revision))}`))
    },
    async series(key: string, names: string[], days = 90): Promise<Record<string, SeriesPoint[]>> {
      const params = new URLSearchParams({ series: names.join(','), days: String(days) })
      return (await apiFetch<{ series: Record<string, SeriesPoint[]> }>(path(key, `/series?${params}`))).series
    },
  }
}
