/**
 * Eco mode switch (plan 2026-10-04-eco-implementation):
 * `PATCH /api/strands/:id/eco` and the additive `eco` block of
 * `GET /api/strands/:id/context`. Real SessionManager, real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager, isStrandEcoEnabled, readStrandContextWindow, saveProviders, getOllamaShowFacts, resetShowFactsCacheForTest } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-strand-eco-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  server = http.createServer(createApp({ db, getAgentCore: () => agentCore }))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM tool_calls; DELETE FROM chat_messages; DELETE FROM sessions;')
})

async function api(method: string, url: string, body?: unknown, authToken = token) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${authToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

describe('strand eco mode', () => {
  it('defaults to off, persists on, and rolls back by switching off', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Eco strand')
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)

    const ctx0 = await api('GET', `/api/strands/${strand.id}/context`)
    expect(ctx0.status).toBe(200)
    expect(ctx0.body.eco).toMatchObject({ enabled: false, last: null })

    const on = await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: true })
    expect(on.status).toBe(200)
    expect(on.body).toMatchObject({ strandId: strand.id, eco: { enabled: true } })
    expect(isStrandEcoEnabled(db, strand.id)).toBe(true)
    expect((await api('GET', `/api/strands/${strand.id}/context`)).body.eco).toMatchObject({ enabled: true })

    const off = await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: false })
    expect(off.status).toBe(200)
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)
  })

  it('rejects anything but a strict boolean body', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Strict')
    for (const body of [{ enabled: 'true' }, { enabled: 1 }, {}, { enabled: true, extra: 1 }, [true], { contextWindow: 65536, extra: 1 }]) {
      const res = await api('PATCH', `/api/strands/${strand.id}/eco`, body)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('invalid_eco')
    }
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)
  })

  it('answers 404 for a foreign or unknown strand and changes nothing', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Mine')
    const foreign = await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: true }, otherToken)
    expect(foreign.status).toBe(404)
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)
    expect((await api('PATCH', '/api/strands/does-not-exist/eco', { enabled: true })).status).toBe(404)
  })

  it('requires authentication', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Auth')
    const res = await fetch(`${baseUrl}/api/strands/${strand.id}/eco`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(401)
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)
  })

  it('reports frozen tool results (real Eco) as estimates, never refusals', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Metric')
    await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: true })
    const ctx0 = await api('GET', `/api/strands/${strand.id}/context`)
    expect(ctx0.body.eco).toMatchObject({ enabled: true, last: null })
    // Two results frozen at creation: originals 3000 + 6000 chars, projections 900 + 1200.
    const meta = (o: number, p: number) => JSON.stringify({ toolName: 'shell', toolResult: { content: [{ type: 'text', text: 'x' }], details: { eco: { rowId: 1, originalChars: o, projectedChars: p } } } })
    const ins = db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, eco_original) VALUES (?, 1, 'tool', 'Tool: shell', ?, ?)")
    ins.run(strand.id, meta(3000, 900), '{"content":[]}')
    ins.run(strand.id, meta(6000, 1200), '{"content":[]}')
    const ctx = await api('GET', `/api/strands/${strand.id}/context`)
    expect(ctx.body.eco).toMatchObject({
      enabled: true,
      last: { estimatedTokensBefore: 3000, estimatedTokensAfter: 700, compactedResults: 2, droppedMessages: 0, degraded: false, refused: false, refusalReason: null },
    })
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool_name = 'eco_context'").get()).toEqual({ n: 0 })
  })
})

describe('strand eco context window (plan 2026-10-05-ollama-native-context)', () => {
  it('defaults to Unverändert (null) and old { enabled } bodies keep working without touching it', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Ctx default')
    const ctx = await api('GET', `/api/strands/${strand.id}/context`)
    expect((ctx.body.eco as Record<string, unknown>).contextWindow).toMatchObject({ choice: null, presets: [32768, 49152, 65536, 131072] })
    const on = await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: true })
    expect(on.status).toBe(200)
    expect(readStrandContextWindow(db, strand.id)).toBeNull()
  })

  it('persists a preset independently of the Eco switch and resets with null', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Ctx set')
    const res = await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: 65536 })
    expect(res.status).toBe(200)
    expect(res.body.eco).toMatchObject({ enabled: false, contextWindow: { choice: 65536 } })
    expect(isStrandEcoEnabled(db, strand.id)).toBe(false)
    await api('PATCH', `/api/strands/${strand.id}/eco`, { enabled: true })
    expect(readStrandContextWindow(db, strand.id)).toBe(65536)
    await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: null })
    expect(readStrandContextWindow(db, strand.id)).toBeNull()
  })

  it('rejects invalid windows server-side (800000000, 0, -1, 1.5, string, unlisted) and changes nothing', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Ctx invalid')
    for (const contextWindow of [800000000, 0, -1, 1.5, '65536', 12345]) {
      const res = await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('invalid_context_window')
    }
    expect(readStrandContextWindow(db, strand.id)).toBeNull()
  })

  it('rejects a foreign owner (404) and isolates concurrent writes per strand and user', async () => {
    const mine = sessionManager.createThread('1', 'main', 'Mine A')
    const mineB = sessionManager.createThread('1', 'main', 'Mine B')
    const theirs = sessionManager.createThread('2', 'main', 'Theirs')
    const foreign = await api('PATCH', `/api/strands/${mine.id}/eco`, { contextWindow: 131072 }, otherToken)
    expect(foreign.status).toBe(404)
    expect(readStrandContextWindow(db, mine.id)).toBeNull()
    const results = await Promise.all([
      api('PATCH', `/api/strands/${mine.id}/eco`, { contextWindow: 32768 }),
      api('PATCH', `/api/strands/${mineB.id}/eco`, { contextWindow: 131072 }),
      api('PATCH', `/api/strands/${theirs.id}/eco`, { contextWindow: 49152 }, otherToken),
    ])
    expect(results.map(r => r.status)).toEqual([200, 200, 200])
    expect(readStrandContextWindow(db, mine.id)).toBe(32768)
    expect(readStrandContextWindow(db, mineB.id)).toBe(131072)
    expect(readStrandContextWindow(db, theirs.id)).toBe(49152)
  })

  it('reports an honest state for a strand without a native provider (never claims an override)', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Ctx state')
    const res = await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: 131072 })
    const cw = (res.body.eco as Record<string, unknown>).contextWindow as Record<string, unknown>
    expect(cw.supported).toBe(false)
    expect(['no_model', 'provider_unsupported']).toContain(cw.state)
    expect(cw.state).not.toBe('applied')
  })
})

describe('strand eco context window on a native Ollama provider (fake /api/show, synthetic)', () => {
  let fake: http.Server
  let fakeUrl: string
  const seen: string[] = []

  beforeAll(async () => {
    fake = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/show' && body.includes('missing-model')) {
        res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"model not found"}')
        return
      }
      if (req.method === 'POST' && req.url === '/api/show' && body.includes('nofile-')) {
        // Like gemma4/qwen3.8 MLX on the real server: no num_ctx in the modelfile.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ parameters: 'temperature 1', model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 131072 } }))
        return
      }
      if (req.method === 'POST' && req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ parameters: 'num_ctx 32768', model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 65536 } }))
        return
      }
      res.writeHead(500); res.end('unexpected')
      })
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`
    saveProviders({
      providers: [
        { id: 'native', name: 'Native', type: 'ollama-chat', providerType: 'ollama-native', provider: 'ollama-native', baseUrl: fakeUrl, apiKey: '', enabledModels: ['synthetic-model', 'missing-model', 'nofile-configured', 'nofile-bare'], models: [{ id: 'synthetic-model', name: 'Synthetic', contextWindow: 32768 }, { id: 'missing-model', name: 'Missing' }, { id: 'nofile-configured', name: 'NoFile configured', ollamaNumCtx: 40960 }, { id: 'nofile-bare', name: 'NoFile bare' }] },
        { id: 'compat', name: 'Compat', type: 'openai-completions', providerType: 'ollama', provider: 'ollama', baseUrl: `${fakeUrl}/v1`, apiKey: '', enabledModels: ['synthetic-model'], models: [{ id: 'synthetic-model', name: 'Synthetic', contextWindow: 32768 }] },
      ],
      activeProvider: 'compat', activeModel: 'synthetic-model', fallbackProvider: 'compat', fallbackModel: 'synthetic-model',
    } as Parameters<typeof saveProviders>[0])
    resetShowFactsCacheForTest()
  })

  afterAll(async () => {
    resetShowFactsCacheForTest()
    await new Promise<void>((resolve) => fake.close(() => resolve()))
  })

  it('applies a larger choice, refuses one above the supported maximum server-side, and re-checks on model change', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Native ctx')
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('native', 'synthetic-model', strand.id)
    // Warm the per-(root, model) cache exactly like the request path does.
    const warmed = await getOllamaShowFacts(fakeUrl, 'synthetic-model')
    expect(warmed.source).toBe('fresh')

    const tooBig = await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: 131072 })
    expect(tooBig.status).toBe(400)
    expect(tooBig.body.code).toBe('context_window_exceeds_supported')
    expect(readStrandContextWindow(db, strand.id)).toBeNull()

    const ok = await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: 65536 })
    expect(ok.status).toBe(200)
    expect((ok.body.eco as Record<string, unknown>).contextWindow).toMatchObject({ choice: 65536, supported: true, state: 'applied', effective: 65536, facts: 'known' })

    const same = await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: 32768 })
    expect((same.body.eco as Record<string, unknown>).contextWindow).toMatchObject({ choice: 32768, state: 'baseline_kept', effective: null })

    await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: 65536 })
    // Model change to the /v1 provider: choice is kept but honestly not effective.
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('compat', 'synthetic-model', strand.id)
    const ctx = await api('GET', `/api/strands/${strand.id}/context`)
    expect((ctx.body.eco as Record<string, unknown>).contextWindow).toMatchObject({ choice: 65536, supported: false, state: 'provider_unsupported', effective: null })

    // Only read-only /api/show was ever called: no chat, generate, unload or ps.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(s => s === 'POST /api/show')).toBe(true)
  })

  it('modelfile without num_ctx: a configured per-model baseline makes the choice effective; without it the state stays baseline_unknown', async () => {
    await getOllamaShowFacts(fakeUrl, 'nofile-configured')
    await getOllamaShowFacts(fakeUrl, 'nofile-bare')
    const strand = sessionManager.createThread('1', 'main', 'Native nofile')
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('native', 'nofile-bare', strand.id)
    const bare = await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: 65536 })
    expect((bare.body.eco as Record<string, unknown>).contextWindow).toMatchObject({ choice: 65536, state: 'baseline_unknown', effective: null, baseline: null, baselineSource: null, facts: 'known' })
    // Model switch to the configured twin: same choice now takes effect above the baseline.
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('native', 'nofile-configured', strand.id)
    const ctx = await api('GET', `/api/strands/${strand.id}/context`)
    expect((ctx.body.eco as Record<string, unknown>).contextWindow).toMatchObject({ choice: 65536, state: 'applied', effective: 65536, baseline: 40960, baselineSource: 'model_setting' })
    // A choice at/below the baseline never lowers it.
    const lower = await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: 32768 })
    expect((lower.body.eco as Record<string, unknown>).contextWindow).toMatchObject({ choice: 32768, state: 'baseline_kept', effective: null, baseline: 40960 })
  })

  it('reports an honest non-applied state (no guessed floor) while /api/show facts are not yet known', async () => {
    resetShowFactsCacheForTest()
    const strand = sessionManager.createThread('1', 'main', 'Native unknown')
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?').run('native', 'missing-model', strand.id)
    const res = await api('PATCH', `/api/strands/${strand.id}/eco`, { contextWindow: 65536 })
    expect(res.status).toBe(200)
    const cw = (res.body.eco as Record<string, unknown>).contextWindow as Record<string, unknown>
    expect(cw).toMatchObject({ supported: true, state: 'baseline_unknown', effective: null })
    expect(['pending', 'failed']).toContain(cw.facts)
    // After the read-only fetch failed (404), the status says so and still sends nothing.
    await getOllamaShowFacts(fakeUrl, 'missing-model')
    const ctx = await api('GET', `/api/strands/${strand.id}/context`)
    expect((ctx.body.eco as Record<string, unknown>).contextWindow).toMatchObject({ state: 'baseline_unknown', effective: null, facts: 'failed' })
  })
})
