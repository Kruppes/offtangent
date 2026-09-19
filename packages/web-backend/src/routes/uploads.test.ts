/**
 * /api/uploads is user content and must not be readable by anyone on the LAN.
 * Real express server on port 0 so the middleware chain (header token, query
 * token, path traversal) is exercised exactly as in production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken, generateRefreshToken } from '../auth.js'

const TEST_SECRET = 'test-secret-for-uploads-auth'
const FILE_CONTENT = 'hello uploaded world'

let db: Database
let server: http.Server
let baseUrl: string
let tempDataDir: string
let previousDataDir: string | undefined
let previousJwtSecret: string | undefined
let accessToken: string
let refreshToken: string

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  previousJwtSecret = process.env.JWT_SECRET
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uploads-routes-'))
  process.env.DATA_DIR = tempDataDir
  process.env.JWT_SECRET = TEST_SECRET

  const uploadDir = path.join(tempDataDir, 'uploads', '2026', '04', '20')
  fs.mkdirSync(uploadDir, { recursive: true })
  fs.writeFileSync(path.join(uploadDir, 'abc-report.txt'), FILE_CONTENT)
  // A file outside the uploads dir that traversal attempts would target.
  fs.writeFileSync(path.join(tempDataDir, 'secret-outside.txt'), 'do not serve me')

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
    1, 'admin', 'x', 'admin'
  )

  const app = createApp({ db })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`

  accessToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  refreshToken = generateRefreshToken({ userId: 1, username: 'admin', role: 'admin' }).token
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousJwtSecret
})

const FILE_URL = '/api/uploads/2026/04/20/abc-report.txt'

/**
 * fetch() normalizes `..` segments away before the request leaves the client,
 * which would silently turn a traversal test into a request for a different
 * route. Send the raw path over http.request instead.
 */
function rawGet(rawPath: string): Promise<{ status: number; body: string }> {
  const { port } = server.address() as { port: number }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port, method: 'GET', path: rawPath }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/uploads/*', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await fetch(`${baseUrl}${FILE_URL}`)
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain(FILE_CONTENT)
  })

  it('serves the file with a Bearer access token', async () => {
    const res = await fetch(`${baseUrl}${FILE_URL}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(FILE_CONTENT)
  })

  it('serves the file with a ?token= query parameter (for <img src>)', async () => {
    const res = await fetch(`${baseUrl}${FILE_URL}?token=${encodeURIComponent(accessToken)}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(FILE_CONTENT)
  })

  it('rejects a refresh token', async () => {
    const header = await fetch(`${baseUrl}${FILE_URL}`, {
      headers: { Authorization: `Bearer ${refreshToken}` },
    })
    expect(header.status).toBe(401)

    const query = await fetch(`${baseUrl}${FILE_URL}?token=${encodeURIComponent(refreshToken)}`)
    expect(query.status).toBe(401)
  })

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ userId: 1, username: 'admin', role: 'admin' }, 'wrong-secret', {
      expiresIn: '1h',
    })
    const res = await fetch(`${baseUrl}${FILE_URL}?token=${encodeURIComponent(forged)}`)
    expect(res.status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const expired = jwt.sign(
      { userId: 1, username: 'admin', role: 'admin', type: 'access' },
      TEST_SECRET,
      { expiresIn: '-1h' }
    )
    const res = await fetch(`${baseUrl}${FILE_URL}?token=${encodeURIComponent(expired)}`)
    expect(res.status).toBe(401)
  })

  it('blocks path traversal', async () => {
    const targets = [
      '/api/uploads/../../etc/passwd',
      '/api/uploads/%2e%2e/%2e%2e/etc/passwd',
      '/api/uploads/2026/../../secret-outside.txt',
      '/api/uploads/..%2f..%2fsecret-outside.txt',
    ]
    for (const target of targets) {
      const res = await rawGet(`${target}?token=${encodeURIComponent(accessToken)}`)
      expect([400, 404], `${target} -> ${res.status}`).toContain(res.status)
      expect(res.body).not.toContain('root:')
      expect(res.body).not.toContain('do not serve me')
    }
  })

  it('carries the query token into the preview page', async () => {
    const res = await fetch(
      `${baseUrl}${FILE_URL}?preview=1&w=100&h=100&token=${encodeURIComponent(accessToken)}`
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(`token=${encodeURIComponent(accessToken)}`)
  })
})
