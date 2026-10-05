import { describe, expect, it } from 'vitest'
import { normalizeContext, Type } from '@earendil-works/pi-ai'
import type { AssistantMessageEvent, Context, Model, Tool } from '@earendil-works/pi-ai'
import { buildOllamaChatBody, OLLAMA_CHAT_API, streamOllamaChat } from './chat-stream.js'

/* Synthetic fixtures only: no real model, no network. */

const model = {
  id: 'synthetic-model:7b',
  name: 'synthetic',
  api: OLLAMA_CHAT_API,
  provider: 'ollama-native-test',
  baseUrl: 'http://ollama.invalid:11434',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 8192,
} as unknown as Model<string>

const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Weather for a city',
  parameters: Type.Object({ city: Type.String() }),
}

function ctx(extra: Partial<Context> = {}) {
  return normalizeContext({
    systemPrompt: 'You are a test. Ümlaut ✓',
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    tools: [weatherTool],
    ...extra,
  })
}

/** Fake fetch that streams the given raw byte chunks and records the request. */
function fakeFetch(chunks: Array<string | Uint8Array>, init: { status?: number; body?: string; hangAfter?: boolean } = {}) {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchFn = async (url: string | URL, req?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(req?.body)) })
    if (init.status && init.status >= 400) {
      return new Response(init.body ?? '', { status: init.status })
    }
    const enc = new TextEncoder()
    const signal = req?.signal
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c)
        if (init.hangAfter) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve())
          })
          controller.error(new DOMException('aborted', 'AbortError'))
          return
        }
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
  }
  return { fetchFn: fetchFn as unknown as typeof fetch, calls }
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = []
  for await (const e of stream) events.push(e)
  return events
}

const line = (o: unknown) => JSON.stringify(o) + '\n'
const msg = (content: string, extra: Record<string, unknown> = {}) => line({ model: model.id, message: { role: 'assistant', content, ...extra }, done: false })
const done = (extra: Record<string, unknown> = {}) => line({ model: model.id, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 26, eval_count: 7, ...extra })

describe('buildOllamaChatBody', () => {
  it('serializes system, user, tools; no options/num_ctx without explicit override', () => {
    const body = buildOllamaChatBody(model, ctx(), {})
    expect(body.model).toBe('synthetic-model:7b')
    expect(body.stream).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a test. Ümlaut ✓' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(body.tools?.[0]?.function.name).toBe('get_weather')
    expect(body.tools?.[0]?.type).toBe('function')
    expect('options' in body).toBe(false)
    expect('think' in body).toBe(false)
  })

  it('sends options.num_ctx exactly when given, and num_predict from maxTokens', () => {
    const body = buildOllamaChatBody(model, ctx(), { ollamaNumCtx: 65536, maxTokens: 4000 })
    expect(body.options).toEqual({ num_ctx: 65536, num_predict: 4000 })
  })

  it('rejects an invalid num_ctx instead of sending it', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 800_000_000]) {
      expect(() => buildOllamaChatBody(model, ctx(), { ollamaNumCtx: bad })).toThrow(/num_ctx/)
    }
  })

  it('serializes assistant tool calls and tool results with tool_name', () => {
    const c = normalizeContext({
      systemPrompt: 's',
      tools: [weatherTool],
      messages: [
        { role: 'user', content: 'w?', timestamp: 1 },
        {
          role: 'assistant', api: OLLAMA_CHAT_API, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 2,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 'call_0', name: 'get_weather', arguments: { city: 'Köln' } }],
        },
        { role: 'toolResult', toolCallId: 'call_0', toolName: 'get_weather', content: [{ type: 'text', text: '11 °C' }], isError: false, timestamp: 3 },
      ],
    } as Context)
    const body = buildOllamaChatBody(model, c, {})
    expect(body.messages[2]).toMatchObject({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Köln' } } }] })
    expect(body.messages[3]).toEqual({ role: 'tool', content: '11 °C', tool_name: 'get_weather' })
  })

  it('maps reasoning to think only for reasoning models', () => {
    expect(buildOllamaChatBody(model, ctx(), { reasoning: 'high' }).think).toBe(true)
    const plain = { ...model, reasoning: false } as Model<string>
    expect('think' in buildOllamaChatBody(plain, ctx(), { reasoning: 'high' })).toBe(false)
  })
})

describe('streamOllamaChat', () => {
  it('streams text across fragmented chunks and split UTF-8 bytes, with usage', async () => {
    const enc = new TextEncoder()
    const all = enc.encode(msg('Grü') + msg('ße ✓') + done())
    // split inside the multibyte "ü" and inside JSON lines
    const cut1 = 40
    const idx = Array.from(all).findIndex((b, i) => b === 0xc3 && i > 10)
    const parts = [all.slice(0, cut1), all.slice(cut1, idx + 1), all.slice(idx + 1, idx + 9), all.slice(idx + 9)]
    const { fetchFn, calls } = fakeFetch(parts)
    const events = await collect(streamOllamaChat(model, ctx(), { fetch: fetchFn }))
    expect(calls[0]?.url).toBe('http://ollama.invalid:11434/api/chat')
    expect(events[0]?.type).toBe('start')
    const last = events.at(-1)!
    expect(last.type).toBe('done')
    if (last.type !== 'done') throw new Error('unreachable')
    expect(last.reason).toBe('stop')
    expect(last.message.content).toEqual([{ type: 'text', text: 'Grüße ✓' }])
    expect(last.message.usage).toMatchObject({ input: 26, output: 7, totalTokens: 33, cacheRead: 0, cacheWrite: 0 })
    expect(events.map(e => e.type)).toEqual(['start', 'text_start', 'text_delta', 'text_delta', 'text_end', 'done'])
  })

  it('emits thinking then text blocks', async () => {
    const { fetchFn } = fakeFetch([msg('', { thinking: 'let me ' }), msg('', { thinking: 'think' }), msg('Answer'), done()])
    const events = await collect(streamOllamaChat(model, ctx(), { fetch: fetchFn, reasoning: 'medium' }))
    const last = events.at(-1)!
    if (last.type !== 'done') throw new Error(`expected done, got ${last.type}`)
    expect(last.message.content).toEqual([{ type: 'thinking', thinking: 'let me think' }, { type: 'text', text: 'Answer' }])
    expect(events.map(e => e.type)).toEqual(['start', 'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'done'])
  })

  it('maps tool calls (none dropped) to toolUse with stable ids', async () => {
    const { fetchFn } = fakeFetch([
      msg('', { tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }, { function: { name: 'get_weather', arguments: { city: 'Köln' } } }] }),
      done(),
    ])
    const events = await collect(streamOllamaChat(model, ctx(), { fetch: fetchFn }))
    const last = events.at(-1)!
    if (last.type !== 'done') throw new Error('expected done')
    expect(last.reason).toBe('toolUse')
    const calls = last.message.content.filter(c => c.type === 'toolCall')
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.type === 'toolCall' && c.arguments)).toEqual([{ city: 'Tokyo' }, { city: 'Köln' }])
    expect(new Set(calls.map(c => c.type === 'toolCall' && c.id)).size).toBe(2)
    expect(events.filter(e => e.type === 'toolcall_end')).toHaveLength(2)
  })

  it('rejects a tool call with unparseable arguments as an error, not a silent drop', async () => {
    const { fetchFn } = fakeFetch([msg('', { tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":' } }] }), done()])
    const events = await collect(streamOllamaChat(model, ctx(), { fetch: fetchFn }))
    const last = events.at(-1)!
    expect(last.type).toBe('error')
  })

  it('done_reason=length → stopReason length (no fake success)', async () => {
    const { fetchFn } = fakeFetch([msg('partial'), done({ done_reason: 'length' })])
    const events = await collect(streamOllamaChat(model, ctx(), { fetch: fetchFn }))
    const last = events.at(-1)!
    if (last.type !== 'done') throw new Error('expected done')
    expect(last.reason).toBe('length')
    expect(last.message.stopReason).toBe('length')
  })

  it('HTTP error → typed error event with server message and zero usage', async () => {
    const { fetchFn } = fakeFetch([], { status: 404, body: '{"error":"model \\"x\\" not found"}' })
    const events = await collect(streamOllamaChat(model, ctx(), { fetch: fetchFn }))
    const last = events.at(-1)!
    if (last.type !== 'error') throw new Error('expected error')
    expect(last.reason).toBe('error')
    expect(last.error.errorMessage).toContain('404')
    expect(last.error.errorMessage).toContain('not found')
    expect(last.error.usage).toMatchObject({ input: 0, output: 0, totalTokens: 0 })
  })

  it('mid-stream {"error"} → error, keeps partial content visible', async () => {
    const { fetchFn } = fakeFetch([msg('Hal'), line({ error: 'out of memory' })])
    const events = await collect(streamOllamaChat(model, ctx(), { fetch: fetchFn }))
    const last = events.at(-1)!
    if (last.type !== 'error') throw new Error('expected error')
    expect(last.error.errorMessage).toContain('out of memory')
    expect(last.error.stopReason).toBe('error')
  })

  it('malformed NDJSON line → error', async () => {
    const { fetchFn } = fakeFetch([msg('a'), '{not json}\n', done()])
    const last = (await collect(streamOllamaChat(model, ctx(), { fetch: fetchFn }))).at(-1)!
    expect(last.type).toBe('error')
    if (last.type === 'error') expect(last.error.errorMessage).toMatch(/malformed/i)
  })

  it('stream ending without done:true → error (truncation is not success)', async () => {
    const { fetchFn } = fakeFetch([msg('cut')])
    const last = (await collect(streamOllamaChat(model, ctx(), { fetch: fetchFn }))).at(-1)!
    expect(last.type).toBe('error')
    if (last.type === 'error') expect(last.error.errorMessage).toMatch(/before done/i)
  })

  it('abort mid-stream → aborted', async () => {
    const ac = new AbortController()
    const { fetchFn } = fakeFetch([msg('x')], { hangAfter: true })
    const stream = streamOllamaChat(model, ctx(), { fetch: fetchFn, signal: ac.signal })
    const events: AssistantMessageEvent[] = []
    for await (const e of stream) {
      events.push(e)
      if (e.type === 'text_delta') ac.abort()
    }
    const last = events.at(-1)!
    if (last.type !== 'error') throw new Error('expected error')
    expect(last.reason).toBe('aborted')
    expect(last.error.stopReason).toBe('aborted')
  })

  it('sends num_ctx in the HTTP body only when explicitly requested', async () => {
    const a = fakeFetch([done()])
    await collect(streamOllamaChat(model, ctx(), { fetch: a.fetchFn }))
    expect(a.calls[0]?.body).not.toHaveProperty('options')
    const b = fakeFetch([done()])
    await collect(streamOllamaChat(model, ctx(), { fetch: b.fetchFn, ollamaNumCtx: 49152 }))
    expect((b.calls[0]?.body as { options: { num_ctx: number } }).options.num_ctx).toBe(49152)
  })
})
