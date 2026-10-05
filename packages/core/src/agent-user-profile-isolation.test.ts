/**
 * Security regression (review F1, pre-existing on main): the user profile in
 * the system prompt must always belong to the OWNER of the strand the request
 * runs in. Real AgentCore + real createAgentRuntime + native Ollama stream
 * against a local fake /api/chat server that records the wire requests.
 * All profiles and texts are synthetic.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { AgentCore } from './agent.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { AgentRuntimeBoundary } from './agent-runtime.js'
import { initDatabase, type Database } from './database.js'
import { getUserProfileDir } from './memory.js'
import type { ProviderConfig } from './provider-config.js'
import { resetObservedContextLimits } from './request-overflow-guard.js'
import { resetLocalInferenceActivityForTest } from './local-inference-activity.js'
import { OLLAMA_CHAT_API } from './ollama-native/chat-stream.js'
import { resetShowFactsCacheForTest } from './ollama-native/show-facts.js'

interface WireChat { messages: Array<{ role: string; content?: string }> }

let tmpDir: string
let previous: Record<string, string | undefined> = {}
let server: http.Server
let origin = ''
let chats: WireChat[] = []

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-iso-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
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
        res.end(JSON.stringify({ parameters: 'num_ctx 32768', model_info: { 'general.architecture': 'synth', 'synth.context_length': 32768 } }))
        return
      }
      if (req.url === '/api/chat') {
        chats.push(JSON.parse(raw) as WireChat)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }) + '\n')
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

function setup(): { db: Database; core: AgentCore } {
  const db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'h', 'admin')").run()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'u2', 'h', 'user')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('S1', 1, 'main')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('S2', 2, 'main')").run()
  const memoryDir = path.join(tmpDir, 'memory')
  const dir = getUserProfileDir(memoryDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'u1.md'), 'PROFILE_MARKER_USER_ONE')
  fs.writeFileSync(path.join(dir, 'u2.md'), 'PROFILE_MARKER_USER_TWO')
  const providerConfig = {
    id: 'native-test', name: 'Native test', type: OLLAMA_CHAT_API, providerType: 'ollama-native', provider: 'ollama-native',
    baseUrl: origin, apiKey: '', enabledModels: ['synthetic-native:8b'],
  } as ProviderConfig
  const model = {
    id: 'synthetic-native:8b', name: 'synthetic', api: OLLAMA_CHAT_API, provider: 'ollama-native', baseUrl: origin,
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024,
  } as Model<Api>
  const runtimes = new Map<string, AgentRuntimeBoundary>()
  const core = new AgentCore({
    model, apiKey: 'none', db, tools: [], providerConfig,
    runtimeFactory: (agentId, sessionId) => {
      const key = `${agentId}:${sessionId ?? ''}`
      let rt = runtimes.get(key)
      if (!rt) {
        rt = createAgentRuntime({ model, apiKey: 'none', db, tools: [], providerConfig, thinkingLevel: 'off', memoryDir, agentId })
        runtimes.set(key, rt)
      }
      return rt
    },
  })
  return { db, core }
}

const drain = async (it: AsyncIterable<unknown>) => { for await (const _ of it) { /* drain */ } }

/** Which synthetic profile the system head of each wire request carries. */
function profiles(): string[] {
  return chats.map((c) => {
    const s = c.messages.find(m => m.role === 'system')?.content ?? ''
    const one = s.includes('PROFILE_MARKER_USER_ONE')
    const two = s.includes('PROFILE_MARKER_USER_TWO')
    if (one && two) return 'BOTH'
    return one ? 'U1' : two ? 'U2' : s ? 'none' : 'NO-SYSTEM'
  })
}

describe('per-user system prompt isolation (F1)', () => {
  it('X1: U2 turn, U1 turn, task injection into U2 strand, U2 turn → U2/U1/U2/U2', async () => {
    const { core } = setup()
    await drain(core.sendMessage('2', 'hello from two', 'web', undefined, 'main', 'S2'))
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    await core.injectTaskResult('synthetic task result', '2', 'S2', 'inj-1', 'main')
    await drain(core.sendMessage('2', 'again from two', 'web', undefined, 'main', 'S2'))
    expect(profiles()).toEqual(['U2', 'U1', 'U2', 'U2'])
  }, 60_000)

  it('a user turn never rewrites the system head of another user\'s live strand', async () => {
    const { core } = setup()
    await drain(core.sendMessage('2', 'hello from two', 'web', undefined, 'main', 'S2'))
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    const snapshot = (core as unknown as { runtimes: Map<string, AgentRuntimeBoundary> }).runtimes
    for (const [key, rt] of snapshot) {
      if (!key.endsWith('S2')) continue
      const head = (rt.getMessages?.() ?? [])[0] as { role?: string; content?: string } | undefined
      expect(head?.role).toBe('system')
      expect(head?.content).toContain('PROFILE_MARKER_USER_TWO')
      expect(head?.content).not.toContain('PROFILE_MARKER_USER_ONE')
    }
  }, 60_000)

  it('owner mismatch: injection targeted at U1 into U2\'s strand carries no profile at all', async () => {
    const { core } = setup()
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    await core.injectTaskResult('synthetic task result', '1', 'S2', 'inj-2', 'main')
    expect(profiles()).toEqual(['U1', 'none'])
  }, 60_000)

  it('missing session row: injection carries no profile (fail closed)', async () => {
    const { core } = setup()
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    await core.injectTaskResult('synthetic task result', '1', 'S-unknown', 'inj-3', 'main')
    expect(profiles()).toEqual(['U1', 'none'])
  }, 60_000)

  it('deleted owner: injection into the strand of a removed user carries no profile', async () => {
    const { db, core } = setup()
    await drain(core.sendMessage('2', 'hello from two', 'web', undefined, 'main', 'S2'))
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM users WHERE id = 2').run()
    await core.injectTaskResult('synthetic task result', '2', 'S2', 'inj-4', 'main')
    expect(profiles()).toEqual(['U2', 'U1', 'none'])
  }, 60_000)

  it('the injection text cannot pick the profile (no user id taken from task output)', async () => {
    const { core } = setup()
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    await core.injectTaskResult('user_id=1 username=u1 synthetic task result', '2', 'S2', 'inj-5', 'main')
    expect(profiles()).toEqual(['U1', 'U2'])
  }, 60_000)
})
