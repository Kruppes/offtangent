import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { buildStreamFn } from '../provider-config.js'
import { learnContextLimit, resetObservedContextLimits } from '../request-overflow-guard.js'
import { OLLAMA_CHAT_API } from './chat-stream.js'
import type { ContextWindowChoice } from './context-window.js'
import { nativeLimitIdentity } from './native-request.js'
import { getOllamaShowFacts, peekOllamaShowFacts, resetShowFactsCacheForTest } from './show-facts.js'

/*
 * M2 runtime wiring against a FAKE Ollama HTTP server (synthetic only, no real
 * model): buildStreamFn → native snapshot → /api/show facts → single decision →
 * native guard → /api/chat.
 */

let server: http.Server
let origin = ''
let chats: Array<Record<string, unknown>> = []
let shows = 0
let showStatus = 200
let modelfileNumCtx: number | undefined = 4096

beforeEach(async () => {
  resetShowFactsCacheForTest()
  resetObservedContextLimits()
  chats = []
  shows = 0
  showStatus = 200
  modelfileNumCtx = 4096
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      if (req.url === '/api/show') {
        shows += 1
        if (showStatus !== 200) { res.writeHead(showStatus); res.end('{"error":"synthetic"}'); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          parameters: modelfileNumCtx !== undefined ? `num_ctx                        ${modelfileNumCtx}\nstop "<|im_end|>"` : 'stop "<|im_end|>"',
          model_info: { 'general.architecture': 'synth', 'synth.context_length': 131072 },
        }))
        return
      }
      if (req.url === '/api/chat') {
        chats.push(JSON.parse(raw) as Record<string, unknown>)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 1 }) + '\n')
        return
      }
      res.writeHead(404); res.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()))
  resetObservedContextLimits()
  resetShowFactsCacheForTest()
})

function nativeModel(): Model<Api> {
  return {
    id: 'synthetic-native:8b', name: 'synthetic', api: OLLAMA_CHAT_API, provider: 'native-runtime-test', baseUrl: origin,
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096,
  } as Model<Api>
}
const ctx = (chars = 10): Context => ({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'x'.repeat(chars), timestamp: 1 }] })

function streamFor(choice: () => ContextWindowChoice, providerNumCtx?: number) {
  return buildStreamFn({ textVerbosity: undefined, transport: undefined, providerType: 'ollama-native', ollamaNumCtx: providerNumCtx }, undefined, {
    getSessionId: () => undefined,
    getContextWindowChoice: choice,
  })
}

describe('native Ollama runtime wiring (fake HTTP server)', () => {
  it('two strands streaming in parallel keep their own choice (A 65536, B unchanged)', async () => {
    const a = streamFor(() => 65536)
    const b = streamFor(() => null)
    const [ra, rb] = await Promise.all([
      a(nativeModel(), { ...ctx(), systemPrompt: 'strand-A' }, { apiKey: 'no-key' }).result(),
      b(nativeModel(), { ...ctx(), systemPrompt: 'strand-B' }, { apiKey: 'no-key' }).result(),
    ])
    expect(ra.stopReason).toBe('stop')
    expect(rb.stopReason).toBe('stop')
    const bodyOf = (sys: string) => chats.find(c => (c.messages as Array<{ content: string }>)[0]?.content === sys)!
    expect(bodyOf('strand-A').options).toEqual({ num_ctx: 65536 })
    expect(bodyOf('strand-B')).not.toHaveProperty('options')
  })

  it('reads the strand choice exactly once per request (immutable snapshot)', async () => {
    let reads = 0
    const s = streamFor(() => { reads += 1; return 49152 })
    await s(nativeModel(), ctx(), { apiKey: 'no-key' }).result()
    expect(reads).toBe(1)
    expect(chats[0]!.options).toEqual({ num_ctx: 49152 })
  })

  it('explicit provider num_ctx outranks the modelfile; a smaller choice never lowers it', async () => {
    await streamFor(() => 32768, 49152)(nativeModel(), ctx(), { apiKey: 'no-key' }).result()
    expect(chats[0]).not.toHaveProperty('options')
    await streamFor(() => 65536, 49152)(nativeModel(), ctx(), { apiKey: 'no-key' }).result()
    expect(chats[1]!.options).toEqual({ num_ctx: 65536 })
  })

  it('/api/show failure → baseline unknown: request sent without num_ctx, failure cached (no refetch storm)', async () => {
    showStatus = 500
    const s = streamFor(() => 131072)
    await s(nativeModel(), ctx(), { apiKey: 'no-key' }).result()
    await s(nativeModel(), ctx(), { apiKey: 'no-key' }).result()
    expect(chats).toHaveLength(2)
    expect(chats[0]).not.toHaveProperty('options')
    expect(shows).toBe(1)
  })

  it('missing modelfile num_ctx → unknown baseline, no guessed floor, no override', async () => {
    modelfileNumCtx = undefined
    await streamFor(() => 65536)(nativeModel(), ctx(), { apiKey: 'no-key' }).result()
    expect(chats[0]).not.toHaveProperty('options')
  })

  it('native guard refuses input above the effective window; nothing is sent', async () => {
    const r = await streamFor(() => null)(nativeModel(), ctx(40_000), { apiKey: 'no-key' }).result()
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toMatch(/native Ollama context window/)
    expect(chats).toHaveLength(0)
    // The same conversation fits once the strand chooses 32768.
    const ok = await streamFor(() => 32768)(nativeModel(), ctx(40_000), { apiKey: 'no-key' }).result()
    expect(ok.stopReason).toBe('stop')
    expect(chats[0]!.options).toEqual({ num_ctx: 32768 })
  })

  it('explicit maxTokens that does not fit is refused, never silently reduced', async () => {
    const r = await streamFor(() => null)(nativeModel(), ctx(8_000), { apiKey: 'no-key', maxTokens: 3000 }).result()
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toMatch(/never reduced silently/)
    expect(chats).toHaveLength(0)
  })

  it('learned limits carry the num_ctx dimension: a limit learned at 4096 never blocks 65536', async () => {
    // 9000 chars fit the 4096 baseline on their own, but not a 2048 limit learned at num_ctx 4096.
    const before = await streamFor(() => null)(nativeModel(), ctx(9_000), { apiKey: 'no-key' }).result()
    expect(before.stopReason).toBe('stop')
    chats = []
    learnContextLimit(nativeLimitIdentity(nativeModel(), 4096), 2048, 'synthetic')
    const blocked = await streamFor(() => null)(nativeModel(), ctx(9_000), { apiKey: 'no-key' }).result()
    expect(blocked.stopReason).toBe('error')
    const ok = await streamFor(() => 65536)(nativeModel(), ctx(9_000), { apiKey: 'no-key' }).result()
    expect(ok.stopReason).toBe('stop')
    expect(chats).toHaveLength(1)
  })

  it('non-native api never consults the choice or /api/show', async () => {
    let reads = 0
    const s = streamFor(() => { reads += 1; return 65536 })
    const m = { ...nativeModel(), api: 'openai-completions', baseUrl: `${origin}/v1` } as Model<Api>
    await s(m, ctx(), { apiKey: 'synthetic', maxRetries: 0 } as never).result()
    expect(reads).toBe(0)
    expect(shows).toBe(0)
  })
})

describe('show-facts cache', () => {
  const okShow = (n: { calls: number }) => (async () => { n.calls += 1; return new Response(JSON.stringify({ parameters: 'num_ctx 8192', model_info: { 'a.context_length': 32768 } }), { status: 200 }) }) as unknown as typeof fetch

  it('caches per server+model within the TTL and revalidates after it', async () => {
    const n = { calls: 0 }
    let t = 0
    const now = () => t
    const r1 = await getOllamaShowFacts('http://h.invalid:11434', 'm', { fetchImpl: okShow(n), now })
    expect(r1).toMatchObject({ source: 'fresh', facts: { modelfileNumCtx: 8192, supportedMax: 32768 } })
    expect((await getOllamaShowFacts('http://h.invalid:11434/v1', 'm', { fetchImpl: okShow(n), now })).source).toBe('cached')
    await getOllamaShowFacts('http://h.invalid:11434', 'other', { fetchImpl: okShow(n), now })
    expect(n.calls).toBe(2)
    t = 10 * 60_000
    expect((await getOllamaShowFacts('http://h.invalid:11434', 'm', { fetchImpl: okShow(n), now })).source).toBe('fresh')
  })

  it('timeout → failed with empty facts (unknown), not a guess', async () => {
    const hang = ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('timeout'))))) as unknown as typeof fetch
    const r = await getOllamaShowFacts('http://h.invalid:11434', 'slow', { fetchImpl: hang, timeoutMs: 20 })
    expect(r.source).toBe('failed')
    expect(r.facts).toEqual({})
  })

  it('stale-on-error: success → TTL → failure keeps the last good facts (stale), bounded retry, recovery', async () => {
    const n = { calls: 0 }
    let fail = false
    const flaky = (async () => {
      n.calls += 1
      if (fail) return new Response('x', { status: 503 })
      return new Response(JSON.stringify({ parameters: 'num_ctx 8192', model_info: { 'general.architecture': 'a', 'a.context_length': 32768 }, details: { format: 'safetensors' } }), { status: 200 })
    }) as unknown as typeof fetch
    let t = 0
    const now = () => t
    const o = { fetchImpl: flaky, now }
    const good = { modelfileNumCtx: 8192, supportedMax: 32768, runner: 'mlx' }
    expect(await getOllamaShowFacts('http://h.invalid:11434', 's', o)).toMatchObject({ source: 'fresh', facts: good })
    t = 5 * 60_000 + 1
    fail = true
    const r = await getOllamaShowFacts('http://h.invalid:11434', 's', o)
    expect(r).toMatchObject({ source: 'stale', facts: good })
    expect(r.error).toContain('503')
    expect(peekOllamaShowFacts('http://h.invalid:11434', 's', o)).toEqual({ known: true, facts: good, failed: true, stale: true })
    // within the failure window: no new request (peek does not refresh either)
    t += 29_000
    expect((await getOllamaShowFacts('http://h.invalid:11434', 's', o)).source).toBe('stale')
    expect(n.calls).toBe(2)
    // after the failure window: one retry, still failing → still stale
    t += 2_000
    expect((await getOllamaShowFacts('http://h.invalid:11434', 's', o)).source).toBe('stale')
    expect(n.calls).toBe(3)
    // recovery: fresh again, stale flags cleared
    t += 31_000
    fail = false
    expect((await getOllamaShowFacts('http://h.invalid:11434', 's', o)).source).toBe('fresh')
    expect(peekOllamaShowFacts('http://h.invalid:11434', 's', o)).toEqual({ known: true, facts: good, failed: false, stale: false })
  })

  it('stale facts expire after maxStaleMs (no forever cache) and a cold failure is empty', async () => {
    let fail = false
    const flaky = (async () => fail ? new Response('x', { status: 500 }) : new Response(JSON.stringify({ parameters: 'num_ctx 4096' }), { status: 200 })) as unknown as typeof fetch
    let t = 0
    const o = { fetchImpl: flaky, now: () => t, maxStaleMs: 60 * 60_000 }
    await getOllamaShowFacts('http://h.invalid:11434', 'x', o)
    fail = true
    t = 59 * 60_000
    expect((await getOllamaShowFacts('http://h.invalid:11434', 'x', o)).source).toBe('stale')
    t = 60 * 60_000 + 1
    expect(await getOllamaShowFacts('http://h.invalid:11434', 'x', o)).toMatchObject({ source: 'failed', facts: {} })
    expect(peekOllamaShowFacts('http://h.invalid:11434', 'x', o)).toEqual({ known: false, facts: {}, failed: true, stale: false })
    // cold: never a success
    const cold = await getOllamaShowFacts('http://h.invalid:11434', 'never', o)
    expect(cold).toMatchObject({ source: 'failed', facts: {} })
    expect(peekOllamaShowFacts('http://h.invalid:11434', 'never', o)).toEqual({ known: false, facts: {}, failed: true, stale: false })
  })

  it('peek: unknown key → pending (not failed) and starts one background fetch; concurrent callers share it', async () => {
    const n = { calls: 0 }
    let release: () => void = () => undefined
    const gate = new Promise<void>(r => { release = r })
    const slow = (async () => { n.calls += 1; await gate; return new Response(JSON.stringify({ parameters: 'num_ctx 2048' }), { status: 200 }) }) as unknown as typeof fetch
    const o = { fetchImpl: slow }
    expect(peekOllamaShowFacts('http://h.invalid:11434', 'p', o)).toEqual({ known: false, facts: {}, failed: false, stale: false })
    const a = getOllamaShowFacts('http://h.invalid:11434', 'p', o)
    const b = getOllamaShowFacts('http://h.invalid:11434', 'p', o)
    release()
    expect((await a).facts).toEqual({ modelfileNumCtx: 2048 })
    expect((await b).facts).toEqual({ modelfileNumCtx: 2048 })
    expect(n.calls).toBe(1)
  })

  it('a caller abort is not cached as a server failure', async () => {
    const ac = new AbortController()
    const hang = ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch
    const p = getOllamaShowFacts('http://h.invalid:11434', 'ab', { fetchImpl: hang, signal: ac.signal })
    ac.abort()
    expect((await p).source).toBe('failed')
    const n = { calls: 0 }
    expect((await getOllamaShowFacts('http://h.invalid:11434', 'ab', { fetchImpl: okShow(n) })).source).toBe('fresh')
  })
})
