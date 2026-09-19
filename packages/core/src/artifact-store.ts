/**
 * artifact-store.ts — persistence for canvas artifacts (SPEC 7.4b, R2).
 *
 * ## Why a table and not just `chat_messages.metadata`
 *
 * The SPEC asks for the artifact to be "persisted per message so the canvas
 * reopens from the strand later" and prefers reusing the upload path. The
 * BYTES do reuse the upload storage idea (same data volume, same date sharded
 * layout, same `DATA_DIR`), but the METADATA gets its own table because:
 *
 *  - `GET /api/artifacts?strandId=` has to list artifacts of a strand. Over
 *    `chat_messages.metadata` that is a `LIKE '%…%'` scan of the largest table
 *    in the database, per request, per client.
 *  - Ownership has to be checkable in one indexed read. An artifact URL is
 *    handed to untrusted HTML; "find the message, parse its JSON, compare the
 *    user" is the wrong amount of work for a security boundary.
 *  - `cleanupExpiredUploads()` deletes upload files after the retention window
 *    (30 days by default) AND nulls the message metadata. An artifact that
 *    lived there would disappear from the strand — the exact opposite of
 *    "the canvas reopens from the strand later". Artifacts therefore live
 *    under `DATA_DIR/artifacts/`, outside the retention sweep, and an artifact
 *    sourced from an upload COPIES the bytes so the canvas survives the
 *    deletion of the original upload.
 *  - The field list the product owner asked for (id, user, strand, message,
 *    kind, title, source, created_at, size) is a row, not a JSON blob.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import { getDataDir, getUploadsDir, parseUploadsMetadata } from './uploads.js'
import type { UploadDescriptor } from './uploads.js'
import {
  MAX_ARTIFACT_BYTES,
  artifactFileExtension,
  extractArtifactCandidates,
} from './artifact-extract.js'
import type { ArtifactCandidate, ArtifactKind, ArtifactSource } from './artifact-extract.js'

export interface Artifact {
  id: string
  userId: number
  /** `sessions.id` — a strand is a session (SPEC 6.2). */
  strandId: string
  messageId: number
  agentId: string | null
  kind: ArtifactKind
  title: string
  source: ArtifactSource
  mimeType: string
  size: number
  createdAt: string
}

interface ArtifactRow {
  id: string
  user_id: number
  strand_id: string
  message_id: number
  agent_id: string | null
  kind: string
  title: string
  source: string
  mime_type: string
  size: number
  content_path: string
  content_hash: string
  created_at: string
}

const ARTIFACT_COLUMNS =
  'id, user_id, strand_id, message_id, agent_id, kind, title, source, mime_type, size, content_path, content_hash, created_at'

/**
 * `artifacts`: one row per renderable artifact of one message.
 *
 * Additive and idempotent, no existing table is rebuilt. `content_path` is
 * relative to {@link getArtifactsDir} so the data directory stays movable.
 * The UNIQUE index over (message_id, content_hash) makes extraction idempotent:
 * re-running it over the same message never doubles an artifact.
 */
export function ensureArtifactTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      strand_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      agent_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('html','svg','image')),
      title TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('inline_fence','upload')),
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      content_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_strand ON artifacts(user_id, strand_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_message_hash ON artifacts(message_id, content_hash);
  `)
}

/** Root of the artifact byte store. Never the uploads dir: see file header. */
export function getArtifactsDir(): string {
  return path.join(getDataDir(), 'artifacts')
}

function toIso(value: string): string {
  const normalized = value.includes('Z') || value.includes('+') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    userId: row.user_id,
    strandId: row.strand_id,
    messageId: row.message_id,
    agentId: row.agent_id,
    kind: row.kind as ArtifactKind,
    title: row.title,
    source: row.source as ArtifactSource,
    mimeType: row.mime_type,
    size: row.size,
    createdAt: toIso(row.created_at),
  }
}

function datePath(date = new Date()): string {
  const y = String(date.getUTCFullYear())
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}/${m}/${d}`
}

function resolveContentPath(contentPath: string): string | null {
  const root = path.resolve(getArtifactsDir())
  const normalized = contentPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) return null
  const absolute = path.resolve(root, normalized)
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null
  return absolute
}

export interface InsertArtifactInput {
  userId: number
  strandId: string
  messageId: number
  agentId?: string | null
  kind: ArtifactKind
  title: string
  source: ArtifactSource
  mimeType: string
  content: Buffer
}

/**
 * Store the bytes and the row. Returns `null` when an identical artifact is
 * already attached to the message (idempotent re-extraction).
 *
 * Throws when the content exceeds {@link MAX_ARTIFACT_BYTES}; callers that
 * extract from a message filter oversized candidates before they get here.
 */
export function insertArtifact(db: Database, input: InsertArtifactInput): Artifact | null {
  if (input.content.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds the ${MAX_ARTIFACT_BYTES} byte limit`)
  }

  const hash = crypto.createHash('sha256').update(input.content).digest('hex')
  const existing = db.prepare(
    `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE message_id = ? AND content_hash = ?`,
  ).get(input.messageId, hash) as ArtifactRow | undefined
  if (existing) return null

  const id = crypto.randomUUID()
  const relative = `${datePath()}/${id}.${artifactFileExtension(input.kind)}`
  const absolute = resolveContentPath(relative)
  if (!absolute) throw new Error('Refusing to write an artifact outside the artifact directory')
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, input.content)

  db.prepare(
    `INSERT INTO artifacts (id, user_id, strand_id, message_id, agent_id, kind, title, source, mime_type, size, content_path, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.strandId,
    input.messageId,
    input.agentId ?? null,
    input.kind,
    input.title,
    input.source,
    input.mimeType,
    input.content.length,
    relative,
    hash,
  )

  const row = db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`).get(id) as ArtifactRow
  return toArtifact(row)
}

/** Metadata of one artifact, scoped to its owner. */
export function getArtifactForUser(db: Database, userId: number, id: string): Artifact | null {
  const row = db.prepare(
    `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ? AND user_id = ?`,
  ).get(id, userId) as ArtifactRow | undefined
  return row ? toArtifact(row) : null
}

export interface ListArtifactsOptions {
  strandId?: string
  limit?: number
  offset?: number
}

export function listArtifacts(db: Database, userId: number, options: ListArtifactsOptions = {}): Artifact[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)
  const params: unknown[] = [userId]
  let where = 'user_id = ?'
  if (options.strandId) {
    where += ' AND strand_id = ?'
    params.push(options.strandId)
  }
  const rows = db.prepare(
    `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE ${where} ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as ArtifactRow[]
  return rows.map(toArtifact)
}

/**
 * Artifacts of several messages at once, keyed by message id. This is what
 * lets the chat history carry its artifact references so no client has to
 * parse markdown to find out whether a message has a canvas.
 */
export function listArtifactsForMessages(
  db: Database,
  userId: number,
  messageIds: number[],
): Map<number, Artifact[]> {
  const result = new Map<number, Artifact[]>()
  if (messageIds.length === 0) return result
  const unique = [...new Set(messageIds)]
  const chunkSize = 400
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db.prepare(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE user_id = ? AND message_id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
    ).all(userId, ...chunk) as ArtifactRow[]
    for (const row of rows) {
      const artifact = toArtifact(row)
      const list = result.get(artifact.messageId)
      if (list) list.push(artifact)
      else result.set(artifact.messageId, [artifact])
    }
  }
  return result
}

/** Raw bytes of an artifact, or `null` when the file is gone. */
export function readArtifactContent(db: Database, id: string): Buffer | null {
  const row = db.prepare('SELECT content_path FROM artifacts WHERE id = ?').get(id) as
    | { content_path: string }
    | undefined
  if (!row) return null
  const absolute = resolveContentPath(row.content_path)
  if (!absolute) return null
  try {
    return fs.readFileSync(absolute)
  } catch {
    return null
  }
}

/**
 * Drop the artifacts of messages that are being deleted, files included.
 * Used by the turn transcript when a failed attempt is rolled back.
 */
export function deleteArtifactsForMessages(db: Database, messageIds: number[]): number {
  if (messageIds.length === 0) return 0
  const unique = [...new Set(messageIds)]
  const placeholders = unique.map(() => '?').join(', ')
  const rows = db.prepare(
    `SELECT id, content_path FROM artifacts WHERE message_id IN (${placeholders})`,
  ).all(...unique) as Array<{ id: string; content_path: string }>
  if (rows.length === 0) return 0
  const remove = db.prepare('DELETE FROM artifacts WHERE id = ?')
  for (const row of rows) {
    const absolute = resolveContentPath(row.content_path)
    if (absolute) {
      try {
        fs.rmSync(absolute, { force: true })
      } catch {
        // A file we cannot remove is not a reason to keep the row.
      }
    }
    remove.run(row.id)
  }
  return rows.length
}

/** Bytes of an upload referenced by a message, guarded against traversal. */
function readUploadBytes(relativePath: string): Buffer | null {
  const root = path.resolve(getUploadsDir())
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) return null
  const absolute = path.resolve(root, normalized)
  if (!absolute.startsWith(root + path.sep)) return null
  try {
    const stats = fs.statSync(absolute)
    if (!stats.isFile() || stats.size > MAX_ARTIFACT_BYTES) return null
    return fs.readFileSync(absolute)
  } catch {
    return null
  }
}

export interface RecordMessageArtifactsInput {
  messageId: number
  strandId: string
  userId: number
  agentId?: string | null
  content: string
  /** Upload descriptors of the message (from `metadata`), when already parsed. */
  uploads?: UploadDescriptor[]
  /** Raw `chat_messages.metadata`, parsed when `uploads` is not given. */
  metadata?: string | null
}

export interface RecordMessageArtifactsResult {
  artifacts: Artifact[]
  /** Candidates that were dropped, with the reason. Reported, never thrown. */
  skipped: Array<{ title: string; reason: 'too_large' | 'missing_content' | 'duplicate' | 'write_failed' }>
}

/**
 * Turn one persisted assistant message into artifact rows.
 *
 * Called from the single place every channel writes its assistant row
 * (`TurnRunner`), so the app, the web app and Telegram see the identical
 * artifact set. Never throws: a canvas that cannot be stored must not take
 * the answer down with it.
 */
export function recordMessageArtifacts(
  db: Database,
  input: RecordMessageArtifactsInput,
): RecordMessageArtifactsResult {
  const result: RecordMessageArtifactsResult = { artifacts: [], skipped: [] }
  if (!input.content && !input.metadata && !input.uploads?.length) return result

  const uploads = input.uploads ?? parseUploadsMetadata(input.metadata)
  let candidates: ArtifactCandidate[]
  try {
    candidates = extractArtifactCandidates(input.content ?? '', uploads)
  } catch (err) {
    console.error('[artifacts] extraction failed:', err)
    return result
  }
  if (candidates.length === 0) return result

  for (const candidate of candidates) {
    let content: Buffer | null = null
    if (candidate.source === 'inline_fence') {
      if (candidate.size > MAX_ARTIFACT_BYTES) {
        result.skipped.push({ title: candidate.title, reason: 'too_large' })
        continue
      }
      content = Buffer.from(candidate.body, 'utf8')
    } else {
      content = readUploadBytes(candidate.relativePath)
      if (!content) {
        result.skipped.push({ title: candidate.title, reason: 'missing_content' })
        continue
      }
    }

    try {
      const artifact = insertArtifact(db, {
        userId: input.userId,
        strandId: input.strandId,
        messageId: input.messageId,
        agentId: input.agentId ?? null,
        kind: candidate.kind,
        title: candidate.title,
        source: candidate.source,
        mimeType: candidate.mimeType,
        content,
      })
      if (artifact) result.artifacts.push(artifact)
      else result.skipped.push({ title: candidate.title, reason: 'duplicate' })
    } catch (err) {
      console.error('[artifacts] failed to persist artifact:', err)
      result.skipped.push({ title: candidate.title, reason: 'write_failed' })
    }
  }

  return result
}
