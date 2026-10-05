import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { Type } from '@earendil-works/pi-ai'
import { buildStreamFn } from '../provider-config.js'
import { resetObservedContextLimits } from '../request-overflow-guard.js'
import { OLLAMA_CHAT_API } from './chat-stream.js'
import { resetShowFactsCacheForTest } from './show-facts.js'
import { resetLocalInferenceActivityForTest } from '../local-inference-activity.js'
import { summarizeNativeRequest } from './request-diagnostics.js'

/*
 * H1 of the live-failure plan (2026-10-05-qwen-native-eco-live-failure):
 * "prompt doubled from turn 1 to turn 2" (last turn-1 request ~20.3k tokens,
 * first turn-2 request ~40.7k). Synthetic 2-turn repro through the pi Agent
 * loop + the REAL native stream (buildStreamFn 'ollama-native') against a fake
 * Ollama HTTP server. Only synthetic text; nothing from a real strand.
 *
 * Scope: pi agent loop + native request conversion. NOT covered: Axiom's own
 * context assembly in AgentRuntime (memory/fact injection, DB history reload).
 */

let server: http.Server
let origin = ''
let chats: Array<{ tools?: unknown[]; messages: Array<{ role: string; content?: string; thinking?: string; tool_calls?: unknown[] }> }> = []
let script: Array<Record<string, unknown>> = []

const TOOL_OUTPUT = 'R'.repeat(20_000) // stands in for a large read_file result
const THINKING = 'T'.repeat(4_000)

beforeEach(async () => {
  resetShowFactsCacheForTest()
  resetObservedContextLimits()
  resetLocalInferenceActivityForTest()
  chats = []
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ parameters: 'num_ctx 262144', model_info: { 'general.architecture': 'synth', 'synth.context_length': 262144 } }))
        return
      }
      if (req.url === '/api/chat') {
        chats.push(JSON.parse(raw))
        const msg = script.shift() ?? { role: 'assistant', content: 'fallback' }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(JSON.stringify({ message: msg, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }) + '\n')
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
  resetLocalInferenceActivityForTest()
})

const chars = (req: (typeof chats)[number]) =>
  req.messages.reduce((n, m) => n + (m.content?.length ?? 0) + (m.thinking?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0)

describe('native request diagnostics', () => {
  it('counts system prompt and tools from the leading system message (as the native body sees them)', () => {
    const d = summarizeNativeRequest({
      messages: [
        { role: 'system', content: 'synthetic system prompt', toolsAdded: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }] },
        { role: 'user', content: 'hi', timestamp: 1 },
      ],
    } as never, false)
    expect(d.toolCount).toBe(1)
    expect(d.systemChars).toBe('synthetic system prompt'.length)
  })
})

describe('H1: native 2-turn prompt growth (synthetic repro)', () => {
  it('turn 2 = turn-1 transcript + final answer + new user message; nothing is sent twice', async () => {
    const model = {
      id: 'synthetic-native:8b', name: 'synthetic', api: OLLAMA_CHAT_API, provider: 'two-turn-test', baseUrl: origin,
      reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 4096,
    } as Model<Api>
    const readTool: AgentTool = {
      name: 'read_file', label: 'read_file', description: 'synthetic read',
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: 'text', text: TOOL_OUTPUT }], details: {} }),
    }
    const agent = new Agent({
      initialState: { systemPrompt: 'synthetic system prompt', model, tools: [readTool], thinkingLevel: 'medium' },
      getApiKey: () => 'no-key',
      streamFn: buildStreamFn({ textVerbosity: undefined, transport: undefined, providerType: 'ollama-native' }, undefined, {
        getSessionId: () => undefined,
        getContextWindowChoice: () => null,
      }),
    })

    // Turn 1: thinking + tool call, then thinking + final answer.
    script = [
      { role: 'assistant', content: '', thinking: THINKING, tool_calls: [{ function: { name: 'read_file', arguments: { path: '/synthetic/a.txt' } } }] },
      { role: 'assistant', content: 'turn one answer', thinking: THINKING },
    ]
    await agent.prompt('first synthetic question')
    expect(agent.state.errorMessage).toBeUndefined()
    expect(chats).toHaveLength(2)
    const lastTurn1 = chats[1]!
    // tools reach the native request on every call
    expect(chats.every(c => (c.tools?.length ?? 0) === 1)).toBe(true)

    // Turn 2: plain answer.
    script = [{ role: 'assistant', content: 'turn two answer' }]
    await agent.prompt('second synthetic question')
    expect(chats).toHaveLength(3)
    const firstTurn2 = chats[2]!

    // Exactly one more assistant + one more user message than the last turn-1 request.
    expect(firstTurn2.messages.length).toBe(lastTurn1.messages.length + 2)
    expect(firstTurn2.messages.slice(0, lastTurn1.messages.length)).toEqual(lastTurn1.messages)
    expect(firstTurn2.messages.at(-2)).toMatchObject({ role: 'assistant', content: 'turn one answer' })
    expect(firstTurn2.messages.at(-1)).toMatchObject({ role: 'user', content: 'second synthetic question' })
    // The tool result is carried exactly once.
    expect(firstTurn2.messages.filter(m => m.content === TOOL_OUTPUT)).toHaveLength(1)
    // Growth = the final answer (+ its re-sent thinking) + the new question — far from 2x.
    const growth = chars(firstTurn2) - chars(lastTurn1)
    expect(growth).toBe('turn one answer'.length + THINKING.length + 'second synthetic question'.length)
    expect(chars(firstTurn2)).toBeLessThan(chars(lastTurn1) * 1.5)
  })
})
