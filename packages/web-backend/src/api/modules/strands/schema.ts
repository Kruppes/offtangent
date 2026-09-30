import { normalizeSessionId, resolveAgentId } from '../../../persona-request.js'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

export function parseFlag(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
}

/**
 * Strict variant of {@link parseFlag} for the filter chips (plan 2026-09-26).
 *
 * `include_archived` may stay lax — a client that sends nonsense there sees
 * one strand too few. A filter that silently falls back to "off" is worse:
 * `?attention=maybe` would answer 200 with the FULL list, and the client would
 * present it as the filtered one. So anything that is not a recognised
 * boolean is a 400.
 */
export function parseStrictFlag(raw: unknown, name: string): ParseResult<boolean> {
  if (raw === undefined || raw === '') return { ok: true, value: false }
  if (typeof raw !== 'string') return { ok: false, error: `${name} must be 0 or 1`, code: `invalid_${name}` }
  const value = raw.toLowerCase()
  if (value === '1' || value === 'true' || value === 'yes') return { ok: true, value: true }
  if (value === '0' || value === 'false' || value === 'no') return { ok: true, value: false }
  return { ok: false, error: `${name} must be 0 or 1`, code: `invalid_${name}` }
}

export interface ListStrandsQuery {
  agentId?: string
  includeArchived: boolean
  limit: number
  offset: number
  projectId?: string | null
  tag?: string
  nowOnly: boolean
  /** `?attention=1`: only strands with an open question. */
  attentionOnly: boolean
  /** `?unread=1`: only strands with unread non-user activity. */
  unreadOnly: boolean
}

export function parseListStrandsQuery(query: Record<string, unknown>): ParseResult<ListStrandsQuery> {
  const rawAgentId = query.agent_id
  const agentId = rawAgentId === undefined || rawAgentId === '' ? undefined : resolveAgentId(rawAgentId)
  if (agentId === null) return { ok: false, error: 'Unknown agent_id', code: 'unknown_agent' }
  const rawLimit = parseInt(String(query.limit ?? ''), 10)
  const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50))
  const rawOffset = parseInt(String(query.offset ?? ''), 10)
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)
  let projectId: string | null | undefined
  if (typeof query.project_id === 'string' && query.project_id !== '') {
    projectId = query.project_id === 'none' ? null : query.project_id
  }
  const tag = typeof query.tag === 'string' && query.tag.trim() ? query.tag.trim().toLowerCase() : undefined
  const attentionOnly = parseStrictFlag(query.attention, 'attention')
  if (!attentionOnly.ok) return attentionOnly
  const unreadOnly = parseStrictFlag(query.unread, 'unread')
  if (!unreadOnly.ok) return unreadOnly
  return {
    ok: true,
    value: {
      agentId,
      includeArchived: parseFlag(query.include_archived),
      limit,
      offset,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(tag ? { tag } : {}),
      nowOnly: parseFlag(query.now),
      attentionOnly: attentionOnly.value,
      unreadOnly: unreadOnly.value,
    },
  }
}

export interface StrandTasksQuery {
  include: 'active' | 'all'
}

/**
 * `?include=active|all` for the strand task tree. Anything else is a 400 — a
 * silently ignored filter would make a client believe it sees everything.
 */
export function parseStrandTasksQuery(query: Record<string, unknown>): ParseResult<StrandTasksQuery> {
  const raw = query.include
  if (raw === undefined || raw === '') return { ok: true, value: { include: 'active' } }
  if (raw === 'active' || raw === 'all') return { ok: true, value: { include: raw } }
  return { ok: false, error: 'include must be "active" or "all"', code: 'invalid_include' }
}

export function parseStrandTagsBody(body: unknown): ParseResult<string[]> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (!Array.isArray(b.tags) || b.tags.some(t => typeof t !== 'string')) {
    return { ok: false, error: 'tags must be an array of strings', code: 'invalid_tags' }
  }
  return { ok: true, value: b.tags as string[] }
}

export function parseNowSetBody(body: unknown): ParseResult<string[]> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (!Array.isArray(b.strandIds)) return { ok: false, error: 'strandIds must be an array', code: 'invalid_strand_ids' }
  const ids: string[] = []
  for (const raw of b.strandIds) {
    const id = normalizeSessionId(raw)
    if (!id) return { ok: false, error: 'strandIds must contain strand ids', code: 'invalid_strand_ids' }
    if (!ids.includes(id)) ids.push(id)
  }
  return { ok: true, value: ids }
}

export interface PatchStrandBody {
  archived?: boolean
  pinned?: boolean
  title?: string | null
}

/**
 * `PATCH /api/strands/:id` (SPEC 6.2): archive/un-archive (the undo of the
 * swipe action), pin and rename. An empty body is refused so a client bug
 * cannot silently "succeed" without changing anything.
 */
export function parsePatchStrandBody(body: unknown): ParseResult<PatchStrandBody> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const value: PatchStrandBody = {}
  if (b.archived !== undefined) {
    if (typeof b.archived !== 'boolean') return { ok: false, error: 'archived must be a boolean', code: 'invalid_archived' }
    value.archived = b.archived
  }
  if (b.pinned !== undefined) {
    if (typeof b.pinned !== 'boolean') return { ok: false, error: 'pinned must be a boolean', code: 'invalid_pinned' }
    value.pinned = b.pinned
  }
  if (b.title !== undefined) {
    if (b.title !== null && typeof b.title !== 'string') {
      return { ok: false, error: 'title must be a string or null', code: 'invalid_title' }
    }
    value.title = b.title as string | null
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, error: 'Nothing to update: pass archived, pinned or title', code: 'empty_patch' }
  }
  return { ok: true, value }
}

export interface PatchStrandModelBody {
  providerId: string | null
  modelId: string | null
}

export function parsePatchStrandModelBody(body: unknown): ParseResult<PatchStrandModelBody> {
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const providerId = value.providerId
  const modelId = value.modelId
  if (providerId === null && modelId === null) return { ok: true, value: { providerId, modelId } }
  if (typeof providerId !== 'string' || !providerId.trim() || typeof modelId !== 'string' || !modelId.trim()) {
    return { ok: false, error: 'providerId and modelId must both be non-empty strings, or both null', code: 'invalid_model_pin' }
  }
  return { ok: true, value: { providerId: providerId.trim(), modelId: modelId.trim() } }
}

export interface DeleteStrandQuery {
  confirm: boolean
  deleteFacts: boolean
}

/**
 * `DELETE /api/strands/:id?confirm=1&delete_facts=0` (SPEC 6.2, 7.5b).
 * `delete_facts` is the second, unchecked box of the confirm modal: facts
 * live above strands (SPEC 2.2), so keeping them is the default.
 */
export function parseDeleteStrandQuery(query: Record<string, unknown>): DeleteStrandQuery {
  return { confirm: parseFlag(query.confirm), deleteFacts: parseFlag(query.delete_facts) }
}

export interface TagBody {
  name?: unknown
  color?: unknown
  archived?: unknown
}

export function parseTagBody(body: unknown): TagBody {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  return {
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.color !== undefined ? { color: b.color } : {}),
    ...(b.archived !== undefined ? { archived: b.archived } : {}),
  }
}

export function parseResurfaceQuery(query: Record<string, unknown>): { limit: number } {
  const rawLimit = parseInt(String(query.limit ?? ''), 10)
  return { limit: Math.min(20, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 5)) }
}

export function parseSnoozeBody(body: unknown): ParseResult<number> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const days = typeof b.days === 'number' ? b.days : Number(b.days)
  if (!Number.isFinite(days) || days < 1 || days > 365) return { ok: false, error: 'days must be between 1 and 365', code: 'invalid_days' }
  return { ok: true, value: Math.trunc(days) }
}
