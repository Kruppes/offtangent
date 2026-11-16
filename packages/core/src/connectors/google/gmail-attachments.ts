/**
 * Read-only attachment tools of the Google connector.
 *
 * `gmail_list_attachments` lists the files of a thread or message;
 * `gmail_read_attachment` downloads ONE of them (`users.messages.attachments.get`,
 * covered by `gmail.readonly`) and hands its text to the local sub-agent.
 *
 * Privacy (ADR 2026-09-26, data class `local_only`): the bytes and the
 * extracted text exist only in this process and in the tool result, i.e. the
 * transcript of the local model. Nothing is written to disk, logged, or put
 * into `details` (which carries metadata only). There is deliberately no
 * "save to workspace" mode: a file in the workspace is readable by the cloud
 * main agent, which would be a second way out besides the sub-agent's answer.
 *
 * Limits: a declared size above {@link ATTACHMENT_MAX_BYTES} is refused before
 * any download, and the download itself is a bounded stream that is dropped
 * past the limit (the declared size may be missing or wrong). The text is cut
 * to a window of {@link ATTACHMENT_TEXT_CAP_CHARS} characters and
 * {@link ATTACHMENT_CALL_TOKENS} estimated tokens per call, and one run gets at
 * most {@link ATTACHMENT_RUN_BUDGET_TOKENS} estimated tokens of attachment
 * text in total, so paging through a long PDF cannot fill the local model's
 * context and block the shared runner.
 */
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  ATTACHMENT_CALL_TOKENS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_RUN_BUDGET_TOKENS,
  ATTACHMENT_TEXT_CAP_CHARS,
  estimateTokens,
  prefixWithinTokens,
  PDF_MAX_PAGES,
  attachmentFormat,
  extractAttachmentText,
  isReadableFormat,
} from '../attachment-text.js'
import type { AttachmentTextResult, ExtractOptions } from '../attachment-text.js'
import { GoogleApiError, buildUrl, googleGetJson } from './api.js'
import {
  GMAIL_MESSAGE_MAX_RESPONSE_BYTES,
  GMAIL_THREAD_MAX_RESPONSE_BYTES,
  attachmentParts,
  decodeBase64UrlBytes,
  partCharset,
} from './gmail.js'
import type { GmailMessage, GmailPart, GmailThreadResponse, GmailToolOptions, ThreadAttachment } from './gmail.js'
import { toolError, toolText } from './result.js'

/** Most attachments listed per call. */
export const GMAIL_ATTACHMENT_LIST_MAX = 40

interface GmailAttachmentResponse {
  size?: number
  data?: string
}

export interface GmailAttachmentToolOptions extends GmailToolOptions {
  /** Test seam for the local extractor (binary paths, timeout). */
  extractor?: Pick<ExtractOptions, 'pdftotextBin' | 'pdfinfoBin' | 'timeoutMs'>
  /**
   * Estimated tokens of attachment text this tool instance hands out in total.
   * The manifest builds the tools once per sub-agent run, so this is a
   * per-run budget. Default {@link ATTACHMENT_RUN_BUDGET_TOKENS}.
   */
  runBudgetTokens?: number
}

/**
 * Bound for the JSON body of `attachments.get`: base64url of the byte limit
 * plus room for the envelope. Crossing it drops the stream mid-download.
 */
export const ATTACHMENT_MAX_RESPONSE_BYTES = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 + 64 * 1024

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

const MAX_MB = Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))

/** What the read tool will do with this attachment, for the listing. */
function readability(attachment: ThreadAttachment): string {
  if (attachment.size > ATTACHMENT_MAX_BYTES) return `too large (limit ${MAX_MB} MB), not readable`
  const format = attachmentFormat(attachment.mimeType, attachment.filename)
  return isReadableFormat(format) ? `readable as ${format}` : 'metadata only (format is not read)'
}

async function fetchMessage(
  options: GmailToolOptions,
  messageId: string,
  signal?: AbortSignal,
): Promise<GmailMessage> {
  return googleGetJson<GmailMessage>(
    options.ctx,
    buildUrl(options.baseUrl, `users/me/messages/${encodeURIComponent(messageId)}`, { format: 'full' }),
    options.counters,
    signal,
    { maxBodyBytes: GMAIL_MESSAGE_MAX_RESPONSE_BYTES },
  )
}

export function createGmailListAttachmentsTool(options: GmailToolOptions): AgentTool {
  const { ctx, baseUrl, counters } = options
  return {
    name: 'gmail_list_attachments',
    label: 'List mail attachments',
    description: [
      'List the attachments of one thread (threadId from gmail_search) or one message (messageId from gmail_read_thread):',
      'message id, part id, file name, type, size and whether gmail_read_attachment can read it as text.',
      'Nothing is downloaded.',
    ].join(' '),
    parameters: Type.Object({
      threadId: Type.Optional(Type.String({ description: 'Thread id as returned by gmail_search.' })),
      messageId: Type.Optional(Type.String({ description: 'Message id as shown by gmail_read_thread (`message id:`).' })),
    }),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const raw = (params ?? {}) as { threadId?: unknown; messageId?: unknown }
      const threadId = typeof raw.threadId === 'string' ? raw.threadId.trim() : ''
      const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : ''
      if (!threadId && !messageId) return toolError('`threadId` or `messageId` is required.')

      try {
        let messages: GmailMessage[]
        if (messageId) {
          messages = [await fetchMessage(options, messageId, signal)]
        } else {
          const thread = await googleGetJson<GmailThreadResponse>(
            ctx,
            buildUrl(baseUrl, `users/me/threads/${encodeURIComponent(threadId)}`, { format: 'full' }),
            counters,
            signal,
            { maxBodyBytes: GMAIL_THREAD_MAX_RESPONSE_BYTES },
          )
          messages = thread.messages ?? []
        }

        const lines: string[] = []
        let total = 0
        for (const message of messages) {
          for (const { attachment } of attachmentParts(message)) {
            total += 1
            if (lines.length >= GMAIL_ATTACHMENT_LIST_MAX) continue
            lines.push([
              `message=${message.id ?? ''}`,
              `part=${attachment.partId || '(none)'}`,
              attachment.filename,
              attachment.mimeType,
              sizeLabel(attachment.size),
              readability(attachment),
            ].join(' | '))
          }
        }
        const scope = messageId ? `message "${messageId}"` : `thread "${threadId}"`
        if (total === 0) return toolText(`No attachments in ${scope}.`, { attachments: 0 })
        const more = total > lines.length ? ` Only the first ${lines.length} are listed.` : ''
        return toolText(
          [
            `${total} attachment(s) in ${scope} (message | part | name | type | size | readable).${more}`,
            ...lines,
            'Read one with gmail_read_attachment(messageId, partId).',
          ].join('\n'),
          { attachments: total },
        )
      } catch (err) {
        return toolError(err)
      }
    },
  } as AgentTool
}

type PartLookup =
  | { ok: true; part: GmailPart; attachment: ThreadAttachment }
  | { ok: false; error: string }

/** Find the attachment by part id, or by file name when the name is unique. */
export function findAttachment(message: GmailMessage, partId: string, filename: string): PartLookup {
  const all = attachmentParts(message)
  if (all.length === 0) return { ok: false, error: 'the message has no attachments.' }
  const known = all.map(entry => `${entry.attachment.partId || '(none)'}=${entry.attachment.filename}`).join(', ')
  if (partId) {
    const hit = all.find(entry => entry.attachment.partId === partId)
    return hit ? { ok: true, ...hit } : { ok: false, error: `no attachment with part id "${partId}". Known parts: ${known}.` }
  }
  const wanted = filename.toLowerCase()
  const hits = all.filter(entry => entry.attachment.filename.toLowerCase() === wanted)
  if (hits.length === 1) return { ok: true, ...hits[0] }
  if (hits.length > 1) return { ok: false, error: `several attachments are named "${filename}"; pass the part id. Known parts: ${known}.` }
  return { ok: false, error: `no attachment named "${filename}". Known parts: ${known}.` }
}

function statusLine(result: AttachmentTextResult): string {
  switch (result.kind) {
    case 'text':
      return 'status: text extracted'
    case 'scan':
      return 'status: kein Text, Scan — the PDF has pages but no text layer (a scanned image). '
        + 'No OCR was done. Say that the document is a scan; do not guess its content.'
    case 'binary':
      return result.reason === 'too_large'
        ? `status: not read — larger than the ${MAX_MB} MB limit.`
        : 'status: metadata only — this format is not read as text.'
    case 'extractor_unavailable':
      return 'status: not read — PDF text extraction is not installed on this server.'
    case 'unreadable':
    default: {
      const why = result.reason === 'pdf_encrypted'
        ? 'the PDF is password protected'
        : result.reason === 'extract_timeout'
          ? 'text extraction took too long'
          : result.reason === 'cancelled'
            ? 'the read was cancelled'
            : 'the file is damaged or not what its type claims'
      return `status: unreadable — ${why} (${result.reason ?? 'unknown'}). Nothing could be read.`
    }
  }
}

function describe(attachment: ThreadAttachment, messageId: string, result?: AttachmentTextResult, bytes?: number): string {
  const facts = [attachment.mimeType, sizeLabel(bytes ?? attachment.size)]
  if (result?.pages !== undefined) facts.push(`${result.pages} page(s)`)
  return `attachment: ${attachment.filename} (${facts.join(', ')}) message=${messageId} part=${attachment.partId || '(none)'}`
}

export function createGmailReadAttachmentTool(options: GmailAttachmentToolOptions): AgentTool {
  const { ctx, baseUrl, counters } = options
  let budgetLeft = options.runBudgetTokens ?? ATTACHMENT_RUN_BUDGET_TOKENS
  const tooLarge = (attachment: ThreadAttachment, messageId: string, meta: Record<string, unknown>, format: AttachmentTextResult['format']) => {
    const result: AttachmentTextResult = {
      kind: 'binary', format, text: '', totalChars: 0, offset: 0, truncated: false, reason: 'too_large',
    }
    return toolText([describe(attachment, messageId), statusLine(result)].join('\n'), { ...meta, kind: 'too_large', downloaded: false })
  }
  return {
    name: 'gmail_read_attachment',
    label: 'Read mail attachment',
    description: [
      'Download ONE attachment and return its text: PDF (text layer only, no OCR), txt, csv, html, eml.',
      'Other formats (images, office files, archives) return metadata only.',
      'Needs the message id and the part id from gmail_read_thread or gmail_list_attachments;',
      'instead of the part id the exact file name works when it is unique.',
      `Attachments over ${MAX_MB} MB are not downloaded. The text is cut at ${ATTACHMENT_TEXT_CAP_CHARS} characters;`,
      'call again with `offset` to read further. One run has a fixed total budget for attachment text;',
      'once it is used up, answer with what you have.',
    ].join(' '),
    parameters: Type.Object({
      messageId: Type.String({ description: 'Message id (`message id:` in gmail_read_thread, `message=` in gmail_list_attachments).' }),
      partId: Type.Optional(Type.String({ description: 'Part id of the attachment (`part=` / `[part …]`).' })),
      filename: Type.Optional(Type.String({ description: 'Exact file name, used when no part id is given.' })),
      offset: Type.Optional(Type.Number({ description: 'Character offset to continue a cut-off text (default 0).' })),
    }),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const raw = (params ?? {}) as { messageId?: unknown; partId?: unknown; filename?: unknown; offset?: unknown }
      const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : ''
      const partId = typeof raw.partId === 'string' ? raw.partId.trim() : ''
      const filename = typeof raw.filename === 'string' ? raw.filename.trim() : ''
      const offset = typeof raw.offset === 'number' && Number.isFinite(raw.offset) ? Math.max(0, Math.floor(raw.offset)) : 0
      if (!messageId) return toolError('`messageId` is required — take it from gmail_read_thread or gmail_list_attachments.')
      if (!partId && !filename) return toolError('`partId` or `filename` is required — see gmail_list_attachments.')
      if (budgetLeft <= 0) {
        return toolText(
          'status: budget_exhausted — this run has used its whole budget for attachment text. '
            + 'Nothing was downloaded. Answer with what you have read so far and say that the rest was not read.',
          { kind: 'budget_exhausted', downloaded: false },
        )
      }

      try {
        const message = await fetchMessage(options, messageId, signal)
        const lookup = findAttachment(message, partId, filename)
        if (!lookup.ok) return toolError(lookup.error)
        const { part, attachment } = lookup
        const format = attachmentFormat(attachment.mimeType, attachment.filename)
        const meta = { format, declaredBytes: attachment.size }

        if (!isReadableFormat(format)) {
          const result: AttachmentTextResult = {
            kind: 'binary', format, text: '', totalChars: 0, offset: 0, truncated: false, reason: 'unsupported_format',
          }
          return toolText([describe(attachment, messageId), statusLine(result)].join('\n'), { ...meta, kind: 'binary', downloaded: false })
        }
        // The declared size is only a hint (it may be missing, zero or wrong);
        // the bounded download below is the real limit.
        if (attachment.size > ATTACHMENT_MAX_BYTES) return tooLarge(attachment, messageId, meta, format)

        // Small attachments come inline in the message; the rest needs the
        // attachment id, which Gmail re-issues on every message fetch — so it
        // is taken from THIS fetch, never from an earlier tool call.
        let data = part.body?.data ?? ''
        if (!data) {
          const attachmentId = part.body?.attachmentId ?? ''
          if (!attachmentId) return toolError('the attachment has no downloadable body.')
          let response: GmailAttachmentResponse
          try {
            response = await googleGetJson<GmailAttachmentResponse>(
              ctx,
              buildUrl(
                baseUrl,
                `users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
              ),
              counters,
              signal,
              { maxBodyBytes: ATTACHMENT_MAX_RESPONSE_BYTES },
            )
          } catch (err) {
            if (err instanceof GoogleApiError && err.code === 'response_too_large') {
              return tooLarge(attachment, messageId, meta, format)
            }
            throw err
          }
          if (typeof response.size === 'number' && response.size > ATTACHMENT_MAX_BYTES) {
            return tooLarge(attachment, messageId, meta, format)
          }
          data = typeof response.data === 'string' ? response.data : ''
        }
        // Base64 of more than the limit, inline or downloaded: refuse before decoding.
        if (data.length > Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 + 4) return tooLarge(attachment, messageId, meta, format)

        let bytes: Buffer
        try {
          bytes = decodeBase64UrlBytes(data)
        } catch {
          const result: AttachmentTextResult = {
            kind: 'unreadable', format, text: '', totalChars: 0, offset: 0, truncated: false, reason: 'invalid_base64',
          }
          return toolText([describe(attachment, messageId), statusLine(result)].join('\n'), { ...meta, kind: 'unreadable' })
        }

        const result = await extractAttachmentText(bytes, {
          mimeType: attachment.mimeType,
          filename: attachment.filename,
          charset: partCharset(part),
          offset,
          capChars: ATTACHMENT_TEXT_CAP_CHARS,
          ...options.extractor,
          signal,
        })
        if (result.kind === 'binary' && result.reason === 'too_large') return tooLarge(attachment, messageId, meta, format)

        // Second bound: the estimated tokens of this window and what is left of
        // the run's budget. A window cut here pages on like any other.
        let budgetCut = false
        if (result.kind === 'text' && result.text) {
          const allowed = Math.min(ATTACHMENT_CALL_TOKENS, budgetLeft)
          if (estimateTokens(result.text) > allowed) {
            result.text = result.text.slice(0, prefixWithinTokens(result.text, allowed))
            result.truncated = true
            budgetCut = true
          }
          budgetLeft -= estimateTokens(result.text)
        }

        const lines = [describe(attachment, messageId, result, bytes.length), statusLine(result)]
        if (result.pagesLimited) lines.push(`(only the first ${PDF_MAX_PAGES} of ${result.pages} pages were read)`)
        if (result.outputLimited) {
          lines.push('(the extractor stopped at its output limit: the document goes on after the captured text; the total length is unknown)')
        }
        if (result.kind === 'text') {
          const end = result.offset + result.text.length
          const total = result.outputLimited ? `at least ${result.totalChars}` : String(result.totalChars)
          lines.push(`--- text, characters ${result.offset}-${end} of ${total} ---`)
          lines.push(result.text || '(no text in this range)')
          if (result.truncated) {
            const more = result.outputLimited ? 'more text follows' : `${result.totalChars - end} more characters`
            lines.push(`[cut off: ${more}. Call gmail_read_attachment again with offset=${end} to continue.]`)
          }
          if (budgetLeft <= 0) {
            lines.push('[the attachment-text budget of this run is now used up; further reads return nothing.]')
          }
        }
        return toolText(lines.join('\n'), {
          ...meta,
          kind: result.kind,
          downloaded: true,
          bytes: bytes.length,
          chars: result.totalChars,
          truncated: result.truncated,
          ...(result.outputLimited ? { outputLimited: true } : {}),
          ...(budgetCut ? { budgetCut: true } : {}),
        })
      } catch (err) {
        return toolError(err)
      }
    },
  } as AgentTool
}
