/**
 * board-renderer-registry.ts — a board kind can bring its own renderer as a
 * file on the server, so a NEW board type never needs a client update.
 *
 * The rule is one file per kind:
 *
 *   <DATA_DIR>/board-renderers/<name>.v<n>.html
 *
 * When that file exists, the board content route serves it through the same
 * sandbox `html_view.v1` uses, with the board state injected as
 *
 *   <script type="application/json" id="board-data">{…}</script>
 *
 * inserted before `</head>`. The renderer reads that element, nothing else:
 * it has no network (`connect-src 'none'`), no cookies and no storage, so the
 * injected JSON is its only input besides `?theme=`.
 *
 * Why a file and not a payload: the renderer is operator supplied data, not
 * repository code. It lives under DATA_DIR next to the other user data, is
 * never committed, and a new one takes effect on the next request without a
 * restart (the file is read per request; the documents are small and the
 * route is not a hot path).
 *
 * Security of the lookup — the kind comes from the database and, through
 * `publish_board`, ultimately from a model:
 *  - the kind must match {@link BOARD_KIND_PATTERN} (`^[a-z0-9_]+\.v[0-9]+$`),
 *    which contains no `/`, no `\` and no `.` other than the version dot, so
 *    `../../etc/passwd` and absolute paths cannot be expressed at all,
 *  - the resolved path must stay inside the renderer directory,
 *  - symlinks are not followed (`lstat`), so a link planted in the directory
 *    cannot export an arbitrary file into a sandboxed document,
 *  - a file above {@link BOARD_RENDERER_MAX_BYTES} is ignored like a missing
 *    one; a board with no usable renderer keeps the previous behaviour
 *    (no `content` block, the client renders summary plus raw payload).
 */
import fs from 'node:fs'
import path from 'node:path'
import { BOARD_KIND_PATTERN } from './board-tool.js'

/** Upper bound for one renderer document, UTF-8 bytes. */
export const BOARD_RENDERER_MAX_BYTES = 512 * 1024

/** Element id the injected board state uses. */
export const BOARD_DATA_SCRIPT_ID = 'board-data'

/** Directory holding the renderer files. Derived from `DATA_DIR`, like every other store. */
export function boardRenderersDir(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'board-renderers')
}

/**
 * Absolute path of the renderer file for a kind, or null when the kind cannot
 * name a file (bad pattern, traversal attempt, absurd length).
 */
export function boardRendererPath(kind: unknown, dir: string = boardRenderersDir()): string | null {
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > 80) return null
  if (!BOARD_KIND_PATTERN.test(kind)) return null
  const base = path.resolve(dir)
  const file = path.resolve(base, `${kind}.html`)
  // Belt and braces: the pattern already excludes separators, this catches a
  // future pattern change before it becomes a file disclosure.
  if (file !== path.join(base, `${kind}.html`)) return null
  if (!file.startsWith(`${base}${path.sep}`)) return null
  return file
}

export interface BoardRendererTemplate {
  kind: string
  /** Absolute path the document was read from. */
  path: string
  /** The renderer document, verbatim. */
  html: string
}

function usableFile(file: string): boolean {
  let stat: fs.Stats
  try {
    // lstat, not stat: a symlink is never followed, whatever it points at.
    stat = fs.lstatSync(file)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  if (stat.size > BOARD_RENDERER_MAX_BYTES) return false
  return true
}

/** True when this kind has a usable renderer file. Cheap: one `lstat`. */
export function hasBoardRenderer(kind: unknown, dir: string = boardRenderersDir()): boolean {
  const file = boardRendererPath(kind, dir)
  return file !== null && usableFile(file)
}

/**
 * Read the renderer of a kind. Returns null when there is none, when the path
 * is not a regular file (directory, symlink, socket) or when it is too large.
 * Read fresh on every call so a new renderer works without a restart.
 */
export function readBoardRenderer(kind: unknown, dir: string = boardRenderersDir()): BoardRendererTemplate | null {
  const file = boardRendererPath(kind, dir)
  if (file === null || !usableFile(file)) return null
  let html: string
  try {
    html = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  if (Buffer.byteLength(html, 'utf8') > BOARD_RENDERER_MAX_BYTES) return null
  return { kind: kind as string, path: file, html }
}

/** The board state handed to a server renderer. Exactly what the API returns, minus internals. */
export interface BoardRendererData {
  key: string
  kind: string
  title: string
  revision: number
  as_of: string
  summary: string | null
  payload: unknown
}

/**
 * JSON for a `<script type="application/json">` block.
 *
 * `JSON.stringify` may emit `<`, `>` and the two line separators raw, and a
 * payload string containing `</script>` would end the block early — the
 * classic way a data island turns into an XSS. Escaping them as `\uXXXX`
 * keeps the JSON byte-identical in meaning (`JSON.parse` resolves the escapes)
 * while making it impossible to leave the element.
 */
export function encodeBoardDataJson(data: unknown): string {
  return JSON.stringify(data ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** The `<script>` element carrying the board state. */
export function boardDataScript(data: BoardRendererData): string {
  return `<script type="application/json" id="${BOARD_DATA_SCRIPT_ID}">${encodeBoardDataJson(data)}</script>`
}

/**
 * Where the data island goes: before `</head>` so the renderer can read it in
 * its own `DOMContentLoaded`, or as early as the document allows when it has
 * no head (after `<html>`, after the doctype, else at the very start — never
 * before a doctype, which would drop the page into quirks mode).
 */
function insertionIndex(html: string): number {
  const closingHead = /<\/head\s*>/i.exec(html)
  if (closingHead) return closingHead.index
  const openingHead = /<head\b[^>]*>/i.exec(html)
  if (openingHead) return openingHead.index + openingHead[0].length
  const openingHtml = /<html\b[^>]*>/i.exec(html)
  if (openingHtml) return openingHtml.index + openingHtml[0].length
  const doctype = /^\s*<!doctype\b[^>]*>/i.exec(html)
  if (doctype) return doctype[0].length
  return 0
}

/** Insert the board state into a renderer document. */
export function injectBoardData(html: string, data: BoardRendererData): string {
  const at = insertionIndex(html)
  return `${html.slice(0, at)}${boardDataScript(data)}${html.slice(at)}`
}
