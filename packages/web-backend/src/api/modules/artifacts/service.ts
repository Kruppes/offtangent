/**
 * Canvas artifacts (SPEC 7.4b, R2). Reads only: artifacts are written by the
 * server side extraction in `@axiom/core` when an assistant message is
 * persisted, never by a client.
 *
 * The security model of the content route lives here because it is the same
 * for every renderer: an Android WebView and a web `<iframe>` get byte
 * identical headers, so the guarantee cannot drift between the two clients.
 */
import type { Artifact, Database } from '@axiom/core'
import { getArtifactForUser, listArtifacts, readArtifactContent } from '@axiom/core'
import { mintArtifactToken } from '../../../artifact-token.js'
import { toArtifactRef } from './schema.js'
import type { ArtifactRef, ListArtifactsQuery } from './schema.js'

export class ArtifactServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ArtifactServiceError'
  }
}

/**
 * What the two renderers must do with the content URL. Served by the backend
 * so that the app and the web app cannot disagree about the sandbox — if this
 * ever has to change, it changes in one place.
 */
export interface ArtifactEmbedContract {
  /** `sandbox` attribute for a web `<iframe>`. `allow-same-origin` is absent on purpose. */
  iframeSandbox: string
  /** `referrerpolicy` for the same iframe, so the capability token never leaves. */
  iframeReferrerPolicy: string
  /**
   * True when the artifact origin differs from the API origin. The response
   * enforces an opaque origin through the CSP `sandbox` directive either way;
   * this only tells a client whether it may additionally rely on a real
   * cross origin boundary.
   */
  separateOrigin: boolean
  /** Capabilities the artifact document never gets, in both clients. */
  denies: string[]
}

export interface ArtifactDetail {
  artifact: ArtifactRef
  contentUrl: string
  contentExpiresAt: string
  embed: ArtifactEmbedContract
}

export interface ArtifactContent {
  artifact: Artifact
  body: Buffer
}

export interface ArtifactsServiceOptions {
  db: Database
}

/**
 * Origins allowed to frame an artifact. Defaults to the app itself; set
 * `ARTIFACT_FRAME_ANCESTORS` to a space separated origin list when the web app
 * runs on another origin than the API, and set `ARTIFACT_ORIGIN` when the
 * content is served from a dedicated artifact host.
 */
export function frameAncestors(): string {
  const configured = process.env.ARTIFACT_FRAME_ANCESTORS?.trim()
  return configured && configured.length > 0 ? configured : "'self'"
}

export function artifactOrigin(): string | null {
  const origin = process.env.ARTIFACT_ORIGIN?.trim()
  return origin && /^https?:\/\/[^\s'"]+$/.test(origin) ? origin.replace(/\/+$/, '') : null
}

/**
 * Content Security Policy for artifact bytes.
 *
 * `sandbox allow-scripts` is the load bearing part: it puts the document in an
 * opaque origin even when the embedder forgot the `sandbox` attribute, so the
 * artifact can never reach the app origin, its cookies, its LocalStorage or
 * the access token. `allow-same-origin` is never sent — together with
 * `allow-scripts` it would undo the whole sandbox.
 *
 * `default-src 'none'` plus `connect-src 'none'` plus `form-action 'none'`
 * closes every path back to `/api/*`: no fetch, no XHR, no WebSocket, no form
 * post, no subresource. Inline script and style are allowed because a self
 * contained artifact IS inline; there is nothing else it could load.
 */
export function artifactContentSecurityPolicy(kind: Artifact['kind']): string {
  const directives = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data:",
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

/** Every response header the content route sets, in one testable place. */
export function artifactContentHeaders(artifact: Artifact): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': artifact.kind === 'html' ? 'text/html; charset=utf-8' : artifact.mimeType,
    'Content-Length': String(artifact.size),
    'Content-Security-Policy': artifactContentSecurityPolicy(artifact.kind),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
    // The URL carries a capability token, so no shared cache may keep it.
    'Cache-Control': 'private, no-store, max-age=0',
    // The artifact host may be a different origin than the embedder.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Disposition': `inline; filename="${safeFilename(artifact)}"`,
  }
  // Belt and braces for engines that predate `frame-ancestors`. Only while the
  // policy is the default: X-Frame-Options cannot express an allow list, and
  // an old engine would block a legitimately configured cross-origin embed.
  if (frameAncestors() === "'self'") headers['X-Frame-Options'] = 'SAMEORIGIN'
  return headers
}

function safeFilename(artifact: Artifact): string {
  const ext = artifact.kind === 'html' ? 'html' : artifact.kind === 'svg' ? 'svg' : 'png'
  const base = artifact.title.replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'artifact'
  return `${base}.${ext}`
}

export function createArtifactsService(options: ArtifactsServiceOptions) {
  const { db } = options

  function list(userId: number, query: ListArtifactsQuery): ArtifactRef[] {
    return listArtifacts(db, userId, {
      strandId: query.strandId ?? undefined,
      limit: query.limit,
      offset: query.offset,
    }).map(toArtifactRef)
  }

  function require(userId: number, id: string): Artifact {
    const artifact = getArtifactForUser(db, userId, id)
    // 404 and not 403: a foreign artifact must not be distinguishable from a
    // missing one, otherwise the id space becomes an existence oracle.
    if (!artifact) throw new ArtifactServiceError(404, 'artifact_not_found', 'Artifact not found')
    return artifact
  }

  function detail(userId: number, id: string): ArtifactDetail {
    const artifact = require(userId, id)
    const minted = mintArtifactToken(artifact.id, userId)
    const origin = artifactOrigin() ?? ''
    return {
      artifact: toArtifactRef(artifact),
      contentUrl: `${origin}/api/artifacts/${artifact.id}/content?t=${encodeURIComponent(minted.token)}`,
      contentExpiresAt: minted.expiresAt,
      embed: {
        iframeSandbox: artifact.kind === 'html' ? 'allow-scripts' : '',
        iframeReferrerPolicy: 'no-referrer',
        separateOrigin: origin.length > 0,
        denies: ['same-origin', 'cookies', 'localStorage', 'network', 'top-navigation'],
      },
    }
  }

  function content(userId: number, id: string): ArtifactContent {
    const artifact = require(userId, id)
    const body = readArtifactContent(db, artifact.id)
    if (!body) throw new ArtifactServiceError(410, 'artifact_content_gone', 'Artifact content is no longer stored')
    return { artifact, body }
  }

  return { list, detail, content, require }
}

export type ArtifactsService = ReturnType<typeof createArtifactsService>
