import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { buildStreamFn } from '../provider-config.js'
import { resetObservedContextLimits } from '../request-overflow-guard.js'
import { OLLAMA_CHAT_API } from './chat-stream.js'
import { decideNumCtx, parseOllamaShow, resolveNativeThink, type ContextWindowChoice } from './context-window.js'
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
const shows: Record<string, unknown> = { 'qwen-synth:27b': QWEN_SHOW, 'gemma-synth:12b': GEMMA_SHOW, 'plain-synth:8b': PLAIN_SHOW }

beforeEach(async () => {
  resetShowFactsCacheForTest()
  resetObservedContextLimits()
  chats = []
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { model?: string }
      if (req.url === '/api/show') {
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

async function send(m: Model<Api>, choice: ContextWindowChoice, opts: { modelNumCtx?: Record<string, number>; reasoning?: string } = {}) {
  const fn = buildStreamFn({
    textVerbosity: undefined, transport: undefined, providerType: 'ollama-native',
    models: Object.entries(opts.modelNumCtx ?? {}).map(([id, n]) => ({ id, ollamaNumCtx: n })),
  }, undefined, { getSessionId: () => undefined, getContextWindowChoice: () => choice })
  const stream = fn(m, ctx, { apiKey: 'no-key', ...(opts.reasoning ? { reasoning: opts.reasoning as never } : {}) })
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
