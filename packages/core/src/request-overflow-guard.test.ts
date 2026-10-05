/**
 * M4 universal context-overflow guard (plan 2026-10-05-real-eco).
 * Real pi-ai serializers over a fake HTTP server; synthetic data only.
 */
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { buildStreamFn } from './provider-config.js'
import {
  CONTEXT_GUARD_MARKER, decideRequest, getObservedContextLimit, guardStream, learnContextLimit,
  parseProviderOverflow, resetObservedContextLimits, sdkRequestShape,
  observedLimitsFilePath, reloadObservedContextLimitsForTest, OBSERVED_LIMIT_TTL_MS,
} from './request-overflow-guard.js'
import { isRetryableTurnError } from './turn-retry.js'

type Body = Record<string, unknown>
let server: http.Server
let origin: string
let received: Body[] = []
let script: Array<(res: http.ServerResponse) => void> = []

function openaiText(res: http.ServerResponse, text = 'ok') {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  res.write(frame({ role: 'assistant', content: text }, null))
  res.write(frame({}, 'stop'))
  res.end('data: [DONE]\n\n')
}
function jsonError(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } }))
}
function anthropicText(res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
  ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  ev('message_stop', {})
  res.end()
}

beforeEach(async () => {
  resetObservedContextLimits()
  received = []
  script = []
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      try { received.push(JSON.parse(raw) as Body) } catch { received.push({}) }
      const next = script.shift()
      if (next) next(res)
      else openaiText(res)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()))
  resetObservedContextLimits()
})

function oaModel(over: Partial<Model<Api>> = {}): Model<Api> {
  return { id: 'local-test', name: 'Local', api: 'openai-completions', provider: 'openai', baseUrl: `${origin}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 65536, ...over } as Model<Api>
}
function anthModel(over: Partial<Model<Api>> = {}): Model<Api> {
  return { id: 'claude-fake', name: 'Claude fake', api: 'anthropic-messages', provider: 'anthropic', baseUrl: origin, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 64000, ...over } as Model<Api>
}
function ctx(chars: number, sys = 'You are a synthetic test agent.'): Context {
  return {
    systemPrompt: sys,
    messages: [{ role: 'user', content: 'x'.repeat(chars), timestamp: 1 }],
    tools: [{ name: 'synthetic_tool', description: 'synthetic', parameters: { type: 'object', properties: {} } as never }],
  } as Context
}
const provider = { textVerbosity: undefined, transport: undefined } as never
async function run(model: Model<Api>, context: Context, options: Record<string, unknown> = {}) {
  const fn = buildStreamFn(provider, undefined, { settings: { retention: 'short', sessionAffinity: false } as never })
  const s = fn(model as never, context, { apiKey: 'synthetic', maxRetries: 0, ...options } as never)
  for await (const _ of s) { /* drain */ }
  return s.result()
}

describe('parseProviderOverflow', () => {
  it('parses OpenAI/vLLM, llama.cpp, Anthropic, Ollama; ignores own refusals and ordinary errors', () => {
    expect(parseProviderOverflow("400 This model's maximum context length is 40960 tokens. However, you requested 65000 tokens (2000 in the messages, 63000 in the completion).")).toEqual({ limit: 40960, inputTokens: 2000 })
    expect(parseProviderOverflow('400 {"error":{"code":400,"message":"the request exceeds the available context size","type":"exceed_context_size_error","n_prompt_tokens":9000,"n_ctx":8192}}')).toEqual({ limit: 8192, inputTokens: 9000 })
    expect(parseProviderOverflow('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}')).toEqual({ limit: 200000, inputTokens: 210000 })
    expect(parseProviderOverflow('input length and `max_tokens` exceed context limit: 190000 + 21333 > 200000')).toEqual({ limit: 200000, inputTokens: 190000 })
    expect(parseProviderOverflow('prompt too long; exceeded max context length by 12 tokens')).toEqual({ limit: null, inputTokens: null })
    expect(parseProviderOverflow(`${CONTEXT_GUARD_MARKER} maximum context length is 10 tokens`)).toBeNull()
    expect(parseProviderOverflow('403 forbidden')).toBeNull()
    expect(parseProviderOverflow('500 internal server error')).toBeNull()
    // raw provider overflow text whose token counts contain "500" is not a transient error
    expect(isRetryableTurnError("400 This model's maximum context length is 40500 tokens.")).toBe(false)
    expect(isRetryableTurnError('500 internal server error')).toBe(true)
  })
})

describe('guard: allowed requests are untouched', () => {
  it('passes the very same model/context/options objects to the SDK (Normal wire unchanged)', async () => {
    const seen: unknown[][] = []
    const inner = ((m: unknown, c: unknown, o: unknown) => { seen.push([m, c, o]); return { async *[Symbol.asyncIterator]() { /* empty */ }, result: async () => ({}) } }) as never
    const m = oaModel(); const c = ctx(1000); const o = { maxTokens: 65536 }
    guardStream(inner)(m, c, o as never)
    expect(seen[0]![0]).toBe(m); expect(seen[0]![1]).toBe(c); expect(seen[0]![2]).toBe(o)
  })

  it('M=W=65536 without observation is NOT refused (SDK clamps max_tokens itself)', async () => {
    const r = await run(oaModel(), ctx(30000))
    expect(r.stopReason).toBe('stop')
    expect(received).toHaveLength(1)
    const sent = Number(received[0]!.max_completion_tokens ?? received[0]!.max_tokens)
    expect(sent).toBeLessThan(65536)          // pi-ai's own clamp
    expect(sent).toBeGreaterThan(40000)
  })
})

describe('guard: learned window, one retry, fail-fast', () => {
  it('W=65536 declared, provider observed 40960: learns, retries ONCE with the SDK clamp on the learned window, next request needs no retry', async () => {
    script.push(res => jsonError(res, 400, "This model's maximum context length is 40960 tokens. However, you requested 75000 tokens (11500 in the messages, 63500 in the completion)."))
    const r = await run(oaModel(), ctx(30000))
    expect(r.stopReason).toBe('stop')
    expect(received).toHaveLength(2)
    const second = Number(received[1]!.max_completion_tokens ?? received[1]!.max_tokens)
    expect(second + 11500).toBeLessThanOrEqual(40960)
    // everything except max tokens is byte-identical
    const strip = (b: Body) => JSON.stringify({ ...b, max_tokens: 0, max_completion_tokens: 0 })
    expect(strip(received[1]!)).toBe(strip(received[0]!))
    expect(getObservedContextLimit(oaModel())?.tokens).toBe(40960)
    await run(oaModel(), ctx(30000))
    expect(received).toHaveLength(3)
    expect(Number(received[2]!.max_completion_tokens ?? received[2]!.max_tokens)).toBeLessThanOrEqual(40960 - 10000)
  })

  it('second overflow after the retry fails fast with a typed message, at most 2 HTTP calls, not retryable', async () => {
    const err = "This model's maximum context length is 40960 tokens. However, you requested 75000 tokens (11500 in the messages, 63500 in the completion)."
    script.push(res => jsonError(res, 400, err), res => jsonError(res, 400, err), res => jsonError(res, 400, err))
    const r = await run(oaModel(), ctx(30000))
    expect(received).toHaveLength(2)
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toContain(CONTEXT_GUARD_MARKER)
    expect(r.errorMessage).toContain('new strand')
    expect(isRetryableTurnError(r.errorMessage!)).toBe(false)
  })

  it('pure input over the learned window: refused before sending, numbers estimated vs window, zero HTTP', async () => {
    learnContextLimit(oaModel(), 8192, 'synthetic')
    const r = await run(oaModel(), ctx(60000))
    expect(received).toHaveLength(0)
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toMatch(/context-guard.*estimated input \d+–\d+ tokens.*observed context window 8192/)
    expect(isRetryableTurnError(r.errorMessage!)).toBe(false)
  })

  it('provider says input itself is over (prompt too long): learns, no retry, fail-fast', async () => {
    script.push(res => jsonError(res, 400, "This model's maximum context length is 4096 tokens. However, you requested 12000 tokens (9000 in the messages, 3000 in the completion)."))
    const r = await run(oaModel(), ctx(20000))
    expect(received).toHaveLength(1)
    expect(r.errorMessage).toContain(CONTEXT_GUARD_MARKER)
    expect(r.errorMessage).toContain('provider measured 9000 input tokens')
    // next call is refused locally instead of repeating the HTTP 400
    const r2 = await run(oaModel(), ctx(20000))
    expect(received).toHaveLength(1)
    expect(r2.errorMessage).toContain('Request not sent')
  })

  it('gray zone (only chars/3 over, chars/4 under) is sent; the provider decides', async () => {
    learnContextLimit(oaModel(), 9000, 'synthetic')
    await run(oaModel(), ctx(30000))   // chars/3 ≈ 10000+, chars/4 ≈ 7500+
    expect(received).toHaveLength(1)
  })

  it('ordinary provider errors pass through unmasked', async () => {
    script.push(res => jsonError(res, 403, 'synthetic forbidden'))
    const r = await run(oaModel(), ctx(100))
    expect(received).toHaveLength(1)
    expect(r.errorMessage).toContain('synthetic forbidden')
    expect(r.errorMessage).not.toContain(CONTEXT_GUARD_MARKER)
  })

  it('limits are keyed by provider/model/baseUrl: another endpoint or model is unaffected (cross-session shared per key)', () => {
    learnContextLimit(oaModel(), 8192, 'synthetic')
    expect(getObservedContextLimit(oaModel())?.tokens).toBe(8192)
    expect(getObservedContextLimit(oaModel({ id: 'other' }))).toBeUndefined()
    expect(getObservedContextLimit(oaModel({ baseUrl: 'http://127.0.0.2/v1' }))).toBeUndefined()
    learnContextLimit(oaModel(), 30000, 'higher never raises')
    expect(getObservedContextLimit(oaModel())?.tokens).toBe(8192)
  })
})

describe('guard: learned windows survive a restart (persisted store)', () => {
  it('a window learned from a provider 400 is persisted and applied after a simulated restart without a new HTTP 400', async () => {
    script.push(res => jsonError(res, 400, "This model's maximum context length is 4096 tokens. However, you requested 12000 tokens (9000 in the messages, 3000 in the completion)."))
    await run(oaModel(), ctx(20000))
    expect(received).toHaveLength(1)
    const file = observedLimitsFilePath()
    expect(fs.existsSync(file)).toBe(true)
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as { version: number; limits: Record<string, { tokens: number; source: string }> }
    expect(stored.version).toBe(1)
    expect(Object.values(stored.limits).map(v => v.tokens)).toEqual([4096])
    // the key is a hash of provider|id|baseUrl: no URL or prompt text in the file
    expect(JSON.stringify(stored)).not.toContain('127.0.0.1')
    expect(JSON.stringify(stored)).not.toContain('xxxx')
    reloadObservedContextLimitsForTest()            // process restart: memory gone, file stays
    expect(getObservedContextLimit(oaModel())?.tokens).toBe(4096)
    const r = await run(oaModel(), ctx(20000))
    expect(received).toHaveLength(1)                // refused locally, no repeated HTTP 400
    expect(r.errorMessage).toContain('Request not sent')
  })

  it('stale (older than TTL) or corrupt persisted entries are ignored: declared window applies again', () => {
    const file = observedLimitsFilePath()
    learnContextLimit(oaModel(), 8192, 'synthetic')
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as { limits: Record<string, { at: number }> }
    for (const v of Object.values(stored.limits)) v.at = Date.now() - OBSERVED_LIMIT_TTL_MS - 1000
    fs.writeFileSync(file, JSON.stringify(stored))
    reloadObservedContextLimitsForTest()
    expect(getObservedContextLimit(oaModel())).toBeUndefined()
    fs.writeFileSync(file, '{not json')
    reloadObservedContextLimitsForTest()
    expect(getObservedContextLimit(oaModel())).toBeUndefined()
    // learning again rewrites a valid file
    learnContextLimit(oaModel(), 9000, 'synthetic')
    reloadObservedContextLimitsForTest()
    expect(getObservedContextLimit(oaModel())?.tokens).toBe(9000)
  })
})

describe('guard: thinking / reasoning fields never changed to fit', () => {
  it('anthropic budget thinking: a learned window that would change the thinking budget is not applied as override', () => {
    const m = anthModel()
    const c = ctx(1000)
    learnContextLimit(m, 20000, 'synthetic')
    const d = decideRequest(m, c, { reasoning: 'high' } as never)
    const shape = sdkRequestShape(m, c, { reasoning: 'high' } as never)
    // the SDK would request more than the learned window → refusal, not a lowered budget
    expect(shape.maxTokens).toBeGreaterThan(20000)
    expect(d.kind).toBe('refuse')
    if (d.kind === 'refuse') expect(d.reason).toBe('reserve_needs_reasoning_change')
  })

  it('options/thinking matrix: without a learned limit, every combination passes the original objects', () => {
    for (const model of [oaModel(), oaModel({ reasoning: true } as never), anthModel(), anthModel({ compat: { forceAdaptiveThinking: true } } as never)]) {
      for (const reasoning of [undefined, 'minimal', 'low', 'medium', 'high', 'xhigh']) {
        for (const maxTokens of [undefined, 1024, model.maxTokens]) {
          const d = decideRequest(model, ctx(5000), { reasoning, maxTokens } as never)
          expect(d.kind).toBe('send')
          if (d.kind === 'send') { expect(d.model).toBe(model); expect(d.overridden).toBe(false) }
        }
      }
    }
  })

  it('anthropic wire through buildStreamFn: <=4 cache_control markers and identical body with the guard active', async () => {
    const fn = buildStreamFn(provider, undefined, { settings: { retention: 'short', sessionAffinity: false } as never })
    script.push(res => anthropicText(res), res => anthropicText(res))
    const c = ctx(4000)
    for (let i = 0; i < 2; i++) {
      const s = fn(anthModel() as never, c, { apiKey: 'synthetic', maxRetries: 0, reasoning: 'medium' } as never)
      for await (const _ of s) { /* drain */ }
    }
    expect(received).toHaveLength(2)
    expect(JSON.stringify(received[0])).toBe(JSON.stringify(received[1]))
    expect(JSON.stringify(received[0]).split('"cache_control"').length - 1).toBeLessThanOrEqual(4)
  })

  it('malformed/unknown window: no pre-send check, provider error gets an explicit reason', async () => {
    script.push(res => jsonError(res, 400, 'the request exceeds the available context size, n_ctx: 2048, n_prompt_tokens: 5000'))
    const r = await run(oaModel({ contextWindow: 0 }), ctx(100))
    expect(received).toHaveLength(1)
    expect(r.errorMessage).toContain('declares no valid context window')
  })
})
