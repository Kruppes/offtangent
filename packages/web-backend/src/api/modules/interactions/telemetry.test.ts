/**
 * POST /api/interactions/telemetry (S0-B/B1, review 8): counters only, read
 * strictly, rate limited per user. Bodies here carry no message content.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { initDatabase, getInteractionTelemetry, resetInteractionTelemetry } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createInteractionsRouter } from './route.js'
import { createTelemetryRateLimiter, parseTelemetryBody, TELEMETRY_MAX_COUNT } from './controller.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string

async function report(body: unknown, authToken = token): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${baseUrl}/api/interactions/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({})) as { code?: string }
  return { status: res.status, code: json.code }
}

beforeAll(async () => {
  db = initDatabase(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api/interactions', createInteractionsRouter({
    db,
    telemetryLimiter: createTelemetryRateLimiter({ limit: 3, windowMs: 60_000 }),
  }))
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
})

beforeEach(() => resetInteractionTelemetry({ logger: null }))

describe('parseTelemetryBody', () => {
  it('accepts a known channel, a client event and a small count', () => {
    expect(parseTelemetryBody({ channel: 'android', event: 'stream_cut' }))
      .toEqual({ ok: true, value: { channel: 'android', event: 'stream_cut', count: 1 } })
    expect(parseTelemetryBody({ channel: 'web', event: 'superseded', count: TELEMETRY_MAX_COUNT }))
      .toEqual({ ok: true, value: { channel: 'web', event: 'superseded', count: TELEMETRY_MAX_COUNT } })
  })

  it.each([
    [null, 'invalid_body'],
    [[], 'invalid_body'],
    [{ channel: 'web', event: 'stream_cut', note: 'x' }, 'invalid_body'],
    [{ event: 'stream_cut' }, 'invalid_channel'],
    [{ channel: 'telegram', event: 'stream_cut' }, 'invalid_channel'],
    [{ channel: 'other', event: 'stream_cut' }, 'invalid_channel'],
    [{ channel: 'WEB', event: 'stream_cut' }, 'invalid_channel'],
    [{ channel: 'web', event: 'answered' }, 'invalid_event'],
    [{ channel: 'web', event: 'free text' }, 'invalid_event'],
    [{ channel: 'web', event: 'stream_cut', count: 0 }, 'invalid_count'],
    [{ channel: 'web', event: 'stream_cut', count: -1 }, 'invalid_count'],
    [{ channel: 'web', event: 'stream_cut', count: 1.5 }, 'invalid_count'],
    [{ channel: 'web', event: 'stream_cut', count: TELEMETRY_MAX_COUNT + 1 }, 'invalid_count'],
    [{ channel: 'web', event: 'stream_cut', count: '3' }, 'invalid_count'],
  ])('refuses %j with %s', (body, code) => {
    expect(parseTelemetryBody(body)).toEqual({ ok: false, code })
  })
})

describe('createTelemetryRateLimiter', () => {
  it('allows the limit per window and user, then refuses until the window ends', () => {
    let now = 1_000
    const limiter = createTelemetryRateLimiter({ limit: 2, windowMs: 100, now: () => now })
    expect([limiter.allow(1), limiter.allow(1), limiter.allow(1)]).toEqual([true, true, false])
    expect(limiter.allow(2)).toBe(true)
    now += 100
    expect(limiter.allow(1)).toBe(true)
  })
})

describe('POST /api/interactions/telemetry', () => {
  it('counts a valid report under its channel', async () => {
    expect((await report({ channel: 'android', event: 'click_not_ready', count: 2 })).status).toBe(204)
    expect(getInteractionTelemetry().counters.android.click_not_ready).toBe(2)
  })

  it('refuses a free value and counts nothing', async () => {
    expect(await report({ channel: 'web', event: 'stream_cut', count: 1000 })).toEqual({ status: 400, code: 'invalid_count' })
    expect(await report({ channel: 'desktop', event: 'stream_cut' }, otherToken)).toEqual({ status: 400, code: 'invalid_channel' })
    const counters = getInteractionTelemetry().counters
    expect(counters.web.stream_cut + counters.other.stream_cut).toBe(0)
  })

  it('rate limits per user with 429', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await report({ channel: 'web', event: 'superseded' }, otherToken)).status)
    expect(statuses).toEqual([204, 204, 204, 429])
    expect(getInteractionTelemetry().counters.web.superseded).toBe(3)
  })

  it('requires authentication', async () => {
    expect((await report({ channel: 'web', event: 'stream_cut' }, 'nope')).status).toBe(401)
  })
})
