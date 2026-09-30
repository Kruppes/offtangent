/**
 * API tests for `/api/secrets/handles` (plan 2026-09-26, step 1, T4).
 *
 * Fixtures are synthetic: every token-shaped string is assembled at runtime
 * from fragments, so no scanner (and no human reader) can mistake this file for
 * a leak, and the gitleaks allowlist needs no new entry.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database } from '@axiom/core'
import { ensureConfigTemplates, initDatabase, listSecrets, resolveSecret, secretHandle } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined
let secretsPath: string

/** A synthetic "GitHub-looking" token, assembled at runtime. */
function syntheticToken(): string {
  return ['gh', 'p', '_'].join('') + 'T4tokenFixture'.padEnd(36, 'x')
}

/** A synthetic password, assembled at runtime. */
function syntheticPassword(): string {
  return ['Sample', 'Pass', 'Word'].join('-') + '-42'
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-secret-handles-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  ensureConfigTemplates()
  secretsPath = path.join(tempDataDir, 'config', 'secrets.json')

  db = initDatabase(':memory:')
  server = http.createServer(createApp({ db }))
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  adminToken = generateAccessToken({ userId: 1, username: 'alice', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'bob', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  // Fresh store per test: only the `env` section, no handles.
  fs.writeFileSync(secretsPath, `${JSON.stringify({ env: {} }, null, 2)}\n`, 'utf-8')
  db.prepare('DELETE FROM chat_messages').run()
})

async function createHandle(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/secrets/handles`, {
    method: 'POST',
    headers: authHeaders(adminToken),
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('GET /api/secrets/handles', () => {
  it('requires authentication and admin', async () => {
    const anon = await fetch(`${baseUrl}/api/secrets/handles`)
    expect(anon.status).toBe(401)

    const nonAdmin = await fetch(`${baseUrl}/api/secrets/handles`, { headers: authHeaders(userToken) })
    expect(nonAdmin.status).toBe(403)
  })

  it('returns metadata only — never the value', async () => {
    const value = syntheticToken()
    const created = await createHandle({ value, kind: 'github-token' })
    expect(created.status).toBe(201)

    const res = await fetch(`${baseUrl}/api/secrets/handles`, { headers: authHeaders(adminToken) })
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain(value)
    // Not even a fragment of the value: a mask built from real characters
    // would leak its shape.
    expect(raw).not.toContain(value.slice(0, 8))
    expect(raw).not.toContain(value.slice(-8))

    const body = JSON.parse(raw) as { handles: Array<Record<string, unknown>>; kinds: string[] }
    expect(body.handles).toHaveLength(1)
    expect(Object.keys(body.handles[0]!).sort()).toEqual(['createdAt', 'kind', 'length', 'slug', 'source'])
    expect(body.handles[0]!.kind).toBe('github-token')
    expect(body.handles[0]!.length).toBe(value.length)
    expect(body.kinds).toContain('password')
  })
})

describe('POST /api/secrets/handles', () => {
  it('requires admin', async () => {
    const res = await fetch(`${baseUrl}/api/secrets/handles`, {
      method: 'POST',
      headers: authHeaders(userToken),
      body: JSON.stringify({ value: syntheticPassword(), kind: 'password' }),
    })
    expect(res.status).toBe(403)
  })

  it('answers with the slug only and stores the value encrypted', async () => {
    const value = syntheticPassword()
    const created = await createHandle({ value, kind: 'password', slug: 'router-password' })
    expect(created.status).toBe(201)
    expect(created.body).toEqual({
      slug: 'router-password',
      handle: '{{secret:router-password}}',
      kind: 'password',
    })
    expect(JSON.stringify(created.body)).not.toContain(value)

    // The value is retrievable on the server, and only there.
    expect(resolveSecret('router-password')).toBe(value)
    // On disk it is ciphertext, not plaintext.
    expect(fs.readFileSync(secretsPath, 'utf-8')).not.toContain(value)
  })

  it('deduplicates the same value instead of filing it twice', async () => {
    const value = syntheticPassword()
    const first = await createHandle({ value, kind: 'password' })
    const second = await createHandle({ value, kind: 'password', slug: 'another-name' })
    expect(second.status).toBe(201)
    expect(second.body.slug).toBe(first.body.slug)
    expect(listSecrets()).toHaveLength(1)
  })

  // F7 (triage 2026-09-26 19:25): the answer must not tell the caller whether
  // a candidate value was already in the store — that turned the endpoint into
  // a guessing oracle for low-entropy values.
  it('answers a new and a duplicate value with the same shape', async () => {
    const fresh = await createHandle({ value: syntheticPassword(), kind: 'password' })
    const duplicate = await createHandle({ value: syntheticPassword(), kind: 'password' })
    expect(fresh.status).toBe(duplicate.status)
    expect(Object.keys(duplicate.body).sort()).toEqual(Object.keys(fresh.body).sort())
    expect(Object.keys(fresh.body).sort()).toEqual(['handle', 'kind', 'slug'])
    expect(duplicate.body).toEqual(fresh.body)
    expect('deduplicated' in duplicate.body).toBe(false)
  })

  // F5 (review triage 2026-09-26 19:25)
  it('rejects a value shorter than six characters with a code', async () => {
    const tooShort = await createHandle({ value: '1234', kind: 'password' })
    expect(tooShort.status).toBe(400)
    expect(tooShort.body.code).toBe('value_too_short')
    expect(String(tooShort.body.error)).toContain('6')
    expect(listSecrets()).toHaveLength(0)

    const exactly = await createHandle({ value: 'abcdef', kind: 'password' })
    expect(exactly.status).toBe(201)
  })

  it('validates value, kind and slug without echoing the value', async () => {
    const empty = await createHandle({ value: '', kind: 'password' })
    expect(empty.status).toBe(400)

    const tooLong = await createHandle({ value: 'x'.repeat(8193), kind: 'password' })
    expect(tooLong.status).toBe(400)
    expect(String(tooLong.body.error)).toContain('8192')

    const badKind = await createHandle({ value: syntheticPassword(), kind: 'arbitrary-kind' })
    expect(badKind.status).toBe(400)
    expect(String(badKind.body.error)).toContain('Allowed')
    expect(String(badKind.body.error)).not.toContain(syntheticPassword())

    const badSlug = await createHandle({ value: syntheticPassword(), kind: 'password', slug: 'Not A Slug' })
    expect(badSlug.status).toBe(400)
    expect(String(badSlug.body.error)).not.toContain(syntheticPassword())

    expect(listSecrets()).toHaveLength(0)
  })

  it('refuses a slug that already exists', async () => {
    await createHandle({ value: syntheticPassword(), kind: 'password', slug: 'taken-name' })
    const clash = await createHandle({ value: syntheticToken(), kind: 'token', slug: 'taken-name' })
    expect(clash.status).toBe(409)
  })
})

describe('PATCH /api/secrets/handles/:slug', () => {
  it('renames an unused handle', async () => {
    await createHandle({ value: syntheticPassword(), kind: 'password', slug: 'old-name' })
    const res = await fetch(`${baseUrl}/api/secrets/handles/old-name`, {
      method: 'PATCH',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ slug: 'new-name' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ slug: 'new-name', handle: '{{secret:new-name}}' })
    expect(listSecrets().map(entry => entry.slug)).toEqual(['new-name'])
  })

  it('refuses to rename a handle that a stored message still references (409)', async () => {
    await createHandle({ value: syntheticPassword(), kind: 'password', slug: 'used-name' })
    db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')
      .run('sess-1', 'user', `the router password is ${secretHandle('used-name')} thanks`)

    const res = await fetch(`${baseUrl}/api/secrets/handles/used-name`, {
      method: 'PATCH',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ slug: 'fresh-name' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { code: string; error: string; usage: Record<string, number> }
    expect(body.code).toBe('handle_in_use')
    expect(body.usage.chat_messages).toBe(1)
    expect(body.error).toMatch(/referenced in stored messages/)
    expect(listSecrets().map(entry => entry.slug)).toEqual(['used-name'])
  })

  it('rejects unknown slugs, invalid names and non-admins', async () => {
    await createHandle({ value: syntheticPassword(), kind: 'password', slug: 'keep-name' })

    const unknown = await fetch(`${baseUrl}/api/secrets/handles/nope-name`, {
      method: 'PATCH', headers: authHeaders(adminToken), body: JSON.stringify({ slug: 'other-name' }),
    })
    expect(unknown.status).toBe(404)

    const invalid = await fetch(`${baseUrl}/api/secrets/handles/keep-name`, {
      method: 'PATCH', headers: authHeaders(adminToken), body: JSON.stringify({ slug: 'UPPER' }),
    })
    expect(invalid.status).toBe(400)

    const forbidden = await fetch(`${baseUrl}/api/secrets/handles/keep-name`, {
      method: 'PATCH', headers: authHeaders(userToken), body: JSON.stringify({ slug: 'other-name' }),
    })
    expect(forbidden.status).toBe(403)
  })
})

describe('DELETE /api/secrets/handles/:slug', () => {
  it('removes the handle and its value', async () => {
    await createHandle({ value: syntheticPassword(), kind: 'password', slug: 'gone-name' })
    const res = await fetch(`${baseUrl}/api/secrets/handles/gone-name`, {
      method: 'DELETE', headers: authHeaders(adminToken),
    })
    expect(res.status).toBe(200)
    expect(listSecrets()).toHaveLength(0)
    expect(resolveSecret('gone-name')).toBeNull()
  })

  it('deletes even a referenced handle, and reports where it was used', async () => {
    await createHandle({ value: syntheticPassword(), kind: 'password', slug: 'used-name' })
    db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')
      .run('sess-1', 'user', `login with ${secretHandle('used-name')}`)

    const res = await fetch(`${baseUrl}/api/secrets/handles/used-name`, {
      method: 'DELETE', headers: authHeaders(adminToken),
    })
    expect(res.status).toBe(200)
    // The answer reports the rows that now carry a dangling handle — useful
    // information for the UI, and still no value.
    expect((await res.json() as { usage: Record<string, number> }).usage).toEqual({ chat_messages: 1 })
    expect(listSecrets()).toHaveLength(0)
  })

  it('404s on an unknown slug and 403s for non-admins', async () => {
    const unknown = await fetch(`${baseUrl}/api/secrets/handles/nothing-here`, {
      method: 'DELETE', headers: authHeaders(adminToken),
    })
    expect(unknown.status).toBe(404)

    const forbidden = await fetch(`${baseUrl}/api/secrets/handles/nothing-here`, {
      method: 'DELETE', headers: authHeaders(userToken),
    })
    expect(forbidden.status).toBe(403)
  })
})

describe('rate limit on POST', () => {
  // Own server, so the in-process counter of this test is not shared with the
  // creations the tests above already made.
  let ownServer: http.Server
  let ownUrl: string

  beforeAll(async () => {
    ownServer = http.createServer(createApp({ db }))
    await new Promise<void>(resolve => ownServer.listen(0, resolve))
    ownUrl = `http://127.0.0.1:${(ownServer.address() as { port: number }).port}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => ownServer.close(() => resolve()))
  })

  it('answers 429 once a burst exceeds the per-minute budget', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 32; i++) {
      const res = await fetch(`${ownUrl}/api/secrets/handles`, {
        method: 'POST',
        headers: authHeaders(adminToken),
        body: JSON.stringify({ value: `${syntheticPassword()}-${i}`, kind: 'password' }),
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 30).every(status => status === 201)).toBe(true)
    expect(statuses[30]).toBe(429)
    expect(statuses[31]).toBe(429)
  })
})
