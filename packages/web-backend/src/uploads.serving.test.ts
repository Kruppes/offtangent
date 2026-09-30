/**
 * With no MIME whitelist on the way in, the way out has to be conservative:
 * an uploaded .html or .svg must never execute as markup under our own origin
 * (it would run with the user's session against /api). Only a short list of
 * inert types is served inline, everything else becomes an octet-stream
 * download, and `nosniff` stops the browser from second-guessing us.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, ensureUploadsTempDir } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { resolveServedContentType } from './uploads.js'

const TEST_SECRET = 'test-secret-for-upload-serving'
const HTML_PAYLOAD = '<script>fetch("/api/users")</script>'
const SVG_PAYLOAD = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
const PNG_PAYLOAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined
let previousJwtSecret: string | undefined

const DIR = path.join('2026', '09', '14')

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  previousJwtSecret = process.env.JWT_SECRET
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-upload-serving-'))
  process.env.DATA_DIR = tempDataDir
  process.env.JWT_SECRET = TEST_SECRET

  const uploadDir = path.join(tempDataDir, 'uploads', DIR)
  fs.mkdirSync(uploadDir, { recursive: true })
  fs.writeFileSync(path.join(uploadDir, 'aaa-page.html'), HTML_PAYLOAD)
  fs.writeFileSync(path.join(uploadDir, 'bbb-vector.svg'), SVG_PAYLOAD)
  fs.writeFileSync(path.join(uploadDir, 'ccc-shot.png'), PNG_PAYLOAD)
  fs.writeFileSync(path.join(uploadDir, 'ddd-clip.mp4'), Buffer.alloc(64, 3))
  fs.writeFileSync(path.join(uploadDir, 'eee-notes.txt'), 'plain notes')
  fs.writeFileSync(path.join(uploadDir, 'fff-tool'), 'no extension at all')
  fs.writeFileSync(path.join(ensureUploadsTempDir(), 'inflight.part'), 'half an upload')

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'viewer', 'x', 'user')

  const app = createApp({ db })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'viewer', role: 'user' })
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

function get(name: string, query = ''): Promise<Response> {
  return fetch(`${baseUrl}/api/uploads/2026/09/14/${name}${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe('GET /api/uploads/* content types', () => {
  it('never serves an uploaded HTML file as HTML', async () => {
    const res = await get('aaa-page.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(await res.text()).toBe(HTML_PAYLOAD)
  })

  it('never serves an uploaded SVG as an image/svg+xml document', async () => {
    const res = await get('bbb-vector.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('serves a png inline so the chat can render it', async () => {
    const res = await get('ccc-shot.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toContain('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('serves video inline (the player needs it) and text as text/plain', async () => {
    const video = await get('ddd-clip.mp4')
    expect(video.headers.get('content-type')).toBe('video/mp4')
    expect(video.headers.get('content-disposition')).toContain('inline')

    const text = await get('eee-notes.txt')
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('falls back to a download for an unknown / extension-less file', async () => {
    const res = await get('fff-tool')
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('attachment')
  })

  it('forces a download when ?download is set, even for an inline type', async () => {
    const res = await get('ccc-shot.png', '?download=1')
    expect(res.headers.get('content-disposition')).toContain('attachment')
  })

  it('does not serve in-flight multipart parts from the temp dir', async () => {
    const res = await fetch(`${baseUrl}/api/uploads/.tmp/inflight.part`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('half an upload')
  })

  it('classifies types the same way outside the request path', () => {
    expect(resolveServedContentType('x.html')).toEqual({ contentType: 'application/octet-stream', inline: false })
    expect(resolveServedContentType('x.svg')).toEqual({ contentType: 'application/octet-stream', inline: false })
    expect(resolveServedContentType('x.xhtml')).toEqual({ contentType: 'application/octet-stream', inline: false })
    expect(resolveServedContentType('x.PNG')).toEqual({ contentType: 'image/png', inline: true })
  })
})
