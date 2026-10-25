/**
 * The "note from Main" on the status screens: one short line Main (or any
 * agent with file access under DATA_DIR) can set without credentials.
 *
 * One note per user, never shared across users: the status of user `<id>`
 * shows `${DATA_DIR}/status/note-<id>.json` (directory override:
 * `STATUS_NOTE_DIR`):
 *
 *   { "text": "Deploy läuft, bitte nichts mergen", "expires_at": "2026-10-25T18:00:00Z" }
 *
 * `expires_at` is optional; once it lies in the past the note is gone. A
 * missing file, an empty text or unreadable JSON all mean "no note"; the last
 * one logs a warning once per file content. A file larger than
 * {@link STATUS_NOTE_FILE_MAX} bytes is not parsed at all (no note, one
 * warning). A former shared `note.json` is deliberately never read: it would
 * show one user's note to every user.
 *
 * Change detection hashes the content (at most 8 KB per poll), not mtime and
 * size: an edit within the same second and of the same length is still seen.
 *
 * Why a file and not an API: an API needs a credential the agent would have to
 * hold; the file lives in the agent's own data volume, so writing it is exactly
 * as privileged as the agent already is, and deleting it clears the note.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { lineText } from './status.js'

export const STATUS_NOTE_MAX = 160
/** Largest note file that is read at all, in bytes. */
export const STATUS_NOTE_FILE_MAX = 8 * 1024

export interface StatusNote {
  text: string
  expiresAt: string | null
}

export function defaultNoteDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STATUS_NOTE_DIR?.trim()) return env.STATUS_NOTE_DIR.trim()
  return path.join(env.DATA_DIR ?? '/data', 'status')
}

/** File name of the note of one user; the id is an integer, so no path tricks. */
export function noteFileName(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('invalid user id')
  return `note-${userId}.json`
}

/** Parses the file content; null for "no note". Throws on invalid JSON / shape. */
export function parseStatusNote(raw: string): { text: string; expiresAt: string | null } | null {
  const data = JSON.parse(raw) as unknown
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('note must be a JSON object')
  const record = data as Record<string, unknown>
  if (typeof record.text !== 'string') throw new Error('note.text must be a string')
  const text = lineText(record.text, STATUS_NOTE_MAX)
  if (!text) return null
  let expiresAt: string | null = null
  if (record.expires_at !== undefined && record.expires_at !== null) {
    const ms = typeof record.expires_at === 'string' ? Date.parse(record.expires_at) : NaN
    if (!Number.isFinite(ms)) throw new Error('note.expires_at must be an ISO-8601 timestamp')
    expiresAt = new Date(ms).toISOString()
  }
  return { text, expiresAt }
}

/**
 * Reads at most `max + 1` bytes; null when the file does not exist, `'too_big'`
 * when it holds more than `max` bytes.
 */
function readCapped(file: string, max: number): Buffer | 'too_big' | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(max + 1)
    let length = 0
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length)
      if (read === 0) break
      length += read
    }
    return length > max ? 'too_big' : buffer.subarray(0, length)
  } finally {
    fs.closeSync(fd)
  }
}

interface CachedNote {
  hash: string
  note: StatusNote | null
}

export class StatusNoteSource {
  private readonly cache = new Map<number, CachedNote>()

  constructor(
    private readonly dir: string = defaultNoteDir(),
    private readonly maxBytes: number = STATUS_NOTE_FILE_MAX,
  ) {}

  /** Path of the note of `userId`. */
  fileFor(userId: number): string {
    return path.join(this.dir, noteFileName(userId))
  }

  /** The current note of `userId`, or null (no file, empty, too big, expired or unreadable). */
  read(userId: number, now: number = Date.now()): StatusNote | null {
    const file = this.fileFor(userId)
    let raw: Buffer | 'too_big' | null
    try {
      raw = readCapped(file, this.maxBytes)
    } catch (err) {
      raw = null
      this.warnOnce(userId, `error:${(err as Error).message}`, `ignoring ${file}: ${(err as Error).message}`)
    }
    if (raw === null) {
      if (!this.cache.get(userId)?.hash.startsWith('error:')) this.cache.delete(userId)
      return null
    }
    if (raw === 'too_big') {
      this.warnOnce(userId, 'too_big', `ignoring ${file}: larger than ${this.maxBytes} bytes`)
      return null
    }
    const hash = crypto.createHash('sha256').update(raw).digest('hex')
    let entry = this.cache.get(userId)
    if (entry?.hash !== hash) {
      let note: StatusNote | null = null
      try {
        note = parseStatusNote(raw.toString('utf8'))
      } catch (err) {
        console.warn(`[status] ignoring ${file}: ${(err as Error).message}`)
      }
      entry = { hash, note }
      this.cache.set(userId, entry)
    }
    if (entry.note?.expiresAt && Date.parse(entry.note.expiresAt) <= now) return null
    return entry.note
  }

  /** Logs once until the state of the file changes again; caches "no note". */
  private warnOnce(userId: number, state: string, message: string): void {
    if (this.cache.get(userId)?.hash === state) return
    this.cache.set(userId, { hash: state, note: null })
    console.warn(`[status] ${message}`)
  }
}
