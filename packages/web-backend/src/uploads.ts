import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import multer from 'multer'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { getUploadsDir, ensureUploadsTempDir, getFreeDiskBytes } from '@axiom/core'

/**
 * Upload policy.
 *
 * Any file type may be attached — there is no MIME whitelist. What is capped
 * is only what keeps the host alive:
 *  - per-file size (streamed to disk, never buffered in the Node heap)
 *  - number of files per request
 *  - a free-disk floor, so a big upload cannot fill the volume the database
 *    and the uploads themselves live on
 *
 * All three are configurable through the environment; the defaults below are
 * what a self-hosted instance gets.
 */
const DEFAULT_MAX_UPLOAD_MB = 500
const DEFAULT_MAX_FILES = 20
const DEFAULT_MIN_FREE_DISK_MB = 2048
/** Nothing above this can be configured — a single request must stay survivable. */
const HARD_MAX_UPLOAD_MB = 4096
const HARD_MAX_FILES = 100

function readEnvNumber(name: string, fallback: number, hardMax: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.round(value), hardMax)
}

export function getMaxUploadBytes(): number {
  return readEnvNumber('UPLOAD_MAX_FILE_SIZE_MB', DEFAULT_MAX_UPLOAD_MB, HARD_MAX_UPLOAD_MB) * 1024 * 1024
}

export function getMaxUploadFiles(): number {
  return readEnvNumber('UPLOAD_MAX_FILES', DEFAULT_MAX_FILES, HARD_MAX_FILES)
}

export function getMinFreeDiskBytes(): number {
  return readEnvNumber('UPLOAD_MIN_FREE_DISK_MB', DEFAULT_MIN_FREE_DISK_MB, Number.MAX_SAFE_INTEGER) * 1024 * 1024
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      cb(null, ensureUploadsTempDir())
    } catch (err) {
      cb(err as Error, '')
    }
  },
  /**
   * The client-supplied name never reaches the filesystem: the part file gets a
   * random name and `saveUploadFromFile` derives the final (also generated)
   * name. The original name survives as metadata only.
   */
  filename: (_req, _file, cb) => {
    cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(16).toString('hex')}.part`)
  },
})

/** Built per request so a changed limit (env) takes effect without a restart. */
function createUploader(): multer.Multer {
  return multer({
    storage,
    limits: {
      fileSize: getMaxUploadBytes(),
      files: getMaxUploadFiles(),
      // A multipart body is not a JSON document; keep the non-file fields small.
      fieldSize: 1024 * 1024,
    },
  })
}

/** Best effort: a request that failed must not leave part files behind. */
export function cleanupRequestUploads(req: Request): void {
  const files: Express.Multer.File[] = []
  const single = (req as Request & { file?: Express.Multer.File }).file
  if (single) files.push(single)
  const many = (req as Request & { files?: unknown }).files
  if (Array.isArray(many)) files.push(...(many as Express.Multer.File[]))
  else if (many && typeof many === 'object') {
    for (const group of Object.values(many as Record<string, Express.Multer.File[]>)) {
      if (Array.isArray(group)) files.push(...group)
    }
  }
  for (const file of files) {
    if (!file?.path) continue
    try {
      fs.rmSync(file.path, { force: true })
    } catch {
      // The cleanup cron sweeps whatever survives here.
    }
  }
}

function isMulterError(err: unknown): err is multer.MulterError {
  return Boolean(err) && (err as { name?: string }).name === 'MulterError'
}

function respondUploadError(req: Request, res: Response, err: unknown): void {
  cleanupRequestUploads(req)
  if (isMulterError(err)) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        res.status(413).json({
          error: `File too large. The limit is ${Math.round(getMaxUploadBytes() / (1024 * 1024))} MB per file.`,
          code: 'upload_too_large',
          maxFileSizeBytes: getMaxUploadBytes(),
        })
        return
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
        res.status(400).json({
          error: `Too many files. At most ${getMaxUploadFiles()} files per request.`,
          code: 'too_many_files',
          maxFiles: getMaxUploadFiles(),
        })
        return
      default:
        res.status(400).json({ error: `Upload rejected: ${err.message}`, code: 'upload_rejected' })
        return
    }
  }
  // Busboy rejects a body it cannot parse (broken boundary, CRLF smuggled
  // into a part header). That is the client's fault, not ours.
  const message = (err as Error)?.message ?? 'unknown error'
  if (/malformed|unexpected end|boundary|part header|missing content-type/i.test(message)) {
    res.status(400).json({ error: `Malformed multipart body: ${message}`, code: 'malformed_multipart' })
    return
  }
  res.status(500).json({ error: `Upload failed: ${message}` })
}

/**
 * Refuses an upload before a single byte is written when the volume is already
 * close to full — a half-written 500 MB file that fills the disk takes the
 * database down with it, so 507 is the friendlier answer.
 */
function hasRoomForRequest(req: Request): boolean {
  const free = getFreeDiskBytes()
  if (free === null) return true
  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
  const needed = Number.isFinite(declared) && declared > 0 ? declared : 0
  return free - needed >= getMinFreeDiskBytes()
}

function guardDiskSpace(req: Request, res: Response): boolean {
  if (hasRoomForRequest(req)) return true
  res.status(507).json({
    error: 'Not enough free disk space on the server to store this upload.',
    code: 'insufficient_storage',
  })
  return false
}

/**
 * Multipart handlers that answer with a status code instead of falling through
 * to the generic error handler (413 too large, 400 too many, 507 out of space).
 */
export function uploadArray(field: string): RequestHandler {
  return (req, res, next) => {
    if (!guardDiskSpace(req, res)) return
    const handler = createUploader().array(field, getMaxUploadFiles())
    handler(req, res, (err: unknown) => {
      if (err) {
        respondUploadError(req, res, err)
        return
      }
      next()
    })
  }
}

export function uploadSingle(field: string): RequestHandler {
  return (req, res, next) => {
    if (!guardDiskSpace(req, res)) return
    const handler = createUploader().single(field)
    handler(req, res, (err: unknown) => {
      if (err) {
        respondUploadError(req, res, err)
        return
      }
      next()
    })
  }
}

/**
 * Reads a streamed upload back into memory for the few consumers that need the
 * bytes (STT, skill zips). Capped on purpose: those paths were written for
 * small files and must not be turned into a heap bomb by the raised limits.
 */
export function readUploadedFile(file: Express.Multer.File, maxBytes: number): Buffer {
  if (file.buffer) return file.buffer
  if (!file.path) throw new Error('Uploaded file has neither a buffer nor a path')
  const size = fs.statSync(file.path).size
  if (size > maxBytes) {
    throw new Error(`File is ${size} bytes, the limit for this endpoint is ${maxBytes} bytes`)
  }
  return fs.readFileSync(file.path)
}

/**
 * Types that may render inside the browser tab. Everything else is served as a
 * download with `application/octet-stream`, which is what keeps an uploaded
 * `.html`/`.svg` from executing script under our own origin (session cookies,
 * stored tokens). `nosniff` stops the browser from "helpfully" upgrading an
 * octet-stream back to HTML.
 */
const INLINE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
}

export function resolveServedContentType(fileName: string): { contentType: string; inline: boolean } {
  const ext = path.extname(fileName).toLowerCase()
  const inlineType = INLINE_CONTENT_TYPES[ext]
  if (inlineType) return { contentType: inlineType, inline: true }
  return { contentType: 'application/octet-stream', inline: false }
}

export function sendUploadedFile(req: Request, res: Response, next: NextFunction): void {
  try {
    const rawPath = req.params.path ?? req.params[0]
    const relativePath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath
    if (!relativePath) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const normalized = path.posix.normalize(relativePath).replace(/^\/+/, '')
    if (!normalized || normalized.includes('..')) {
      res.status(400).json({ error: 'Invalid file path' })
      return
    }
    // In-flight multipart parts are not content anybody may fetch.
    if (normalized === '.tmp' || normalized.startsWith('.tmp/')) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const uploadsDir = path.resolve(getUploadsDir())
    const absolutePath = path.resolve(uploadsDir, normalized)
    if (!absolutePath.startsWith(uploadsDir) || !fs.existsSync(absolutePath)) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    res.setHeader('X-Content-Type-Options', 'nosniff')
    const { contentType, inline } = resolveServedContentType(absolutePath)

    // Our own wrapper markup around an <img>; the file itself is still served
    // by the branch below (octet-stream for anything not inline-safe).
    if (req.query.preview === '1') {
      const width = Number(req.query.w)
      const height = Number(req.query.h)
      // The preview page loads the image through a plain <img>, which cannot
      // send an Authorization header — carry the query token over if the
      // caller authenticated that way.
      const token = typeof req.query.token === 'string' ? req.query.token : null
      const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : ''
      const style: string[] = ['max-width:100%', 'height:auto', 'display:block']
      if (Number.isFinite(width) && width > 0) style.push(`width:${Math.round(width)}px`)
      if (Number.isFinite(height) && height > 0) style.push(`max-height:${Math.round(height)}px`)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
      res.end(`<!doctype html><html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="/api/uploads/${encodeURIComponent(normalized).replace(/%2F/g, '/')}${tokenQuery}" alt="preview" style="${style.join(';')}" /></body></html>`)
      return
    }

    const downloadRequested = typeof req.query.download === 'string'
    const fileName = path.basename(absolutePath).replace(/["\\\r\n]/g, '')
    res.setHeader('Content-Type', contentType)
    if (!inline) {
      // Belt and braces for the types we refuse to render: even if a browser
      // ignored the octet-stream, a sandboxed document has no origin and no
      // script. Not set for inline types — it breaks the built-in PDF viewer.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    }
    res.setHeader(
      'Content-Disposition',
      `${inline && !downloadRequested ? 'inline' : 'attachment'}; filename="${fileName}"`,
    )
    res.sendFile(absolutePath, { dotfiles: 'allow' })
  } catch (err) {
    next(err)
  }
}
