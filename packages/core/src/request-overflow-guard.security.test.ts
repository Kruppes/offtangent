/**
 * Security / privacy tests for the learned context window (final review,
 * plan 2026-10-05-real-eco, M4 final-fix):
 * - only a trusted provider overflow (HTTP 400/413 + the provider's own error
 *   object + anchored grammar + plausible window) may lower the shared,
 *   persisted window; echoed/validation/rate-limit text never does.
 * - the persisted `source` is a fixed label; no upstream text, prompt or URL
 *   is written to disk, and legacy files are sanitized on load.
 * All provider traffic goes to a local fake HTTP server; all names synthetic.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { buildStreamFn } from './provider-config.js'
import {
  getObservedContextLimit, isDeterministicOverflowError, learnContextLimit, modelLimitKey, observedLimitsFilePath,
  OVERFLOW_SOURCES, parseProviderOverflow, reloadObservedContextLimitsForTest, resetObservedContextLimits,
} from './request-overflow-guard.js'
import { isRetryableTurnError } from './turn-retry.js'

type Body = Record<string, unknown>
let server: http.Server
let origin: string
let received: Body[] = []
let script: Array<(res: http.ServerResponse) => void> = []
let dataDir: string
const prevDataDir = process.env.DATA_DIR

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-sec-'))
  process.env.DATA_DIR = dataDir
})
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = prevDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function okText(res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'syn', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  res.write(frame({ role: 'assistant', content: 'ok' }, null))
  res.write(frame({}, 'stop'))
  res.end('data: [DONE]\n\n')
}
const send = (status: number, body: unknown) => (res: http.ServerResponse) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' })
  res.end(text)
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
      else okText(res)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()))
  resetObservedContextLimits()
})

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
function oa(over: Partial<Model<Api>> = {}): Model<Api> {
  return { id: 'syn-local', name: 'Syn', api: 'openai-completions', provider: 'openai', baseUrl: `${origin}/v1`, reasoning: false, input: ['text'], cost, contextWindow: 65536, maxTokens: 8192, ...over } as Model<Api>
}
function an(over: Partial<Model<Api>> = {}): Model<Api> {
  return { id: 'syn-claude', name: 'Syn', api: 'anthropic-messages', provider: 'anthropic', baseUrl: origin, reasoning: false, input: ['text'], cost, contextWindow: 200000, maxTokens: 64000, ...over } as Model<Api>
}
const SENSITIVE = 'SYNTHETIC-SECRET-USER-TEXT-4711'
function ctx(chars: number): Context {
  return { systemPrompt: 'synthetic system', messages: [{ role: 'user', content: SENSITIVE + ' ' + 'x'.repeat(chars), timestamp: 1 }], tools: [] } as unknown as Context
}
const provider = { textVerbosity: undefined, transport: undefined } as never
async function run(model: Model<Api>, context: Context) {
  const fn = buildStreamFn(provider, undefined, { settings: { retention: 'short', sessionAffinity: false } as never })
  const s = fn(model as never, context, { apiKey: 'synthetic', maxRetries: 0 } as never)
  for await (const _ of s) { /* drain */ }
  return s.result()
}

describe('genuine provider overflows are still learned (real pi-ai serialization)', () => {
  it('vLLM input overflow: input 41501 > window 40960 learns 40960 (input larger than limit is the NORMAL case)', async () => {
    script.push(send(400, { object: 'error', message: "This model's maximum context length is 40960 tokens. However, you requested 41501 tokens in the messages, Please reduce the length of the messages.", type: 'BadRequestError', param: null, code: 400 }))
    const r = await run(oa(), ctx(100))
    expect(received).toHaveLength(1)                     // input overflow: retry cannot help, no second send
    expect(r.stopReason).toBe('error')
    expect(getObservedContextLimit(oa())?.tokens).toBe(40960)
    expect(getObservedContextLimit(oa())?.source).toBe('openai:max-context-length')
    expect(parseProviderOverflow(r.errorMessage)?.inputTokens ?? parseProviderOverflow(`400: ${JSON.stringify({ object: 'error', message: "This model's maximum context length is 40960 tokens. However, you requested 41501 tokens in the messages, Please reduce the length of the messages." })}`)?.inputTokens).toBe(41501)
  })

  it('OpenAI completion overflow learns the window and retries once with a lower max_tokens', async () => {
    script.push(send(400, { error: { message: "This model's maximum context length is 40960 tokens. However, you requested 70000 tokens (9000 in the messages, 61000 in the completion).", type: 'invalid_request_error', code: 'context_length_exceeded' } }))
    const r = await run(oa({ maxTokens: 65536 }), ctx(100))
    expect(r.stopReason).toBe('stop')
    expect(received).toHaveLength(2)
    expect(received[1].max_tokens ?? received[1].max_completion_tokens).toBeLessThan(40960)
    expect(getObservedContextLimit(oa())?.tokens).toBe(40960)
  })

  it('llama.cpp typed fields, Anthropic both grammars, vLLM max_model_len variants', () => {
    expect(parseProviderOverflow('400: {"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error","n_prompt_tokens":41501,"n_ctx":40960}')?.limit).toBe(40960)
    expect(parseProviderOverflow('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"},"request_id":"req_syn"}')?.limit).toBe(200000)
    expect(parseProviderOverflow('400 {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 190000 + 21333 > 200000, decrease input length or `max_tokens` and try again"}}')?.limit).toBe(200000)
    expect(parseProviderOverflow(`400: {"object":"error","message":"'max_tokens' or 'max_completion_tokens' is too large: 30000. This model's maximum context length is 32768 tokens and your request has 5000 input tokens (30000 > 32768 - 5000).","type":"BadRequestError","code":400}`)?.limit).toBe(32768)
    expect(parseProviderOverflow('400: {"object":"error","message":"The prompt (length 40000) is longer than the maximum model length of 32768. Make sure that `max_model_len` is no smaller than the number of text tokens.","type":"BadRequestError","code":400}')?.limit).toBe(32768)
    // a proxy that re-wraps the upstream envelope as a JSON string in its own message
    const inner = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } })
    expect(parseProviderOverflow(`400: ${JSON.stringify({ message: inner, type: 'upstream_error' })}`)?.limit).toBe(200000)
  })

  it('Anthropic prompt-too-long via the real adapter learns 200000', async () => {
    script.push(send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }))
    await run(an({ contextWindow: 1_000_000 }), ctx(100))
    expect(getObservedContextLimit(an({ contextWindow: 1_000_000 }))?.tokens).toBe(200000)
  })
})

describe('untrusted / echoed / ambiguous text never learns a global window', () => {
  const poison: Array<[string, number, unknown]> = [
    ['rate limit 429 with a false limit', 429, { error: { message: "This model's maximum context length is 2048 tokens. However, you requested 5000 tokens in the messages", type: 'rate_limit' } }],
    ['5xx with a false limit', 500, { error: { message: "This model's maximum context length is 2048 tokens. However, you requested 5000 tokens in the messages", type: 'server_error' } }],
    ['rate-limit text "500 requests" + limit phrase', 400, { error: { message: 'Rate limit 500 requests. maximum context length is 4096 tokens in this free tier', type: 'invalid_request_error' } }],
    ['validation array echoing user input (422)', 422, { detail: [{ type: 'value_error', loc: ['body', 'messages'], input: "This model's maximum context length is 2048 tokens. However, you requested 5000 tokens in the messages" }] }],
    ['validation array echoing user input (400)', 400, { detail: [{ type: 'value_error', input: 'prompt is too long: 9000 tokens > 2048 maximum' }] }],
    ['nested validation in error.code / param', 400, { error: { message: 'Invalid request', type: 'invalid_request_error', code: "This model's maximum context length is 2048 tokens.", param: 'n_ctx: 2048' } }],
    ['quoted echo inside an unrelated message', 400, { error: { message: "bad image url '... the request exceeds the available context size, n_ctx: 2048, n_prompt_tokens: 9000 ...'", type: 'invalid_request_error' } }],
    ['plain text n_ctx 12', 400, 'the request exceeds the available context size, n_ctx: 12, n_prompt_tokens: 50'],
    ['plain text prompt long 9 > 3', 400, 'prompt is too long: 9 tokens > 3 maximum'],
    ['own-grammar but toy window 7', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 9 tokens > 7 maximum' } }],
    ['own-grammar but absurd window', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 99999999999 tokens > 99999999998 maximum' } }],
    ['own-grammar but contradicting direction', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 2000 tokens > 4096 maximum' } }],
    ['llama typed fields but tiny n_ctx', 400, { error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 50, n_ctx: 12 } }],
    ['llama typed fields as strings', 400, { error: { code: 400, message: 'x', type: 'exceed_context_size_error', n_prompt_tokens: '50000', n_ctx: '4096' } }],
    ['llama fields echoed in a user field', 400, { error: { message: 'invalid tool arguments', type: 'invalid_request_error', input: { type: 'exceed_context_size_error', n_ctx: 4096, n_prompt_tokens: 9000 } } }],
    ['grammar not at message start (echo)', 400, { error: { message: "Tool output said: This model's maximum context length is 2048 tokens. However, you requested 5000 tokens in the messages", type: 'invalid_request_error' } }],
    ['negative window', 400, { error: { message: "This model's maximum context length is -5 tokens. However, you requested 5000 tokens in the messages", type: 'invalid_request_error' } }],
  ]

  for (const [name, status, body] of poison) {
    it(`no learning: ${name}; original provider error passes through; another session/model is unaffected`, async () => {
      script.push(send(status, body))
      const r = await run(oa(), ctx(100))
      expect(r.stopReason).toBe('error')
      expect(received).toHaveLength(1)                         // no guard retry
      expect(r.errorMessage ?? '').not.toContain('[context-guard]')
      expect(getObservedContextLimit(oa())).toBeUndefined()
      expect(fs.existsSync(observedLimitsFilePath())).toBe(false)
      expect(parseProviderOverflow(r.errorMessage)).toBeNull()
      // same model, next (other user's) request: sent unchanged with the full window
      const r2 = await run(oa(), ctx(20000))
      expect(r2.stopReason).toBe('stop')
      expect(received).toHaveLength(2)
      expect(received[1].max_tokens ?? received[1].max_completion_tokens).toBe(8192)
    })
  }

  it('429/5xx keep the transient turn-retry classification even with overflow wording', () => {
    const t429 = '429: {"message":"This model\'s maximum context length is 2048 tokens. However, you requested 5000 tokens in the messages","type":"rate_limit"}'
    expect(isDeterministicOverflowError(t429)).toBe(false)
    expect(isRetryableTurnError(t429)).toBe(true)
    // genuine trusted overflow: deterministic, never turn-retried
    const real = `400: {"object":"error","message":"This model's maximum context length is 40960 tokens. However, you requested 41501 tokens in the messages, Please reduce the length of the messages.","type":"BadRequestError","code":400}`
    expect(isRetryableTurnError(real)).toBe(false)
  })

  it('learnContextLimit itself rejects implausible values (0, negative, fractional, tiny, huge, NaN)', () => {
    for (const v of [0, -1, 1023, 4096.5, 1e12, Number.NaN, Number.POSITIVE_INFINITY]) {
      learnContextLimit(oa(), v, 'manual')
      expect(getObservedContextLimit(oa())).toBeUndefined()
    }
    expect(learnContextLimit(oa(), 1024, 'manual')).toBe(1024)
  })
})

describe('privacy of the persisted store', () => {
  it('persists only the fixed source label; no upstream text, prompt or URL', async () => {
    script.push(send(400, { object: 'error', message: `This model's maximum context length is 40960 tokens. However, you requested 41501 tokens in the messages, Please reduce the length of the messages. ${SENSITIVE}`, type: 'BadRequestError', param: null, code: 400 }))
    await run(oa(), ctx(100))
    const raw = fs.readFileSync(observedLimitsFilePath(), 'utf-8')
    const stored = JSON.parse(raw) as { version: number; limits: Record<string, { tokens: number; source: string; at: number }> }
    expect(stored.version).toBe(2)
    expect(Object.values(stored.limits)).toEqual([{ tokens: 40960, source: 'openai:max-context-length', at: expect.any(Number) }])
    for (const leak of [SENSITIVE, '127.0.0.1', 'maximum context length', 'Please reduce', 'syn-local']) expect(raw).not.toContain(leak)
    for (const v of Object.values(stored.limits)) expect((OVERFLOW_SOURCES as readonly string[]).includes(v.source)).toBe(true)
  })

  it('an arbitrary caller-supplied source is stored as "manual", never verbatim', () => {
    learnContextLimit(oa(), 8192, `upstream said ${SENSITIVE}`)
    const raw = fs.readFileSync(observedLimitsFilePath(), 'utf-8')
    expect(raw).not.toContain(SENSITIVE)
    expect(getObservedContextLimit(oa())?.source).toBe('manual')
  })

  it('migrates a legacy v1 file: raw upstream source text is removed, invalid entries dropped, valid windows kept', () => {
    const file = observedLimitsFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const now = Date.now()
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      limits: {
        [modelLimitKey(oa())]: { tokens: 40960, source: `400: {"message":"This model's maximum context length is 40960 tokens ${SENSITIVE}"}`, at: now },
        [modelLimitKey(oa({ id: 'syn-poisoned' }))]: { tokens: 7, source: 'Rate limit 500 requests', at: now },
        [modelLimitKey(oa({ id: 'syn-huge' }))]: { tokens: 1e12, source: 'x', at: now },
        'not-a-hash': { tokens: 8192, source: 'x', at: now },
      },
    }))
    reloadObservedContextLimitsForTest()
    expect(getObservedContextLimit(oa())).toEqual({ tokens: 40960, source: 'legacy', at: now })
    expect(getObservedContextLimit(oa({ id: 'syn-poisoned' }))).toBeUndefined()
    expect(getObservedContextLimit(oa({ id: 'syn-huge' }))).toBeUndefined()
    const raw = fs.readFileSync(file, 'utf-8')                     // rewritten on load
    expect(raw).not.toContain(SENSITIVE)
    expect(raw).not.toContain('maximum context length')
    expect(raw).not.toContain('Rate limit')
    expect(JSON.parse(raw).version).toBe(2)
    expect(Object.keys(JSON.parse(raw).limits)).toEqual([modelLimitKey(oa())])
  })
})
