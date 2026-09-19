import type { Artifact } from '@axiom/core'

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
  }
}
