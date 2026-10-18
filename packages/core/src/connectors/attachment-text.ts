/**
 * attachment-text.ts: turn the bytes of ONE mail attachment into plain text
 * for the local connector sub-agent.
 *
 * Everything here runs on this machine: PDFs go through `pdftotext`/`pdfinfo`
 * (poppler-utils) via stdin/stdout, so no temp file is written and nothing is
 * sent anywhere. There is no OCR: a PDF without a text layer is reported as a
 * scan, never shipped to an OCR service.
 *
 * Lenient by design — a broken, encrypted or mislabelled attachment yields a
 * result with `kind: 'unreadable'` and a short reason, never a thrown error, so
 * one bad file cannot take down the answer about the rest of the mail.
 *
 * The returned text is attachment content: it may only ever travel into the
 * transcript of the local sub-agent (see sub-agent.ts). Callers must not log
 * it or put it into `details`.
 */
import { spawn } from 'node:child_process'
import { htmlToText, parseEmlText } from '../email-client.js'

/** Attachments larger than this are not downloaded at all. */
export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024
/**
 * Characters of extracted text handed to the local model per call. The local
 * box runs with a 40k-token context shared by system prompt, tools, the thread
 * and every earlier tool result of the run; 10k ASCII characters are at most
 * 5k estimated tokens (see {@link estimateTokens}), real prose ~2.5-3k.
 */
export const ATTACHMENT_TEXT_CAP_CHARS = 10_000
/**
 * Estimated tokens of attachment text ONE sub-agent run may receive in total,
 * over all calls and pages. Together with the per-call window this keeps a
 * run that pages through a long PDF from filling the shared 40k context.
 *
 * Context arithmetic for the local runner (n_ctx 40960):
 * - Under the estimate below a real run gets ~12k tokens or LESS of attachment
 *   text (prose, tables and figures tokenise at 3-4 ASCII characters per token,
 *   the estimate counts 2).
 * - Hard worst case, the estimate being wrong by the full factor 2 (text where
 *   every ASCII character is its own token): 24k tokens. Non-ASCII text cannot
 *   exceed the estimate, it is counted at its UTF-8 bytes.
 * - Plus one thread read (GMAIL_THREAD_CAP_CHARS = 8000 characters, worst case
 *   8k tokens) that leaves ~9k for system prompt, tool schemas and answer even
 *   in that worst case, and well over 20k in any realistic one.
 */
export const ATTACHMENT_RUN_BUDGET_TOKENS = 12_000
/** Estimated tokens per single call (a second bound next to the character window). */
export const ATTACHMENT_CALL_TOKENS = 5_000

/** Estimated tokens of one UTF-16 code unit (see {@link estimateTokens}). */
function unitWeight(code: number): { ascii: number; bytes: number } {
  if (code < 0x80) return { ascii: 1, bytes: 0 }
  if (code < 0x800) return { ascii: 0, bytes: 2 }
  // A surrogate half is half of a 4-byte character.
  if (code >= 0xd800 && code <= 0xdfff) return { ascii: 0, bytes: 2 }
  return { ascii: 0, bytes: 3 }
}

/**
 * Token ESTIMATE of a text — a deliberately pessimistic one, not a tokeniser.
 * The budgets above are counted in it, not in real tokens.
 *
 * - ASCII: two characters per token. Real BPE tokenisers (the local Qwen/Llama
 *   family included) average 3-4 characters per token on prose and around
 *   2.5-3 on digits, codes and tables, so this over-counts. It is NOT a hard
 *   bound: pathological text (a run of lone punctuation) can reach one token
 *   per character, which the run budget's arithmetic covers.
 * - Every other character: its UTF-8 byte count. A byte-level tokeniser never
 *   spends more than one token per byte, so for non-ASCII this IS an upper
 *   bound (umlauts 2, CJK 3, emoji 4).
 *
 * Changed from three ASCII characters per token after review: the old rate
 * matched real prose and therefore under-counted dense tables and IDs.
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const w = unitWeight(text.charCodeAt(i))
    ascii += w.ascii
    bytes += w.bytes
  }
  return Math.ceil(ascii / 2) + bytes
}

/** Length of the longest prefix of `text` whose estimate stays within `maxTokens`. */
export function prefixWithinTokens(text: string, maxTokens: number): number {
  if (maxTokens <= 0) return 0
  let ascii = 0
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const w = unitWeight(text.charCodeAt(i))
    ascii += w.ascii
    bytes += w.bytes
    if (Math.ceil(ascii / 2) + bytes > maxTokens) {
      // Never split a surrogate pair.
      const code = text.charCodeAt(i)
      return code >= 0xdc00 && code <= 0xdfff && i > 0 ? i - 1 : i
    }
  }
  return text.length
}

/** Pages `pdftotext` reads at most; a 900-page manual must not pin the CPU. */
export const PDF_MAX_PAGES = 60
/** Wall clock per extractor process. */
export const EXTRACTOR_TIMEOUT_MS = 20_000
/** Raw extractor output kept in memory at most (bytes) before the process is killed. */
const EXTRACTOR_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export type AttachmentTextKind =
  /** Text was extracted. */
  | 'text'
  /** A PDF with pages but no text layer — most likely a scan. No OCR is done. */
  | 'scan'
  /** A format this module does not read (images, office files, archives, …). */
  | 'binary'
  /** Damaged, encrypted or otherwise unreadable. */
  | 'unreadable'
  /** The PDF extractor is not installed on this machine. */
  | 'extractor_unavailable'

export type AttachmentFormat = 'pdf' | 'text' | 'csv' | 'html' | 'eml' | 'other'

export interface AttachmentTextResult {
  kind: AttachmentTextKind
  format: AttachmentFormat
  /** Extracted text, already cut to the window `[offset, offset + cap)`. Empty unless `kind === 'text'`. */
  text: string
  /** Length of the whole extracted text, before the window was applied. */
  totalChars: number
  /** Offset the window starts at. */
  offset: number
  /** True when text after the window exists. */
  truncated: boolean
  /** PDF page count, when `pdfinfo` could tell. */
  pages?: number
  /** True when only the first {@link PDF_MAX_PAGES} pages were read. */
  pagesLimited?: boolean
  /**
   * True when the extractor was stopped at its output bound: `totalChars`
   * counts only what was captured, and the document goes on after it.
   */
  outputLimited?: boolean
  /** Short technical reason for `unreadable`/`binary` — a fixed token, never content. */
  reason?: string
}

export interface ExtractOptions {
  mimeType: string
  filename: string
  /** `charset` parameter of the part's Content-Type, if any. */
  charset?: string
  /** Start of the text window (characters). Default 0. */
  offset?: number
  /** Window size (characters). Default {@link ATTACHMENT_TEXT_CAP_CHARS}. */
  capChars?: number
  /** Test seams; production uses the binaries on PATH. */
  pdftotextBin?: string
  pdfinfoBin?: string
  timeoutMs?: number
  /** Cancels a running extractor (the child is killed). */
  signal?: AbortSignal
}

const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log', 'md', 'markdown', 'json', 'xml', 'ics', 'vcf', 'yaml', 'yml'])
const CSV_EXTENSIONS = new Set(['csv', 'tsv'])
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
/** Types that say nothing about the content; the extension decides for them. */
const GENERIC_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/binary',
  'application/force-download',
  'application/download',
  'application/unknown',
  'binary/octet-stream',
])

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(filename.trim())
  return match ? match[1].toLowerCase() : ''
}

/**
 * Which reader to use. The MIME type wins when it is specific; Gmail labels a
 * lot of attachments `application/octet-stream`, so the extension decides then.
 */
export function attachmentFormat(mimeType: string, filename: string): AttachmentFormat {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim()
  const ext = extensionOf(filename)
  if (mime === 'application/pdf' || mime === 'application/x-pdf') return 'pdf'
  if (mime === 'message/rfc822') return 'eml'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml') return 'text'
  // A specific type that is not readable (image/jpeg, application/zip, …)
  // stays metadata-only even when the name says `.pdf`.
  if (mime && !GENERIC_MIME_TYPES.has(mime)) return 'other'
  // Generic or missing type: the extension decides.
  if (ext === 'pdf') return 'pdf'
  if (ext === 'eml') return 'eml'
  if (HTML_EXTENSIONS.has(ext)) return 'html'
  if (CSV_EXTENSIONS.has(ext)) return 'csv'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'other'
}

/** Can this attachment be read as text at all (before looking at the bytes)? */
export function isReadableFormat(format: AttachmentFormat): boolean {
  return format !== 'other'
}

/**
 * Decode bytes that claim to be text. Strict UTF-8 first; on failure
 * windows-1252, which is what most German office exports really are. A
 * declared non-UTF-8 `charset` of the part wins over the sniffing. A NUL in
 * the first 8 KB means it is not text at all.
 */
export function decodeTextBytes(bytes: Buffer, charset = ''): string | null {
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) {
    // UTF-16 with BOM is text; anything else with NULs is binary.
    if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
    if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
    return null
  }
  const declared = charset.trim().toLowerCase()
  if (declared && declared !== 'utf-8' && declared !== 'utf8' && declared !== 'us-ascii') {
    try {
      return new TextDecoder(declared).decode(bytes)
    } catch {
      // Unknown label: fall through to the sniffing below.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

interface ProcessResult {
  code: number | null
  stdout: Buffer
  /** True when the process could not be started at all (binary missing). */
  missing: boolean
  timedOut: boolean
  overflow: boolean
  aborted: boolean
}

/** Run a local binary with `input` on stdin. Never rejects. */
function runLocal(bin: string, args: string[], input: Buffer, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: Buffer.alloc(0), missing: false, timedOut: false, overflow: false, aborted: true })
      return
    }
    let settled = false
    const chunks: Buffer[] = []
    let size = 0
    let timedOut = false
    let overflow = false
    let aborted = false
    const finish = (result: Omit<ProcessResult, 'stdout' | 'aborted'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ...result, aborted, stdout: Buffer.concat(chunks) })
    }

    let child: ReturnType<typeof spawn>
    try {
      // stderr is ignored on purpose: poppler quotes object names and, for
      // some errors, document metadata. Only the exit code is used.
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      resolve({ code: null, stdout: Buffer.alloc(0), missing: true, timedOut: false, overflow: false, aborted: false })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    function onAbort(): void {
      aborted = true
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ code: null, missing: err?.code === 'ENOENT', timedOut, overflow })
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return
      size += chunk.length
      if (size > EXTRACTOR_MAX_OUTPUT_BYTES) {
        overflow = true
        // Keep what fits; the text is cut to a far smaller window anyway.
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - EXTRACTOR_MAX_OUTPUT_BYTES))))
        child.kill('SIGKILL')
        return
      }
      chunks.push(chunk)
    })
    child.on('close', code => finish({ code, missing: false, timedOut, overflow }))
    // After a kill, do not wait for 'close': a grandchild that inherited the
    // stdout pipe could hold it open long after the process itself is gone.
    child.on('exit', code => {
      if (!timedOut && !aborted && !overflow) return
      child.stdout?.destroy()
      finish({ code, missing: false, timedOut, overflow })
    })
    // A process that exits before reading all input raises EPIPE on stdin.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

function windowed(
  base: Omit<AttachmentTextResult, 'text' | 'totalChars' | 'offset' | 'truncated'>,
  fullText: string,
  offset: number,
  cap: number,
): AttachmentTextResult {
  const normalized = fullText
    .replace(/\r\n?/g, '\n')
    // Form feeds separate PDF pages; a visible marker is more useful to a model.
    .replace(/\f/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  const start = Math.min(Math.max(0, Math.floor(offset)), normalized.length)
  const text = normalized.slice(start, start + cap)
  return {
    ...base,
    text,
    totalChars: normalized.length,
    offset: start,
    truncated: start + cap < normalized.length,
  }
}

function emptyResult(kind: AttachmentTextKind, format: AttachmentFormat, reason?: string, extra: Partial<AttachmentTextResult> = {}): AttachmentTextResult {
  return { kind, format, text: '', totalChars: 0, offset: 0, truncated: false, ...(reason ? { reason } : {}), ...extra }
}

async function extractPdf(bytes: Buffer, options: ExtractOptions, offset: number, cap: number): Promise<AttachmentTextResult> {
  // Not a PDF at all (a mislabelled HTML error page, a truncated download).
  // The header may sit anywhere in the first KB according to the spec.
  if (!bytes.subarray(0, 1024).includes('%PDF-')) return emptyResult('unreadable', 'pdf', 'not_a_pdf')

  const timeoutMs = options.timeoutMs ?? EXTRACTOR_TIMEOUT_MS
  const info = await runLocal(options.pdfinfoBin ?? 'pdfinfo', ['-'], bytes, timeoutMs, options.signal)
  if (info.aborted) return emptyResult('unreadable', 'pdf', 'cancelled')
  let pages: number | undefined
  if (info.code === 0) {
    const match = /^Pages:\s+(\d+)/m.exec(info.stdout.toString('utf-8'))
    if (match) pages = Number(match[1])
  }

  const result = await runLocal(
    options.pdftotextBin ?? 'pdftotext',
    ['-q', '-enc', 'UTF-8', '-layout', '-l', String(PDF_MAX_PAGES), '-', '-'],
    bytes,
    timeoutMs,
    options.signal,
  )
  if (result.aborted) return emptyResult('unreadable', 'pdf', 'cancelled')
  if (result.missing) return emptyResult('extractor_unavailable', 'pdf', 'pdftotext_missing', pages ? { pages } : {})
  if (result.timedOut) return emptyResult('unreadable', 'pdf', 'extract_timeout', pages ? { pages } : {})

  const text = result.stdout.toString('utf-8')
  const pagesLimited = typeof pages === 'number' && pages > PDF_MAX_PAGES
  const meta = { ...(pages !== undefined ? { pages } : {}), ...(pagesLimited ? { pagesLimited } : {}) }
  // Killed at the output bound: what was captured is real text, but only a
  // prefix — never present it as the whole document.
  const outputLimit = result.overflow ? { outputLimited: true } : {}

  if (result.code !== 0 && !text.trim()) {
    // poppler exit codes: 1 = cannot open/parse, 3 = permission (encrypted).
    return emptyResult('unreadable', 'pdf', result.code === 3 ? 'pdf_encrypted' : 'pdf_damaged', meta)
  }
  if (!text.replace(/[\s\f]/g, '')) {
    // pdftotext opened the file and found not one character: an image-only
    // PDF. Only a pdfinfo that RAN and rejected the file (or counted zero
    // pages) makes it damaged; a missing or slow pdfinfo says nothing.
    const infoRejected = !info.missing && !info.timedOut && info.code !== 0
    if (result.code !== 0 || infoRejected || pages === 0) return emptyResult('unreadable', 'pdf', 'pdf_damaged', meta)
    return emptyResult('scan', 'pdf', 'no_text_layer', meta)
  }
  const windowedResult = windowed({ kind: 'text', format: 'pdf', ...meta, ...outputLimit }, text, offset, cap)
  // Paging past the captured prefix must not look like the end of the document.
  return result.overflow ? { ...windowedResult, truncated: true } : windowedResult
}

async function extractEml(bytes: Buffer, offset: number, cap: number): Promise<AttachmentTextResult> {
  try {
    return windowed({ kind: 'text', format: 'eml' }, await parseEmlText(bytes), offset, cap)
  } catch {
    return emptyResult('unreadable', 'eml', 'eml_damaged')
  }
}

/**
 * Extract the text of one attachment. Never throws.
 */
export async function extractAttachmentText(bytes: Buffer, options: ExtractOptions): Promise<AttachmentTextResult> {
  const format = attachmentFormat(options.mimeType, options.filename)
  const offset = options.offset ?? 0
  const cap = Math.max(1, options.capChars ?? ATTACHMENT_TEXT_CAP_CHARS)
  try {
    if (bytes.length > ATTACHMENT_MAX_BYTES) return emptyResult('binary', format, 'too_large')
    switch (format) {
      case 'pdf':
        return await extractPdf(bytes, options, offset, cap)
      case 'eml':
        return await extractEml(bytes, offset, cap)
      case 'html': {
        const decoded = decodeTextBytes(bytes, options.charset)
        if (decoded === null) return emptyResult('unreadable', format, 'not_text')
        return windowed({ kind: 'text', format }, htmlToText(decoded), offset, cap)
      }
      case 'csv':
      case 'text': {
        const decoded = decodeTextBytes(bytes, options.charset)
        if (decoded === null) return emptyResult('unreadable', format, 'not_text')
        return windowed({ kind: 'text', format }, decoded, offset, cap)
      }
      default:
        return emptyResult('binary', format, 'unsupported_format')
    }
  } catch {
    return emptyResult('unreadable', format, 'extract_failed')
  }
}
