/**
 * sandboxed-document.ts — the one security contract for every byte in this
 * system that was written by a model or a skill and is executed by a browser.
 *
 * Two features deliver such bytes today: canvas artifacts
 * (`/api/artifacts/:id/content`) and `html_view.v1` boards
 * (`/api/boards/:key/content`). They must not drift apart, so the CSP, the
 * response headers and the embed contract handed to the two clients live here
 * instead of once per feature.
 *
 * See `docs/reference/artifacts-api.md` for the rationale of every directive.
 */

/** What a document is allowed to be: a program (`html`) or data. */
export type SandboxedDocumentKind = 'html' | 'data'

/**
 * Origins allowed to frame a sandboxed document. Defaults to the app itself;
 * set `ARTIFACT_FRAME_ANCESTORS` to a space separated origin list when the web
 * app runs on another origin than the API.
 */
export function frameAncestors(): string {
  const configured = process.env.ARTIFACT_FRAME_ANCESTORS?.trim()
  return configured && configured.length > 0 ? configured : "'self'"
}

/** Absolute origin the content bytes are served from, when one is configured. */
export function sandboxedContentOrigin(): string | null {
  const origin = process.env.ARTIFACT_ORIGIN?.trim()
  return origin && /^https?:\/\/[^\s'"]+$/.test(origin) ? origin.replace(/\/+$/, '') : null
}

/**
 * Content Security Policy for sandboxed bytes.
 *
 * `sandbox allow-scripts` is the load bearing part: it puts the document in an
 * opaque origin even when the embedder forgot the `sandbox` attribute, so the
 * document can never reach the app origin, its cookies, its LocalStorage or
 * the access token. `allow-same-origin` is never sent — together with
 * `allow-scripts` it would undo the whole sandbox.
 *
 * `default-src 'none'` plus `connect-src 'none'` plus `form-action 'none'`
 * closes every path back to `/api/*`: no fetch, no XHR, no WebSocket, no form
 * post, no subresource. Inline script and style are allowed because a self
 * contained document IS inline; there is nothing else it could load.
 */
export function sandboxedContentSecurityPolicy(kind: SandboxedDocumentKind): string {
  const directives = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    `frame-ancestors ${frameAncestors()}`,
    'sandbox allow-scripts',
  ]
  // An SVG or PNG is data, not a program: it gets no script budget at all.
  if (kind !== 'html') {
    directives[1] = "script-src 'none'"
    directives[directives.length - 1] = 'sandbox'
  }
  return directives.join('; ')
}

export interface SandboxedContentHeaderInput {
  kind: SandboxedDocumentKind
  contentType: string
  byteLength: number
  filename: string
}

/** Every response header a content route sets, in one testable place. */
export function sandboxedContentHeaders(input: SandboxedContentHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': input.contentType,
    'Content-Length': String(input.byteLength),
    'Content-Security-Policy': sandboxedContentSecurityPolicy(input.kind),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
    // The URL carries a capability token, so no shared cache may keep it.
    'Cache-Control': 'private, no-store, max-age=0',
    // The content host may be a different origin than the embedder.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Disposition': `inline; filename="${input.filename}"`,
  }
  // Belt and braces for engines that predate `frame-ancestors`. Only while the
  // policy is the default: X-Frame-Options cannot express an allow list, and
  // an old engine would block a legitimately configured cross-origin embed.
  if (frameAncestors() === "'self'") headers['X-Frame-Options'] = 'SAMEORIGIN'
  return headers
}

/**
 * What a renderer must do with a content URL. Served by the backend so that
 * the app and the web app cannot disagree about the sandbox — if this ever has
 * to change, it changes in one place.
 */
export interface SandboxEmbedContract {
  /** `sandbox` attribute for a web `<iframe>`. `allow-same-origin` is absent on purpose. */
  iframeSandbox: string
  /** `referrerpolicy` for the same iframe, so the capability token never leaves. */
  iframeReferrerPolicy: string
  /**
   * True when the content origin differs from the API origin. The response
   * enforces an opaque origin through the CSP `sandbox` directive either way;
   * this only tells a client whether it may additionally rely on a real cross
   * origin boundary.
   */
  separateOrigin: boolean
  /** Capabilities the document never gets, in both clients. */
  denies: string[]
}

export function sandboxEmbedContract(kind: SandboxedDocumentKind, separateOrigin: boolean): SandboxEmbedContract {
  return {
    iframeSandbox: kind === 'html' ? 'allow-scripts' : '',
    iframeReferrerPolicy: 'no-referrer',
    separateOrigin,
    denies: ['same-origin', 'cookies', 'localStorage', 'network', 'top-navigation'],
  }
}

/** A filename a browser accepts in `Content-Disposition`, derived from a title. */
export function safeContentFilename(title: string, extension: string, fallback: string): string {
  const base = title.replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, '_').slice(0, 60) || fallback
  return `${base}.${extension}`
}
