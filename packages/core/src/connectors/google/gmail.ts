/**
 * Read-only Gmail tools of the Google connector.
 *
 * Both tools are written for a small local model: few parameters, one result
 * line per message, a worked example of the search syntax in the description.
 *
 * Nothing here ever returns an attachment's bytes — an attachment is listed by
 * name, type and size only, so a tool result can never grow to a megabyte of
 * base64 and no file leaves the mailbox.
 */
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { htmlToText } from '../../email-client.js'
import type { ConnectorToolContext } from '../types.js'
import { buildUrl, googleGetJson } from './api.js'
import { toolText, toolError } from './result.js'

/** Hard ceiling on `gmail_search` hits, independent of what the model asks for. */
export const GMAIL_SEARCH_MAX_RESULTS = 20
/** Character cap of one `gmail_read_thread` answer. */
export const GMAIL_THREAD_CAP_CHARS = 8000
/** Longest snippet kept per search hit. */
export const GMAIL_SNIPPET_CHARS = 160
/** A quote block longer than this is replaced by a note. */
export const GMAIL_QUOTE_KEEP_LINES = 2

interface GmailHeader {
  name?: string
  value?: string
}

interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}

interface GmailMessage {
  id?: string
  threadId?: string
  snippet?: string
  internalDate?: string
  payload?: GmailPart
}

interface GmailListResponse {
  messages?: Array<{ id?: string; threadId?: string }>
  resultSizeEstimate?: number
  nextPageToken?: string
}

interface GmailThreadResponse {
  id?: string
  messages?: GmailMessage[]
}

interface GmailProfileResponse {
  emailAddress?: string
  messagesTotal?: number
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const wanted = name.toLowerCase()
  for (const header of headers ?? []) {
    if ((header.name ?? '').toLowerCase() === wanted) return (header.value ?? '').trim()
  }
  return ''
}

/** Separator in front of an embedded `message/rfc822` part. */
export const GMAIL_FORWARD_MARKER = '--- Weitergeleitete Nachricht ---'

export class InvalidBase64UrlError extends Error {
  constructor() {
    super('not valid base64url data')
    this.name = 'InvalidBase64UrlError'
  }
}

/**
 * `Buffer.from(x, 'base64')` silently drops anything it does not understand, so
 * garbage decodes to garbage instead of failing. The alphabet is therefore
 * checked first: a body that is not base64url is a bug or a broken message, not
 * text to hand to a model.
 */
export function decodeBase64UrlBytes(data: string): Buffer {
  if (!data) return Buffer.alloc(0)
  const compact = data.replace(/[\s]/g, '')
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(compact) || compact.length % 4 === 1) throw new InvalidBase64UrlError()
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

/**
 * Decode a part body. The `charset` of the part wins — German business mail is
 * routinely iso-8859-1/-15 or windows-1252, and reading that as UTF-8 destroys
 * every umlaut and every € sign. An unknown label falls back to UTF-8.
 */
export function decodeBase64Url(data: string, charset = 'utf-8'): string {
  const bytes = decodeBase64UrlBytes(data)
  if (bytes.length === 0) return ''
  const wanted = (charset || 'utf-8').trim().toLowerCase()
  try {
    return new TextDecoder(wanted).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** `charset` of a part, from its own `Content-Type` header. */
export function partCharset(part: GmailPart): string {
  const contentType = headerValue(part.headers, 'Content-Type')
  const match = /charset\s*=\s*"?([A-Za-z0-9_.:+-]+)"?/i.exec(contentType)
  return match ? match[1].toLowerCase() : ''
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export interface ThreadAttachment {
  filename: string
  mimeType: string
  size: number
}

interface FlatPart {
  part: GmailPart
  mimeType: string
  forwarded: boolean
}

function flatten(part: GmailPart | undefined, out: FlatPart[] = [], forwarded = false): FlatPart[] {
  if (!part) return out
  const mimeType = (part.mimeType ?? '').toLowerCase()
  out.push({ part, mimeType, forwarded })
  const childForwarded = forwarded || mimeType === 'message/rfc822'
  for (const child of part.parts ?? []) flatten(child, out, childForwarded)
  return out
}

/**
 * Join decoded part texts, marking where an embedded forwarded message starts.
 * Without the marker a forward reads as if the quoted mail were the sender's
 * own text.
 */
function joinParts(entries: Array<{ text: string; forwarded: boolean }>): string {
  const out: string[] = []
  let marked = false
  for (const entry of entries) {
    if (entry.forwarded && !marked) {
      out.push(GMAIL_FORWARD_MARKER)
      marked = true
    }
    out.push(entry.text)
  }
  return out.join('\n')
}

function decodePart(entry: FlatPart): { text: string; forwarded: boolean } {
  try {
    return {
      text: decodeBase64Url(entry.part.body?.data ?? '', partCharset(entry.part)),
      forwarded: entry.forwarded,
    }
  } catch {
    return { text: '[unreadable part: the body is not valid base64url]', forwarded: entry.forwarded }
  }
}

/**
 * Body of one message as plain text.
 *
 * `text/plain` wins; only when a message carries no plain part at all is the
 * HTML alternative converted (`htmlToText` from the mail module, so both paths
 * behave the same). A `multipart/*` container has no body of its own.
 */
export function messageBodyText(message: GmailMessage): string {
  const parts = flatten(message.payload)
  const usable = parts.filter(entry => !entry.part.filename && entry.part.body?.data)

  const plain = joinParts(usable.filter(entry => entry.mimeType === 'text/plain').map(decodePart)).trim()
  if (plain) return plain

  const html = joinParts(usable.filter(entry => entry.mimeType === 'text/html').map(decodePart))
  if (html.trim()) return htmlToText(html)

  // Neither type present: a single-part message without a declared mime type.
  return joinParts(usable.filter(entry => !entry.mimeType.startsWith('multipart/')).map(decodePart)).trim()
}

export function messageAttachments(message: GmailMessage): ThreadAttachment[] {
  return flatten(message.payload)
    .filter(entry => (entry.part.filename ?? '').length > 0)
    .map(entry => ({
      filename: entry.part.filename ?? '',
      mimeType: entry.mimeType || 'application/octet-stream',
      size: entry.part.body?.size ?? 0,
    }))
}

/** Replaces an attribution line ("On … wrote:") in the shortened body. */
export const GMAIL_ATTRIBUTION_MARKER = '[quoted message header omitted]'

const ATTRIBUTION = /^\s*(?:>*\s*)?(?:On .{0,300}? wrote:|Am .{0,300}? schrieb.{0,120}?:|-{2,}\s*Original Message\s*-{2,}|-{2,}\s*Urspr(?:ü|ue)ngliche Nachricht\s*-{2,})\s*$/i

/**
 * How many lines starting at `index` form one attribution. Gmail wraps a long
 * attribution across up to three lines (`… Alice Example <\nalice@example.com>
 * wrote:`), so the joined window is tried as well.
 */
export function attributionSpan(lines: string[], index: number): number {
  for (let span = 1; span <= 3; span += 1) {
    if (index + span > lines.length) break
    const window = lines.slice(index, index + span)
    if (span > 1 && window.slice(0, -1).some(line => /^\s*$/.test(line))) break
    if (ATTRIBUTION.test(window.join(' ').replace(/\s+/g, ' '))) return span
  }
  return 0
}

/**
 * Shorten quoted history: a run of quoted (`>`) lines keeps its first
 * {@link GMAIL_QUOTE_KEEP_LINES} lines, the rest becomes a count. An
 * attribution line is replaced by a marker.
 *
 * Nothing else is dropped. Cutting everything after the attribution deletes the
 * answer of a bottom-posting writer — exactly the sentence the question was
 * about.
 */
export function trimQuotes(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let quoted = 0

  const flush = (): void => {
    if (quoted > GMAIL_QUOTE_KEEP_LINES) {
      out.push(`[quoted text shortened: ${quoted - GMAIL_QUOTE_KEEP_LINES} more lines]`)
    }
    quoted = 0
  }

  for (let index = 0; index < lines.length; index += 1) {
    const span = attributionSpan(lines, index)
    if (span > 0) {
      flush()
      out.push(GMAIL_ATTRIBUTION_MARKER)
      index += span - 1
      continue
    }
    const line = lines[index]
    if (/^\s*>/.test(line)) {
      quoted += 1
      if (quoted <= GMAIL_QUOTE_KEEP_LINES) out.push(line.trim())
      continue
    }
    flush()
    out.push(line)
  }
  flush()

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function capText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false }
  return {
    text: `${text.slice(0, cap)}\n[cut off: the thread is longer than ${cap} characters. Ask for a single message or a narrower question.]`,
    truncated: true,
  }
}

export interface GmailToolOptions {
  ctx: ConnectorToolContext
  baseUrl: string
  /** Formats an instant for the answer; injected so tests stay timezone-stable. */
  formatDate: (value: string) => string
  counters?: { refreshes: number }
}

function searchLine(message: GmailMessage, formatDate: (value: string) => string): string {
  const headers = message.payload?.headers
  const date = headerValue(headers, 'Date')
  const from = headerValue(headers, 'From')
  const subject = headerValue(headers, 'Subject')
  return [
    `thread=${message.threadId ?? ''}`,
    formatDate(date || message.internalDate || ''),
    from || '(no sender)',
    subject || '(no subject)',
    oneLine(message.snippet ?? '', GMAIL_SNIPPET_CHARS),
  ].join(' | ')
}

export function createGmailSearchTool(options: GmailToolOptions): AgentTool {
  const { ctx, baseUrl, formatDate, counters } = options
  return {
    name: 'gmail_search',
    label: 'Search mail',
    description: [
      'Search the mailbox with Gmail search syntax and return one line per hit:',
      'thread id, date, sender, subject, snippet.',
      'Example: `from:alice@example.com after:2026/09/20 has:attachment`.',
      'Useful operators: from:, to:, subject:, newer_than:2d, after:YYYY/MM/DD, is:unread, has:attachment, label:.',
      'Use the returned thread id with gmail_read_thread to read the full text.',
    ].join(' '),
    parameters: Type.Object({
      query: Type.String({
        description: 'Gmail search query, e.g. "from:alice@example.com newer_than:2d".',
      }),
      limit: Type.Optional(Type.Number({
        description: `How many hits at most (1-${GMAIL_SEARCH_MAX_RESULTS}, default 10).`,
      })),
    }),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const raw = (params ?? {}) as { query?: unknown; limit?: unknown }
      const query = typeof raw.query === 'string' ? raw.query.trim() : ''
      if (!query) return toolError('`query` is required, e.g. "from:alice@example.com newer_than:2d".')
      const requested = typeof raw.limit === 'number' && Number.isFinite(raw.limit) ? Math.floor(raw.limit) : 10
      const limit = Math.min(Math.max(requested, 1), GMAIL_SEARCH_MAX_RESULTS)

      try {
        const list = await googleGetJson<GmailListResponse>(
          ctx,
          buildUrl(baseUrl, 'users/me/messages', { q: query, maxResults: limit }),
          counters,
          signal,
        )
        const ids = (list.messages ?? []).map(entry => entry.id ?? '').filter(Boolean).slice(0, limit)
        if (ids.length === 0) return toolText(`No message matches "${query}".`, { hits: 0 })

        const lines: string[] = []
        for (const id of ids) {
          const message = await googleGetJson<GmailMessage>(
            ctx,
            buildUrl(baseUrl, `users/me/messages/${encodeURIComponent(id)}`, {
              format: 'metadata',
              metadataHeaders: ['From', 'Subject', 'Date'],
            }),
            counters,
            signal,
          )
          lines.push(searchLine(message, formatDate))
        }
        // Completeness: a model that sees 10 of 4000 hits must not answer "that
        // is all there is". The estimate and the paging flag say so explicitly.
        const estimate = typeof list.resultSizeEstimate === 'number' ? list.resultSizeEstimate : 0
        const more = Boolean(list.nextPageToken) || estimate > lines.length
        const note = more
          ? ` Es gibt weitere Treffer (geschätzt ca. ${Math.max(estimate, lines.length)} insgesamt) — Suche eingrenzen.`
          : ''
        return toolText(
          [
            `${lines.length} hit(s) for "${query}" (thread | date | from | subject | snippet).${note}`,
            ...lines,
          ].join('\n'),
          { hits: lines.length, resultSizeEstimate: estimate, moreAvailable: more },
        )
      } catch (err) {
        return toolError(err)
      }
    },
  } as AgentTool
}

export function createGmailReadThreadTool(options: GmailToolOptions): AgentTool {
  const { ctx, baseUrl, formatDate, counters } = options
  return {
    name: 'gmail_read_thread',
    label: 'Read mail thread',
    description: [
      'Read the plain text of every message in one mail thread.',
      'Needs the thread id from gmail_search, e.g. `gmail_read_thread(threadId: "18f2c…")`.',
      'Quoted history is shortened, attachments are listed by name, type and size only (no download),',
      `and the answer is cut at ${GMAIL_THREAD_CAP_CHARS} characters.`,
    ].join(' '),
    parameters: Type.Object({
      threadId: Type.String({ description: 'Thread id as returned by gmail_search (field `thread=`).' }),
    }),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const raw = (params ?? {}) as { threadId?: unknown }
      const threadId = typeof raw.threadId === 'string' ? raw.threadId.trim() : ''
      if (!threadId) return toolError('`threadId` is required — take it from a gmail_search hit.')

      try {
        const thread = await googleGetJson<GmailThreadResponse>(
          ctx,
          buildUrl(baseUrl, `users/me/threads/${encodeURIComponent(threadId)}`, { format: 'full' }),
          counters,
          signal,
        )
        const messages = thread.messages ?? []
        if (messages.length === 0) return toolText(`Thread "${threadId}" has no messages.`, { messages: 0 })

        const blocks: string[] = []
        for (const [index, message] of messages.entries()) {
          const headers = message.payload?.headers
          const attachments = messageAttachments(message)
          const head = [
            `--- message ${index + 1}/${messages.length} ---`,
            `date: ${formatDate(headerValue(headers, 'Date') || message.internalDate || '')}`,
            `from: ${headerValue(headers, 'From') || '(no sender)'}`,
            `to: ${headerValue(headers, 'To') || '(no recipient)'}`,
            `subject: ${headerValue(headers, 'Subject') || '(no subject)'}`,
          ]
          if (attachments.length > 0) {
            head.push(`attachments: ${attachments.map(a => `${a.filename} (${a.mimeType}, ${a.size} bytes)`).join('; ')}`)
          }
          blocks.push([...head, '', trimQuotes(messageBodyText(message)) || '(no text body)'].join('\n'))
        }

        const capped = capText(blocks.join('\n\n'), GMAIL_THREAD_CAP_CHARS)
        return toolText(capped.text, { messages: messages.length, truncated: capped.truncated })
      } catch (err) {
        return toolError(err)
      }
    },
  } as AgentTool
}

export interface GmailProfileSummary {
  emailAddress: string
  messagesTotal: number
}

/** Cheap liveness probe: the profile of the connected mailbox, nothing else. */
export async function fetchGmailProfile(
  ctx: ConnectorToolContext,
  baseUrl: string,
): Promise<GmailProfileSummary> {
  const profile = await googleGetJson<GmailProfileResponse>(ctx, buildUrl(baseUrl, 'users/me/profile'))
  return {
    emailAddress: profile.emailAddress ?? '',
    messagesTotal: typeof profile.messagesTotal === 'number' ? profile.messagesTotal : 0,
  }
}
