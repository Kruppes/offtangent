import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { buildStreamFn } from '../provider-config.js'
import { resetObservedContextLimits } from '../request-overflow-guard.js'
import { OLLAMA_CHAT_API } from './chat-stream.js'
import { decideNumCtx, parseOllamaShow, resolveBaseline, resolveNativeThink, type ContextWindowChoice } from './context-window.js'
import { resetShowFactsCacheForTest } from './show-facts.js'

/*
 * Reproduces the two gaps found live on 2026-10-05 with SYNTHETIC /api/show
 * shapes mirroring Ollama 0.34 MLX models (qwen3.8:27b-mlx, gemma4:12b-mlx):
 * no modelfile num_ctx, architecture max 262144, native `thinking.values`.
 * Fake HTTP server only, no real model.
 */

const QWEN_SHOW = {
  parameters: 'top_k                          20\ntemperature                    1',
  model_info: { 'general.architecture': 'qwen3_5', 'qwen3_5.context_length': 262144 },
  capabilities: ['completion', 'tools', 'thinking'],
  thinking: { values: [false, 'low', 'medium', 'xhigh'], default: 'medium' },
}
const GEMMA_SHOW = {
  parameters: 'top_k                          64\ntemperature                    1',
  model_info: { 'general.architecture': 'gemma4_unified', 'gemma4_unified.context_length': 262144 },
  capabilities: ['completion', 'tools', 'thinking'],
  thinking: { values: [false, true], default: true },
}
const PLAIN_SHOW = {
  parameters: 'temperature 1',
  model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 },
  capabilities: ['completion'],
}

let server: http.Server
let origin = ''
let chats: Array<Record<string, unknown>> = []
/** Synthetic /api/show outage switch + call counter (stale-on-error repro). */
let showFails = false
let showCalls = 0
const shows: Record<string, unknown> = { 'qwen-synth:27b': QWEN_SHOW, 'gemma-synth:12b': GEMMA_SHOW, 'plain-synth:8b': PLAIN_SHOW }

beforeEach(async () => {
  resetShowFactsCacheForTest()
  resetObservedContextLimits()
  chats = []
  showFails = false
  showCalls = 0
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { model?: string }
      if (req.url === '/api/show') {
        showCalls += 1
        if (showFails) { res.writeHead(500); res.end('synthetic outage'); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(shows[body.model ?? ''] ?? {}))
        return
      }
      if (req.url === '/api/chat') {
        chats.push(body as Record<string, unknown>)
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

function model(id: string, reasoning = false): Model<Api> {
  return {
    id, name: id, api: OLLAMA_CHAT_API, provider: 'gq-test', baseUrl: origin,
    reasoning, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 4096,
  } as Model<Api>
}
const ctx: Context = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'synthetic ping', timestamp: 1 }] }

async function send(m: Model<Api>, choice: ContextWindowChoice, opts: { modelNumCtx?: Record<string, number>; reasoning?: string; context?: Context } = {}) {
  const fn = buildStreamFn({
    textVerbosity: undefined, transport: undefined, providerType: 'ollama-native',
    models: Object.entries(opts.modelNumCtx ?? {}).map(([id, n]) => ({ id, ollamaNumCtx: n })),
  }, undefined, { getSessionId: () => undefined, getContextWindowChoice: () => choice })
  const stream = fn(m, opts.context ?? ctx, { apiKey: 'no-key', ...(opts.reasoning ? { reasoning: opts.reasoning as never } : {}) })
  const final = await stream.result()
  return { final, body: chats.at(-1) }
}

describe('gap 1: unknown modelfile num_ctx needs a configured per-model baseline', () => {
  it('without any configured baseline a choice stays baseline_unknown (unchanged ADR rule, nothing sent)', async () => {
    const { body } = await send(model('qwen-synth:27b'), 65536)
    expect(body?.options).toBeUndefined()
  })
  it('per-model baseline 40960: choice above is sent, choice below/equal never lowers, null sends nothing', async () => {
    const cfg = { modelNumCtx: { 'qwen-synth:27b': 40960 } }
    expect((await send(model('qwen-synth:27b'), 65536, cfg)).body?.options).toEqual({ num_ctx: 65536 })
    expect((await send(model('qwen-synth:27b'), 32768, cfg)).body?.options).toBeUndefined()
    expect((await send(model('qwen-synth:27b'), null, cfg)).body?.options).toBeUndefined()
    // the setting is per model: another model of the same provider stays unknown
    expect((await send(model('gemma-synth:12b'), 65536, cfg)).body?.options).toBeUndefined()
  })
  it('model setting outranks provider setting and modelfile; model max stays a separate cap', () => {
    const facts = { modelNumCtx: 40960, providerNumCtx: 8192, modelfileNumCtx: 4096, supportedMax: 262144 }
    expect(decideNumCtx({ nativeProvider: true, choice: 49152, facts })).toMatchObject({ numCtx: 49152, state: 'applied' })
    expect(decideNumCtx({ nativeProvider: true, choice: 32768, facts })).toMatchObject({ numCtx: undefined, state: 'baseline_kept', guardWindow: 40960 })
    expect(decideNumCtx({ nativeProvider: true, choice: 131072, facts: { modelNumCtx: 40960, supportedMax: 65536 } })).toMatchObject({ numCtx: undefined, state: 'exceeds_supported' })
  })
})

describe('gap 2: think follows the native /api/show thinking contract', () => {
  it('parses thinking.values (garbage ignored)', () => {
    expect(parseOllamaShow(QWEN_SHOW).thinkValues).toEqual([false, 'low', 'medium', 'xhigh'])
    expect(parseOllamaShow(GEMMA_SHOW).thinkValues).toEqual([false, true])
    expect(parseOllamaShow(PLAIN_SHOW).thinkValues).toBeUndefined()
    expect(parseOllamaShow({ thinking: { values: [{}, 'drop table', 3] } }).thinkValues).toBeUndefined()
  })
  it('resolveNativeThink: off → false when supported; levels exact or next LOWER supported; booleans → true', () => {
    const q = [false, 'low', 'medium', 'xhigh'] as const
    expect(resolveNativeThink([...q], undefined)).toEqual({ think: false })
    expect(resolveNativeThink([...q], 'off')).toEqual({ think: false })
    expect(resolveNativeThink([...q], 'medium')).toEqual({ think: 'medium' })
    expect(resolveNativeThink([...q], 'high')).toEqual({ think: 'medium' })
    expect(resolveNativeThink([...q], 'xhigh')).toEqual({ think: 'xhigh' })
    expect(resolveNativeThink([...q], 'minimal')).toEqual({ think: 'low' })
    expect(resolveNativeThink([false, true], undefined)).toEqual({ think: false })
    expect(resolveNativeThink([false, true], 'high')).toEqual({ think: true })
    // cannot be switched off (no false advertised) → omit, never send a value the server rejects
    expect(resolveNativeThink(['low', 'medium', 'high'], undefined)).toEqual({ think: undefined })
  })
  it('Qwen with thinking off (non-reasoning metadata) sends think:false (was: field omitted → Qwen thinks)', async () => {
    const { body, final } = await send(model('qwen-synth:27b'), null)
    expect(final.stopReason).toBe('stop')
    expect(body?.think).toBe(false)
  })
  it('Qwen reasoning model: on → advertised level, off → false', async () => {
    expect((await send(model('qwen-synth:27b', true), null, { reasoning: 'medium' })).body?.think).toBe('medium')
    expect((await send(model('qwen-synth:27b', true), null, { reasoning: 'high' })).body?.think).toBe('medium')
    expect((await send(model('qwen-synth:27b', true), null)).body?.think).toBe(false)
  })
  it('Gemma without thinking sends think:false (Gemma default would be true)', async () => {
    expect((await send(model('gemma-synth:12b'), null)).body?.think).toBe(false)
    expect((await send(model('gemma-synth:12b', true), null, { reasoning: 'low' })).body?.think).toBe(true)
  })
  it('models without native thinking metadata keep the old wire (no think field)', async () => {
    const { body } = await send(model('plain-synth:8b'), null)
    expect(body).not.toHaveProperty('think')
    expect(body).not.toHaveProperty('options')
  })
})

/*
 * Gap 3 (verified live 2026-10-05 on Ollama 0.34.4-snapfix): models in
 * safetensors format run on Ollama's MLX runner, which always serves the model
 * maximum (mlxrunner/runner.go `r.contextLength = m.MaxContextLength()`);
 * request `options.num_ctx` never reaches it and /api/ps only shows a soft
 * report value. A 56k-token synthetic needle prompt was answered correctly with
 * /api/ps still reporting 40960/49152. So for MLX: no num_ctx on the wire, the
 * state says the window is fixed, and the guard uses the real (maximum) window.
 */
const MLX_DETAILS = { format: 'safetensors', family: 'gemma4_unified' }
describe('gap 3: MLX runner window is fixed at the model maximum', () => {
  it('parseOllamaShow marks safetensors models as runner mlx (gguf/unknown stays unset)', () => {
    expect(parseOllamaShow({ ...GEMMA_SHOW, details: MLX_DETAILS }).runner).toBe('mlx')
    expect(parseOllamaShow({ ...GEMMA_SHOW, details: { format: 'gguf' } }).runner).toBeUndefined()
    expect(parseOllamaShow(GEMMA_SHOW).runner).toBeUndefined()
  })
  it('decideNumCtx: any choice → runner_fixed, nothing sent, guard = model max; settings cannot fake a smaller window', () => {
    const facts = { runner: 'mlx' as const, supportedMax: 262144, modelNumCtx: 40960, providerNumCtx: 8192 }
    for (const choice of [32768, 49152, 65536, 131072]) {
      expect(decideNumCtx({ nativeProvider: true, choice, facts })).toEqual({ numCtx: undefined, state: 'runner_fixed', guardWindow: 262144 })
    }
    expect(decideNumCtx({ nativeProvider: true, choice: null, facts })).toEqual({ numCtx: undefined, state: 'unchanged', guardWindow: 262144 })
    expect(resolveBaseline(facts)).toEqual({ known: true, value: 262144, source: 'runner_max' })
    // MLX without a known maximum: honest unknown, still nothing sent
    expect(decideNumCtx({ nativeProvider: true, choice: 65536, facts: { runner: 'mlx' } })).toEqual({ numCtx: undefined, state: 'runner_fixed', guardWindow: undefined })
    expect(resolveBaseline({ runner: 'mlx', modelNumCtx: 40960 })).toEqual({ known: false })
  })
  it('wire: MLX model with a per-model baseline and a large choice sends no num_ctx, think contract unchanged', async () => {
    shows['gemma-mlx-synth:12b'] = { ...GEMMA_SHOW, details: MLX_DETAILS }
    const { body } = await send(model('gemma-mlx-synth:12b'), 131072, { modelNumCtx: { 'gemma-mlx-synth:12b': 40960 } })
    expect(body?.options).toBeUndefined()
    expect(body?.think).toBe(false)
  })
})

/*
 * Review F1 (2026-10-05): a failed /api/show REFRESH after the TTL used to
 * replace the last good facts with {} for the failure window. For an MLX model
 * with the (old rollout) per-model baseline 40960 that meant: guard 40960 →
 * long requests refused, and no thinking contract → Gemma's think:false
 * dropped (Gemma thinks by default). Synthetic outage, fake clock.
 */
describe('F1: stale-on-error keeps the last good facts on the request path', () => {
  const ID = 'gemma-mlx-stale:12b'
  // ~60k tokens: above the old 40960 pin, far below the 262144 MLX maximum
  const longCtx: Context = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'synthetic '.repeat(60_000), timestamp: 1 }] }
  let clock = 1_000_000
  beforeEach(() => {
    shows[ID] = { ...GEMMA_SHOW, details: MLX_DETAILS }
    clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('success → TTL → outage: thinking off and the MLX window survive; bounded retry; recovery', async () => {
    const pin = { modelNumCtx: { [ID]: 40960 } }
    const m = model(ID)
    // 1. success
    let r = await send(m, null, { ...pin, context: longCtx })
    expect(r.final.stopReason).toBe('stop')
    expect(r.body?.think).toBe(false)
    expect(showCalls).toBe(1)
    // 2. TTL over, server outage → refresh fails, last good facts are used
    clock += 5 * 60_000 + 1
    showFails = true
    const sentBefore = chats.length
    r = await send(m, null, { ...pin, context: longCtx })
    expect(showCalls).toBe(2)
    expect(r.final.stopReason).toBe('stop')
    expect(chats.length).toBe(sentBefore + 1)
    expect(r.body?.think).toBe(false)
    expect(r.body?.options).toBeUndefined()
    // 3. inside the failure window: no new /api/show (bounded retry), still stale facts
    clock += 10_000
    r = await send(m, 65536, { ...pin, context: longCtx })
    expect(showCalls).toBe(2)
    expect(r.final.stopReason).toBe('stop')
    expect(r.body?.think).toBe(false)
    expect(r.body?.options).toBeUndefined()
    // 4. recovery after the failure window
    clock += 30_000
    showFails = false
    r = await send(m, null, { ...pin, context: longCtx })
    expect(showCalls).toBe(3)
    expect(r.final.stopReason).toBe('stop')
    expect(r.body?.think).toBe(false)
  })

  it('cold outage (never a success) stays honestly unknown: no MLX invented, the configured baseline guards', async () => {
    showFails = true
    const r = await send(model(ID), null, { modelNumCtx: { [ID]: 40960 }, context: longCtx })
    expect(r.final.stopReason).toBe('error')
    expect(chats.length).toBe(0)
  })

  it('after maxStale (30 min) without a successful refresh the facts are dropped (no forever cache)', async () => {
    const m = model(ID)
    await send(m, null, { modelNumCtx: { [ID]: 40960 } })
    showFails = true
    clock += 30 * 60_000 + 1
    const r = await send(m, null, { modelNumCtx: { [ID]: 40960 }, context: longCtx })
    expect(r.final.stopReason).toBe('error')
  })
})
