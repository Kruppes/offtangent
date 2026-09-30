/**
 * `html_view.v1` — the rules for embedding a board document, as pure functions
 * so they are unit tested instead of only screenshot tested.
 *
 * The document is skill written HTML. It is never injected into this app's DOM
 * and never handed to an iframe as `srcdoc`: it is loaded from the sandboxed
 * content URL the backend minted, which answers with
 * `Content-Security-Policy: … sandbox allow-scripts` (opaque origin, no
 * network, no storage, no form action). See `docs/reference/boards-api.md`.
 */
import type { BoardContentRef } from '~/api/boards'

/** `allow-same-origin` is never added: with allow-scripts it would undo the sandbox. */
export const HTML_VIEW_SANDBOX = 'allow-scripts'

export const HTML_VIEW_ALLOW = "accelerometer 'none'; camera 'none'; geolocation 'none'; gyroscope 'none'; microphone 'none'; payment 'none'; usb 'none'"

const DEFAULT_MIN_HEIGHT_PX = 320
const MAX_HEIGHT_PX = 4000

/**
 * The URL the iframe loads.
 *
 * Only a same-host API path is accepted (`/api/boards/…/content`): a backend
 * that answered with an absolute URL to somewhere else, or with an `?token=`
 * access token next to the document, is a bug worth a blank frame rather than
 * a request. The theme hint is appended for a page that declared
 * `supports_theme`; everything else keeps the URL as minted.
 */
export function htmlViewSrc(content: BoardContentRef | undefined, dark: boolean): string | null {
  if (!content?.url) return null
  const base = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  let parsed: URL
  try {
    parsed = new URL(content.url, base)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  if (!/^\/api\/boards\/[^/]+\/(content|revisions\/\d+\/content)$/.test(parsed.pathname)) return null
  if (!parsed.searchParams.get('t')) return null
  if (parsed.searchParams.has('token')) return null
  if (content.supportsTheme) parsed.searchParams.set('theme', dark ? 'dark' : 'light')
  return parsed.toString()
}

/** Frame height from the payload hints: an aspect ratio wins, else a minimum. */
export function htmlViewHeight(content: BoardContentRef | undefined, frameWidth: number): number {
  const min = clampHeight(content?.minHeightPx ?? DEFAULT_MIN_HEIGHT_PX)
  const ratio = content?.aspectRatio
  if (ratio && ratio > 0 && frameWidth > 0) return clampHeight(Math.round(frameWidth / ratio))
  return min
}

function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_HEIGHT_PX
  return Math.min(MAX_HEIGHT_PX, Math.max(120, Math.round(value)))
}

/**
 * ## Links out of the sandbox
 *
 * The document cannot open anything itself: its sandbox has no
 * `allow-popups`, no `allow-top-navigation` and no `allow-same-origin`, and
 * that is not going to be relaxed — it would hand a model written page the
 * power to open `javascript:`/`data:` windows. Instead the server injects a
 * small script (`@axiom/core/board-link-bridge.ts`) that turns a click on an
 * http(s) link into
 *
 *   parent.postMessage({ type: 'offtangent.open-link', url }, '*')
 *
 * and the HOST opens it. Everything below is the receiving half: it trusts
 * nothing but the identity of the frame and re-validates the URL.
 */
export const BOARD_OPEN_LINK_MESSAGE = 'offtangent.open-link'

/** Longer than any honest link; a longer one is a flooding attempt, not a URL. */
export const BOARD_LINK_MAX_LENGTH = 2048

/**
 * The URL to open for a `message` event, or null when the message is not a
 * link request this host accepts.
 *
 * Checked, in order: the message really comes from OUR iframe (`event.source`
 * is its `contentWindow` — `event.origin` is useless here, a sandboxed
 * document posts from an opaque origin `"null"` that any other sandboxed
 * frame also has), the exact message type, a sane length, a parsable absolute
 * URL, and `http:`/`https:` only — never `javascript:`, `data:`, `blob:`,
 * `file:` or `ftp:`.
 */
export function boardLinkFromMessage(
  event: { data?: unknown; source?: unknown },
  frameWindow: unknown,
  activation?: { isActive: boolean },
): string | null {
  if (!frameWindow || event.source !== frameWindow) return null
  // A click in the frame activates the host too; a message without that is a
  // script acting on its own. Browsers without the API cannot tell, so absent
  // means "not known", not "no" (window.open's popup blocker still applies).
  if (activation && !activation.isActive) return null
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const message = data as { type?: unknown; url?: unknown }
  if (message.type !== BOARD_OPEN_LINK_MESSAGE) return null
  if (typeof message.url !== 'string' || message.url.length === 0 || message.url.length > BOARD_LINK_MAX_LENGTH) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(message.url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // `https://trusted@evil/` reads as one host and opens another.
  if (parsed.username || parsed.password) return null
  return parsed.href
}
