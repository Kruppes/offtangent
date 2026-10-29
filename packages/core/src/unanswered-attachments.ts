import type { Database } from './database.js'
import type { UploadDescriptor } from './uploads.js'
import { parseUploadsMetadata } from './uploads.js'

/**
 * How far back an unanswered user message may lie and still hand its images
 * to the next turn. Long enough for "photos, then a voice note" (upload and
 * transcription take seconds), short enough that a photo nobody answered days
 * ago does not resurface in an unrelated turn.
 */
export const UNANSWERED_ATTACHMENT_WINDOW_MS = 10 * 60 * 1000

export interface CollectUnansweredImagesInput {
  sessionId: string
  /** The message the turn is about; only rows BEFORE it are collected. */
  beforeMessageId: number
  windowMs?: number
  now?: Date
}

/** `chat_messages.timestamp` format: `YYYY-MM-DD HH:MM:SS`, UTC, no zone. */
function sqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Images of the user messages of `sessionId` that no turn answered yet: user
 * rows after the last assistant row and before `beforeMessageId`, inside the
 * window. A message with only photos and no text, followed seconds later by a
 * voice note, ends up here; the turn of the voice note must see those photos
 * as image blocks, not just its own attachments.
 *
 * Only images travel: a recording or a document of an earlier row is already
 * represented by its text (transcript, caption), and re-inlining files would
 * blow up the context.
 */
export function collectUnansweredImageUploads(db: Database, input: CollectUnansweredImagesInput): UploadDescriptor[] {
  const windowMs = input.windowMs ?? UNANSWERED_ATTACHMENT_WINDOW_MS
  const cutoff = sqliteUtc(new Date((input.now ?? new Date()).getTime() - windowMs))
  const lastAnswer = db.prepare(
    "SELECT MAX(id) AS id FROM chat_messages WHERE session_id = ? AND role = 'assistant' AND id < ?",
  ).get(input.sessionId, input.beforeMessageId) as { id: number | null } | undefined
  const rows = db.prepare(
    `SELECT metadata FROM chat_messages
      WHERE session_id = ? AND role = 'user' AND id > ? AND id < ?
        AND metadata IS NOT NULL AND timestamp >= ?
      ORDER BY id`,
  ).all(input.sessionId, lastAnswer?.id ?? 0, input.beforeMessageId, cutoff) as Array<{ metadata: string | null }>
  const images: UploadDescriptor[] = []
  for (const row of rows) {
    for (const upload of parseUploadsMetadata(row.metadata)) {
      if (upload.kind === 'image') images.push(upload)
    }
  }
  return images
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
