import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  deleteArtifactsForMessages,
  getArtifactForUser,
  getArtifactsDir,
  insertArtifact,
  listArtifacts,
  listArtifactsForMessages,
  readArtifactContent,
  recordMessageArtifacts,
} from './artifact-store.js'
import { MAX_ARTIFACT_BYTES } from './artifact-extract.js'
import { getUploadsDir, serializeUploadsMetadata } from './uploads.js'
import type { UploadDescriptor } from './uploads.js'

const fence = '```'
const STRAND = 'strand-artifacts'
const OWNER = 1
const STRANGER = 2

let db: Database
let dataDir: string
let previousDataDir: string | undefined

function insertMessage(content: string, metadata: string | null = null, userId = OWNER): number {
  const result = db.prepare(
    "INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, 'assistant', ?, ?, 'bob')",
  ).run(STRAND, userId, content, metadata)
  return Number(result.lastInsertRowid)
}

function writeUpload(relativePath: string, body: string): UploadDescriptor {
  const absolute = path.join(getUploadsDir(), relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, body)
  return {
    kind: 'file',
    originalName: path.basename(relativePath),
    storedName: path.basename(relativePath),
    relativePath,
    urlPath: `/api/uploads/${relativePath}`,
    mimeType: 'text/html',
    size: Buffer.byteLength(body),
  }
}

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-artifacts-'))
  process.env.DATA_DIR = dataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(OWNER, 'owner', 'x')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(STRANGER, 'stranger', 'x')
})

afterEach(() => {
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
})

describe('artifacts schema', () => {
  it('is created by initDatabase', () => {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'").get()
    expect(table).toBeTruthy()
    const columns = (db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).map(c => c.name)
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'user_id', 'strand_id', 'message_id', 'agent_id',
      'kind', 'title', 'source', 'mime_type', 'size', 'content_path', 'created_at',
    ]))
  })
})

describe('recordMessageArtifacts', () => {
  it('stores an html fence as an artifact and leaves the message text untouched', () => {
    const content = `Hier ist der Rechner, unten als Canvas.\n\n${fence}html Zins-Rechner\n<h1>Zins</h1>\n${fence}`
    const messageId = insertMessage(content)

    const result = recordMessageArtifacts(db, { messageId, strandId: STRAND, userId: OWNER, agentId: 'bob', content })

    expect(result.artifacts).toHaveLength(1)
    const artifact = result.artifacts[0]!
    expect(artifact).toMatchObject({
      strandId: STRAND,
      messageId,
      agentId: 'bob',
      kind: 'html',
      title: 'Zins-Rechner',
      source: 'inline_fence',
      mimeType: 'text/html',
    })
    expect(artifact.size).toBe(Buffer.byteLength('<h1>Zins</h1>'))

    // Telegram / web fallback: the fence is still in the message.
    const stored = db.prepare('SELECT content FROM chat_messages WHERE id = ?').get(messageId) as { content: string }
    expect(stored.content).toBe(content)
    expect(stored.content).toContain('```html Zins-Rechner')
  })

  it('creates no artifact for a message without an html block', () => {
    const content = `Kurz: nein.\n\n${fence}ts\nconst a = 1\n${fence}`
    const messageId = insertMessage(content)
    const result = recordMessageArtifacts(db, { messageId, strandId: STRAND, userId: OWNER, content })
    expect(result.artifacts).toEqual([])
    expect(listArtifacts(db, OWNER, { strandId: STRAND })).toEqual([])
  })

  it('refuses an oversized block and reports why', () => {
    const body = 'x'.repeat(MAX_ARTIFACT_BYTES + 10)
    const content = `${fence}html Riesig\n${body}\n${fence}`
    const messageId = insertMessage(content)

    const result = recordMessageArtifacts(db, { messageId, strandId: STRAND, userId: OWNER, content })

    expect(result.artifacts).toEqual([])
    expect(result.skipped).toEqual([{ title: 'Riesig', reason: 'too_large' }])
    expect(listArtifacts(db, OWNER)).toEqual([])
  })

  it('copies a referenced upload so the canvas survives upload retention', () => {
    const descriptor = writeUpload('2026/09/14/report.html', '<h1>Report</h1>')
    const content = 'Der Report liegt im Canvas.'
    const messageId = insertMessage(content, serializeUploadsMetadata([descriptor]))

    const result = recordMessageArtifacts(db, {
      messageId, strandId: STRAND, userId: OWNER, content, metadata: serializeUploadsMetadata([descriptor]),
    })

    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toMatchObject({ source: 'upload', kind: 'html', title: 'report.html' })

    fs.rmSync(path.join(getUploadsDir(), descriptor.relativePath))
    expect(readArtifactContent(db, result.artifacts[0]!.id)?.toString()).toBe('<h1>Report</h1>')
  })

  it('skips an upload reference whose file is gone', () => {
    const content = 'Siehe /api/uploads/2026/09/14/missing.html'
    const messageId = insertMessage(content)
    const result = recordMessageArtifacts(db, { messageId, strandId: STRAND, userId: OWNER, content })
    expect(result.artifacts).toEqual([])
    expect(result.skipped[0]!.reason).toBe('missing_content')
  })

  it('is idempotent: a second run adds nothing', () => {
    const content = `${fence}html\n<p>eins</p>\n${fence}`
    const messageId = insertMessage(content)
    recordMessageArtifacts(db, { messageId, strandId: STRAND, userId: OWNER, content })
    const second = recordMessageArtifacts(db, { messageId, strandId: STRAND, userId: OWNER, content })
    expect(second.artifacts).toEqual([])
    expect(second.skipped[0]!.reason).toBe('duplicate')
    expect(listArtifacts(db, OWNER, { strandId: STRAND })).toHaveLength(1)
  })
})

describe('artifact reads', () => {
  it('survives a reload: the artifact is still readable from a fresh handle on the same file', () => {
    const dbPath = path.join(dataDir, 'reload.sqlite')
    const first = initDatabase(dbPath)
    first.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(OWNER, 'owner', 'x')
    const messageId = Number(first.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, 'assistant', ?)",
    ).run(STRAND, OWNER, 'text').lastInsertRowid)
    const content = `${fence}html Bleibt\n<p>bleibt</p>\n${fence}`
    const created = recordMessageArtifacts(first, { messageId, strandId: STRAND, userId: OWNER, content })
    expect(created.artifacts).toHaveLength(1)
    first.close()

    const second = initDatabase(dbPath)
    const reopened = getArtifactForUser(second, OWNER, created.artifacts[0]!.id)
    expect(reopened).toMatchObject({ title: 'Bleibt', strandId: STRAND })
    expect(readArtifactContent(second, reopened!.id)?.toString()).toBe('<p>bleibt</p>')
    expect(listArtifacts(second, OWNER, { strandId: STRAND })).toHaveLength(1)
    second.close()
  })

  it('never returns another user artifact', () => {
    const content = `${fence}html\n<p>privat</p>\n${fence}`
    const messageId = insertMessage(content)
    const [artifact] = recordMessageArtifacts(db, { messageId, strandId: STRAND, userId: OWNER, content }).artifacts

    expect(getArtifactForUser(db, STRANGER, artifact!.id)).toBeNull()
    expect(listArtifacts(db, STRANGER, { strandId: STRAND })).toEqual([])
    expect(listArtifactsForMessages(db, STRANGER, [messageId]).size).toBe(0)
  })

  it('groups artifacts per message for the chat history', () => {
    const a = insertMessage('x')
    const b = insertMessage('y')
    recordMessageArtifacts(db, { messageId: a, strandId: STRAND, userId: OWNER, content: `${fence}html\n<p>a</p>\n${fence}` })
    recordMessageArtifacts(db, { messageId: b, strandId: STRAND, userId: OWNER, content: `${fence}html\n<p>b1</p>\n${fence}\n${fence}svg\n<svg/>\n${fence}` })

    const map = listArtifactsForMessages(db, OWNER, [a, b, 99999])
    expect(map.get(a)).toHaveLength(1)
    expect(map.get(b)).toHaveLength(2)
    expect(map.has(99999)).toBe(false)
  })

  it('filters the list by strand', () => {
    const first = insertMessage('x')
    const other = Number(db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('other-strand', ?, 'assistant', 'y')",
    ).run(OWNER).lastInsertRowid)
    recordMessageArtifacts(db, { messageId: first, strandId: STRAND, userId: OWNER, content: `${fence}html\n<p>a</p>\n${fence}` })
    recordMessageArtifacts(db, { messageId: other, strandId: 'other-strand', userId: OWNER, content: `${fence}html\n<p>b</p>\n${fence}` })

    expect(listArtifacts(db, OWNER, { strandId: STRAND })).toHaveLength(1)
    expect(listArtifacts(db, OWNER)).toHaveLength(2)
  })
})

describe('artifact writes', () => {
  it('rejects content over the size limit', () => {
    const messageId = insertMessage('x')
    expect(() => insertArtifact(db, {
      userId: OWNER,
      strandId: STRAND,
      messageId,
      kind: 'html',
      title: 'too big',
      source: 'inline_fence',
      mimeType: 'text/html',
      content: Buffer.alloc(MAX_ARTIFACT_BYTES + 1),
    })).toThrow(/limit/)
  })

  it('stores bytes under DATA_DIR/artifacts, not under uploads', () => {
    const messageId = insertMessage('x')
    const artifact = insertArtifact(db, {
      userId: OWNER,
      strandId: STRAND,
      messageId,
      kind: 'html',
      title: 'path check',
      source: 'inline_fence',
      mimeType: 'text/html',
      content: Buffer.from('<p>x</p>'),
    })!
    const row = db.prepare('SELECT content_path FROM artifacts WHERE id = ?').get(artifact.id) as { content_path: string }
    const absolute = path.join(getArtifactsDir(), row.content_path)
    expect(fs.existsSync(absolute)).toBe(true)
    expect(absolute.startsWith(getArtifactsDir())).toBe(true)
    expect(absolute.startsWith(getUploadsDir())).toBe(false)
  })

  it('deletes rows and files for rolled back messages', () => {
    const messageId = insertMessage('x')
    const [artifact] = recordMessageArtifacts(db, {
      messageId, strandId: STRAND, userId: OWNER, content: `${fence}html\n<p>weg</p>\n${fence}`,
    }).artifacts
    const row = db.prepare('SELECT content_path FROM artifacts WHERE id = ?').get(artifact!.id) as { content_path: string }
    const absolute = path.join(getArtifactsDir(), row.content_path)

    expect(deleteArtifactsForMessages(db, [messageId])).toBe(1)
    expect(getArtifactForUser(db, OWNER, artifact!.id)).toBeNull()
    expect(fs.existsSync(absolute)).toBe(false)
  })
})
