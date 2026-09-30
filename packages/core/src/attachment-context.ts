import fs from 'node:fs'
import nodePath from 'node:path'
import type { ImageContent } from '@earendil-works/pi-ai'
import { getUploadsDir } from './uploads.js'
import type { UploadDescriptor } from './uploads.js'
import { sealText } from './secret-boundary.js'

/**
 * Turns the attachments of a chat message into model input.
 *
 * Uploads are unrestricted (any type, up to the transport limit), the model
 * context is not: a 500 MB video or a binary blob must never be inlined into a
 * turn. Everything the model cannot consume is therefore mentioned as a
 * reference (name, type, size, absolute path) that the agent can open with its
 * file tools if it wants to.
 *
 * Privacy (plan 2026-09-26, F1 of the review triage 19:25): the hints are
 * PROMPT material built here, after the channel has already sealed the user's
 * message (`agent.ts` appended them behind the seal) — so the sealing belongs
 * in this module. Every hint goes through `sealText` with the `strong` tier plus
 * known-value redaction, filing values in the same store under the same handles
 * as the chat path. `strong` is the right tier: file content is not prose
 * someone typed, so the `user`-tier context rules ("Passwort ist …") would be
 * guesswork over foreign text, while the structural rules and `KEY=value`
 * assignments are exactly what a credentials file contains.
 */

/** Image formats the vision APIs actually accept. SVG is markup, not an image, and stays out. */
const MODEL_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
])

/** Base64 inflates by ~4/3, so this is ~10.7 MB of payload per image. */
const DEFAULT_MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_INLINE_TEXT_BYTES = 64 * 1024

const TEXT_MIME_PREFIXES = ['text/']
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-sh',
  'application/x-httpd-php',
  'application/csv',
  'application/x-ndjson',
])
const TEXT_MIME_SUFFIXES = ['+json', '+xml', '+yaml']
/** Extensions we treat as text when the client sent no (or a useless) mime type. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.log', '.json', '.jsonl', '.ndjson',
  '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.sql',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.sh', '.bash',
  '.zsh', '.svg', '.html', '.htm', '.css', '.scss', '.vue', '.svelte',
])

export interface AttachmentContext {
  images: ImageContent[]
  hints: string[]
}

/**
 * Seal one hint before it can reach a prompt: `strong` tier plus known-value
 * redaction, with the store handles of every other path.
 */
function sealHint(hint: string): string {
  try {
    return sealText(hint, { tier: 'strong', source: 'attachment' }).text
  } catch (err) {
    // Fail closed: a broken store must not turn into "send the raw file".
    console.error('[attachment-context] Could not seal an attachment hint, dropping its content:', err)
    return '[Attached file: content withheld — the secret boundary could not process it.]'
  }
}

interface AttachmentContextLimits {
  maxInlineImageBytes?: number
  maxInlineTextBytes?: number
  uploadsDir?: string
}

function readEnvBytes(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const mb = Number.parseFloat(raw)
  if (!Number.isFinite(mb) || mb <= 0) return fallback
  return Math.round(mb * 1024 * 1024)
}

function isTextual(mimeType: string, fileName: string): boolean {
  const mime = mimeType.toLowerCase()
  if (TEXT_MIME_PREFIXES.some(prefix => mime.startsWith(prefix))) return true
  if (TEXT_MIME_TYPES.has(mime)) return true
  if (TEXT_MIME_SUFFIXES.some(suffix => mime.endsWith(suffix))) return true
  if (mime === 'application/octet-stream' || mime === '') {
    return TEXT_EXTENSIONS.has(nodePath.extname(fileName).toLowerCase())
  }
  return false
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function referenceHint(att: UploadDescriptor, absPath: string, reason: string): string {
  return `[Attached file: ${att.originalName} (${att.mimeType}, ${formatBytes(att.size)}) stored at ${absPath} — ${reason}]`
}

/** Reads at most `limit` bytes so a huge "text" file cannot blow up the turn. */
function readTextHead(absPath: string, limit: number): { text: string; truncated: boolean } | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(absPath, 'r')
    const buffer = Buffer.alloc(limit)
    const read = fs.readSync(fd, buffer, 0, limit, 0)
    const size = fs.fstatSync(fd).size
    return { text: buffer.subarray(0, read).toString('utf8'), truncated: size > read }
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export function buildAttachmentContext(
  attachments: UploadDescriptor[] | undefined,
  limits: AttachmentContextLimits = {},
): AttachmentContext {
  const images: ImageContent[] = []
  const hints: string[] = []
  if (!attachments?.length) return { images, hints }

  const uploadsDir = limits.uploadsDir ?? getUploadsDir()
  const maxImageBytes = limits.maxInlineImageBytes
    ?? readEnvBytes('AGENT_MAX_INLINE_IMAGE_MB', DEFAULT_MAX_INLINE_IMAGE_BYTES)
  const maxTextBytes = limits.maxInlineTextBytes
    ?? readEnvBytes('AGENT_MAX_INLINE_TEXT_MB', DEFAULT_MAX_INLINE_TEXT_BYTES)

  for (const att of attachments) {
    const absPath = nodePath.resolve(uploadsDir, att.relativePath)
    const mimeType = (att.mimeType ?? '').toLowerCase()

    if (att.kind === 'image' && MODEL_IMAGE_MIME_TYPES.has(mimeType)) {
      if (att.size > maxImageBytes) {
        hints.push(referenceHint(att, absPath, `too large to inline (limit ${formatBytes(maxImageBytes)}), read it from disk if you need it`))
        continue
      }
      try {
        const buf = fs.readFileSync(absPath)
        images.push({ type: 'image', data: buf.toString('base64'), mimeType: att.mimeType })
      } catch (err) {
        console.error(`[agent] Failed to read uploaded image ${att.originalName} from ${absPath}:`, err)
        hints.push(`[Image upload failed to read: ${att.originalName}]`)
      }
      continue
    }

    if (isTextual(mimeType, att.originalName)) {
      const head = readTextHead(absPath, maxTextBytes)
      if (!head) {
        hints.push(referenceHint(att, absPath, 'could not be read back from disk'))
        continue
      }
      const suffix = head.truncated
        ? `\n[... truncated, showing the first ${formatBytes(maxTextBytes)} of ${formatBytes(att.size)}; full file at ${absPath}]`
        : ''
      hints.push(`[Attached text file: ${att.originalName} (${att.mimeType}, ${formatBytes(att.size)}) stored at ${absPath}]\n\`\`\`\n${head.text}${suffix}\n\`\`\``)
      continue
    }

    hints.push(referenceHint(att, absPath, 'binary content is not inlined; use your file tools on that path if you need it'))
  }

  return { images, hints: hints.map(sealHint) }
}
