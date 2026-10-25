/**
 * Review K0-K2, MAJOR-3: createApp's generic `express.json()` used to read a
 * JSON body of `/api/device/clock/*` before the LAN gate, the device token
 * and the 512 kB PCM bound ran. These tests go through the real createApp:
 * a JSON body (valid, malformed, oversized) of a peer outside the LAN or
 * without a token is refused by the gate, never by the body parser.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createApp, isClockDevicePath } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

interface Started { server: http.Server; url: string; db: Database }

async function start(allowedCidrs: string | undefined): Promise<Started> {
  const previous = process.env.CLOCK_ALLOWED_CIDRS
  if (allowedCidrs === undefined) delete process.env.CLOCK_ALLOWED_CIDRS
  else process.env.CLOCK_ALLOWED_CIDRS = allowedCidrs
  try {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'user')
    const server = http.createServer(createApp({ db }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return { server, db, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
  } finally {
    if (previous === undefined) delete process.env.CLOCK_ALLOWED_CIDRS
    else process.env.CLOCK_ALLOWED_CIDRS = previous
  }
}

async function stop(s: Started): Promise<void> {
  await new Promise<void>((res, rej) => s.server.close(e => (e ? rej(e) : res())))
  s.db.close()
}

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; code: unknown }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
  const text = await res.text()
  let code: unknown = null
  try { code = (JSON.parse(text) as { code?: unknown }).code ?? null } catch { code = `non-json:${text.slice(0, 40)}` }
  return { status: res.status, code }
}

const VALID = JSON.stringify({ message_id: 'm', block_id: 'b', value: 'v', client_id: 'c' })
const MALFORMED = '{"message_id": '
// Over the 100 kB default of express.json(): the generic parser answered 413.
const OVERSIZED = JSON.stringify({ pad: 'x'.repeat(200_000) })
const BODIES: Array<[string, string]> = [['valid', VALID], ['malformed', MALFORMED], ['oversized', OVERSIZED]]
const ROUTES = ['/api/device/clock/voice', '/api/device/clock/answer', '/API/Device/Clock/voice']

describe('clock routes are not parsed before their gates (createApp)', () => {
  let outside: Started
  let lan: Started

  beforeAll(async () => {
    // Default allowlist: 127.0.0.1 is no LAN peer -> 403 not_lan.
    outside = await start(undefined)
    // Loopback allowed: the token gate answers -> 401 unauthorized.
    lan = await start('127.0.0.1/32')
  })
  afterAll(async () => {
    await stop(outside)
    await stop(lan)
  })

  for (const route of ROUTES) {
    for (const [kind, body] of BODIES) {
      it(`${route}, ${kind} JSON from outside the LAN: 403 not_lan`, async () => {
        expect(await post(outside.url + route, body)).toEqual({ status: 403, code: 'not_lan' })
      })
      it(`${route}, ${kind} JSON without a token: 401 from the token gate`, async () => {
        const res = await post(lan.url + route, body)
        expect(res.status).toBe(401)
        expect(typeof res.code).toBe('string')
        expect(String(res.code)).not.toMatch(/^non-json/)
      })
    }
  }

  it('the owner routes still parse JSON, after the JWT', async () => {
    const jwt = generateAccessToken({ userId: 1, username: 'alice', role: 'user' })
    const created = await fetch(`${lan.url}/api/device/clock/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ name: 'Küche', privacy: true }),
    })
    expect(created.status).toBe(201)
    expect(((await created.json()) as { device: { name: string; privacy: boolean } }).device).toMatchObject({ name: 'Küche', privacy: true })
    // Without the JWT the body is not read: oversized JSON gets the 401, not a 413.
    const refused = await post(`${lan.url}/api/device/clock/devices`, OVERSIZED)
    expect(refused.status).toBe(401)
  })

  it('every other route keeps the generic parser', async () => {
    expect(isClockDevicePath('/api/device/clock')).toBe(true)
    expect(isClockDevicePath('/api/device/clock/voice')).toBe(true)
    expect(isClockDevicePath('/API/DEVICE/CLOCK/answer')).toBe(true)
    expect(isClockDevicePath('/api/device/clockwork')).toBe(false)
    expect(isClockDevicePath('/api/captures')).toBe(false)
    // A malformed JSON body on a parsed route is still the parser's 400.
    const res = await fetch(`${lan.url}/api/captures`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: MALFORMED })
    expect(res.status).toBe(400)
  })
})
