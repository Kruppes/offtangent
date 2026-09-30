/**
 * Canvas artifacts (SPEC 7.4b, R2). Reads only: artifacts are written by the
 * server side extraction in `@axiom/core` when an assistant message is
 * persisted, never by a client.
 *
 * The security model of the content route lives in `sandboxed-document.ts`,
 * shared with the `html_view.v1` board route: an Android WebView and a web
 * `<iframe>` get byte identical headers for both features, so the guarantee
 * cannot drift between the two clients or between the two features.
 */
import type { Artifact, Database } from '@axiom/core'
import { getArtifactForUser, listArtifacts, listStrandViews, readArtifactContent } from '@axiom/core'
import { mintArtifactToken } from '../../../artifact-token.js'
import {
  frameAncestors as sharedFrameAncestors,
  safeContentFilename,
  sandboxEmbedContract,
  sandboxedContentHeaders,
  sandboxedContentOrigin,
  sandboxedContentSecurityPolicy,
  type SandboxEmbedContract,
} from '../../../sandboxed-document.js'
import { toArtifactRef, toStrandViewRef } from './schema.js'
import type { ArtifactRef, ListArtifactsQuery, StrandViewRef } from './schema.js'

export class ArtifactServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ArtifactServiceError'
  }
}

export type ArtifactEmbedContract = SandboxEmbedContract

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

/** @see sandboxed-document.ts — shared with the `html_view.v1` board route. */
export const frameAncestors = sharedFrameAncestors

export const artifactOrigin = sandboxedContentOrigin

export function artifactContentSecurityPolicy(kind: Artifact['kind']): string {
  return sandboxedContentSecurityPolicy(kind === 'html' ? 'html' : 'data')
}

/** Every response header the content route sets, in one testable place. */
export function artifactContentHeaders(artifact: Artifact): Record<string, string> {
  return sandboxedContentHeaders({
    kind: artifact.kind === 'html' ? 'html' : 'data',
    contentType: artifact.kind === 'html' ? 'text/html; charset=utf-8' : artifact.mimeType,
    byteLength: artifact.size,
    filename: safeContentFilename(artifact.title, artifactExtension(artifact.kind), 'artifact'),
  })
}

function artifactExtension(kind: Artifact['kind']): string {
  return kind === 'html' ? 'html' : kind === 'svg' ? 'svg' : 'png'
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

  /**
   * The living views of one strand. No bytes and no tokens: a client picks a
   * revision and then goes through `detail` for that artifact id, so the
   * capability tokens stay as short lived as they are for any other canvas.
   */
  function views(userId: number, query: { strandId: string }): StrandViewRef[] {
    return listStrandViews(db, userId, query.strandId).map(toStrandViewRef)
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
      embed: sandboxEmbedContract(artifact.kind === 'html' ? 'html' : 'data', origin.length > 0),
    }
  }

  function content(userId: number, id: string): ArtifactContent {
    const artifact = require(userId, id)
    const body = readArtifactContent(db, artifact.id)
    if (!body) throw new ArtifactServiceError(410, 'artifact_content_gone', 'Artifact content is no longer stored')
    return { artifact, body }
  }

  return { list, views, detail, content, require }
}

export type ArtifactsService = ReturnType<typeof createArtifactsService>
