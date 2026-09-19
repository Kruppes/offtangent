/**
 * tool-output-limits.ts: hard caps for what a tool result may push into the
 * model context.
 *
 * Measured on this installation (token audit 2026-09-17): `read_file` had no
 * limit at all — the largest single result was 3.420.102 characters (a JPEG
 * read as text, ~855k tokens) — and `shell` only had a 10 MB memory guard.
 * Every such result is re-sent with the whole transcript on every following
 * LLM call (amplification 219–246x inside background tasks), so an unbounded
 * tool result is not a one-off cost, it is a recurring one.
 *
 * The rules here are deliberately dumb and local:
 *  - a text result that exceeds its budget is cut, never silently dropped,
 *    and the cut always says how much is missing and how to get it,
 *  - binary content never enters the context as text; only metadata does.
 *
 * The caps apply to the value the tool returns (which is also what gets
 * logged to `tool_calls`), so logs and context stay consistent.
 */

import nodePath from 'node:path'

/** Files above this size are never read into memory; only metadata is returned. */
export const READ_FILE_MAX_BYTES = 64 * 1024 * 1024

export interface HeadTailCap {
  /** The capped text (identical to the input when nothing was cut). */
  text: string
  /** True when the input exceeded the budget. */
  truncated: boolean
  /** Length of the original input in characters. */
  totalChars: number
}

/**
 * Keep the head and the tail of an output, drop the middle.
 *
 * For command output both ends carry signal (the invocation/first errors at
 * the top, the exit summary at the bottom), so a pure head cut loses the part
 * that usually matters most.
 */
export function capHeadTail(text: string, maxChars: number, label = 'output'): HeadTailCap {
  const totalChars = text.length
  if (!Number.isFinite(maxChars) || maxChars <= 0 || totalChars <= maxChars) {
    return { text, truncated: false, totalChars }
  }
  const headChars = Math.floor(maxChars / 2)
  const tailChars = maxChars - headChars
  const omitted = totalChars - headChars - tailChars
  const marker =
    `\n\n…[${label} truncated: ${totalChars} characters total, ${omitted} omitted here. ` +
    `Shown: the first ${headChars} and the last ${tailChars} characters. ` +
    `Narrow the command (grep/head/tail/wc) to see the rest.]…\n\n`
  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(totalChars - tailChars)}`,
    truncated: true,
    totalChars,
  }
}

export interface FileSliceOptions {
  /** Character offset to start at (default 0). */
  offset?: number
  /** Characters to return (default and hard maximum: `maxChars`). */
  limit?: number
  /** Hard cap on returned characters. */
  maxChars: number
  /** Shown in the notice lines. */
  path: string
}

export interface FileSlice {
  /** What the tool returns: either the whole file or a slice with notices. */
  text: string
  truncated: boolean
  totalChars: number
  totalLines: number
  offset: number
  returned: number
  /** Character offset the caller should pass to continue, or null at EOF. */
  nextOffset: number | null
  firstLine: number
  lastLine: number
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * Cut a file to the prompt budget with a slice the model can continue from.
 *
 * A file that fits within the budget and is requested from the start is
 * returned byte-identical — no header, no footer — so the common case pays
 * nothing for this mechanism.
 */
export function sliceFileForPrompt(content: string, options: FileSliceOptions): FileSlice {
  const totalChars = content.length
  const totalLines = countLines(content)
  const maxChars = Math.max(1, Math.floor(options.maxChars))
  const rawOffset = Math.floor(options.offset ?? 0)
  const offset = Math.min(Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0), totalChars)
  const rawLimit = Math.floor(options.limit ?? maxChars)
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : maxChars, maxChars)

  const slice = content.slice(offset, offset + limit)
  const returned = slice.length
  const end = offset + returned
  const truncated = offset > 0 || end < totalChars

  if (!truncated) {
    return {
      text: content,
      truncated: false,
      totalChars,
      totalLines,
      offset,
      returned,
      nextOffset: null,
      firstLine: 1,
      lastLine: totalLines,
    }
  }

  const firstLine = countLines(content.slice(0, offset)) || 1
  const sliceLines = countLines(slice)
  const lastLine = sliceLines === 0 ? firstLine : firstLine + sliceLines - 1
  const nextOffset = end < totalChars ? end : null

  const header =
    `[read_file] ${options.path}: showing characters ${offset}-${end} of ${totalChars} ` +
    `(lines ${firstLine}-${lastLine} of ${totalLines}).`
  const footer = nextOffset === null
    ? '[read_file] End of file.'
    : `[read_file] ${totalChars - end} characters left. Continue with read_file(path, offset=${nextOffset}).`

  return {
    text: `${header}\n${slice}\n${footer}`,
    truncated: true,
    totalChars,
    totalLines,
    offset,
    returned,
    nextOffset,
    firstLine,
    lastLine,
  }
}

export interface BinaryDetection {
  binary: boolean
  /** Why the content was classified as binary ('null-byte' | 'non-utf8'), else null. */
  reason: 'null-byte' | 'non-utf8' | null
}

/** Bytes inspected for a UTF-8 decode check — enough to classify, cheap on big files. */
const UTF8_PROBE_BYTES = 64 * 1024

/**
 * Classify a file as binary: a NUL byte anywhere, or content that does not
 * decode as UTF-8. Both are things no model should ever receive as "text".
 */
export function detectBinaryContent(buf: Uint8Array): BinaryDetection {
  if (buf.length === 0) return { binary: false, reason: null }
  if (Buffer.from(buf.buffer, buf.byteOffset, buf.length).includes(0)) {
    return { binary: true, reason: 'null-byte' }
  }
  const probeLength = Math.min(buf.length, UTF8_PROBE_BYTES)
  // Decode a whole-character window: cutting mid sequence would look like a
  // decode error on perfectly valid UTF-8.
  let end = probeLength
  if (probeLength < buf.length) {
    while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) end--
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, end))
  } catch {
    return { binary: true, reason: 'non-utf8' }
  }
  return { binary: false, reason: null }
}

const EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.sqlite': 'application/vnd.sqlite3',
  '.db': 'application/vnd.sqlite3',
  '.so': 'application/x-sharedlib',
  '.wasm': 'application/wasm',
}

function magicMime(buf: Uint8Array): string | null {
  const b = buf
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'
  if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b) return 'application/zip'
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'application/gzip'
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'application/x-elf'
  if (b.length >= 16 && Buffer.from(b.subarray(0, 15)).toString('latin1') === 'SQLite format 3') {
    return 'application/vnd.sqlite3'
  }
  return null
}

/** Best effort MIME guess from magic bytes first, extension second. */
export function guessMimeType(filePath: string, buf?: Uint8Array): string {
  if (buf && buf.length > 0) {
    const magic = magicMime(buf)
    if (magic) return magic
  }
  const ext = nodePath.extname(filePath).toLowerCase()
  return EXTENSION_MIME[ext] ?? 'application/octet-stream'
}

/** The text a binary or oversized file returns instead of its content. */
export function describeUnreadableFile(params: {
  path: string
  bytes: number
  mime: string
  kind: 'binary' | 'too-large'
  reason?: string | null
}): string {
  if (params.kind === 'too-large') {
    return `[read_file] ${params.path}: ${params.bytes} bytes (${params.mime}) — too large to read into the context. ` +
      'Use shell (head/tail/sed -n, grep) to inspect the parts you need.'
  }
  const why = params.reason === 'null-byte' ? 'contains NUL bytes' : 'is not valid UTF-8'
  return `[read_file] ${params.path}: binary file, not returned as text (${params.mime}, ${params.bytes} bytes, ${why}). ` +
    'Reading it as text would flood the context with noise. Use a dedicated tool or shell if you need to inspect it.'
}
