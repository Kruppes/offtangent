import type { Artifact, ArtifactView } from '@axiom/core'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string }

export interface ListArtifactsQuery {
  strandId: string | null
  limit: number
  offset: number
}

const ID_PATTERN = /^[0-9a-fA-F-]{36}$/
const STRAND_ID_MAX = 128

export function parseListArtifactsQuery(query: Record<string, unknown>): ParseResult<ListArtifactsQuery> {
  const rawStrand = query.strandId ?? query.strand_id
  let strandId: string | null = null
  if (rawStrand !== undefined && rawStrand !== null && rawStrand !== '') {
    if (typeof rawStrand !== 'string' || rawStrand.length > STRAND_ID_MAX) {
      return { ok: false, error: 'strandId must be a string', code: 'invalid_strand_id' }
    }
    strandId = rawStrand
  }

  const limit = clampNumber(query.limit, 100, 1, 200)
  if (limit === null) return { ok: false, error: 'limit must be a positive integer', code: 'invalid_limit' }
  const offset = clampNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  if (offset === null) return { ok: false, error: 'offset must be a non-negative integer', code: 'invalid_offset' }

  return { ok: true, value: { strandId, limit, offset } }
}

/**
 * `GET /api/artifacts/views` needs a strand: a view is a property OF a strand
 * (the same key in two strands is two views), and a global list of views has no
 * surface asking for it.
 */
export function parseStrandViewsQuery(query: Record<string, unknown>): ParseResult<{ strandId: string }> {
  const raw = query.strandId ?? query.strand_id
  if (typeof raw !== 'string' || raw === '' || raw.length > STRAND_ID_MAX) {
    return { ok: false, error: 'strandId is required', code: 'invalid_strand_id' }
  }
  return { ok: true, value: { strandId: raw } }
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) return null
  return Math.min(value, max)
}

export function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** The wire shape of an artifact. Identical in the list, the detail and the chat history. */
export interface ArtifactRef {
  id: string
  strandId: string
  messageId: number
  agentId: string | null
  kind: Artifact['kind']
  title: string
  source: Artifact['source']
  mimeType: string
  size: number
  createdAt: string
  /** Living view this artifact belongs to, `null` for a one-off canvas. */
  viewKey: string | null
  /** 1-based revision inside that view, `null` when `viewKey` is null. */
  revision: number | null
  /**
   * Newest revision that exists for the view right now. A card with
   * `revision < latestRevision` is showing an old state and says so — without
   * a second request, which is why this travels on every ref.
   */
  latestRevision: number | null
  /**
   * Half sentence the writing tool attached to this revision (`canvas_write`'s
   * `summary`), `null` when it gave none. This is the text of the one line the
   * chat keeps per canvas update, so it travels with the ref instead of forcing
   * a second request per line.
   */
  note: string | null
}

/** One revision in the history of a view. */
export interface ViewRevisionRef {
  revision: number
  artifactId: string
  messageId: number
  title: string
  createdAt: string
  /** Half sentence of this revision, `null` when the writer gave none. */
  note: string | null
}

/** The wire shape of a living view, as `GET /api/artifacts/views` returns it. */
export interface StrandViewRef {
  viewKey: string
  title: string
  kind: Artifact['kind']
  latestRevision: number
  updatedAt: string
  /** Ascending by revision, so `revisions[revisions.length - 1]` is current. */
  revisions: ViewRevisionRef[]
}

export function toStrandViewRef(view: ArtifactView): StrandViewRef {
  return {
    viewKey: view.viewKey,
    title: view.title,
    kind: view.kind,
    latestRevision: view.latestRevision,
    updatedAt: view.updatedAt,
    revisions: view.revisions.map(artifact => ({
      revision: artifact.revision ?? 0,
      artifactId: artifact.id,
      messageId: artifact.messageId,
      title: artifact.title,
      createdAt: artifact.createdAt,
      note: artifact.note,
    })),
  }
}

export function toArtifactRef(artifact: Artifact): ArtifactRef {
  return {
    id: artifact.id,
    strandId: artifact.strandId,
    messageId: artifact.messageId,
    agentId: artifact.agentId,
    kind: artifact.kind,
    title: artifact.title,
    source: artifact.source,
    mimeType: artifact.mimeType,
    size: artifact.size,
    createdAt: artifact.createdAt,
    viewKey: artifact.viewKey,
    revision: artifact.revision,
    latestRevision: artifact.latestRevision,
    note: artifact.note,
  }
}
