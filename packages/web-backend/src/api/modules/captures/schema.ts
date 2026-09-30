import type { CaptureKind, CaptureStatus, ModelSelection, RouterAction, RouterIntent, UploadDescriptor } from '@axiom/core'
import { parseTurnModelSelection } from '../../../model-selection.js'
import { normalizeClientMessageId, normalizeSessionId, resolveAgentId } from '../../../persona-request.js'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

const CAPTURE_KINDS: CaptureKind[] = ['text', 'voice', 'image', 'file']
const CAPTURE_STATUSES: Array<CaptureStatus | 'all'> = ['pending', 'filed', 'needs_review', 'unsorted', 'moved', 'failed', 'dismissed', 'all']
const CAPTURE_TEXT_MAX = 20000
const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * Capture modes a client may ask for (U10a).
 *
 * The two names come from the device that sends them: puck firmware 0.9.0
 * writes `mode: "work"` or `mode: "quick"` into every capture body
 * (`cfg_mode_key`, log line `PUCK|CAPTURE|MODE`). `work` is the behaviour that
 * always shipped — router, strand choice, the persona's own model — and is
 * therefore also what a missing field means, so every older client keeps
 * working unchanged.
 *
 * `quick` says: this is a short spoken question. It changes HOW the turn is
 * run (configured model, turn-local thinking level, spoken-answer style) and,
 * when no strand is named, WHERE it goes (one strand per source instead of a
 * router call). The mode is a request, not a privilege — everything it does is
 * either the user's own setting or a strand the server itself created.
 *
 * `assist` (puck assist waves, W1) says: the answer contains something I want
 * to TYPE somewhere. It changes only the style instruction of the turn — short
 * prose, at most one question, the typable text in exactly one `draft` block —
 * and nothing else: no model pin, no thinking level, and above all no fixed
 * strand, because an assisted request is ordinary work that the router files
 * like any other capture.
 */
export const CAPTURE_MODES = ['work', 'quick', 'assist'] as const
export type CaptureMode = (typeof CAPTURE_MODES)[number]

export interface CreateCaptureBody {
  text: string
  clientMessageId: string | null
  agentId: string | null
  strandId: string | null
  kind: CaptureKind
  source: string
  attachments: UploadDescriptor[]
  intent: RouterIntent | null
  mode: CaptureMode
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

  const mode = b.mode === undefined || b.mode === null || b.mode === '' ? 'work' : b.mode
  if (typeof mode !== 'string' || !(CAPTURE_MODES as readonly string[]).includes(mode)) {
    return { ok: false, error: `mode must be one of ${CAPTURE_MODES.join(', ')}`, code: 'invalid_mode' }
  }

  const selection = parseTurnModelSelection(b)
  if (!selection.ok) return selection

  return {
    ok: true,
    value: { turnOverride: selection.value, text, clientMessageId: clientMessageId ?? null, agentId, strandId: strandId ?? null, kind: kind as CaptureKind, source, attachments, intent, mode: mode as CaptureMode },
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
  /**
   * Topic part of a split capture (split-on-intake). Absent means part 0,
   * which is the whole capture for everything that was not split, so a client
   * that never sends the field keeps its old behaviour.
   */
  partIndex: number | null
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
  const partIndex = parsePartIndex(b.partIndex)
  if (partIndex === undefined) return { ok: false, error: 'partIndex must be a non-negative integer', code: 'invalid_part_index' }
  return { ok: true, value: { decisionId, action, strandId: strandId ?? null, title: title || null, personaId, partIndex } }
}

/**
 * A `partIndex` field: a non-negative integer, or null when it is absent.
 * `undefined` means the value was there but unusable.
 */
function parsePartIndex(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value < 0) return undefined
  return value
}

export interface UndoCaptureBody {
  strandId: string | null
  /**
   * Which part to undo. Absent on a split capture undoes EVERY part and puts
   * the whole capture back in the tray, which is what the undo button of the
   * card means.
   */
  partIndex: number | null
}

export function parseUndoCaptureBody(body: unknown): ParseResult<UndoCaptureBody> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const strandId = normalizeSessionId(b.strandId)
  if (strandId === null) return { ok: false, error: 'Invalid strandId', code: 'invalid_strand' }
  const partIndex = parsePartIndex(b.partIndex)
  if (partIndex === undefined) return { ok: false, error: 'partIndex must be a non-negative integer', code: 'invalid_part_index' }
  return { ok: true, value: { strandId: strandId ?? null, partIndex } }
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
