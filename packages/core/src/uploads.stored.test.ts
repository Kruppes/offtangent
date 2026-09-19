/**
 * `resolveStoredUpload` is what makes a kept voice recording attachable to the
 * message that carries its transcript. It is also the only place where a
 * client names a file the server already stored, so everything it hands back
 * has to come from disk, not from the caller.
 *
 * The retention test is here on purpose: a kept recording is an upload like
 * any other and has to be swept by `uploads.retentionDays` with no special
 * case of its own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { cleanupExpiredUploads, resolveStoredUpload, saveUpload, serializeUploadsMetadata } from './uploads.js'

let tmpDir: string
let prevDataDir: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-stored-upload-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  prevDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = tmpDir
})

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = prevDataDir
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function keepRecording(name = 'recording.m4a'): ReturnType<typeof saveUpload> {
  return saveUpload({
    buffer: Buffer.from('pretend this is aac audio'),
    originalName: name,
    mimeType: 'audio/mp4',
    source: 'web',
  })
}

describe('resolveStoredUpload', () => {
  it('resolves a descriptor the server itself wrote', () => {
    const kept = keepRecording()
    const resolved = resolveStoredUpload(kept)
    expect(resolved).not.toBeNull()
    expect(resolved!.relativePath).toBe(kept.relativePath)
    expect(resolved!.urlPath).toBe(kept.urlPath)
    expect(resolved!.size).toBe(kept.size)
    expect(resolved!.mimeType).toBe('audio/mp4')
    expect(resolved!.kind).toBe('file')
  })

  it('measures the file instead of believing the size', () => {
    const kept = keepRecording()
    const resolved = resolveStoredUpload({ ...kept, size: 1 })
    expect(resolved!.size).toBe(kept.size)
  })

  it('rejects traversal, absolute paths and unknown files', () => {
    expect(resolveStoredUpload({ relativePath: '../config/settings.json' })).toBeNull()
    expect(resolveStoredUpload({ relativePath: '/etc/passwd' })).toBeNull()
    expect(resolveStoredUpload({ relativePath: '2026/09/14/nope.m4a' })).toBeNull()
    expect(resolveStoredUpload({ relativePath: '' })).toBeNull()
    expect(resolveStoredUpload(null)).toBeNull()
    expect(resolveStoredUpload('2026/09/14/nope.m4a')).toBeNull()
  })

  it('rejects a directory', () => {
    const kept = keepRecording()
    const dir = path.posix.dirname(kept.relativePath)
    expect(resolveStoredUpload({ relativePath: dir })).toBeNull()
  })

  it('falls back to a harmless mime type and name', () => {
    const kept = keepRecording()
    const resolved = resolveStoredUpload({ relativePath: kept.relativePath, mimeType: 'audio/mp4; boom', originalName: '  ' })
    expect(resolved!.mimeType).toBe('application/octet-stream')
    expect(resolved!.originalName).toBe(kept.storedName)
  })

  it('rebuilds the preview of an image reference from the file', () => {
    const png = Buffer.alloc(24)
    png.write('\x89PNG', 0, 'binary')
    png.writeUInt32BE(8, 16)
    png.writeUInt32BE(4, 20)
    const stored = saveUpload({ buffer: png, originalName: 'tiny.png', mimeType: 'image/png', source: 'web' })
    const resolved = resolveStoredUpload({ relativePath: stored.relativePath, mimeType: 'image/png' })
    expect(resolved!.kind).toBe('image')
    expect(resolved!.width).toBe(8)
    expect(resolved!.height).toBe(4)
    expect(resolved!.previewUrl).toContain('preview=1')
  })
})

describe('retention of a kept recording', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'speaker', 'x', 'user')
    db.prepare("INSERT INTO sessions (id, user_id, source, agent_id) VALUES ('s-main', '1', 'web', 'main')").run()
  })

  afterEach(() => db.close())

  it('sweeps the audio of an old voice message like every other upload', () => {
    fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), JSON.stringify({ uploads: { retentionDays: 30 } }))
    const kept = keepRecording()
    const absolute = path.join(tmpDir, 'uploads', kept.relativePath)
    expect(fs.existsSync(absolute)).toBe(true)

    db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s-main', 1, 'user', 'the spoken words', serializeUploadsMetadata([kept]), 'main', '2026-01-01 00:00:00')

    const result = cleanupExpiredUploads(db, new Date('2026-09-14T04:00:00Z'))
    expect(result.deletedFiles).toBe(1)
    expect(result.deletedMessages).toBe(1)
    expect(fs.existsSync(absolute)).toBe(false)
    // The transcript survives, only the attachment goes.
    const row = db.prepare('SELECT content, metadata FROM chat_messages').get() as { content: string; metadata: string | null }
    expect(row.content).toBe('the spoken words')
    expect(row.metadata).toBeNull()
  })

  it('keeps an attachment written later on the cutoff day itself', () => {
    // Regression: the cutoff used to be an ISO string (`...T...Z`) compared
    // as text against the naked `2026-08-15 22:00:00` in the column. Because
    // `' ' < 'T'`, every row of the cutoff day looked older than the cutoff
    // and lost its attachment up to a day early.
    fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), JSON.stringify({ uploads: { retentionDays: 30 } }))
    const kept = keepRecording()
    // Cutoff is 2026-08-15 04:00:00 — this row is 18 hours INSIDE the window.
    db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s-main', 1, 'user', 'same day, later', serializeUploadsMetadata([kept]), 'main', '2026-08-15 22:00:00')

    const result = cleanupExpiredUploads(db, new Date('2026-09-14T04:00:00Z'))
    expect(result.deletedFiles).toBe(0)
    expect(result.deletedMessages).toBe(0)
    expect(fs.existsSync(path.join(tmpDir, 'uploads', kept.relativePath))).toBe(true)
  })

  it('leaves a voice message inside the window alone', () => {
    fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), JSON.stringify({ uploads: { retentionDays: 30 } }))
    const kept = keepRecording()
    db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s-main', 1, 'user', 'recent words', serializeUploadsMetadata([kept]), 'main', '2026-09-13 22:00:00')

    const result = cleanupExpiredUploads(db, new Date('2026-09-14T04:00:00Z'))
    expect(result.deletedFiles).toBe(0)
    expect(fs.existsSync(path.join(tmpDir, 'uploads', kept.relativePath))).toBe(true)
  })
})
