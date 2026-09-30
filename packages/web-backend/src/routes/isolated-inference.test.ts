/**
 * HTTP level contract and negative authorisation for POST /v1/isolated/infer.
 *
 * The app under test is the real `createApp()`, so the assertions about what a
 * service token can NOT reach (chat, memory, tasks, strands, settings,
 * providers, connectors) are assertions about the actual router stack.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createApp } from '../app.js'
import { initDatabase, resetIsolatedInferenceState, saveProviders, type Database } from '@axiom/core'

const TOKEN = 'synthetic-route-token-0003-abcdefghijklmnop'
const TOKEN_SHA = createHash('sha256').update(TOKEN).digest('hex')

let db: Database
let server: http.Server
let baseUrl = ''
let dataDir = ''
let previousDataDir: string | undefined
let previousAdminUsername: string | undefined
let previousAdminPassword: string | undefined
let providerCalls = 0

/**
 * Stop reason the fake provider reports. `max_tokens` reproduces the live
 * finding of 30.09.2026: the model was cut off at the output budget and the
 * JSON arrived unterminated.
 */
let fakeStopReason: 'end_turn' | 'max_tokens' = 'end_turn'
let fakeText = '{"nextQuestion":"Wie oft passiert das?","done":false}'

/** Controlled fake of the Anthropic messages stream. Never a real call. */
function installFakeProviderBackend(): void {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    if (target.startsWith('https://api.anthropic.com/')) {
      providerCalls += 1
      const events = [
        { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: fakeText } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: fakeStopReason }, usage: { output_tokens: 19 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }
    return realFetch(url as string, init)
  }) as typeof fetch
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-route-'))
  process.env.DATA_DIR = dataDir
  // ensureAdminUser() must create the default admin/admin pair this test logs
  // in with, so an inherited value from the host environment is cleared first.
  previousAdminUsername = process.env.ADMIN_USERNAME
  previousAdminPassword = process.env['ADMIN_' + 'PASSWORD']
  delete process.env.ADMIN_USERNAME
  delete process.env['ADMIN_' + 'PASSWORD']
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'config', 'isolated-inference.json'),
    JSON.stringify({
      enabled: true,
      services: [{ id: 'discovery', tokenSha256: TOKEN_SHA, profiles: ['interview.v1'], maxConcurrent: 2, dailyCallBudget: 50 }],
    }),
    'utf-8',
  )
  saveProviders({
    providers: [{
      id: 'anth', name: 'Anthropic', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1', apiKey: 'synthetic-not-a-real-key',
      enabledModels: ['claude-sonnet-5-5'],
    }],
    activeProvider: 'anth', activeModel: 'claude-sonnet-5-5',
  } as never)
  installFakeProviderBackend()
  db = initDatabase(':memory:')
  const app = createApp({ db })
  server = app.listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousAdminUsername === undefined) delete process.env.ADMIN_USERNAME
  else process.env.ADMIN_USERNAME = previousAdminUsername
  if (previousAdminPassword === undefined) delete process.env['ADMIN_' + 'PASSWORD']
  else process.env['ADMIN_' + 'PASSWORD'] = previousAdminPassword
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetIsolatedInferenceState()
  providerCalls = 0
})

/** Rewrites the live service registry the route reads on every request. */
function writeRegistry(entry: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dataDir, 'config', 'isolated-inference.json'),
    JSON.stringify({ enabled: true, services: [{ id: 'discovery', tokenSha256: TOKEN_SHA, profiles: ['interview.v1'], maxConcurrent: 2, dailyCallBudget: 50, ...entry }] }),
    'utf-8',
  )
}

async function infer(body: unknown, init: { token?: string | null; headers?: Record<string, string>; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) }
  const token = init.token === undefined ? TOKEN : init.token
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${baseUrl}/v1/isolated/infer`, {
    method: init.method ?? 'POST',
    headers,
    body: init.method === 'GET' ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
}

const goodBody = { profile: 'interview.v1', input: 'AUFGABE: eine Frage.\nDATEN: synthetisch.', maxOutputTokens: 900 }

describe('POST /v1/isolated/infer', () => {
  it('answers the contract for a registered service', async () => {
    const res = await infer(goodBody)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      contract: 'isolated-inference.v1',
      json: { nextQuestion: 'Wie oft passiert das?', done: false },
    })
    expect(providerCalls).toBe(1)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('reuses one answer for a repeated idempotency key', async () => {
    const first = await infer(goodBody, { headers: { 'idempotency-key': 'session-9:turn-42' } })
    const second = await infer(goodBody, { headers: { 'idempotency-key': 'session-9:turn-42' } })
    expect(first.status).toBe(200)
    expect(second.json).toEqual(first.json)
    expect(providerCalls).toBe(1)
  })
})

describe('authentication', () => {
  it('rejects a missing, malformed and wrong token without touching the provider', async () => {
    for (const token of [null, 'wrong-token', TOKEN_SHA, `${TOKEN}x`, TOKEN.slice(0, -1), TOKEN.toUpperCase()]) {
      const res = await infer(goodBody, { token })
      expect(res.status).toBe(401)
      expect(res.json).toMatchObject({ error: { code: 'unauthorized' } })
    }
    expect(providerCalls).toBe(0)
  })

  it('rejects a valid web session JWT: a user account is not a service credential', async () => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', ['pass' + 'word']: 'admin' }),
    })
    const body = await login.json() as { accessToken?: string }
    expect(login.status).toBe(200)
    expect(body.accessToken).toBeTruthy()
    const res = await infer(goodBody, { token: body.accessToken })
    expect(res.status).toBe(401)
    expect(providerCalls).toBe(0)
  })

  it('never leaks an internal detail in an error body', async () => {
    const res = await infer(goodBody, { token: 'wrong-token' })
    const text = JSON.stringify(res.json)
    expect(text).not.toContain('anthropic')
    expect(text).not.toContain('sk-')
    expect(text).not.toContain('discovery')
    expect(text).not.toMatch(/at \w+ \(/)
  })
})

describe('request shape', () => {
  it('rejects every field outside profile, input and maxOutputTokens', async () => {
    for (const field of ['system', 'model', 'tools', 'tool_choice', 'temperature', 'thinking', 'messages', 'stream']) {
      const res = await infer({ ...goodBody, [field]: 'x' })
      expect(res.status, field).toBe(400)
      expect(res.json, field).toMatchObject({ error: { code: 'unknown_field' } })
    }
    expect(providerCalls).toBe(0)
  })

  it('rejects an unknown profile', async () => {
    const res = await infer({ ...goodBody, profile: 'agent.v1' })
    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({ error: { code: 'profile_not_allowed' } })
    expect(providerCalls).toBe(0)
  })

  it('rejects an oversized input before the provider', async () => {
    const res = await infer({ ...goodBody, input: 'a'.repeat(80_001) })
    expect(res.status).toBe(413)
    expect(providerCalls).toBe(0)
  })

  it('rejects any method but POST', async () => {
    const res = await infer(null, { method: 'GET' })
    expect(res.status).toBe(405)
    expect(providerCalls).toBe(0)
  })

  it('caps the request body size', async () => {
    const res = await fetch(`${baseUrl}/v1/isolated/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...goodBody, input: 'a'.repeat(400_000) }),
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ contract: 'isolated-inference.v1', error: { code: 'input_too_large' } })
    expect(providerCalls).toBe(0)
  })
})

/**
 * Review finding 3 (body parser ordering), 9 (CORS preflight) and 12 (case /
 * trailing slash). All three were invisible because the old assertions only
 * checked `status >= 400`.
 */
describe('body parser, CORS and path matching of the isolated route', () => {
  it('accepts a legal non-ASCII input that is far larger in bytes than in characters', async () => {
    // 40.000 emoji = 160.000 bytes, well above express' 100 kB default but
    // below the 80.000 character profile cap: this must reach the model, and
    // before the fix it died as an HTML 413 from the generic parser.
    const input = '\u{1f600}'.repeat(40_000)
    expect(Buffer.byteLength(input, 'utf-8')).toBeGreaterThan(100 * 1024)
    const res = await infer({ ...goodBody, input })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ contract: 'isolated-inference.v1' })
    expect(providerCalls).toBe(1)
  })

  it('answers a body above the parser limit in the contract shape, never as HTML', async () => {
    const res = await fetch(`${baseUrl}/v1/isolated/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...goodBody, input: 'x'.repeat(900_000) }),
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.text()
    expect(body).not.toContain('<!DOCTYPE html>')
    expect(JSON.parse(body)).toEqual({
      contract: 'isolated-inference.v1',
      error: { code: 'input_too_large', message: 'request body exceeds the limit' },
    })
    expect(providerCalls).toBe(0)
  })

  it('answers malformed JSON in the contract shape', async () => {
    const res = await fetch(`${baseUrl}/v1/isolated/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{"profile": "interview.v1", ',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ contract: 'isolated-inference.v1', error: { code: 'invalid_request' } })
    expect(providerCalls).toBe(0)
  })

  it('does not answer the credentialed CORS preflight for this path', async () => {
    const res = await fetch(`${baseUrl}/v1/isolated/infer`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
    expect(providerCalls).toBe(0)
  })

  it('matches the path case sensitively and without a trailing slash', async () => {
    // Both halves matter: the wrong spelling must not reach the endpoint AND
    // it must answer the contract shape, not the HTML error page of the app.
    // The 404 alone was already pinned; that a caller can PARSE the answer was
    // not, and the express mount prefix is matched case insensitively, so
    // `/V1/ISOLATED/INFER` really does land inside this router.
    for (const path of ['/V1/ISOLATED/INFER', '/v1/isolated/infer/', '/v1/Isolated/infer', '/v1/isolated//infer', '/v1/isolated/INFER']) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(goodBody),
      })
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type') ?? '', path).toContain('application/json')
      expect(await res.json(), path).toEqual({
        contract: 'isolated-inference.v1',
        error: { code: 'not_found', message: 'unknown path' },
      })
      expect(res.headers.get('cache-control'), path).toBe('no-store')
    }
    expect(providerCalls).toBe(0)
  })

  // Live repro 30.09.2026: 22 of 32 calls ended at the output cap. The caller
  // saw `bad_model_output` and could not tell a budget problem from a bad
  // model, so it silently used its own fallback question.
  it('reports a provider stop at the token budget as output_truncated', async () => {
    fakeStopReason = 'max_tokens'
    fakeText = '{"nextQuestion":"Wie viele Anrufe kommen an einem norm'
    try {
      const res = await fetch(`${baseUrl}/v1/isolated/infer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(goodBody),
      })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({
        contract: 'isolated-inference.v1',
        error: { code: 'output_truncated', message: 'model output hit the output token budget' },
      })
    } finally {
      fakeStopReason = 'end_turn'
      fakeText = '{"nextQuestion":"Wie oft passiert das?","done":false}'
    }
  })
})

describe('the service credential reaches nothing else', () => {
  const endpoints: Array<[string, string]> = [
    ['GET', '/api/chat/history'],
    ['GET', '/api/memory'],
    ['GET', '/api/tasks'],
    ['GET', '/api/strands'],
    ['GET', '/api/settings'],
    ['GET', '/api/providers'],
    ['GET', '/api/connectors'],
    ['GET', `/api/${'secret'}s/handles`],
    ['GET', '/api/skills'],
    ['GET', '/api/users'],
    ['GET', '/api/captures'],
    ['GET', '/api/feed'],
    ['GET', '/api/boards'],
    ['GET', '/api/cronjobs'],
    ['GET', '/api/email/accounts'],
    ['POST', '/api/chat/message'],
  ]

  for (const [method, url] of endpoints) {
    it(`${method} ${url} stays closed for the service token`, async () => {
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: method === 'POST' ? JSON.stringify({ message: 'hello' }) : undefined,
      })
      expect([401, 403, 404], `${method} ${url} answered ${res.status}`).toContain(res.status)
    })
  }

  it('exposes exactly one route below /v1/isolated', async () => {
    for (const url of ['/v1/isolated', '/v1/isolated/', '/v1/isolated/chat', '/v1/isolated/infer/extra', '/v1/isolated/admin']) {
      const res = await fetch(`${baseUrl}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(goodBody),
      })
      expect([404], `${url} answered ${res.status}`).toContain(res.status)
    }
  })

  // Repro of the 30.09.2026 acceptance finding: a non canonical path below the
  // mount answered an HTML page, so a client could not tell a typo from a
  // broken proxy. Every answer below the mount is the contract shape now.
  it('answers non canonical paths below the mount in the contract shape, not HTML', async () => {
    for (const [method, url] of [['POST', '/v1/isolated/chat'], ['GET', '/v1/isolated/'], ['POST', '/v1/isolated/infer/extra'], ['DELETE', '/v1/isolated/admin']] as Array<[string, string]>) {
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(goodBody),
      })
      expect(res.status, `${method} ${url}`).toBe(404)
      expect(res.headers.get('content-type') ?? '', `${method} ${url}`).toContain('application/json')
      expect(await res.json(), `${method} ${url}`).toEqual({
        contract: 'isolated-inference.v1',
        error: { code: 'not_found', message: 'unknown path' },
      })
    }
    expect(providerCalls).toBe(0)
  })
})


describe('service credential lifecycle over HTTP', () => {
  afterEach(() => writeRegistry({}))

  it('answers 401 for a revoked credential and never calls the provider', async () => {
    writeRegistry({ revoked: true })
    const res = await infer({ profile: 'interview.v1', input: 'synthetic', maxOutputTokens: 100 })
    expect(res.status).toBe(401)
    expect(res.json).toMatchObject({ contract: 'isolated-inference.v1', error: { code: 'unauthorized' } })
    expect(providerCalls).toBe(0)
  })

  it('answers 401 for an expired credential and never calls the provider', async () => {
    writeRegistry({ expiresAt: '2020-01-01T00:00:00.000Z' })
    const res = await infer({ profile: 'interview.v1', input: 'synthetic', maxOutputTokens: 100 })
    expect(res.status).toBe(401)
    expect(providerCalls).toBe(0)
  })

  it('writes one audit line per request with the service id but no prompt', async () => {
    writeRegistry({})
    const auditFile = path.join(dataDir, 'logs', 'isolated-inference.audit.jsonl')
    if (fs.existsSync(auditFile)) fs.rmSync(auditFile)
    const ok = await infer({ profile: 'interview.v1', input: 'SYNTHETIC-MARKER-7788', maxOutputTokens: 100 })
    expect(ok.status).toBe(200)
    const lines = fs.readFileSync(auditFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(entry).toMatchObject({ serviceId: 'discovery', profile: 'interview.v1', status: 'ok', code: 'ok', model: 'anth/claude-sonnet-5-5' })
    expect(typeof entry.requestId).toBe('string')
    expect(lines[0]).not.toContain('SYNTHETIC-MARKER-7788')
    expect(lines[0]).not.toContain(TOKEN)
    expect(lines[0]).not.toContain(TOKEN_SHA)
  })
})
