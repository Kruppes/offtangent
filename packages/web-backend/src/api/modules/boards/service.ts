/**
 * Boards service (plan 2026-09-25). Reads the boards of ONE user.
 *
 * It never writes a board: boards are produced by agents through the
 * `publish_board` tool (`@axiom/core/board-tool.ts`). The only write here is
 * the admin delete, which exists so a board that should not exist any more
 * can actually be removed.
 *
 * Every board of another user is reported as 404, not 403: whether a key
 * exists in someone else's account is itself none of the caller's business.
 */
import {
  BOARD_SERIES_MAX_DAYS,
  HTML_VIEW_KIND,
  hasBoardRenderer,
  injectBoardData,
  injectBoardLinkBridge,
  readBoardRenderer,
  readHtmlViewPayload,
  deleteBoard,
  getBoard,
  getBoardRevision,
  getBoardSeries,
  listBoardRevisions,
  listBoards,
  type Board,
  type BoardRevision,
  type BoardRevisionMeta,
  type BoardSeriesPoint,
  type BoardSummary,
  type Database,
} from '@axiom/core'
import { BOARD_TOKEN_CURRENT_REVISION, mintBoardToken } from '../../../board-token.js'
import {
  safeContentFilename,
  sandboxEmbedContract,
  sandboxedContentHeaders,
  sandboxedContentOrigin,
  type SandboxEmbedContract,
} from '../../../sandboxed-document.js'

export class BoardServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'BoardServiceError'
  }
}

export interface BoardsServiceOptions {
  db: Database
}

/**
 * How a client gets at the document of a board that is served as a sandboxed
 * document: `html_view.v1` (the document IS the payload) and every kind that
 * has a server renderer under `<DATA_DIR>/board-renderers/<kind>.html`.
 * A kind with neither keeps the exact response it had before — no `content`
 * block, so a client falls back to its built-in renderer or to summary plus
 * raw payload.
 */
export interface BoardContentRef {
  url: string
  expiresAt: string
  embed: SandboxEmbedContract
  /** The page reads `?theme=dark|light` from its own URL. */
  supportsTheme: boolean
  aspectRatio: number | null
  minHeightPx: number | null
}

export interface BoardHtmlContent {
  html: string
  headers: Record<string, string>
}

export type BoardWithContent = (Board | BoardRevision) & { content?: BoardContentRef }

export interface BoardsService {
  list: (userId: number) => { boards: BoardSummary[] }
  get: (userId: number, key: string) => BoardWithContent
  revisions: (userId: number, key: string) => { revisions: BoardRevisionMeta[] }
  revision: (userId: number, key: string, revision: number) => BoardWithContent
  /** The raw document of an `html_view.v1` board; `revision` null = current. */
  content: (userId: number, key: string, revision: number | null) => BoardHtmlContent
  series: (
    userId: number,
    key: string,
    series: readonly string[],
    days: number,
  ) => { series: Record<string, BoardSeriesPoint[]> }
  remove: (userId: number, key: string) => void
}

function notFound(): BoardServiceError {
  return new BoardServiceError(404, 'board_not_found', 'Board not found')
}

function revisionNotFound(): BoardServiceError {
  return new BoardServiceError(404, 'board_revision_not_found', 'Board revision not found')
}

/**
 * The content block of a board whose body is a sandboxed document. The URL
 * carries a capability token for exactly this board (and, for history,
 * exactly this revision); the HTML itself is never handed to a client for
 * direct injection, it is fetched from the sandboxed content route. See
 * `sandboxed-document.ts`.
 *
 * Two sources, one response shape:
 *  - `html_view.v1`: the payload carries the document, so the payload's own
 *    hints (`supports_theme`, `aspect_ratio`, `min_height_px`) apply.
 *  - any kind with a server renderer: the hints belong to the renderer, which
 *    the payload knows nothing about. `supportsTheme` is therefore always
 *    true (the frame appends `?theme=`, a renderer that ignores it loses
 *    nothing) and the size hints stay null.
 */
function contentRef(
  userId: number,
  key: string,
  kind: string,
  revision: number | null,
  payload: unknown,
): BoardContentRef | undefined {
  let hints: { supportsTheme: boolean; aspectRatio: number | null; minHeightPx: number | null }
  if (kind === HTML_VIEW_KIND) {
    const view = readHtmlViewPayload(payload)
    if (!view) return undefined
    hints = { supportsTheme: view.supportsTheme, aspectRatio: view.aspectRatio, minHeightPx: view.minHeightPx }
  } else if (hasBoardRenderer(kind)) {
    hints = { supportsTheme: true, aspectRatio: null, minHeightPx: null }
  } else {
    return undefined
  }
  const origin = sandboxedContentOrigin() ?? ''
  const minted = mintBoardToken(key, revision ?? BOARD_TOKEN_CURRENT_REVISION, userId)
  const path = revision === null
    ? `/api/boards/${encodeURIComponent(key)}/content`
    : `/api/boards/${encodeURIComponent(key)}/revisions/${revision}/content`
  return {
    url: `${origin}${path}?t=${encodeURIComponent(minted.token)}`,
    expiresAt: minted.expiresAt,
    embed: sandboxEmbedContract('html', origin.length > 0),
    ...hints,
  }
}

export function createBoardsService(options: BoardsServiceOptions): BoardsService {
  const { db } = options
  return {
    list(userId) {
      return { boards: listBoards(db, String(userId)) }
    },

    get(userId, key) {
      const board = getBoard(db, String(userId), key)
      if (!board) throw notFound()
      const content = contentRef(userId, key, board.kind, null, board.payload)
      return content ? { ...board, content } : board
    },

    revisions(userId, key) {
      // A key with no board has no revisions to show, even if rows lingered.
      if (!getBoard(db, String(userId), key)) throw notFound()
      return { revisions: listBoardRevisions(db, String(userId), key) }
    },

    revision(userId, key, revision) {
      const found = getBoardRevision(db, String(userId), key, revision)
      if (!found) throw notFound()
      const content = contentRef(userId, key, found.kind, revision, found.payload)
      return content ? { ...found, content } : found
    },

    content(userId, key, revision) {
      const board = getBoard(db, String(userId), key)
      if (!board) throw notFound()
      // The kind is read from the CURRENT board row, exactly like the revision
      // route does: a board that was republished under a different kind must
      // not keep serving its old revisions as executable HTML.
      const renderer = board.kind === HTML_VIEW_KIND ? null : readBoardRenderer(board.kind)
      if (board.kind !== HTML_VIEW_KIND && !renderer) throw notFound()
      const source = revision === null ? board : getBoardRevision(db, String(userId), key, revision)
      if (!source) throw revisionNotFound()

      let document: string
      if (renderer) {
        document = injectBoardData(renderer.html, {
          key,
          kind: board.kind,
          title: source.title,
          revision: source.revision,
          as_of: source.asOf,
          summary: source.summary,
          payload: source.payload,
        })
      } else {
        const view = readHtmlViewPayload(source.payload)
        if (!view) {
          throw new BoardServiceError(410, 'board_content_gone', 'This board revision carries no renderable document')
        }
        document = view.html
      }
      // Every board document gets the link bridge: without it an `<a href>`
      // is dead inside the sandbox (no allow-popups, no top navigation).
      const html = injectBoardLinkBridge(document)
      const body = Buffer.from(html, 'utf8')
      return {
        html,
        headers: sandboxedContentHeaders({
          kind: 'html',
          contentType: 'text/html; charset=utf-8',
          byteLength: body.byteLength,
          filename: safeContentFilename(board.title, 'html', 'board'),
        }),
      }
    },

    series(userId, key, series, days) {
      if (!getBoard(db, String(userId), key)) throw notFound()
      const window = Math.min(BOARD_SERIES_MAX_DAYS, Math.max(1, days))
      return { series: getBoardSeries(db, String(userId), key, series, window) }
    },

    remove(userId, key) {
      if (!deleteBoard(db, String(userId), key)) throw notFound()
    },
  }
}
