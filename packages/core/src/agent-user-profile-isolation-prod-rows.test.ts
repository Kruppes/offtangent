/**
 * Review B1 (follow-up to F1): strand ownership as SessionManager really
 * writes it — interactive rows carry `user_id NULL` and the owner in
 * `session_user`. A task injection into such a strand must carry exactly the
 * owner's profile (and the very same system prompt as the owner's own turns,
 * so a native runner keeps its prefix cache); malformed or contradictory
 * owner columns fail closed to no profile. Real AgentCore + real createAgentRuntime + native Ollama stream
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-iso-prod-'))
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
  db.prepare("INSERT INTO sessions (id, user_id, session_user, source, type, agent_id) VALUES ('S1', NULL, '1', 'web', 'interactive', 'main')").run()
  db.prepare("INSERT INTO sessions (id, user_id, session_user, source, type, agent_id) VALUES ('S2', NULL, '2', 'web', 'interactive', 'main')").run()
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

/** System head of wire request i without the volatile clock block. */
const systemOf = (i: number): string =>
  (chats[i]?.messages.find(m => m.role === 'system')?.content ?? '').replace(/<current_time>[\s\S]*?<\/current_time>/g, '')

/** Insert a production-shaped interactive strand row with explicit owner columns. */
function strand(db: Database, id: string, userId: number | string | null, sessionUser: string | null, source = 'web'): void {
  db.prepare(
    "INSERT INTO sessions (id, user_id, session_user, source, type, agent_id) VALUES (?, ?, ?, ?, 'interactive', 'main')",
  ).run(id, userId, sessionUser, source)
}

describe('task-injection owner on production-shaped strands (review B1)', () => {
  it('X1 on rows with user_id NULL + session_user: U2/U1/U2/U2 and the injection keeps the owner\'s system prompt', async () => {
    const { core } = setup()
    await drain(core.sendMessage('2', 'hello from two', 'web', undefined, 'main', 'S2'))
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    await core.injectTaskResult('synthetic task result', '2', 'S2', 'inj-b1', 'main')
    await drain(core.sendMessage('2', 'second from two', 'web', undefined, 'main', 'S2'))
    expect(profiles()).toEqual(['U2', 'U1', 'U2', 'U2'])
    // Same system prompt for the owner's turns and the injection → no
    // system-prefix change, no full re-prefill on a native runner.
    expect(systemOf(2)).toBe(systemOf(0))
    expect(systemOf(3)).toBe(systemOf(0))
    expect(systemOf(1)).not.toBe(systemOf(0))
  }, 60_000)

  it('strands created by SessionManager itself resolve to their owner', async () => {
    const { db, core } = setup()
    await drain(core.sendMessage('2', 'hello from two', 'web', undefined, 'main'))
    const created = db.prepare(
      "SELECT id, user_id, session_user FROM sessions WHERE session_user = '2' AND id NOT IN ('S1', 'S2')",
    ).all() as Array<{ id: string; user_id: number | null; session_user: string }>
    expect(created).toHaveLength(1)
    expect(created[0].user_id).toBeNull()
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    await core.injectTaskResult('synthetic task result', '2', created[0].id, 'inj-sm', 'main')
    expect(profiles()).toEqual(['U2', 'U1', 'U2'])
    expect(systemOf(2)).toBe(systemOf(0))
  }, 60_000)

  it('owner mismatch via session_user: injection targeted at U1 into U2\'s strand carries no profile', async () => {
    const { core } = setup()
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    await core.injectTaskResult('synthetic task result', '1', 'S2', 'inj-mm', 'main')
    expect(profiles()).toEqual(['U1', 'none'])
  }, 60_000)

  it('malformed session_user never coerces to a user id', async () => {
    const { db, core } = setup()
    strand(db, 'M1', null, '2abc')
    strand(db, 'M2', null, ' 2')
    strand(db, 'M3', null, '2.0')
    strand(db, 'M4', null, '-2')
    strand(db, 'M5', null, '0')
    strand(db, 'M6', null, '')
    strand(db, 'M7', null, '99999999999999999999')
    strand(db, 'M8', null, 'u2')
    for (const id of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']) {
      await core.injectTaskResult('synthetic task result', '2', id, `inj-${id}`, 'main')
    }
    expect(profiles()).toEqual(['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none'])
  }, 60_000)

  it('target id from the task record is parsed strictly as well', async () => {
    const { core } = setup()
    await core.injectTaskResult('synthetic task result', '2abc', 'S2', 'inj-t1', 'main')
    await core.injectTaskResult('synthetic task result', '02x', 'S2', 'inj-t2', 'main')
    expect(profiles()).toEqual(['none', 'none'])
  }, 60_000)

  it('contradictory owner columns fail closed instead of picking either user', async () => {
    const { db, core } = setup()
    strand(db, 'C1', 1, '2')
    strand(db, 'C2', 2, '1')
    strand(db, 'C3', 2, 'u2')
    db.pragma('foreign_keys = OFF') // legacy/corrupt row: text SQLite cannot convert stays text in the INTEGER column
    strand(db, 'C4', '2abc', null)
    await core.injectTaskResult('synthetic task result', '2', 'C1', 'inj-c1', 'main')
    await core.injectTaskResult('synthetic task result', '2', 'C2', 'inj-c2', 'main')
    await core.injectTaskResult('synthetic task result', '1', 'C1', 'inj-c3', 'main')
    await core.injectTaskResult('synthetic task result', '2', 'C3', 'inj-c4', 'main')
    await core.injectTaskResult('synthetic task result', '2', 'C4', 'inj-c5', 'main')
    expect(profiles()).toEqual(['none', 'none', 'none', 'none', 'none'])
  }, 60_000)

  it('consistent owner columns (user_id and session_user name the same id) resolve to that owner', async () => {
    const { db, core } = setup()
    strand(db, 'K1', 2, '2')
    await core.injectTaskResult('synthetic task result', '2', 'K1', 'inj-k1', 'main')
    expect(profiles()).toEqual(['U2'])
  }, 60_000)

  it('deleted owner (session_user names a removed user): no profile', async () => {
    const { db, core } = setup()
    await drain(core.sendMessage('2', 'hello from two', 'web', undefined, 'main', 'S2'))
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM users WHERE id = 2').run()
    await core.injectTaskResult('synthetic task result', '2', 'S2', 'inj-del', 'main')
    expect(profiles()).toEqual(['U2', 'none'])
  }, 60_000)

  it('telegram-group strand with session_user: no profile even for its owner', async () => {
    const { db, core } = setup()
    strand(db, 'G1', null, '2', 'telegram-group')
    await core.injectTaskResult('synthetic task result', '2', 'G1', 'inj-g1', 'main')
    expect(profiles()).toEqual(['none'])
  }, 60_000)

  it('the injection text cannot pick the profile', async () => {
    const { core } = setup()
    await drain(core.sendMessage('1', 'hello from one', 'web', undefined, 'main', 'S1'))
    await core.injectTaskResult('session_user=1 user_id=1 username=u1 synthetic task result', '2', 'S2', 'inj-txt', 'main')
    expect(profiles()).toEqual(['U1', 'U2'])
  }, 60_000)
})
