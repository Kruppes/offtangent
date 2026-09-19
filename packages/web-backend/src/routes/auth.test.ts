/**
 * Auth hardening: refresh token store with rotation, reuse detection,
 * logout and session management. Runs against a REAL express server on port 0
 * (like app.test.ts) because the middleware chain is part of the contract the
 * native Android client depends on.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createApp } from '../app.js'

const TEST_SECRET = 'test-secret-for-auth-hardening'

let db: Database
let server: http.Server
let baseUrl: string
let tempDataDir: string
let previousDataDir: string | undefined
let previousJwtSecret: string | undefined

interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: { id: number; username: string; role: string }
}

function decode(token: string): Record<string, unknown> {
  return jwt.decode(token) as Record<string, unknown>
}

async function login(username = 'alice', password = 'pw-alice', deviceName?: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deviceName === undefined ? { username, password } : { username, password, deviceName }),
  })
  const body = (await res.json()) as LoginResponse
  return { res, body }
}

async function refresh(refreshToken: string) {
  const res = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  const body = (await res.json().catch(() => ({}))) as Partial<LoginResponse> & { error?: string }
  return { res, body }
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  previousJwtSecret = process.env.JWT_SECRET
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-auth-routes-'))
  process.env.DATA_DIR = tempDataDir
  process.env.JWT_SECRET = TEST_SECRET

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
    1, 'admin', bcrypt.hashSync('pw-admin', 4), 'admin'
  )
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
    2, 'alice', bcrypt.hashSync('pw-alice', 4), 'user'
  )
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
    3, 'bob', bcrypt.hashSync('pw-bob', 4), 'user'
  )

  const app = createApp({ db })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousJwtSecret
})

beforeEach(() => {
  db.prepare('DELETE FROM refresh_tokens').run()
})

describe('POST /api/auth/login', () => {
  it('returns the unchanged response shape and persists a refresh row', async () => {
    const { res, body } = await login()
    expect(res.status).toBe(200)
    expect(body.user).toEqual({ id: 2, username: 'alice', role: 'user' })
    expect(typeof body.accessToken).toBe('string')
    expect(typeof body.refreshToken).toBe('string')

    const access = decode(body.accessToken)
    const refreshPayload = decode(body.refreshToken)
    expect(access.type).toBe('access')
    expect(typeof access.sid).toBe('number')
    expect(refreshPayload.type).toBe('refresh')
    expect(typeof refreshPayload.jti).toBe('string')

    const rows = db.prepare('SELECT * FROM refresh_tokens WHERE user_id = 2').all() as Array<{
      id: number
      device_name: string | null
      revoked_at: string | null
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(access.sid)
    expect(rows[0]!.device_name).toBeNull()
    expect(rows[0]!.revoked_at).toBeNull()
  })

  it('stores a trimmed deviceName capped at 80 characters', async () => {
    await login('alice', 'pw-alice', `   ${'x'.repeat(100)}   `)
    const row = db.prepare('SELECT device_name FROM refresh_tokens WHERE user_id = 2').get() as {
      device_name: string
    }
    expect(row.device_name).toBe('x'.repeat(80))
  })

  it('rejects wrong credentials', async () => {
    const { res } = await login('alice', 'nope')
    expect(res.status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) as c FROM refresh_tokens').get()).toEqual({ c: 0 })
  })
})

describe('POST /api/auth/refresh', () => {
  it('rotates the refresh token and links old → new', async () => {
    const { body: first } = await login('alice', 'pw-alice', 'Pixel 8')
    const oldSid = decode(first.accessToken).sid as number

    const { res, body } = await refresh(first.refreshToken)
    expect(res.status).toBe(200)
    expect(body.refreshToken).not.toBe(first.refreshToken)
    expect(body.user).toEqual({ id: 2, username: 'alice', role: 'user' })

    const newSid = decode(body.accessToken!).sid as number
    expect(newSid).not.toBe(oldSid)

    const oldRow = db.prepare('SELECT * FROM refresh_tokens WHERE id = ?').get(oldSid) as {
      revoked_at: string | null
      replaced_by: number | null
    }
    expect(oldRow.revoked_at).not.toBeNull()
    expect(oldRow.replaced_by).toBe(newSid)

    const newRow = db.prepare('SELECT * FROM refresh_tokens WHERE id = ?').get(newSid) as {
      revoked_at: string | null
      device_name: string | null
    }
    expect(newRow.revoked_at).toBeNull()
    // Device name is inherited by the rotated row.
    expect(newRow.device_name).toBe('Pixel 8')

    // The rotated token works for the next refresh.
    const second = await refresh(body.refreshToken!)
    expect(second.res.status).toBe(200)
  })

  it('detects replay of a rotated token: 401 and the whole chain is revoked', async () => {
    const { body: first } = await login()
    const { body: rotated } = await refresh(first.refreshToken)

    const replay = await refresh(first.refreshToken)
    expect(replay.res.status).toBe(401)

    // The still-active successor must be dead too.
    const active = db
      .prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE user_id = 2 AND revoked_at IS NULL')
      .get() as { c: number }
    expect(active.c).toBe(0)

    const afterReuse = await refresh(rotated.refreshToken!)
    expect(afterReuse.res.status).toBe(401)
  })

  it('accepts a legacy refresh JWT without jti exactly once and migrates it', async () => {
    // Token as issued before the store existed: no `type`, no `jti`.
    const legacy = jwt.sign({ userId: 2, username: 'alice', role: 'user' }, TEST_SECRET, {
      expiresIn: '7d',
    })

    const migrated = await refresh(legacy)
    expect(migrated.res.status).toBe(200)
    expect(migrated.body.refreshToken).toBeTruthy()
    expect(decode(migrated.body.refreshToken!).jti).toBeTruthy()

    const active = db
      .prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE user_id = 2 AND revoked_at IS NULL')
      .get() as { c: number }
    expect(active.c).toBe(1)

    // Replaying the legacy token is now caught by reuse detection.
    const replay = await refresh(legacy)
    expect(replay.res.status).toBe(401)
    const stillActive = db
      .prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE user_id = 2 AND revoked_at IS NULL')
      .get() as { c: number }
    expect(stillActive.c).toBe(0)
  })

  it('rejects a refresh token whose row was revoked out of band', async () => {
    const { body } = await login()
    db.prepare('UPDATE refresh_tokens SET revoked_at = datetime(\'now\') WHERE user_id = 2').run()
    const res = await refresh(body.refreshToken)
    expect(res.res.status).toBe(401)
  })

  it('rejects an expired store row', async () => {
    const { body } = await login()
    db.prepare("UPDATE refresh_tokens SET expires_at = datetime('now', '-1 day') WHERE user_id = 2").run()
    const res = await refresh(body.refreshToken)
    expect(res.res.status).toBe(401)
  })

  it('rejects an access token presented as a refresh token', async () => {
    const { body } = await login()
    const res = await refresh(body.accessToken)
    expect(res.res.status).toBe(401)
  })

  it('rejects garbage', async () => {
    const res = await refresh('not-a-jwt')
    expect(res.res.status).toBe(401)
    const missing = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(missing.status).toBe(400)
  })
})

describe('POST /api/auth/logout', () => {
  it('revokes the presented refresh token and is idempotent', async () => {
    const { body } = await login()

    const first = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.accessToken}` },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    })
    expect(first.status).toBe(204)

    const afterLogout = await refresh(body.refreshToken)
    expect(afterLogout.res.status).toBe(401)

    const second = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.accessToken}` },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    })
    expect(second.status).toBe(204)
  })

  it('requires a refresh token when the access token is valid', async () => {
    const { body } = await login()
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.accessToken}` },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('logs out with an expired access token using the refresh token alone', async () => {
    // The app case: the access token died while the process was backgrounded.
    // Without this path the refresh token would stay alive on the server
    // forever, because the client can never present a valid access token.
    const { body } = await login()
    const expiredAccess = jwt.sign(
      { userId: 2, username: 'alice', role: 'user', type: 'access' },
      TEST_SECRET,
      { expiresIn: '-1h' },
    )

    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${expiredAccess}` },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    })
    expect(res.status).toBe(204)

    const afterLogout = await refresh(body.refreshToken)
    expect(afterLogout.res.status).toBe(401)
  })

  it('logs out without any Authorization header when the body token is signed', async () => {
    const { body } = await login()

    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    })
    expect(res.status).toBe(204)

    const row = db.prepare('SELECT revoked_at FROM refresh_tokens WHERE user_id = 2').get() as { revoked_at: string | null }
    expect(row.revoked_at).not.toBeNull()
    expect((await refresh(body.refreshToken)).res.status).toBe(401)
  })

  it('refuses an unauthenticated logout without a token, and unsigned or access tokens', async () => {
    const { body } = await login()

    const noCredentials = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(noCredentials.status).toBe(401)

    const forged = jwt.sign({ userId: 2, username: 'alice', role: 'user', type: 'refresh' }, 'not-the-secret')
    const forgedRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: forged }),
    })
    expect(forgedRes.status).toBe(401)

    // An access token in the body is not a refresh token.
    const accessInBody = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: body.accessToken }),
    })
    expect(accessInBody.status).toBe(401)

    // The session survived all three attempts.
    expect((await refresh(body.refreshToken)).res.status).toBe(200)
  })

  it('answers 204 for an unknown but correctly signed refresh token (no leak)', async () => {
    const unknown = jwt.sign(
      { userId: 2, username: 'alice', role: 'user', type: 'refresh', jti: 'never-issued' },
      TEST_SECRET,
      { expiresIn: '30d' },
    )
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: unknown }),
    })
    expect(res.status).toBe(204)
  })

  it('revokes only the presented session, not the user\'s other devices', async () => {
    const phone = (await login('alice', 'pw-alice', 'Pixel 8')).body
    const laptop = (await login('alice', 'pw-alice', 'Laptop')).body

    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: phone.refreshToken }),
    })
    expect(res.status).toBe(204)

    expect((await refresh(phone.refreshToken)).res.status).toBe(401)
    expect((await refresh(laptop.refreshToken)).res.status).toBe(200)
  })

  it('does not revoke a foreign refresh token', async () => {
    const alice = (await login()).body
    const bob = (await login('bob', 'pw-bob')).body

    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.accessToken}` },
      body: JSON.stringify({ refreshToken: bob.refreshToken }),
    })
    expect(res.status).toBe(204)

    const bobStillWorks = await refresh(bob.refreshToken)
    expect(bobStillWorks.res.status).toBe(200)
  })
})

describe('GET /api/auth/sessions', () => {
  it('lists active sessions and flags the current one', async () => {
    const phone = (await login('alice', 'pw-alice', 'Pixel 8')).body
    const laptop = (await login('alice', 'pw-alice', 'Laptop')).body

    const res = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { Authorization: `Bearer ${phone.accessToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessions: Array<{ id: number; deviceName: string | null; createdAt: string; lastUsedAt: string | null; current: boolean }>
    }
    expect(body.sessions).toHaveLength(2)
    const names = body.sessions.map((s) => s.deviceName).sort()
    expect(names).toEqual(['Laptop', 'Pixel 8'])
    const current = body.sessions.filter((s) => s.current)
    expect(current).toHaveLength(1)
    expect(current[0]!.deviceName).toBe('Pixel 8')
    expect(current[0]!.id).toBe(decode(phone.accessToken).sid)
    expect(new Date(current[0]!.createdAt).toString()).not.toBe('Invalid Date')
    expect(laptop.refreshToken).toBeTruthy()
  })

  it('resolves current through the rotation chain', async () => {
    const initial = (await login('alice', 'pw-alice', 'Pixel 8')).body
    const rotated = await refresh(initial.refreshToken)
    const newSid = decode(rotated.body.accessToken!).sid as number

    // Old access token (still valid for an hour) points at the rotated-away row.
    const res = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { Authorization: `Bearer ${initial.accessToken}` },
    })
    const body = (await res.json()) as { sessions: Array<{ id: number; current: boolean }> }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]!.id).toBe(newSid)
    expect(body.sessions[0]!.current).toBe(true)
  })

  it('hides revoked and expired sessions', async () => {
    const keep = (await login('alice', 'pw-alice', 'Keep')).body
    const gone = (await login('alice', 'pw-alice', 'Gone')).body
    db.prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE id = ?").run(
      decode(gone.accessToken).sid as number
    )

    const res = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { Authorization: `Bearer ${keep.accessToken}` },
    })
    const body = (await res.json()) as { sessions: Array<{ deviceName: string | null }> }
    expect(body.sessions.map((s) => s.deviceName)).toEqual(['Keep'])
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/auth/sessions`)
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/auth/sessions/:id', () => {
  it('revokes an own session', async () => {
    const current = (await login('alice', 'pw-alice', 'Current')).body
    const other = (await login('alice', 'pw-alice', 'Other')).body
    const otherId = decode(other.accessToken).sid as number

    const res = await fetch(`${baseUrl}/api/auth/sessions/${otherId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${current.accessToken}` },
    })
    expect(res.status).toBe(204)

    const afterDelete = await refresh(other.refreshToken)
    expect(afterDelete.res.status).toBe(401)

    // The caller's own session survives.
    expect((await refresh(current.refreshToken)).res.status).toBe(200)
  })

  it('returns 404 for a foreign session', async () => {
    const alice = (await login()).body
    const bob = (await login('bob', 'pw-bob')).body
    const bobSid = decode(bob.accessToken).sid as number

    const res = await fetch(`${baseUrl}/api/auth/sessions/${bobSid}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.accessToken}` },
    })
    expect(res.status).toBe(404)
    expect((await refresh(bob.refreshToken)).res.status).toBe(200)
  })

  it('returns 404 for an unknown session', async () => {
    const alice = (await login()).body
    const res = await fetch(`${baseUrl}/api/auth/sessions/999999`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.accessToken}` },
    })
    expect(res.status).toBe(404)
  })
})

describe('access token middleware', () => {
  it('rejects a refresh token on a protected endpoint', async () => {
    const { body } = await login()
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${body.refreshToken}` },
    })
    expect(res.status).toBe(401)
  })

  it('still accepts legacy access tokens without a type claim', async () => {
    const legacyAccess = jwt.sign({ userId: 2, username: 'alice', role: 'user' }, TEST_SECRET, {
      expiresIn: '1h',
    })
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${legacyAccess}` },
    })
    expect(res.status).toBe(200)
  })
})
