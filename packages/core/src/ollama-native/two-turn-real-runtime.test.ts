/**
 * H1/H2 of the live-failure plan (2026-10-05-qwen-native-eco-live-failure):
 * "prompt doubled from turn 1 to turn 2". The pi-Agent-level repro lives in
 * two-turn-growth.test.ts; this one goes through Axiom's OWN request path:
 * AgentCore.sendMessage -> real AgentRuntime (createAgentRuntime: system
 * prompt assembly, strand transcript, Eco freeze, boundary sanitizer, trim)
 * -> buildStreamFn('ollama-native') -> a fake Ollama /api/chat server that
 * records the exact message list on the wire.
 *
 * Shape mirrors the failed live strand (metadata only, NO content): turn 1 is
 * the first message of the strand, thinking on, parallel web tool calls with
 * ~5-8k char results, Eco ON; turn 2 is a short follow-up.
 * All text is synthetic.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { Type } from '@earendil-works/pi-ai'
import { AgentCore } from '../agent.js'
import { createAgentRuntime, createYoloTools } from '../agent-runtime.js'
import type { AgentRuntimeBoundary } from '../agent-runtime.js'
import { initDatabase, type Database } from '../database.js'
import { setStrandEcoEnabled } from '../eco-mode-store.js'
import { frozenEcoRowId } from '../eco-tool-freeze.js'
import type { ProviderConfig } from '../provider-config.js'
import { resetObservedContextLimits } from '../request-overflow-guard.js'
import { isLocalInferenceBusy, localInferenceActivitySizeForTest, resetLocalInferenceActivityForTest } from '../local-inference-activity.js'
import { OLLAMA_CHAT_API } from './chat-stream.js'
import { resetShowFactsCacheForTest } from './show-facts.js'

interface WireMsg { role: string; content?: string; thinking?: string; tool_calls?: unknown[]; tool_name?: string }
interface WireChat { model: string; tools?: unknown[]; options?: Record<string, unknown>; think?: unknown; messages: WireMsg[] }

let tmpDir: string
let previous: Record<string, string | undefined> = {}
let server: http.Server
let origin = ''
let chats: WireChat[] = []
let script: Array<Record<string, unknown>> = []
/** F9 probe: busy state of the runner key seen from inside a tool (= the tool gap of a turn). */
let toolGapBusy: boolean[] = []
let failChat = false

const SESSION = 's-native-2turn'
const THINKING = 'synthetic reasoning step. '.repeat(120)
// Web results above the Eco threshold (6000) and below it, like the live strand.
const WEB_A = `SYNTH-WEB-A ${'alpha result line\n'.repeat(430)}END-A` // ~7.7k
const WEB_B = `SYNTH-WEB-B ${'beta result line\n'.repeat(320)}END-B` // ~5.4k
const BUILD_LOG = ` ✓ src/synthetic.test.ts (3 tests) 4ms\n`.repeat(300) // ~12k, shell build output

const REAL_SHELL = (({ name, label, description, parameters }) => ({ name, label, description, parameters }))(createYoloTools().find(t => t.name === 'shell')!)

function tools(): AgentTool[] {
  const webFetch: AgentTool = {
    name: 'web_fetch', label: 'web_fetch', description: 'synthetic fetch',
    parameters: Type.Object({ url: Type.String() }),
    execute: async (_id, args) => {
      // Probe through the LEGACY /v1 URL on a loopback alias, like the session summary would ask.
      toolGapBusy.push(isLocalInferenceBusy(origin.replace('127.0.0.1', 'localhost') + '/v1', 'synthetic-native:8b'))
      return { content: [{ type: 'text', text: (args as { url: string }).url.endsWith('a') ? WEB_A : WEB_B }], details: {} }
    },
  }
  const shell: AgentTool = {
    ...REAL_SHELL,
    execute: async () => ({ content: [{ type: 'text', text: BUILD_LOG }], details: {} }),
  } as AgentTool
  return [webFetch, shell]
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-2turn-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  // The synthetic web_fetch replaces the built-in one; with both present the
  // two same-named tools would make the declared tool set itself a variable.
  fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), JSON.stringify({ builtinTools: { webFetch: { enabled: false } } }))
  previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
  resetShowFactsCacheForTest()
  resetObservedContextLimits()
  resetLocalInferenceActivityForTest()
  chats = []
  script = []
  toolGapBusy = []
  failChat = false
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
        chats.push(JSON.parse(raw) as WireChat)
        if (failChat) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'synthetic runner failure' })); return }
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
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function nativeSetup(): { db: Database; core: AgentCore } {
  const db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'h', 'admin')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES (?, 1, 'main')").run(SESSION)
  const providerConfig: ProviderConfig = {
    id: 'native-test', name: 'Native test', type: OLLAMA_CHAT_API, providerType: 'ollama-native', provider: 'ollama-native',
    baseUrl: origin, apiKey: '', enabledModels: ['synthetic-native:8b'],
  } as ProviderConfig
  const model = {
    id: 'synthetic-native:8b', name: 'synthetic', api: OLLAMA_CHAT_API, provider: 'ollama-native', baseUrl: origin,
    reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 4096,
  } as Model<Api>
  // Production shape: one runtime per (persona, strand) key, like createRuntimeForAgent.
  const runtimes = new Map<string, AgentRuntimeBoundary>()
  const core = new AgentCore({
    model, apiKey: 'none', db, tools: [], providerConfig,
    runtimeFactory: (agentId, sessionId) => {
      const key = `${agentId}:${sessionId ?? ''}`
      let rt = runtimes.get(key)
      if (!rt) {
        rt = createAgentRuntime({
          model, apiKey: 'none', db, tools: tools(), providerConfig, thinkingLevel: 'medium',
          memoryDir: path.join(tmpDir, 'memory'), agentId,
        })
        runtimes.set(key, rt)
      }
      return rt
    },
  })
  return { db, core }
}

/** Drain one turn and persist rows the way the web transport/turn-runner does. */
async function turn(db: Database, core: AgentCore, text: string): Promise<void> {
  db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', ?, 'main')").run(SESSION, text)
  let answer = ''
  for await (const chunk of core.sendMessage('1', text, 'web', undefined, 'main', SESSION)) {
    if (chunk.type === 'text' && typeof chunk.text === 'string') answer += chunk.text
    if (chunk.type === 'tool_call_end' && chunk.toolCallId) {
      if (frozenEcoRowId(db, SESSION, chunk.toolCallId, chunk.toolResult) !== undefined) continue
      db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, NULL, 'tool', ?, ?, 'main')").run(
        SESSION, `Tool: ${chunk.toolName}`,
        JSON.stringify({ toolName: chunk.toolName, toolCallId: chunk.toolCallId, toolArgs: null, toolResult: chunk.toolResult ?? null, toolIsError: false }),
      )
    }
  }
  if (answer) db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, NULL, 'assistant', ?, 'main')").run(SESSION, answer)
}

const total = (c: WireChat) => c.messages.reduce((n, m) => n + (m.content?.length ?? 0) + (m.thinking?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0)
/** The user text minus the per-turn time block the runtime appends. */
const userCore = (m: WireMsg | undefined) => (m?.content ?? '').split('\n\n')[0]

describe('H1/H2 real Axiom path: native 2-turn message conservation (Eco on, thinking, web + build tools)', () => {
  it('turn-2 first request = last turn-1 request + [final assistant, user 2]; system/tools/options byte-stable; each tool result once', async () => {
    const { db, core } = nativeSetup()
    setStrandEcoEnabled(db, SESSION, true)

    script = [
      { role: 'assistant', content: '', thinking: THINKING, tool_calls: [
        { function: { name: 'web_fetch', arguments: { url: 'https://synthetic.invalid/a' } } },
        { function: { name: 'web_fetch', arguments: { url: 'https://synthetic.invalid/b' } } },
      ] },
      { role: 'assistant', content: '', thinking: THINKING, tool_calls: [{ function: { name: 'shell', arguments: { command: 'npm test' } } }] },
      { role: 'assistant', content: 'turn one final answer', thinking: THINKING },
    ]
    await turn(db, core, 'first synthetic question')
    expect(chats).toHaveLength(3)
    const lastTurn1 = chats[2]!

    script = [{ role: 'assistant', content: 'turn two answer' }]
    await turn(db, core, 'second synthetic question')
    expect(chats).toHaveLength(4)
    const firstTurn2 = chats[3]!

    if (process.env.DUMP_WIRE) for (const c of chats) console.log("WIRE", JSON.stringify({ keys: Object.keys(c), system: (c as unknown as { system?: string }).system?.length, msgs: c.messages.map(m => `${m.role}:${m.content?.length ?? 0}/${m.thinking?.length ?? 0}/${m.tool_calls ? 1 : 0}`) }))
    // Every request of the strand: the same system message, tools, options and think flag (cache-prefix stable).
    const fixed = (c: WireChat) => JSON.stringify({ model: c.model, tools: c.tools, options: c.options, think: c.think })
    for (const c of chats) {
      expect(fixed(c)).toBe(fixed(chats[0]!))
      expect(c.messages[0]).toEqual(chats[0]!.messages[0])
      expect(c.messages[0]!.role).toBe('system')
    }
    // Within turn 1 each request is a strict prefix extension of the previous one.
    for (let i = 1; i < 3; i++) {
      expect(chats[i]!.messages.slice(0, chats[i - 1]!.messages.length)).toEqual(chats[i - 1]!.messages)
    }

    // Message conservation turn 1 -> turn 2, checked message by message.
    expect(firstTurn2.messages.length).toBe(lastTurn1.messages.length + 2)
    expect(firstTurn2.messages.slice(0, lastTurn1.messages.length)).toEqual(lastTurn1.messages)
    expect(firstTurn2.messages.at(-2)).toMatchObject({ role: 'assistant', content: 'turn one final answer' })
    expect(userCore(firstTurn2.messages.at(-1))).toBe('second synthetic question')
    expect(firstTurn2.messages.at(-1)!.role).toBe('user')

    // Expected role sequence, explicitly (no hash/length pattern).
    expect(firstTurn2.messages.map(m => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'assistant', 'user',
    ])
    // No per-turn context block or duplicated user message left in the transcript.
    // Known, documented behaviour (not the doubling): the web route persists the
    // user row BEFORE the turn, and a strand without a model transcript is
    // "cold", so session-manager injects this strand's own tail — which on the
    // very first turn is just the current question (<= 400 chars, once). It is
    // part of turn 1's user message and byte-identical in turn 2 (cache-stable).
    const users = firstTurn2.messages.filter(m => m.role === 'user')
    expect(users).toHaveLength(2)
    expect(users[0]!.content!.startsWith('<previous_session_tail>\n')).toBe(true)
    expect(users[0]!.content!.split('first synthetic question')).toHaveLength(3) // tail echo + the question itself
    expect(users[0]!.content).toContain('</previous_session_tail>\n\nfirst synthetic question\n\n')
    expect(users[0]!.content).toBe(chats[0]!.messages[1]!.content)
    expect(userCore(users[1])).toBe('second synthetic question')
    expect(firstTurn2.messages.some(m => (m.content ?? '').includes('<strand_context>'))).toBe(false)

    // Each tool result exactly once. Eco reality: web_fetch is never frozen (full text,
    // > 6000 too), the recognised build/test shell output is frozen to a smaller projection.
    const toolMsgs = firstTurn2.messages.filter(m => m.role === 'tool')
    expect(toolMsgs.filter(m => m.content === WEB_A)).toHaveLength(1)
    expect(toolMsgs.filter(m => m.content === WEB_B)).toHaveLength(1)
    const shellMsg = toolMsgs[2]!
    expect(shellMsg.content).not.toBe(BUILD_LOG)
    expect(shellMsg.content!.length).toBeLessThan(BUILD_LOG.length)

    // Growth = previous final answer + its thinking + the new user turn (time block included).
    const growth = total(firstTurn2) - total(lastTurn1)
    const expected = 'turn one final answer'.length + THINKING.length + firstTurn2.messages.at(-1)!.content!.length
    expect(growth).toBe(expected)
    expect(total(firstTurn2)).toBeLessThan(total(lastTurn1) * 1.2)
  })
})

describe('F9 real Axiom path: the runner stays busy exactly for the turn lifetime', () => {
  const busy = () => isLocalInferenceBusy(`${origin}/v1`, 'synthetic-native:8b')

  it('busy in the tool gap of a native turn, idle the moment the turn ended; no leaked leases', async () => {
    const { db, core } = nativeSetup()
    script = [
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_fetch', arguments: { url: 'https://example.invalid/a' } } }] },
      { role: 'assistant', content: 'synthetic answer' },
    ]
    expect(busy()).toBe(false)
    await turn(db, core, 'first synthetic question')
    expect(chats).toHaveLength(2)
    expect(toolGapBusy).toEqual([true]) // between request 1 and request 2 of the turn
    expect(busy()).toBe(false) // no linger after the turn: /new can summarize at once
    expect(localInferenceActivitySizeForTest()).toEqual({ keys: 0, turns: 0 })
  })

  it('a turn that ends with a runner error releases the runner at once', async () => {
    const { db, core } = nativeSetup()
    failChat = true
    await turn(db, core, 'question against a failing runner')
    expect(chats.length).toBeGreaterThanOrEqual(1)
    expect(busy()).toBe(false)
    expect(localInferenceActivitySizeForTest()).toEqual({ keys: 0, turns: 0 })
  })
})
