/**
 * `html_view.v1` — a board whose payload IS a self-contained HTML document.
 *
 * A skill that wants to show something the built-in renderers cannot draw (a
 * wheel diagram, a floor plan, a small calculator) publishes the finished page
 * instead of inventing a payload schema plus two renderers for it. The clients
 * do not interpret the document: they hand it to the same sandbox the canvas
 * artifacts use (`docs/reference/artifacts-api.md`).
 *
 * The contract stays deliberately small, because everything it grows has to be
 * honoured by a web `<iframe>` AND an Android `WebView`:
 *
 *   {
 *     "html": "<!doctype html>…",   // required, the whole document
 *     "supports_theme": true,        // optional, the page reads ?theme=
 *     "aspect_ratio": 1,             // optional, width / height
 *     "min_height_px": 360,          // optional, viewport hint
 *     "schema_version": "html_view.v1"  // optional, must match when present
 *   }
 *
 * ## Why the HTML may be bigger than a normal payload
 *
 * A normal board payload is data for a renderer the client already ships, so
 * 256 KB is generous. Here the payload carries the renderer as well: markup,
 * CSS, inline SVG and the data, with no CDN and no external font allowed. The
 * canvas artifacts (same threat model, same delivery) are capped at 2 MiB;
 * boards keep 30 revisions per key, so the cap is set at 1 MiB — a page that
 * needs more is a file, not a dashboard.
 */

export const HTML_VIEW_KIND = 'html_view.v1'

/** Serialized payload bytes allowed for {@link HTML_VIEW_KIND}. */
export const HTML_VIEW_PAYLOAD_MAX_BYTES = 1024 * 1024

/** The document itself, UTF-8 bytes. Leaves room for the payload envelope. */
export const HTML_VIEW_HTML_MAX_BYTES = 1000 * 1024

/** Bounds of the optional layout hints. Out of range is a validation error, not a clamp. */
export const HTML_VIEW_ASPECT_MIN = 0.1
export const HTML_VIEW_ASPECT_MAX = 10
export const HTML_VIEW_MIN_HEIGHT_PX = 80
export const HTML_VIEW_MAX_HEIGHT_PX = 4000

export interface HtmlViewPayload {
  html: string
  supportsTheme: boolean
  aspectRatio: number | null
  minHeightPx: number | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject a payload that cannot be rendered. Returns null when it is fine,
 * otherwise the reason — the same shape `validatePortfolioDigestPayload` uses,
 * so the tool reports one kind of error.
 *
 * It never rewrites the document: no sanitising, no injected `<base>`, no
 * pretty printing. The sandbox, not a filter, is what makes the HTML safe, and
 * a rewritten document would silently differ from what the skill tested.
 */
export function validateHtmlViewPayload(payload: Record<string, unknown>): string | null {
  const version = payload.schema_version
  if (version !== undefined && version !== null && version !== HTML_VIEW_KIND) {
    return `payload.schema_version must be "${HTML_VIEW_KIND}" when present`
  }

  const html = payload.html
  if (typeof html !== 'string' || html.trim().length === 0) {
    return `payload.html is required for kind ${HTML_VIEW_KIND} and must be a non-empty string`
  }
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > HTML_VIEW_HTML_MAX_BYTES) {
    return `payload.html must be at most ${HTML_VIEW_HTML_MAX_BYTES} bytes (got ${bytes})`
  }

  const supportsTheme = payload.supports_theme
  if (supportsTheme !== undefined && supportsTheme !== null && typeof supportsTheme !== 'boolean') {
    return 'payload.supports_theme must be a boolean'
  }

  const aspect = payload.aspect_ratio
  if (aspect !== undefined && aspect !== null) {
    if (typeof aspect !== 'number' || !Number.isFinite(aspect)
      || aspect < HTML_VIEW_ASPECT_MIN || aspect > HTML_VIEW_ASPECT_MAX) {
      return `payload.aspect_ratio must be a number between ${HTML_VIEW_ASPECT_MIN} and ${HTML_VIEW_ASPECT_MAX} (width / height)`
    }
  }

  const minHeight = payload.min_height_px
  if (minHeight !== undefined && minHeight !== null) {
    if (typeof minHeight !== 'number' || !Number.isInteger(minHeight)
      || minHeight < HTML_VIEW_MIN_HEIGHT_PX || minHeight > HTML_VIEW_MAX_HEIGHT_PX) {
      return `payload.min_height_px must be an integer between ${HTML_VIEW_MIN_HEIGHT_PX} and ${HTML_VIEW_MAX_HEIGHT_PX}`
    }
  }

  return null
}

/**
 * Read a stored payload back. Returns null for anything that is not a valid
 * `html_view.v1` payload, so a board written by an older or broken producer
 * falls back to the generic renderer instead of serving an empty document.
 */
export function readHtmlViewPayload(payload: unknown): HtmlViewPayload | null {
  if (!isPlainObject(payload)) return null
  if (validateHtmlViewPayload(payload) !== null) return null
  return {
    html: payload.html as string,
    supportsTheme: payload.supports_theme === true,
    aspectRatio: typeof payload.aspect_ratio === 'number' ? payload.aspect_ratio : null,
    minHeightPx: typeof payload.min_height_px === 'number' ? payload.min_height_px : null,
  }
}
