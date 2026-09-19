import type { CaptureKind, CaptureStatus, ModelSelection, RouterAction, RouterIntent, UploadDescriptor } from '@axiom/core'
import { parseTurnModelSelection } from '../../../model-selection.js'
import { normalizeClientMessageId, normalizeSessionId, resolveAgentId } from '../../../persona-request.js'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

const CAPTURE_KINDS: CaptureKind[] = ['text', 'voice', 'image', 'file']
const CAPTURE_STATUSES: Array<CaptureStatus | 'all'> = ['pending', 'filed', 'needs_review', 'unsorted', 'moved', 'failed', 'dismissed', 'all']
const CAPTURE_TEXT_MAX = 20000
const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

export interface CreateCaptureBody {
  text: string
  clientMessageId: string | null
  agentId: string | null
  strandId: string | null
  kind: CaptureKind
  source: string
  attachments: UploadDescriptor[]
  intent: RouterIntent | null
  turnOverride?: ModelSelection
}

function parseAttachments(raw: unknown): UploadDescriptor[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return null
  const out: UploadDescriptor[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const d = item as Record<string, unknown>
    if (typeof d.storedName !== 'string' || typeof d.urlPath !== 'string' || typeof d.relativePath !== 'string') return null
    out.push(item as UploadDescriptor)
  }
  return out
}

export function parseCreateCaptureBody(body: unknown): ParseResult<CreateCaptureBody> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) return { ok: false, error: 'text is required', code: 'text_empty' }
  if (text.length > CAPTURE_TEXT_MAX) return { ok: false, error: `text must be at most ${CAPTURE_TEXT_MAX} characters`, code: 'text_too_long' }

  const clientMessageId = normalizeClientMessageId(b.clientMessageId)
  if (clientMessageId === null) return { ok: false, error: 'Invalid clientMessageId', code: 'invalid_client_message_id' }

  // A persona hint is optional and, unlike the chat endpoints, absent means
  // "let the router pick", not 'main'.
  let agentId: string | null = null
  if (b.agentId !== undefined && b.agentId !== null && b.agentId !== '') {
    const resolved = resolveAgentId(b.agentId)
    if (resolved === null) return { ok: false, error: 'Unknown agentId', code: 'unknown_agent' }
    agentId = resolved
  }

  const strandId = normalizeSessionId(b.strandId)
  if (strandId === null) return { ok: false, error: 'Invalid strandId', code: 'invalid_strand' }

  const kind = b.kind === undefined ? 'text' : b.kind
  if (!CAPTURE_KINDS.includes(kind as CaptureKind)) return { ok: false, error: 'Invalid kind', code: 'invalid_kind' }

  const source = b.source === undefined ? 'web' : b.source
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) return { ok: false, error: 'Invalid source', code: 'invalid_source' }

  const attachments = parseAttachments(b.attachments)
  if (attachments === null) return { ok: false, error: 'attachments must be an array of upload descriptors', code: 'invalid_attachments' }

  let intent: RouterIntent | null = null
  if (b.intent !== undefined && b.intent !== null) {
    if (b.intent !== 'note' && b.intent !== 'ask') return { ok: false, error: 'intent must be note or ask', code: 'invalid_intent' }
    intent = b.intent
  }

  const selection = parseTurnModelSelection(b)
  if (!selection.ok) return selection

  return {
    ok: true,
    value: { turnOverride: selection.value, text, clientMessageId: clientMessageId ?? null, agentId, strandId: strandId ?? null, kind: kind as CaptureKind, source, attachments, intent },
  }
}

export interface ListCapturesQuery {
  status: CaptureStatus | 'all'
  limit: number
  offset: number
}

export function parseListCapturesQuery(query: Record<string, unknown>): ParseResult<ListCapturesQuery> {
  const status = query.status === undefined || query.status === '' ? 'all' : query.status
  if (!CAPTURE_STATUSES.includes(status as CaptureStatus | 'all')) return { ok: false, error: 'Invalid status', code: 'invalid_status' }
  const rawLimit = parseInt(String(query.limit ?? ''), 10)
  const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50))
  const rawOffset = parseInt(String(query.offset ?? ''), 10)
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)
  return { ok: true, value: { status: status as CaptureStatus | 'all', limit, offset } }
}

export interface ApplyCaptureBody {
  decisionId: string | null
  action: RouterAction | null
  strandId: string | null
  title: string | null
  personaId: string | null
}

export function parseApplyCaptureBody(body: unknown): ParseResult<ApplyCaptureBody> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const decisionId = typeof b.decisionId === 'string' && b.decisionId ? b.decisionId : null
  let action: RouterAction | null = null
  if (b.action !== undefined && b.action !== null) {
    if (b.action !== 'append' && b.action !== 'new_strand' && b.action !== 'link') return { ok: false, error: 'Invalid action', code: 'invalid_action' }
    action = b.action
  }
  const strandId = normalizeSessionId(b.strandId)
  if (strandId === null) return { ok: false, error: 'Invalid strandId', code: 'invalid_strand' }
  const title = typeof b.title === 'string' ? b.title.trim() : null
  let personaId: string | null = null
  if (b.personaId !== undefined && b.personaId !== null && b.personaId !== '') {
    const resolved = resolveAgentId(b.personaId)
    if (resolved === null) return { ok: false, error: 'Unknown personaId', code: 'unknown_agent' }
    personaId = resolved
  }
  if (action === 'append' && !strandId) return { ok: false, error: 'append requires strandId', code: 'invalid_strand' }
  if (action === 'link' && !strandId) return { ok: false, error: 'link requires strandId', code: 'invalid_strand' }
  return { ok: true, value: { decisionId, action, strandId: strandId ?? null, title: title || null, personaId } }
}

export interface UndoCaptureBody {
  strandId: string | null
}

export function parseUndoCaptureBody(body: unknown): ParseResult<UndoCaptureBody> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const strandId = normalizeSessionId(b.strandId)
  if (strandId === null) return { ok: false, error: 'Invalid strandId', code: 'invalid_strand' }
  return { ok: true, value: { strandId: strandId ?? null } }
}

export interface RouterPreviewBody {
  text: string
  agentId: string | null
}

export function parseRouterPreviewBody(body: unknown): ParseResult<RouterPreviewBody> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) return { ok: false, error: 'text is required', code: 'text_empty' }
  let agentId: string | null = null
  if (b.agentId !== undefined && b.agentId !== null && b.agentId !== '') {
    const resolved = resolveAgentId(b.agentId)
    if (resolved === null) return { ok: false, error: 'Unknown agentId', code: 'unknown_agent' }
    agentId = resolved
  }
  return { ok: true, value: { text, agentId } }
}
