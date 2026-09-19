/**
 * POST /api/uploads — the generic write path that turns bytes into
 * `UploadDescriptor`s. The point of the endpoint is that the descriptors it
 * returns are accepted verbatim as `attachments` by BOTH consumers, so the
 * round-trip tests below actually replay them into `POST /api/captures` and
 * `POST /api/chat/message` instead of asserting on shape alone.
 *
 * Real express server on port 0 (like uploads.test.ts) so the full middleware
 * chain — mount-level `jwtHeaderOrQueryMiddleware`, the route-level
 * `jwtMiddleware`, multer's disk storage and the limit mapping — is exercised
 * exactly as in production.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database, UploadDescriptor } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'

const TEST_SECRET = 'test-secret-for-uploads-post'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let previousJwtSecret: string | undefined

const ENV_KEYS = ['UPLOAD_MAX_FILE_SIZE_MB', 'UPLOAD_MAX_FILES', 'UPLOAD_MIN_FREE_DISK_MB'] as const
const previousLimits: Record<string, string | undefined> = {}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  previousJwtSecret = process.env.JWT_SECRET
  for (const key of ENV_KEYS) previousLimits[key] = process.env[key]
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uploads-post-'))
  process.env.DATA_DIR = tempDataDir
  process.env.JWT_SECRET = TEST_SECRET
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  const app = createApp({ db, getAgentCore: () => agentCore })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousJwtSecret
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM now_set; DELETE FROM sessions;')
  for (const key of ENV_KEYS) {
    if (previousLimits[key] === undefined) delete process.env[key]
    else process.env[key] = previousLimits[key]
  }
})

interface UploadResponse {
  status: number
  body: { uploads?: UploadDescriptor[]; error?: string; code?: string }
}

function filePart(name: string, content: string, type = 'text/plain'): [string, Blob, string] {
  return ['files', new Blob([content], { type }), name]
}

async function postUploads(
  parts: Array<[string, Blob, string]>,
  init: { auth?: 'header' | 'query' | 'none' } = {},
): Promise<UploadResponse> {
  const form = new FormData()
  for (const [field, blob, name] of parts) form.append(field, blob, name)
  const auth = init.auth ?? 'header'
  const url = auth === 'query'
    ? `${baseUrl}/api/uploads?token=${encodeURIComponent(token)}`
    : `${baseUrl}/api/uploads`
  const res = await fetch(url, {
    method: 'POST',
    headers: auth === 'header' ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
  return { status: res.status, body: await res.json() as UploadResponse['body'] }
}

/** Part files of an aborted request must not survive in `<uploads>/.tmp`. */
function tempPartFiles(): string[] {
  const dir = path.join(tempDataDir, 'uploads', '.tmp')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
}

function absoluteUploadPath(descriptor: UploadDescriptor): string {
  return path.join(tempDataDir, 'uploads', ...descriptor.relativePath.split('/'))
}

describe('POST /api/uploads — auth', () => {
  it('rejects an unauthenticated upload', async () => {
    const res = await postUploads([filePart('note.txt', 'hello')], { auth: 'none' })
    expect(res.status).toBe(401)
    expect(res.body.uploads).toBeUndefined()
  })

  it('rejects a ?token= query token for the write path (header Bearer required)', async () => {
    const res = await postUploads([filePart('note.txt', 'hello')], { auth: 'query' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/authorization header/i)
    // Nothing was streamed to disk: the refusal happens before multer runs.
    expect(tempPartFiles()).toEqual([])
  })

  it('still serves GET with a query token (reads keep the old contract)', async () => {
    const created = await postUploads([filePart('served.txt', 'served body')])
    expect(created.status).toBe(201)
    const url = created.body.uploads![0].urlPath
    const res = await fetch(`${baseUrl}${url}?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('served body')
  })
})

describe('POST /api/uploads — happy path', () => {
  it('stores one file and returns a complete descriptor', async () => {
    const res = await postUploads([filePart('report.txt', 'upload me')])
    expect(res.status).toBe(201)
    expect(res.body.uploads).toHaveLength(1)
    const descriptor = res.body.uploads![0]
    expect(descriptor).toMatchObject({
      kind: 'file',
      originalName: 'report.txt',
      mimeType: 'text/plain',
      size: 'upload me'.length,
    })
    // Exactly the fields both attachment parsers read.
    expect(typeof descriptor.storedName).toBe('string')
    expect(typeof descriptor.relativePath).toBe('string')
    expect(descriptor.urlPath).toBe(`/api/uploads/${descriptor.relativePath}`)
    expect(descriptor.relativePath).toMatch(/^\d{4}\/\d{2}\/\d{2}\/[^/]+$/)
    expect(fs.readFileSync(absoluteUploadPath(descriptor), 'utf8')).toBe('upload me')
    expect(tempPartFiles()).toEqual([])
  })

  it('stores several files in one request, in order', async () => {
    const res = await postUploads([
      filePart('first.txt', 'one'),
      filePart('second.txt', 'two'),
      filePart('third.txt', 'three'),
    ])
    expect(res.status).toBe(201)
    const uploads = res.body.uploads!
    expect(uploads.map(u => u.originalName)).toEqual(['first.txt', 'second.txt', 'third.txt'])
    expect(new Set(uploads.map(u => u.storedName)).size).toBe(3)
    for (const upload of uploads) expect(fs.existsSync(absoluteUploadPath(upload))).toBe(true)
    expect(tempPartFiles()).toEqual([])
  })

  it('marks an image upload as kind=image', async () => {
    const res = await postUploads([['files', new Blob([Buffer.from('not really a png')], { type: 'image/png' }), 'shot.png']])
    expect(res.status).toBe(201)
    expect(res.body.uploads![0].kind).toBe('image')
  })

  it('sanitizes a path traversal file name', async () => {
    const res = await postUploads([filePart('../../../../etc/passwd', 'nope')])
    expect(res.status).toBe(201)
    const descriptor = res.body.uploads![0]
    expect(descriptor.storedName).not.toContain('/')
    expect(descriptor.storedName).not.toContain('..')
    expect(descriptor.relativePath).toMatch(/^\d{4}\/\d{2}\/\d{2}\/[^/]+$/)
    const stored = absoluteUploadPath(descriptor)
    expect(path.resolve(stored).startsWith(path.resolve(path.join(tempDataDir, 'uploads')) + path.sep)).toBe(true)
    expect(fs.existsSync(stored)).toBe(true)
    // The traversal target was never touched.
    expect(fs.existsSync('/etc/passwd') ? fs.readFileSync('/etc/passwd', 'utf8') : '').not.toBe('nope')
  })
})

describe('POST /api/uploads — refusals', () => {
  it('answers 400 when no file is attached', async () => {
    const res = await postUploads([])
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('no_files')
    expect(tempPartFiles()).toEqual([])
  })

  it('answers 400 when the file arrives under the wrong field name', async () => {
    const form = new FormData()
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt')
    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    expect(res.status).toBe(400)
    expect(tempPartFiles()).toEqual([])
  })

  it('answers 413 for a file above UPLOAD_MAX_FILE_SIZE_MB and leaves no part file', async () => {
    process.env.UPLOAD_MAX_FILE_SIZE_MB = '1'
    const res = await postUploads([filePart('big.bin', 'x'.repeat(2 * 1024 * 1024), 'application/octet-stream')])
    expect(res.status).toBe(413)
    expect(res.body.code).toBe('upload_too_large')
    expect(tempPartFiles()).toEqual([])
  })

  it('answers 400 for more files than UPLOAD_MAX_FILES and leaves no part file', async () => {
    process.env.UPLOAD_MAX_FILES = '2'
    const res = await postUploads([
      filePart('a.txt', 'a'),
      filePart('b.txt', 'b'),
      filePart('c.txt', 'c'),
    ])
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('too_many_files')
    expect(tempPartFiles()).toEqual([])
  })

  it('answers 507 when the free disk floor is not met', async () => {
    // 100 TB of required headroom: no test host clears that.
    process.env.UPLOAD_MIN_FREE_DISK_MB = String(100 * 1024 * 1024)
    const res = await postUploads([filePart('note.txt', 'hello')])
    expect(res.status).toBe(507)
    expect(res.body.code).toBe('insufficient_storage')
    expect(tempPartFiles()).toEqual([])
  })
})

describe('POST /api/uploads — round trip into the attachment consumers', () => {
  it('feeds its descriptors unchanged into POST /api/captures', async () => {
    const uploaded = await postUploads([
      filePart('photo.png', 'pretend-png', 'image/png'),
      filePart('receipt.pdf', 'pretend-pdf', 'application/pdf'),
    ])
    expect(uploaded.status).toBe(201)
    const uploads = uploaded.body.uploads!

    const strand = sessionManager.createThread('1', 'main', 'Home screen capture')
    const res = await fetch(`${baseUrl}/api/captures`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // Verbatim: whatever the upload endpoint returned is what we send.
      body: JSON.stringify({ text: 'Roof photo from the site', kind: 'image', strandId: strand.id, attachments: uploads }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { capture: { id: string; attachments: UploadDescriptor[]; messageId: number | null } }
    expect(body.capture.attachments).toHaveLength(2)
    expect(body.capture.attachments.map(a => a.relativePath)).toEqual(uploads.map(u => u.relativePath))
    expect(body.capture.attachments[0].urlPath).toBe(uploads[0].urlPath)

    // The capture is persisted with the attachments, not just echoed back.
    const stored = db.prepare('SELECT attachments FROM captures WHERE id = ?').get(body.capture.id) as { attachments: string }
    expect(JSON.parse(stored.attachments).map((a: UploadDescriptor) => a.relativePath)).toEqual(uploads.map(u => u.relativePath))

    // And the chat row the capture was filed into carries them as metadata.
    const message = db.prepare('SELECT metadata FROM chat_messages WHERE capture_id = ?').get(body.capture.id) as { metadata: string }
    expect(JSON.parse(message.metadata).files.map((f: UploadDescriptor) => f.relativePath)).toEqual(uploads.map(u => u.relativePath))

    // The bytes are still fetchable under the descriptor's own url.
    const fetched = await fetch(`${baseUrl}${uploads[1].urlPath}`, { headers: { Authorization: `Bearer ${token}` } })
    expect(fetched.status).toBe(200)
    expect(await fetched.text()).toBe('pretend-pdf')
  })

  it('feeds its descriptors unchanged into POST /api/chat/message', async () => {
    const uploaded = await postUploads([filePart('memo.txt', 'chat attachment body')])
    expect(uploaded.status).toBe(201)
    const uploads = uploaded.body.uploads!

    const form = new FormData()
    form.append('content', 'see attachment')
    // The chat endpoint takes the descriptors as a JSON string multipart field.
    form.append('attachments', JSON.stringify(uploads))
    const res = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { message: { id: number; metadata: string } }
    const files = JSON.parse(body.message.metadata).files as UploadDescriptor[]
    expect(files).toHaveLength(1)
    expect(files[0].relativePath).toBe(uploads[0].relativePath)
    expect(files[0].originalName).toBe('memo.txt')

    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(body.message.id) as { metadata: string }
    expect(JSON.parse(row.metadata).files[0].relativePath).toBe(uploads[0].relativePath)
  })

  it('is accepted as a JSON body attachment by chat as well (same descriptors)', async () => {
    const uploaded = await postUploads([filePart('json-path.txt', 'json body attachment')])
    const uploads = uploaded.body.uploads!
    const res = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'json variant', attachments: uploads }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { message: { metadata: string } }
    expect(JSON.parse(body.message.metadata).files[0].relativePath).toBe(uploads[0].relativePath)
  })
})
