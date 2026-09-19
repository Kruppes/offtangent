/**
 * The feed (SPEC 2.9, 3.2, 6.4): one place for everything unsolicited —
 * task results, task questions, cronjob reports, heartbeat notices,
 * reminders. Strictly separated from the strand dialogue, so background
 * noise cannot bury the conversation and cannot flood the strand list.
 *
 * Storage only. Who writes which item, and whether a strand sees it too,
 * is decided in `task-feed.ts`.
 *
 * Ordering: the list is chronological. `rowid` (insertion order) is the
 * cursor rather than `created_at`, because `datetime('now')` has one-second
 * resolution and two items written in the same second must still have a
 * stable, total order.
 */
import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'

export type FeedItemKind =
  | 'task_result'
  | 'task_question'
  | 'cron_report'
  | 'heartbeat'
  | 'reminder'
  | 'system'

export const FEED_ITEM_KINDS: readonly FeedItemKind[] = [
  'task_result',
  'task_question',
  'cron_report',
  'heartbeat',
  'reminder',
  'system',
] as const

export function isFeedItemKind(value: unknown): value is FeedItemKind {
  return typeof value === 'string' && (FEED_ITEM_KINDS as readonly string[]).includes(value)
}

/** The wire shape of a feed item (SPEC 6.4). */
export interface FeedItem {
  id: string
  kind: FeedItemKind
  title: string
  body: string | null
  agentId: string | null
  taskId: string | null
  strandId: string | null
  createdAt: string
  readAt: string | null
}

export interface InsertFeedItemInput {
  /** The user id as a string, same convention as `captures.user_id`. */
  userId: string
  kind: FeedItemKind
  title: string
  body?: string | null
  agentId?: string | null
  taskId?: string | null
  strandId?: string | null
}

export interface ListFeedOptions {
  /**
   * Cursor: only items written AFTER this feed item id, oldest first
   * (same semantics as `GET /api/chat/history?since_id=`). Without it the
   * newest items come first.
   */
  sinceId?: string | null
  limit?: number
  kind?: FeedItemKind
  unreadOnly?: boolean
}

interface FeedItemRow {
  id: string
  agent_id: string | null
  kind: string
  title: string
  body: string | null
  task_id: string | null
  strand_id: string | null
  created_at: string
  read_at: string | null
}

const FEED_COLUMNS = 'id, agent_id, kind, title, body, task_id, strand_id, created_at, read_at'

/** `YYYY-MM-DD HH:MM:SS` (SQLite) -> ISO 8601, anything else verbatim. */
function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return `${value.replace(' ', 'T')}Z`
  return value
}

function toFeedItem(row: FeedItemRow): FeedItem {
  return {
    id: row.id,
    kind: row.kind as FeedItemKind,
    title: row.title,
    body: row.body ?? null,
    agentId: row.agent_id ?? null,
    taskId: row.task_id ?? null,
    strandId: row.strand_id ?? null,
    createdAt: toIso(row.created_at) ?? row.created_at,
    readAt: toIso(row.read_at),
  }
}

/** The title column is NOT NULL; an empty title would render as a blank card. */
export const FEED_TITLE_MAX = 200

function normalizeTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  const title = collapsed.length > 0 ? collapsed : 'Untitled'
  return title.length > FEED_TITLE_MAX ? `${title.slice(0, FEED_TITLE_MAX - 1)}…` : title
}

export function insertFeedItem(db: Database, input: InsertFeedItemInput): FeedItem {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO feed_items (id, user_id, agent_id, kind, title, body, task_id, strand_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.agentId ?? null,
    input.kind,
    normalizeTitle(input.title),
    input.body ?? null,
    input.taskId ?? null,
    input.strandId ?? null,
  )
  return getFeedItem(db, input.userId, id)!
}

export function getFeedItem(db: Database, userId: string, id: string): FeedItem | null {
  const row = db.prepare(`SELECT ${FEED_COLUMNS} FROM feed_items WHERE user_id = ? AND id = ?`)
    .get(userId, id) as FeedItemRow | undefined
  return row ? toFeedItem(row) : null
}

/** Thrown as a plain sentinel: an unknown cursor is a client bug, not an empty page. */
export class UnknownFeedCursorError extends Error {
  constructor(id: string) {
    super(`Unknown feed cursor ${id}`)
    this.name = 'UnknownFeedCursorError'
  }
}

export function isUnknownFeedCursorError(err: unknown): err is UnknownFeedCursorError {
  return err instanceof UnknownFeedCursorError
}

export function listFeedItems(db: Database, userId: string, options: ListFeedOptions = {}): FeedItem[] {
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)))
  const where: string[] = ['user_id = ?']
  const params: unknown[] = [userId]
  if (options.kind) {
    where.push('kind = ?')
    params.push(options.kind)
  }
  if (options.unreadOnly) {
    where.push('read_at IS NULL')
  }

  // Cursor mode: everything the client has not seen yet, oldest first, so a
  // big gap is fetched in batches by feeding the last id back in.
  if (options.sinceId) {
    const cursor = db.prepare('SELECT rowid AS rid FROM feed_items WHERE user_id = ? AND id = ?')
      .get(userId, options.sinceId) as { rid: number } | undefined
    if (!cursor) throw new UnknownFeedCursorError(options.sinceId)
    where.push('rowid > ?')
    params.push(cursor.rid)
    const rows = db.prepare(
      `SELECT ${FEED_COLUMNS} FROM feed_items WHERE ${where.join(' AND ')} ORDER BY rowid ASC LIMIT ?`,
    ).all(...params, limit) as FeedItemRow[]
    return rows.map(toFeedItem)
  }

  const rows = db.prepare(
    `SELECT ${FEED_COLUMNS} FROM feed_items WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`,
  ).all(...params, limit) as FeedItemRow[]
  return rows.map(toFeedItem)
}

/**
 * Mark one item read. Idempotent: an already-read item keeps its original
 * `read_at`. Returns false when the item does not exist for that user, so
 * the caller can answer 404 instead of a silent 204.
 */
export function markFeedItemRead(db: Database, userId: string, id: string): boolean {
  const exists = db.prepare('SELECT 1 AS present FROM feed_items WHERE user_id = ? AND id = ?')
    .get(userId, id) as { present: number } | undefined
  if (!exists) return false
  db.prepare("UPDATE feed_items SET read_at = datetime('now') WHERE user_id = ? AND id = ? AND read_at IS NULL")
    .run(userId, id)
  return true
}

/** Mark every unread item of that user read. Returns how many rows changed. */
export function markAllFeedItemsRead(db: Database, userId: string): number {
  const result = db.prepare("UPDATE feed_items SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL")
    .run(userId)
  return result.changes
}

export function countUnreadFeedItems(db: Database, userId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM feed_items WHERE user_id = ? AND read_at IS NULL')
    .get(userId) as { count: number }
  return row.count
}
