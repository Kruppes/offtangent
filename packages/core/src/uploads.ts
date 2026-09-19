import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from './database.js'
import { loadConfig } from './config.js'

export interface UploadSettings {
  uploads?: { retentionDays?: number }
  /**
   * Legacy top-level field. Kept here so that `getUploadRetentionDays()` can
   * fall back to it when an older `settings.json` from before the
   * `uploads.retentionDays` move is still on disk. New writes always go to
   * `uploads.retentionDays`.
   */
  uploadRetentionDays?: number
}

export interface UploadDescriptor {
  kind: 'image' | 'file'
  originalName: string
  storedName: string
  relativePath: string
  urlPath: string
  mimeType: string
  size: number
  previewUrl?: string
  width?: number
  height?: number
  /**
   * Delivery caption written by `send_file_to_user`. It travels on the
   * descriptor (not next to it) so that every consumer — the `attachment`
   * frame, the persisted `metadata.files` entry, Telegram — sees it without
   * a second, parallel channel for the same fact.
   */
  caption?: string
}

export interface SaveUploadInput {
  buffer: Buffer
  originalName?: string | null
  mimeType?: string | null
  source: 'web' | 'telegram'
  userId?: number | null
  sessionId?: string | null
}

/**
 * Same as {@link SaveUploadInput}, but the payload already sits on disk (a
 * streamed multipart upload) and is moved into place instead of being held in
 * the Node heap.
 */
export interface SaveUploadFromFileInput {
  sourcePath: string
  originalName?: string | null
  mimeType?: string | null
  source: 'web' | 'telegram'
  userId?: number | null
  sessionId?: string | null
}

const IMAGE_MIME_PREFIX = 'image/'
const PREVIEW_WIDTH = 640
const PREVIEW_HEIGHT = 640
const UPLOAD_TEMP_DIRNAME = '.tmp'
/** Header slice read back from disk to measure an image without loading it whole. */
const DIMENSION_HEADER_BYTES = 256 * 1024

export function getDataDir(): string {
  return process.env.DATA_DIR ?? '/data'
}

export function getUploadsDir(): string {
  return path.join(getDataDir(), 'uploads')
}

/**
 * Landing zone for in-flight multipart uploads. Lives inside the uploads dir
 * on purpose: the finished file is moved with a single `rename()`, which is
 * only atomic (and cheap) within the same filesystem.
 *
 * The leading dot keeps it out of the `YYYY/MM/DD` namespace, and
 * `sendUploadedFile` refuses to serve anything below it.
 */
export function getUploadsTempDir(): string {
  return path.join(getUploadsDir(), UPLOAD_TEMP_DIRNAME)
}

export function ensureUploadsTempDir(): string {
  const dir = getUploadsTempDir()
  ensureDir(dir)
  return dir
}

/**
 * Free bytes on the filesystem backing the uploads dir, or null when the
 * platform/filesystem does not report it. Callers treat null as "cannot tell,
 * do not block the upload".
 */
export function getFreeDiskBytes(dir: string = getUploadsDir()): number | null {
  try {
    ensureDir(dir)
    const stats = fs.statfsSync(dir)
    const free = Number(stats.bavail) * Number(stats.bsize)
    return Number.isFinite(free) ? free : null
  } catch {
    return null
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function sanitizeBaseName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'upload'
}

function sanitizeExtension(ext: string): string {
  const cleaned = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toLowerCase()
  return cleaned ? `.${cleaned}` : ''
}

function splitName(name?: string | null): { base: string; ext: string } {
  const fallback = 'upload'
  const input = (name ?? '').trim()
  const parsed = path.parse(input || fallback)
  return {
    base: sanitizeBaseName(parsed.name || fallback),
    ext: sanitizeExtension(parsed.ext || ''),
  }
}

function buildStorageKey(): string {
  return crypto.randomBytes(12).toString('hex')
}

function buildDatePath(date = new Date()): string {
  const y = String(date.getUTCFullYear())
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return path.join(y, m, d)
}

function detectKind(mimeType: string): 'image' | 'file' {
  return mimeType.startsWith(IMAGE_MIME_PREFIX) ? 'image' : 'file'
}

function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null
  if (buffer.toString('ascii', 1, 4) !== 'PNG') return null
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      offset += 1
      continue
    }

    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return null

    const isSof = marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)
    if (isSof && offset + 8 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      }
    }

    offset += 2 + length
  }

  return null
}

export function getImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png') return parsePngDimensions(buffer)
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return parseJpegDimensions(buffer)
  return null
}

function computePreviewSize(width: number, height: number): { width: number; height: number } {
  const ratio = Math.min(PREVIEW_WIDTH / width, PREVIEW_HEIGHT / height, 1)
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

interface StorageTarget {
  absolutePath: string
  storedName: string
  relativePath: string
  urlPath: string
  displayName: string
}

/**
 * Picks the on-disk name for an upload. The stored name is always generated
 * (random key + sanitized remainder of the original name); the name the user
 * typed only survives as `originalName` metadata.
 */
function buildStorageTarget(originalName?: string | null): StorageTarget {
  const { base, ext } = splitName(originalName)
  const datePath = buildDatePath()
  const storageDir = path.join(getUploadsDir(), datePath)
  ensureDir(storageDir)

  const storedName = `${buildStorageKey()}-${base}${ext}`
  const relativePath = path.posix.join(...datePath.split(path.sep), storedName)

  return {
    absolutePath: path.join(storageDir, storedName),
    storedName,
    relativePath,
    urlPath: `/api/uploads/${relativePath}`,
    displayName: `${base}${ext}`,
  }
}

function applyImageDimensions(result: UploadDescriptor, dimensions: { width: number; height: number } | null): void {
  if (!dimensions) return
  const preview = computePreviewSize(dimensions.width, dimensions.height)
  result.width = dimensions.width
  result.height = dimensions.height
  result.previewUrl = `${result.urlPath}?preview=1&w=${preview.width}&h=${preview.height}`
}

/** Reads just the header of a stored file so a 500 MB video never hits the heap. */
function readHeader(absolutePath: string, bytes = DIMENSION_HEADER_BYTES): Buffer | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(absolutePath, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = fs.readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export function saveUpload(input: SaveUploadInput): UploadDescriptor {
  const mimeType = input.mimeType?.trim() || 'application/octet-stream'
  const kind = detectKind(mimeType)
  const target = buildStorageTarget(input.originalName)
  fs.writeFileSync(target.absolutePath, input.buffer)

  const result: UploadDescriptor = {
    kind,
    originalName: target.displayName,
    storedName: target.storedName,
    relativePath: target.relativePath,
    urlPath: target.urlPath,
    mimeType,
    size: input.buffer.length,
  }

  if (kind === 'image') {
    applyImageDimensions(result, getImageDimensions(input.buffer, mimeType))
  }

  return result
}

/**
 * Moves an already streamed file into the uploads dir. Used by the multipart
 * path so arbitrarily large uploads never exist as a Buffer.
 *
 * `rename` across filesystems fails with EXDEV — then, and only then, we fall
 * back to a streaming copy.
 */
export function saveUploadFromFile(input: SaveUploadFromFileInput): UploadDescriptor {
  const mimeType = input.mimeType?.trim() || 'application/octet-stream'
  const kind = detectKind(mimeType)
  const target = buildStorageTarget(input.originalName)

  try {
    fs.renameSync(input.sourcePath, target.absolutePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    fs.copyFileSync(input.sourcePath, target.absolutePath)
    fs.rmSync(input.sourcePath, { force: true })
  }

  const result: UploadDescriptor = {
    kind,
    originalName: target.displayName,
    storedName: target.storedName,
    relativePath: target.relativePath,
    urlPath: target.urlPath,
    mimeType,
    size: fs.statSync(target.absolutePath).size,
  }

  if (kind === 'image' && result.size <= DIMENSION_READ_LIMIT) {
    const header = readHeader(target.absolutePath)
    if (header) applyImageDimensions(result, getImageDimensions(header, mimeType))
  }

  return result
}

/** Largest file the descriptor resolver measures at all (bigger ones keep no dimensions). */
const DIMENSION_READ_LIMIT = 512 * 1024 * 1024

function sanitizeMimeType(value: unknown): string {
  if (typeof value !== 'string') return 'application/octet-stream'
  const cleaned = value.trim().toLowerCase().slice(0, 100)
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(cleaned) ? cleaned : 'application/octet-stream'
}

/**
 * Turns a reference to an ALREADY stored upload back into a descriptor the
 * server vouches for.
 *
 * Only `relativePath` is load bearing: it is normalized, checked for traversal
 * and has to point at an existing file inside the uploads dir. Everything the
 * caller could lie about is recomputed here (size from `stat`, url paths from
 * the resolved path, kind from the sanitized mime type), so a client can at
 * worst mislabel a file it could already read.
 *
 * This is what lets a recording that `POST /api/stt/transcribe?keepAudio=1`
 * stored become the attachment of the message carrying its transcript, without
 * uploading the same bytes twice.
 */
export function resolveStoredUpload(input: unknown): UploadDescriptor | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const requested = typeof raw.relativePath === 'string' ? raw.relativePath : ''
  if (!requested) return null

  const normalized = path.posix.normalize(requested.replace(/\\/g, '/')).replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) return null

  const uploadsDir = path.resolve(getUploadsDir())
  const absolutePath = path.resolve(uploadsDir, normalized)
  if (!absolutePath.startsWith(uploadsDir + path.sep)) return null

  let stats: fs.Stats
  try {
    stats = fs.statSync(absolutePath)
  } catch {
    return null
  }
  if (!stats.isFile()) return null

  const storedName = path.posix.basename(normalized)
  const mimeType = sanitizeMimeType(raw.mimeType)
  const kind = detectKind(mimeType)
  const requestedName = typeof raw.originalName === 'string' && raw.originalName.trim()
    ? raw.originalName
    : storedName
  const { base, ext } = splitName(requestedName)
  const urlPath = `/api/uploads/${normalized}`

  const result: UploadDescriptor = {
    kind,
    originalName: `${base}${ext}`,
    storedName,
    relativePath: normalized,
    urlPath,
    mimeType,
    size: stats.size,
  }

  if (kind === 'image' && stats.size <= DIMENSION_READ_LIMIT) {
    const header = readHeader(absolutePath)
    if (header) applyImageDimensions(result, getImageDimensions(header, mimeType))
  }

  return result
}

export function serializeUploadsMetadata(files: UploadDescriptor[]): string {
  return JSON.stringify({ files })
}

export function parseUploadsMetadata(metadata?: string | null): UploadDescriptor[] {
  if (!metadata) return []
  try {
    const parsed = JSON.parse(metadata) as { files?: UploadDescriptor[] }
    return Array.isArray(parsed.files) ? parsed.files : []
  } catch {
    return []
  }
}

export function getUploadRetentionDays(): number {
  try {
    const settings = loadConfig<UploadSettings>('settings.json')
    const days = settings.uploads?.retentionDays
    if (typeof days === 'number' && Number.isFinite(days) && days >= 0) return days
    // Legacy fallback: older installs kept this at the top level of
    // settings.json. Read it here so an upgrade does not silently revert
    // a customised retention value to the default.
    const legacyDays = settings.uploadRetentionDays
    if (typeof legacyDays === 'number' && Number.isFinite(legacyDays) && legacyDays >= 0) return legacyDays
  } catch {
    // ignore
  }
  return 30
}

/** Age after which a `.tmp` part file is considered abandoned (client vanished mid-upload). */
const TEMP_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Removes leftovers of interrupted multipart uploads. A part file is only ever
 * touched by one request, so anything older than a day has no owner left.
 */
export function cleanupStaleTempUploads(now = new Date(), maxAgeMs = TEMP_UPLOAD_MAX_AGE_MS): number {
  const tempDir = getUploadsTempDir()
  let removed = 0
  let entries: string[]
  try {
    entries = fs.readdirSync(tempDir)
  } catch {
    return 0
  }

  for (const entry of entries) {
    const absolutePath = path.join(tempDir, entry)
    try {
      const stats = fs.statSync(absolutePath)
      if (!stats.isFile()) continue
      if (now.getTime() - stats.mtimeMs < maxAgeMs) continue
      fs.rmSync(absolutePath, { force: true })
      removed += 1
    } catch {
      // A part file that disappeared underneath us is exactly what we wanted.
    }
  }

  return removed
}

export function cleanupExpiredUploads(db: Database, now = new Date()): { deletedFiles: number; deletedMessages: number; deletedTempFiles: number } {
  const retentionDays = getUploadRetentionDays()
  // The comparison below is a STRING compare against `chat_messages.timestamp`,
  // which SQLite writes as `2026-09-15 06:15:53`. An ISO cutoff (`...T...Z`)
  // is not comparable to that: `' ' < 'T'`, so every row of the cutoff day
  // counted as older than the cutoff and its attachments were deleted up to a
  // day early. The cutoff therefore speaks the column's own dialect.
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)
  const rows = db.prepare(
    `SELECT id, metadata FROM chat_messages WHERE metadata IS NOT NULL AND timestamp < ? AND (
      metadata LIKE '%"relativePath"%' OR metadata LIKE '%"files"%'
    )`
  ).all(cutoff) as Array<{ id: number; metadata: string | null }>

  let deletedFiles = 0
  let deletedMessages = 0

  for (const row of rows) {
    const files = parseUploadsMetadata(row.metadata)
    if (files.length === 0) continue

    for (const file of files) {
      const absolutePath = path.join(getUploadsDir(), file.relativePath)
      if (absolutePath.startsWith(getUploadsDir()) && fs.existsSync(absolutePath)) {
        fs.rmSync(absolutePath, { force: true })
        deletedFiles += 1
      }
    }

    db.prepare('UPDATE chat_messages SET metadata = NULL WHERE id = ?').run(row.id)
    deletedMessages += 1
  }

  return { deletedFiles, deletedMessages, deletedTempFiles: cleanupStaleTempUploads(now) }
}
