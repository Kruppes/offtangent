import type { Database } from './database.js'
import type { UploadDescriptor } from './uploads.js'
import { parseUploadsMetadata } from './uploads.js'
import { errorClass } from './log-safe-error.js'

/**
 * How far back an unanswered user message may lie and still hand its images
 * to the next turn. Long enough for "photos, then a voice note" (upload and
 * transcription take seconds), short enough that a photo nobody answered days
 * ago does not resurface in an unrelated turn.
 */
export const UNANSWERED_ATTACHMENT_WINDOW_MS = 10 * 60 * 1000

/** At most this many earlier images join a turn (the newest ones win). */
export const UNANSWERED_ATTACHMENT_MAX_IMAGES = 8

export interface CollectUnansweredImagesInput {
  sessionId: string
  /**
   * Owner of the strand rows. Rows of another user never travel; rows
   * without a user (`NULL`, legacy) are tolerated because a strand belongs to
   * one user anyway. `null` collects nothing (such turns persist nothing).
   */
  userId: number | null
  /** The message the turn is about; only rows BEFORE it are collected. */
  beforeMessageId: number
  windowMs?: number
  maxImages?: number
  now?: Date
}

export interface UnansweredImages {
  uploads: UploadDescriptor[]
  /** The rows the uploads come from (to mark them as taken). */
  messageIds: number[]
}

/** `chat_messages.timestamp` format: `YYYY-MM-DD HH:MM:SS`, UTC, no zone. */
function sqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Settled rows never hand their images to a later turn:
 *  - `imagesDiscarded`: the message was dropped by a stop while it waited
 *    for a follow-up (hold) — the user cancelled it;
 *  - `imagesTakenBy`: a turn already started with these images. Whatever
 *    that turn did afterwards (answered, stopped, killed, failed), the images
 *    had their turn; a stopped turn must not bring them back.
 */
function isSettled(meta: Record<string, unknown>): boolean {
  return meta.imagesDiscarded === true || typeof meta.imagesTakenBy === 'string'
}

/**
 * Images of the user messages of `sessionId` that no turn answered or took
 * yet: user rows of `userId` after the last assistant row and before
 * `beforeMessageId`, inside the window, not settled (see {@link isSettled}).
 * A message with only photos and no text whose turn never started ends up
 * here; the next turn of the strand must see those photos as image blocks.
 *
 * Only images travel: a recording or a document of an earlier row is already
 * represented by its text (transcript, caption), and re-inlining files would
 * blow up the context. At most `maxImages` (default 8): the newest win, the
 * result keeps the order in which they were sent.
 */
export function collectUnansweredImages(db: Database, input: CollectUnansweredImagesInput): UnansweredImages {
  if (input.userId === null) return { uploads: [], messageIds: [] }
  const windowMs = input.windowMs ?? UNANSWERED_ATTACHMENT_WINDOW_MS
  const maxImages = Math.max(0, input.maxImages ?? UNANSWERED_ATTACHMENT_MAX_IMAGES)
  if (maxImages === 0) return { uploads: [], messageIds: [] }
  const cutoff = sqliteUtc(new Date((input.now ?? new Date()).getTime() - windowMs))
  const lastAnswer = db.prepare(
    "SELECT MAX(id) AS id FROM chat_messages WHERE session_id = ? AND role = 'assistant' AND id < ?",
  ).get(input.sessionId, input.beforeMessageId) as { id: number | null } | undefined
  const rows = db.prepare(
    `SELECT id, metadata FROM chat_messages
      WHERE session_id = ? AND role = 'user' AND (user_id = ? OR user_id IS NULL)
        AND id > ? AND id < ?
        AND metadata IS NOT NULL AND timestamp >= ?
      ORDER BY id DESC
      LIMIT 50`,
  ).all(input.sessionId, input.userId, lastAnswer?.id ?? 0, input.beforeMessageId, cutoff) as Array<{ id: number; metadata: string | null }>
  // Newest row first, newest image of a row first, until the cap is reached.
  const picked: Array<{ id: number; upload: UploadDescriptor }> = []
  for (const row of rows) {
    if (picked.length >= maxImages) break
    if (isSettled(parseMeta(row.metadata))) continue
    const images = parseUploadsMetadata(row.metadata).filter(upload => upload.kind === 'image')
    for (let i = images.length - 1; i >= 0 && picked.length < maxImages; i--) {
      picked.push({ id: row.id, upload: images[i]! })
    }
  }
  picked.reverse()
  return {
    uploads: picked.map(p => p.upload),
    messageIds: [...new Set(picked.map(p => p.id))],
  }
}

/** Uploads only; see {@link collectUnansweredImages}. */
export function collectUnansweredImageUploads(db: Database, input: CollectUnansweredImagesInput): UploadDescriptor[] {
  return collectUnansweredImages(db, input).uploads
}

/**
 * Stamps user rows so their images never join a later turn again: either
 * `{ discarded: true }` (a stop dropped the held message) or
 * `{ takenByTurnId }` (a turn started with them). Read-modify-write of
 * `metadata`, other keys stay. Best effort: a failed write is logged and
 * leaves the row as it was.
 */
export function markImagesSettled(
  db: Database | null | undefined,
  messageIds: Iterable<number | null | undefined>,
  state: { discarded: true } | { takenByTurnId: string },
): void {
  if (!db) return
  for (const id of new Set(messageIds)) {
    if (id === null || id === undefined) continue
    try {
      const row = db.prepare("SELECT metadata FROM chat_messages WHERE id = ? AND role = 'user'").get(id) as { metadata: string | null } | undefined
      if (!row) continue
      const meta = parseMeta(row.metadata)
      // Only rows that carry images matter for the collection.
      if (!parseUploadsMetadata(row.metadata).some(upload => upload.kind === 'image')) continue
      if (isSettled(meta)) continue
      const next = 'discarded' in state
        ? { ...meta, imagesDiscarded: true }
        : { ...meta, imagesTakenBy: state.takenByTurnId }
      db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(JSON.stringify(next), id)
    } catch (err) {
      console.warn(`[unanswered-attachments] Could not mark message ${id}: ${errorClass(err)}`)
    }
  }
}

/** `first` then the entries of `second` that are not in it yet (same stored file). */
export function mergeUploads(first: UploadDescriptor[] | undefined, second: UploadDescriptor[] | undefined): UploadDescriptor[] {
  const merged: UploadDescriptor[] = []
  const seen = new Set<string>()
  for (const upload of [...(first ?? []), ...(second ?? [])]) {
    const key = upload.relativePath || upload.storedName
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(upload)
  }
  return merged
}
