/**
 * strand-delete.ts: the hard delete of a strand and its preview (SPEC 7.5b).
 *
 * Archiving hides a strand and keeps every row; deleting is a real delete:
 * the `sessions` row and everything written under it leaves the database in
 * ONE transaction — messages, captures and their router decisions, tag links,
 * strand links in both directions, the now-set slot, resurface snoozes and
 * the stored summaries. Attachment files that no surviving row references any
 * more are unlinked from the uploads directory AFTER the transaction
 * committed (a filesystem unlink cannot participate in a SQLite transaction,
 * so rows-first is the only order that cannot leave a message pointing at a
 * file that is already gone).
 *
 * Facts (`memories` rows carrying the strand as `session_id`) are NOT part of
 * the cascade unless the caller asks for it: knowledge lives above strands
 * (SPEC 2.2), and a fact is usually the only surviving value of a dead strand.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import { getUploadsDir, parseUploadsMetadata } from './uploads.js'
import type { UploadDescriptor } from './uploads.js'
import { getArtifactsDir } from './artifact-store.js'

/** A fact the delete would take with it when `deleteFacts` is set. */
export interface StrandFactRef {
  id: number
  text: string
}

/** What a delete of this strand would remove (SPEC 6.2 delete-preview). */
export interface StrandDeletePreview {
  strandId: string
  title: string | null
  messages: number
  captures: number
  decisions: number
  /** Attachment FILES that no surviving row references any more. */
  attachments: number
  /** Canvas artifacts (SPEC 7.4b) written under this strand. */
  artifacts: number
  tags: number
  links: number
  nowSlot: boolean
  snoozes: number
  summaries: number
  toolCalls: number
  facts: StrandFactRef[]
}

/** Row counts a delete actually removed. */
export interface StrandDeleteResult {
  messages: number
  captures: number
  decisions: number
  attachments: number
  artifacts: number
  tags: number
  links: number
  nowSlot: boolean
  snoozes: number
  summaries: number
  toolCalls: number
  facts: number
}

function count(db: Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { c: number } | undefined
  return row ? row.c : 0
}

/** Attachment descriptors referenced by the messages and captures of a strand. */
function strandAttachments(db: Database, strandId: string): UploadDescriptor[] {
  const out: UploadDescriptor[] = []
  const seen = new Set<string>()
  const push = (files: UploadDescriptor[]): void => {
    for (const file of files) {
      if (!file || typeof file.relativePath !== 'string' || !file.relativePath) continue
      if (seen.has(file.relativePath)) continue
      seen.add(file.relativePath)
      out.push(file)
    }
  }

  const messages = db.prepare(
    'SELECT metadata FROM chat_messages WHERE session_id = ? AND metadata IS NOT NULL',
  ).all(strandId) as Array<{ metadata: string | null }>
  for (const row of messages) push(parseUploadsMetadata(row.metadata))

  const captures = db.prepare(
    'SELECT attachments FROM captures WHERE strand_id = ? AND attachments IS NOT NULL',
  ).all(strandId) as Array<{ attachments: string | null }>
  for (const row of captures) {
    try {
      const parsed = JSON.parse(row.attachments ?? '[]') as UploadDescriptor[]
      if (Array.isArray(parsed)) push(parsed)
    } catch {
      // A capture row with unreadable attachment JSON contributes nothing;
      // dropping files on a guess would delete somebody else's upload.
    }
  }
  return out
}

/**
 * Files of this strand that NOTHING outside it references. The needle is the
 * stored relative path, which is unique per upload (random storage key), so a
 * substring match against the JSON blobs is exact enough and stays
 * parameterized.
 */
function orphanAttachments(db: Database, strandId: string): UploadDescriptor[] {
  const candidates = strandAttachments(db, strandId)
  if (candidates.length === 0) return []
  const messageRef = db.prepare(
    `SELECT COUNT(*) AS c FROM chat_messages
     WHERE session_id <> ? AND metadata IS NOT NULL AND metadata LIKE '%' || ? || '%'`,
  )
  const captureRef = db.prepare(
    `SELECT COUNT(*) AS c FROM captures
     WHERE (strand_id IS NULL OR strand_id <> ?) AND attachments IS NOT NULL
       AND attachments LIKE '%' || ? || '%'`,
  )
  return candidates.filter((file) => {
    const elsewhere = (messageRef.get(strandId, file.relativePath) as { c: number }).c
      + (captureRef.get(strandId, file.relativePath) as { c: number }).c
    return elsewhere === 0
  })
}

/**
 * Unlink upload files, refusing anything that resolves outside the uploads
 * directory (path traversal guard, same rule as the uploads route). Returns
 * the number of files actually removed.
 */
export function removeUploadFiles(files: UploadDescriptor[]): number {
  if (files.length === 0) return 0
  const uploadsDir = path.resolve(getUploadsDir())
  let removed = 0
  for (const file of files) {
    const absolute = path.resolve(uploadsDir, file.relativePath)
    if (absolute !== uploadsDir && !absolute.startsWith(uploadsDir + path.sep)) {
      console.warn(`[strand] Refusing to delete attachment outside the uploads dir: ${file.relativePath}`)
      continue
    }
    try {
      if (!fs.existsSync(absolute)) continue
      fs.rmSync(absolute, { force: true })
      removed += 1
    } catch (err) {
      console.error(`[strand] Failed to delete attachment ${file.relativePath}:`, err)
    }
  }
  return removed
}

/**
 * Content paths of the canvas artifacts of this strand, relative to the
 * artifact directory. Read before the transaction so the files can be
 * unlinked after it committed — same rows-first order as the attachments.
 */
function artifactContentPaths(db: Database, strandId: string): string[] {
  return (db.prepare('SELECT content_path AS p FROM artifacts WHERE strand_id = ?').all(strandId) as Array<{ p: string }>)
    .map(row => row.p)
}

/** Unlink artifact files, refusing anything that escapes the artifact directory. */
function removeArtifactFiles(contentPaths: string[]): number {
  if (contentPaths.length === 0) return 0
  const artifactsDir = path.resolve(getArtifactsDir())
  let removed = 0
  for (const relative of contentPaths) {
    const absolute = path.resolve(artifactsDir, relative)
    if (absolute !== artifactsDir && !absolute.startsWith(artifactsDir + path.sep)) {
      console.warn(`[strand] Refusing to delete an artifact outside the artifact dir: ${relative}`)
      continue
    }
    try {
      if (!fs.existsSync(absolute)) continue
      fs.rmSync(absolute, { force: true })
      removed += 1
    } catch (err) {
      console.error(`[strand] Failed to delete artifact ${relative}:`, err)
    }
  }
  return removed
}

/** Facts (memories) that carry this strand as their source. */
export function listStrandFacts(db: Database, userId: string, strandId: string): StrandFactRef[] {
  const rows = db.prepare(
    'SELECT id, content FROM memories WHERE session_id = ? AND CAST(user_id AS TEXT) = ? ORDER BY id ASC',
  ).all(strandId, userId) as Array<{ id: number; content: string }>
  return rows.map(r => ({ id: r.id, text: r.content }))
}

/**
 * Count everything a delete of `strandId` would remove. The caller has
 * already verified ownership; this function does not look at users except
 * for the facts, which are user scoped.
 */
export function previewStrandDelete(db: Database, userId: string, strandId: string): StrandDeletePreview {
  const strand = db.prepare('SELECT title FROM sessions WHERE id = ?').get(strandId) as { title: string | null } | undefined
  return {
    strandId,
    title: strand?.title ?? null,
    messages: count(db, 'SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?', strandId),
    captures: count(db, 'SELECT COUNT(*) AS c FROM captures WHERE strand_id = ?', strandId),
    decisions: count(
      db,
      'SELECT COUNT(*) AS c FROM router_decisions WHERE capture_id IN (SELECT id FROM captures WHERE strand_id = ?)',
      strandId,
    ),
    attachments: orphanAttachments(db, strandId).length,
    artifacts: count(db, 'SELECT COUNT(*) AS c FROM artifacts WHERE strand_id = ?', strandId),
    tags: count(db, 'SELECT COUNT(*) AS c FROM strand_tags WHERE strand_id = ?', strandId),
    links: count(db, 'SELECT COUNT(*) AS c FROM strand_links WHERE from_strand = ? OR to_strand = ?', strandId, strandId),
    nowSlot: count(db, 'SELECT COUNT(*) AS c FROM now_set WHERE strand_id = ? AND user_id = ?', strandId, userId) > 0,
    snoozes: count(db, 'SELECT COUNT(*) AS c FROM resurface_snoozes WHERE strand_id = ?', strandId),
    summaries: count(db, 'SELECT COUNT(*) AS c FROM session_summaries WHERE session_id = ?', strandId),
    toolCalls: count(db, 'SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = ?', strandId),
    facts: listStrandFacts(db, userId, strandId),
  }
}

export interface DeleteStrandOptions {
  /** Also delete the facts that carry this strand as their source. Default: keep. */
  deleteFacts?: boolean
}

/**
 * Delete a strand and everything written under it. Ownership and the runtime
 * guards (`strand_busy`, transcript eviction) belong to the caller — by the
 * time this runs, the rows are expected to be free.
 *
 * `token_usage` rows keep their `session_id`: they are cost accounting, carry
 * no conversation content, and retroactively rewriting spend would corrupt
 * the usage history.
 */
export function deleteStrand(
  db: Database,
  userId: string,
  strandId: string,
  options: DeleteStrandOptions = {},
): StrandDeleteResult {
  const preview = previewStrandDelete(db, userId, strandId)
  const orphans = orphanAttachments(db, strandId)
  const artifactPaths = artifactContentPaths(db, strandId)

  const tx = db.transaction(() => {
    db.prepare(
      'DELETE FROM router_decisions WHERE capture_id IN (SELECT id FROM captures WHERE strand_id = ?)',
    ).run(strandId)
    db.prepare('DELETE FROM captures WHERE strand_id = ?').run(strandId)
    db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(strandId)
    db.prepare('DELETE FROM strand_tags WHERE strand_id = ?').run(strandId)
    db.prepare('DELETE FROM strand_links WHERE from_strand = ? OR to_strand = ?').run(strandId, strandId)
    db.prepare('DELETE FROM now_set WHERE strand_id = ?').run(strandId)
    db.prepare('DELETE FROM resurface_snoozes WHERE strand_id = ?').run(strandId)
    db.prepare('DELETE FROM session_summaries WHERE session_id = ?').run(strandId)
    db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(strandId)
    db.prepare('DELETE FROM artifacts WHERE strand_id = ?').run(strandId)
    if (options.deleteFacts) {
      db.prepare('DELETE FROM memories WHERE session_id = ? AND CAST(user_id AS TEXT) = ?').run(strandId, userId)
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(strandId)
  })
  tx()

  const removedFiles = removeUploadFiles(orphans)
  removeArtifactFiles(artifactPaths)

  return {
    messages: preview.messages,
    captures: preview.captures,
    decisions: preview.decisions,
    attachments: removedFiles,
    artifacts: preview.artifacts,
    tags: preview.tags,
    links: preview.links,
    nowSlot: preview.nowSlot,
    snoozes: preview.snoozes,
    summaries: preview.summaries,
    toolCalls: preview.toolCalls,
    facts: options.deleteFacts ? preview.facts.length : 0,
  }
}

/**
 * True while a delegated task still hangs on this strand (SPEC 7.5b / ch. 10):
 * deleting the rows underneath a running task would let its injection write
 * the session back into existence.
 */
export function hasLiveTaskForStrand(db: Database, strandId: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS c FROM tasks WHERE session_id = ? AND status IN ('running', 'paused') LIMIT 1",
  ).get(strandId) as { c: number } | undefined
  return !!row
}
