import { parseContextWindowChoice } from '@axiom/core'
import { normalizeSessionId, resolveAgentId } from '../../../persona-request.js'
import { STRAND_SEARCH_MAX_LENGTH, STRAND_SEARCH_MIN_LENGTH } from './search.js'

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
  /** `?q=`: search in title and message content (2..200 characters, trimmed). */
  q?: string
}

/**
 * `?q=` of the strand search. Absent or blank means "no search". Anything that
 * is not a single string, shorter than 2 or longer than 200 characters after
 * trimming is a 400 — a silently dropped search would show the full list as
 * if it were the result.
 */
export function parseSearchQuery(raw: unknown): ParseResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, error: 'q must be a single string', code: 'invalid_q' }
  const value = raw.trim()
  if (value === '') return { ok: true, value: undefined }
  const length = [...value].length
  if (length < STRAND_SEARCH_MIN_LENGTH || length > STRAND_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `q must be ${STRAND_SEARCH_MIN_LENGTH} to ${STRAND_SEARCH_MAX_LENGTH} characters`, code: 'invalid_q' }
  }
  return { ok: true, value }
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
  const q = parseSearchQuery(query.q)
  if (!q.ok) return q
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
      ...(q.value ? { q: q.value } : {}),
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

/** Body of `POST /api/strands/:id/activity/dismiss|undismiss` (W6c). */
export interface StrandActivityIdsBody {
  ids: string[]
}

/** Same cap as the task tree's node cap (`MAX_TASK_TREE_NODES`). */
export const MAX_ACTIVITY_IDS = 200

/**
 * `{ ids: string[] }`, 1..200 distinct non-empty task ids of at most 200
 * characters each. Anything else is a 400; duplicates collapse.
 */
export function parseStrandActivityIdsBody(body: unknown): ParseResult<StrandActivityIdsBody> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const ids = b.ids
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ACTIVITY_IDS) {
    return { ok: false, error: `ids must be an array of 1 to ${MAX_ACTIVITY_IDS} task ids`, code: 'invalid_ids' }
  }
  if (ids.some(id => typeof id !== 'string' || id.trim() === '' || id.length > 200)) {
    return { ok: false, error: 'every id must be a non-empty string of at most 200 characters', code: 'invalid_ids' }
  }
  return { ok: true, value: { ids: [...new Set(ids as string[])] } }
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

export interface PatchStrandEcoBody {
  enabled?: boolean
  /** Per-strand context window: null = "Unverändert", else a preset. Absent = unchanged. */
  contextWindow?: number | null
}

/**
 * `PATCH /api/strands/:id/eco` — `{ enabled?: boolean, contextWindow?: number | null }`,
 * at least one field, nothing coerced. `{ enabled }` alone stays valid (backward compatible).
 */
export function parsePatchStrandEcoBody(body: unknown): ParseResult<PatchStrandEcoBody> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be an object { enabled?: boolean, contextWindow?: number | null }', code: 'invalid_eco' }
  }
  const value = body as Record<string, unknown>
  const extra = Object.keys(value).filter(k => k !== 'enabled' && k !== 'contextWindow')
  const hasEnabled = 'enabled' in value
  const hasWindow = 'contextWindow' in value
  if (extra.length > 0 || (!hasEnabled && !hasWindow) || (hasEnabled && typeof value.enabled !== 'boolean')) {
    return { ok: false, error: 'enabled must be a boolean; only enabled and contextWindow are allowed', code: 'invalid_eco' }
  }
  const out: PatchStrandEcoBody = {}
  if (hasEnabled) out.enabled = value.enabled as boolean
  if (hasWindow) {
    const parsed = parseContextWindowChoice(value.contextWindow)
    if (!parsed.ok) return { ok: false, error: parsed.error, code: 'invalid_context_window' }
    out.contextWindow = parsed.value
  }
  return { ok: true, value: out }
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

/** Longest title a web fork may set; the core cap of `fork_strand`. */
export const FORK_BODY_TITLE_MAX = 80

/**
 * Body of `POST /api/strands/:id/fork` (W5b): `{ messageId, title? }`.
 * `messageId` is a positive integer (a JSON number; a numeric string is not
 * accepted, the clients send numbers). `title` is optional, trimmed, 1..80
 * characters; blank means "derive it from the message".
 */
export function parseForkBody(raw: unknown): ParseResult<{ messageId: number; title?: string }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Body must be a JSON object', code: 'invalid_body' }
  }
  const body = raw as Record<string, unknown>
  const id = body.messageId
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, error: 'messageId must be a positive integer', code: 'invalid_message_id' }
  }
  if (body.title === undefined || body.title === null) return { ok: true, value: { messageId: id } }
  if (typeof body.title !== 'string') return { ok: false, error: 'title must be a string', code: 'invalid_title' }
  const title = body.title.replace(/\s+/g, ' ').trim()
  if (title === '') return { ok: true, value: { messageId: id } }
  if ([...title].length > FORK_BODY_TITLE_MAX) {
    return { ok: false, error: `title must be at most ${FORK_BODY_TITLE_MAX} characters`, code: 'invalid_title' }
  }
  return { ok: true, value: { messageId: id, title } }
}
