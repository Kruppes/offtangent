/**
 * Upload policy of the chat attachment path.
 *
 * "Attach anything" means: no MIME whitelist, many files, large files — but
 * streamed to disk, capped per file, capped per request, and refused when the
 * volume is about to fill up. These tests run against a real express server
 * and send real multipart bodies (streamed, so neither side holds 64 MB in
 * memory just to run the assertion).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, parseUploadsMetadata, getUploadsTempDir } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { uploadArray } from './uploads.js'

const TEST_SECRET = 'test-secret-for-upload-limits'

let db: Database
let server: http.Server
let token: string
let tempDataDir: string
let previousDataDir: string | undefined
let previousJwtSecret: string | undefined

const ENV_KEYS = ['UPLOAD_MAX_FILE_SIZE_MB', 'UPLOAD_MAX_FILES', 'UPLOAD_MIN_FREE_DISK_MB'] as const
const savedEnv: Record<string, string | undefined> = {}

interface FilePart {
  field: string
  filename: string
  contentType: string
  /** Exact bytes, or a size that gets streamed in 1 MB chunks. */
  content?: Buffer
  size?: number
}

interface TextPart {
  field: string
  value: string
}

interface MultipartResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

const BOUNDARY = '----offtangentUploadLimitsBoundary'

function postMultipart(
  pathname: string,
  parts: Array<FilePart | TextPart>,
  options: { headers?: Record<string, string>; onProgress?: () => void } = {},
): Promise<MultipartResponse> {
  const { port } = server.address() as { port: number }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: pathname,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          Authorization: `Bearer ${token}`,
          ...options.headers,
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)

    const writeChunk = (chunk: Buffer | string): Promise<void> =>
      new Promise((done) => {
        if (req.write(chunk)) {
          setImmediate(done)
          return
        }
        req.once('drain', () => done())
      })

    void (async () => {
      for (const part of parts) {
        if ('value' in part) {
          await writeChunk(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`)
          continue
        }
        await writeChunk(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\n` +
          `Content-Type: ${part.contentType}\r\n\r\n`,
        )
        if (part.content) {
          await writeChunk(part.content)
        } else {
          const chunk = Buffer.alloc(1024 * 1024, 0x61)
          let written = 0
          while (written < (part.size ?? 0)) {
            const next = Math.min(chunk.length, (part.size ?? 0) - written)
            await writeChunk(next === chunk.length ? chunk : chunk.subarray(0, next))
            written += next
            options.onProgress?.()
          }
        }
        await writeChunk('\r\n')
      }
      await writeChunk(`--${BOUNDARY}--\r\n`)
      req.end()
    })().catch(reject)
  })
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  previousJwtSecret = process.env.JWT_SECRET
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-upload-limits-'))
  process.env.DATA_DIR = tempDataDir
  process.env.JWT_SECRET = TEST_SECRET
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'uploader', 'x', 'user')

  const agentCore = {
    getSessionManager: () => ({
      getOrCreateSession: (userId: string, source: string, agentId?: string) => ({
        id: `s-${agentId ?? 'main'}`, userId, source, startedAt: 0, lastActivity: 0, messageCount: 0, summaryWritten: false, restored: false,
      }),
      assertSessionAccess: (_userId: string, sessionId: string) => ({ id: sessionId }),
    }),
  } as unknown as AgentCore

  const app = createApp({ db, getAgentCore: () => agentCore })
  // A bare route on the same server to inspect what multer handed the handler.
  const inspector = express()
  inspector.post('/inspect', uploadArray('files'), (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    res.json({
      files: files.map(file => ({
        hasBuffer: Buffer.isBuffer((file as { buffer?: Buffer }).buffer),
        path: file.path,
        onDisk: file.path ? fs.statSync(file.path).size : -1,
        originalname: file.originalname,
      })),
    })
  })
  app.use(inspector)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  token = generateAccessToken({ userId: 1, username: 'uploader', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  db.close()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousJwtSecret
})

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function tempFiles(): string[] {
  try {
    return fs.readdirSync(getUploadsTempDir())
  } catch {
    return []
  }
}

describe('upload limits', () => {
  it('streams a 64 MB file to disk instead of into the Node heap', async () => {
    const size = 64 * 1024 * 1024
    let peakArrayBuffers = 0
    const before = process.memoryUsage().arrayBuffers
    const sample = (): void => {
      const current = process.memoryUsage().arrayBuffers - before
      if (current > peakArrayBuffers) peakArrayBuffers = current
    }

    const res = await postMultipart(
      '/inspect',
      [{ field: 'files', filename: 'huge.bin', contentType: 'application/octet-stream', size }],
      { onProgress: sample },
    )
    sample()

    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { files: Array<{ hasBuffer: boolean; path: string; onDisk: number }> }
    const staged = body.files[0]
    if (staged?.path) fs.rmSync(staged.path, { force: true })

    expect(body.files).toHaveLength(1)
    // The decisive part: multer handed over a path, not a Buffer, and the full
    // payload was already on disk while the request was still being handled.
    expect(staged!.hasBuffer).toBe(false)
    expect(staged!.onDisk).toBe(size)
    expect(staged!.path).toContain(path.join('uploads', '.tmp'))
    // memoryStorage would hold the whole body (plus the concat copy) at once.
    // The threshold is loose on purpose: other suites in the same process
    // allocate buffers too, and this only has to fail loudly for a 64 MB
    // in-memory upload.
    expect(peakArrayBuffers).toBeLessThan(size * 0.9)
  }, 60_000)

  it('accepts a 60 MB attachment on POST /api/chat/message and stores it on disk', async () => {
    const size = 60 * 1024 * 1024
    const res = await postMultipart('/api/chat/message', [
      { field: 'content', value: 'here is the raw footage' },
      { field: 'files', filename: 'clip.mp4', contentType: 'video/mp4', size },
    ])

    expect(res.status).toBe(201)
    const body = JSON.parse(res.body) as { message: { metadata: string | null } }
    const files = parseUploadsMetadata(body.message.metadata)
    expect(files).toHaveLength(1)
    expect(files[0]!.size).toBe(size)
    expect(files[0]!.mimeType).toBe('video/mp4')

    const stored = path.join(tempDataDir, 'uploads', files[0]!.relativePath)
    expect(fs.statSync(stored).size).toBe(size)
    expect(tempFiles()).toHaveLength(0)

    fs.rmSync(stored, { force: true })
  }, 60_000)

  it('answers 413 for a file above the size limit and leaves no part file behind', async () => {
    process.env.UPLOAD_MAX_FILE_SIZE_MB = '1'
    const res = await postMultipart('/api/chat/message', [
      { field: 'content', value: 'too big' },
      { field: 'files', filename: 'over.bin', contentType: 'application/octet-stream', size: 3 * 1024 * 1024 },
    ])

    expect(res.status).toBe(413)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'upload_too_large' })
    expect(tempFiles()).toHaveLength(0)
  }, 30_000)

  it('answers 400 when more files than allowed are attached', async () => {
    process.env.UPLOAD_MAX_FILES = '2'
    const res = await postMultipart('/api/chat/message', [
      { field: 'content', value: 'three files' },
      { field: 'files', filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('a') },
      { field: 'files', filename: 'b.txt', contentType: 'text/plain', content: Buffer.from('b') },
      { field: 'files', filename: 'c.txt', contentType: 'text/plain', content: Buffer.from('c') },
    ])

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'too_many_files' })
    expect(tempFiles()).toHaveLength(0)
  })

  it('accepts many files in one message by default (20)', async () => {
    const parts: Array<FilePart | TextPart> = [{ field: 'content', value: 'twenty files' }]
    for (let i = 0; i < 20; i += 1) {
      parts.push({ field: 'files', filename: `f${i}.bin`, contentType: 'application/octet-stream', content: Buffer.from(`file ${i}`) })
    }
    const res = await postMultipart('/api/chat/message', parts)

    expect(res.status).toBe(201)
    const body = JSON.parse(res.body) as { message: { metadata: string | null } }
    const files = parseUploadsMetadata(body.message.metadata)
    expect(files).toHaveLength(20)
    for (const file of files) fs.rmSync(path.join(tempDataDir, 'uploads', file.relativePath), { force: true })
  }, 30_000)

  it('accepts any type — no MIME whitelist', async () => {
    const exotic = [
      { filename: 'installer.exe', contentType: 'application/vnd.microsoft.portable-executable' },
      { filename: 'archive.7z', contentType: 'application/x-7z-compressed' },
      { filename: 'page.html', contentType: 'text/html' },
      { filename: 'vector.svg', contentType: 'image/svg+xml' },
      { filename: 'no-extension', contentType: '' },
    ]
    const res = await postMultipart('/api/chat/message', [
      { field: 'content', value: 'everything' },
      ...exotic.map(f => ({ field: 'files', filename: f.filename, contentType: f.contentType || 'application/octet-stream', content: Buffer.from('x') })),
    ])

    expect(res.status).toBe(201)
    const files = parseUploadsMetadata((JSON.parse(res.body) as { message: { metadata: string } }).message.metadata)
    expect(files).toHaveLength(exotic.length)
    for (const file of files) fs.rmSync(path.join(tempDataDir, 'uploads', file.relativePath), { force: true })
  })

  it('sanitizes hostile file names and stores under a generated name', async () => {
    const hostile = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32\\config\\sam',
      '.....hidden',
      'rtl\u202Egnp.exe',
      'sh;rm -rf $HOME.txt',
    ]
    const res = await postMultipart('/api/chat/message', [
      { field: 'content', value: 'hostile names' },
      ...hostile.map(name => ({ field: 'files', filename: name.replace(/"/g, ''), contentType: 'application/octet-stream', content: Buffer.from('x') })),
    ])

    expect(res.status, res.body).toBe(201)
    const files = parseUploadsMetadata((JSON.parse(res.body) as { message: { metadata: string } }).message.metadata)
    expect(files).toHaveLength(hostile.length)

    const uploadsRoot = path.resolve(tempDataDir, 'uploads')
    for (const file of files) {
      expect(file.storedName).not.toContain('/')
      expect(file.storedName).not.toContain('\\')
      expect(file.storedName).not.toContain('..')
      // eslint-disable-next-line no-control-regex
      expect(file.storedName).not.toMatch(/[\u0000-\u001f]/)
      expect(file.originalName).not.toContain('/')
      // eslint-disable-next-line no-control-regex
      expect(file.originalName).not.toMatch(/[\u0000-\u001f]/)
      const absolute = path.resolve(uploadsRoot, file.relativePath)
      expect(absolute.startsWith(uploadsRoot + path.sep)).toBe(true)
      expect(fs.existsSync(absolute)).toBe(true)
      fs.rmSync(absolute, { force: true })
    }
    expect(fs.existsSync(path.join(tempDataDir, 'etc', 'passwd'))).toBe(false)
  })

  it('rejects a multipart body with a smuggled CRLF in the part header', async () => {
    const res = await postMultipart('/api/chat/message', [
      { field: 'content', value: 'crlf' },
      { field: 'files', filename: 'line\r\nbreak.txt', contentType: 'text/plain', content: Buffer.from('x') },
    ])

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'malformed_multipart' })
    expect(tempFiles()).toHaveLength(0)
  })

  it('answers 507 instead of writing half a file when the disk is nearly full', async () => {
    process.env.UPLOAD_MIN_FREE_DISK_MB = String(1024 * 1024 * 1024)
    const res = await postMultipart('/api/chat/message', [
      { field: 'content', value: 'no room' },
      { field: 'files', filename: 'x.bin', contentType: 'application/octet-stream', content: Buffer.from('x') },
    ])

    expect(res.status).toBe(507)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'insufficient_storage' })
    expect(tempFiles()).toHaveLength(0)
  })
})
