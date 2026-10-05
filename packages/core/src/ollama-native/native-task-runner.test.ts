/**
 * Native Ollama (plan 2026-10-05-ollama-native-context, M2 completion):
 * TaskRunner end to end with the real pi-agent loop against a FAKE Ollama
 * HTTP server (/api/show + /api/chat NDJSON). Synthetic data only — no real
 * model, no global Ollama state is read or written.
 *
 *  - the task session gets its own persisted snapshot of the parent strand's
 *    context-window choice at creation; the exact num_ctx is on the wire;
 *  - a parent change after creation never leaks in: not mid-run, not after a
 *    pause/resume, not after a runner restart over a re-opened database;
 *  - two parallel tasks with different choices never cross-contaminate;
 *  - a task on a model whose known maximum is below the snapshot sends no
 *    num_ctx (no fake "applied");
 *  - Eco freeze over the native path: projection once, persisted original,
 *    owner recall with the native-generated tool id.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createYoloTools } from '../agent-runtime.js'
import { initDatabase } from '../database.js'
import type { Database } from '../database.js'
import { readStrandContextWindow, setStrandContextWindow, setStrandEcoEnabled } from '../eco-mode-store.js'
import { createRecallMessageTool } from '../recall-message-tool.js'
import { resetObservedContextLimits } from '../request-overflow-guard.js'
import { SessionManager } from '../session-manager.js'
import { TaskStore } from '../task-store.js'
import { TaskRunner } from '../task-runner.js'
import type { TaskRunnerOptions } from '../task-runner.js'
import type { ProviderConfig } from '../provider-config.js'
import { OLLAMA_CHAT_API } from './chat-stream.js'
import { resetShowFactsCacheForTest } from './show-facts.js'

type ChatBody = { model: string; messages: Array<{ role: string; content: string; tool_name?: string }>; options?: Record<string, unknown> }
type Reply = (res: http.ServerResponse, body: ChatBody) => void

let tmpDir: string
let previous: Record<string, string | undefined> = {}
let server: http.Server
let origin = ''
let chats: ChatBody[] = []
let paths: string[] = []
/** Per-model scripted replies; fallback = completed. */
let scripts: Record<string, Reply[]> = {}
let supportedMax: Record<string, number> = {}
const held: http.ServerResponse[] = []

const REAL_SHELL = (({ name, label, description, parameters }) => ({ name, label, description, parameters }))(createYoloTools().find(t => t.name === 'shell')!)
const MIDDLE_MARK = 'SYNTHETIC-NATIVE-MIDDLE-4711 /srv/synthetic/deep 98765'

function shellLikeTool(): AgentTool {
  return {
    ...REAL_SHELL,
    execute: async (toolCallId: string) => {
      const ok = Array.from({ length: 600 }, (_, i) => ` ✓ src/m${i}.test.ts (3 tests) ${i % 40}ms [${toolCallId}]`)
      ok.splice(300, 0, ' FAIL src/pay.test.ts > totals', `AssertionError: ${MIDDLE_MARK}`, '  at src/pay.ts:88:13')
      ok.push('      Tests  1 failed | 1800 passed', 'exit status 1')
      return { content: [{ type: 'text' as const, text: ok.join('\n') }], details: {} }
    },
  }
}

const nd = (o: unknown) => JSON.stringify(o) + '\n'
function text(res: http.ServerResponse, model: string, content: string) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  res.write(nd({ model, message: { role: 'assistant', content }, done: false }))
  res.end(nd({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 5 }))
}
function toolCall(res: http.ServerResponse, model: string) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  res.write(nd({ model, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'shell', arguments: { command: 'npm test' } } }] }, done: false }))
  res.end(nd({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 5 }))
}
const completed: Reply = (res, b) => text(res, b.model, 'STATUS: completed\nSUMMARY: synthetic done')
const question: Reply = (res, b) => text(res, b.model, 'STATUS: question\nSUMMARY: which synthetic file?')
const tool: Reply = (res, b) => toolCall(res, b.model)
const hold: Reply = (res) => { held.push(res) }

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-task-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
  resetShowFactsCacheForTest()
  resetObservedContextLimits()
  chats = []
  paths = []
  scripts = {}
  supportedMax = {}
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      paths.push(`${req.method} ${req.url}`)
      if (req.url === '/api/show') {
        const name = (JSON.parse(raw) as { model?: string }).model ?? ''
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          parameters: 'num_ctx                        16384\nstop "<|im_end|>"',
          model_info: { 'general.architecture': 'synth', 'synth.context_length': supportedMax[name] ?? 131072 },
        }))
        return
      }
      if (req.url === '/api/chat') {
        const body = JSON.parse(raw) as ChatBody
        chats.push(body)
        const next = scripts[body.model]?.shift() ?? completed
        next(res, body)
        return
      }
      res.writeHead(404); res.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const res of held.splice(0)) res.destroy()
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetShowFactsCacheForTest()
  resetObservedContextLimits()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function provider(): ProviderConfig {
  return {
    id: 'p-native', name: 'p-native', type: 'ollama-native', providerType: 'ollama-native', provider: 'ollama-native', baseUrl: origin,
    apiKey: 'no-key', enabledModels: ['synthetic-a:8b'], models: [], status: 'connected', authMethod: 'api-key',
  } as unknown as ProviderConfig
}

function makeRunner(db: Database) {
  return new TaskRunner({
    db,
    buildModel: (p: ProviderConfig) => ({
      id: p.enabledModels?.[0] ?? 'synthetic-a:8b', name: 'synthetic', api: OLLAMA_CHAT_API, provider: 'ollama-native', baseUrl: origin, reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 2048,
    }) as unknown as ReturnType<TaskRunnerOptions['buildModel']>,
    getApiKey: async () => 'no-key',
    tools: [shellLikeTool()],
    onTaskComplete: () => {},
    sessionManager: new SessionManager({ db }),
  })
}

function strand(db: Database, id: string, user = '1') {
  db.prepare("INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES (?, 'system', 'interactive', NULL, ?)").run(id, user)
}

async function waitFor(fn: () => boolean, what: string, ms = 15000, info: () => unknown = () => '') {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}: ${JSON.stringify(info())} chats=${JSON.stringify(chats.map(c => [c.model, c.options]))}`)
    await new Promise(r => setTimeout(r, 20))
  }
}

const chatsFor = (model: string) => chats.filter(c => c.model === model)

describe('native Ollama context-window snapshot in the TaskRunner (fake HTTP)', { timeout: 30000 }, () => {
  it('task created from a 65536 strand sends exactly num_ctx 65536; a later parent reset never leaks in (mid-run, pause/resume)', async () => {
    const db = initDatabase(path.join(tmpDir, 'a.db'))
    const store = new TaskStore(db)
    strand(db, 'parent')
    setStrandContextWindow(db, 'parent', 65536)
    const runner = makeRunner(db)
    let resetDone = false
    scripts['synthetic-a:8b'] = [
      (res, b) => {
        // the parent switches back to "Unverändert" AFTER the task was created
        setStrandContextWindow(db, 'parent', null)
        resetDone = true
        tool(res, b)
      },
      question,
      completed,
    ]
    const task = store.create({ name: 'native snapshot', prompt: 'run the synthetic tests', triggerType: 'user', agentId: 'main' })
    await runner.startTask(task, provider(), undefined, 'parent')
    await waitFor(() => store.getById(task.id)?.status === 'paused', 'pause', 15000, () => store.getById(task.id))
    expect(resetDone).toBe(true)
    expect(readStrandContextWindow(db, 'parent')).toBeNull()
    const sessionId = store.getById(task.id)!.sessionId!
    expect(sessionId).not.toBe('parent')
    // the task session row carries its OWN persisted copy (not a parent read)
    expect(readStrandContextWindow(db, sessionId)).toBe(65536)
    expect(await runner.resumeTask(task.id, 'src/pay.test.ts')).toBe(true)
    await waitFor(() => store.getById(task.id)?.status === 'completed', 'completion', 15000, () => store.getById(task.id))
    runner.dispose()
    const sent = chatsFor('synthetic-a:8b')
    expect(sent.length).toBe(3)
    for (const body of sent) expect(body.options?.num_ctx).toBe(65536)
    // only read-only /api/show and /api/chat were ever called
    expect(new Set(paths)).toEqual(new Set(['POST /api/show', 'POST /api/chat']))
    db.close()
  })

  it('a runner restart over a re-opened database resumes the task with its own persisted snapshot', async () => {
    const file = path.join(tmpDir, 'restart.db')
    const db1 = initDatabase(file)
    const store1 = new TaskStore(db1)
    strand(db1, 'parent')
    setStrandContextWindow(db1, 'parent', 49152)
    const runner1 = makeRunner(db1)
    scripts['synthetic-a:8b'] = [tool, hold]
    const task = store1.create({ name: 'native restart', prompt: 'run the synthetic tests', triggerType: 'user', agentId: 'main' })
    await runner1.startTask(task, provider(), undefined, 'parent')
    await waitFor(() => held.length === 1, 'second request held open')
    const sessionId = store1.getById(task.id)!.sessionId!
    // parent changes while the server "goes down"
    setStrandContextWindow(db1, 'parent', 131072)

    // "restart": a second connection to the same file, a fresh runner
    const db2 = initDatabase(file)
    const store2 = new TaskStore(db2)
    const runner2 = makeRunner(db2)
    const before = chats.length
    const result = await runner2.recoverTasks(() => null, provider())
    expect(result.resumed).toBe(1)
    const resumed = store2.list({ status: 'running' }).concat(store2.list({ status: 'completed' })).find(t => t.name === 'native restart (resumed)')!
    expect(resumed.sessionId).toBe(sessionId)
    await waitFor(() => store2.getById(resumed.id)?.status === 'completed', 'resumed completion')
    const after = chats.slice(before)
    expect(after.length).toBeGreaterThan(0)
    for (const body of after) expect(body.options?.num_ctx).toBe(49152)
    expect(chats.slice(0, before).every(b => b.options?.num_ctx === 49152)).toBe(true)
    runner2.dispose()
    runner1.dispose()
    for (const res of held.splice(0)) res.destroy()
    db2.close()
  })

  it('two parallel tasks from different owners/strands keep their own choice; a model with a smaller known maximum gets no num_ctx', async () => {
    const db = initDatabase(path.join(tmpDir, 'par.db'))
    const store = new TaskStore(db)
    strand(db, 'strand-u1', '1')
    strand(db, 'strand-u2', '2')
    strand(db, 'strand-u3', '3')
    setStrandContextWindow(db, 'strand-u1', 65536)
    setStrandContextWindow(db, 'strand-u2', 32768)
    setStrandContextWindow(db, 'strand-u3', 131072)
    supportedMax['synthetic-small:4b'] = 65536
    const runner = makeRunner(db)
    for (const m of ['synthetic-a:8b', 'synthetic-b:8b', 'synthetic-small:4b']) scripts[m] = [tool, completed]
    const mk = (name: string) => store.create({ name, prompt: 'run the synthetic tests', triggerType: 'user', agentId: 'main' })
    const t1 = mk('u1'); const t2 = mk('u2'); const t3 = mk('u3')
    await Promise.all([
      runner.startTask(t1, { ...provider(), enabledModels: ['synthetic-a:8b'] }, undefined, 'strand-u1'),
      runner.startTask(t2, { ...provider(), enabledModels: ['synthetic-b:8b'] }, undefined, 'strand-u2'),
      runner.startTask(t3, { ...provider(), enabledModels: ['synthetic-small:4b'] }, undefined, 'strand-u3'),
    ])
    await waitFor(() => [t1, t2, t3].every(t => store.getById(t.id)?.status === 'completed'), 'parallel completion')
    runner.dispose()
    expect(chatsFor('synthetic-a:8b').map(b => b.options?.num_ctx)).toEqual([65536, 65536])
    // 32768 > baseline 16384 → applied exactly
    expect(chatsFor('synthetic-b:8b').map(b => b.options?.num_ctx)).toEqual([32768, 32768])
    // snapshot 131072 kept on the task row, but the model's known max is 65536:
    // nothing is sent as override (exceeds_supported), never a fake 131072/65536
    expect(readStrandContextWindow(db, store.getById(t3.id)!.sessionId!)).toBe(131072)
    for (const b of chatsFor('synthetic-small:4b')) expect(b.options?.num_ctx).toBeUndefined()
    db.close()
  })

  it('a sub-task (no interactive parent) snapshots only its trusted parent TASK session; other trigger types inherit nothing', async () => {
    const db = initDatabase(path.join(tmpDir, 'nested.db'))
    const store = new TaskStore(db)
    strand(db, 'parent')
    setStrandContextWindow(db, 'parent', 65536)
    const runner = makeRunner(db)
    const parentTask = store.create({ name: 'parent task', prompt: 'p', triggerType: 'user', agentId: 'main' })
    await runner.startTask(parentTask, provider(), undefined, 'parent')
    await waitFor(() => store.getById(parentTask.id)?.status === 'completed', 'parent completion')
    // parent strand changes afterwards — the sub-task follows the parent TASK snapshot
    setStrandContextWindow(db, 'parent', null)
    const child = store.create({ name: 'child', prompt: 'c', triggerType: 'agent', triggerSourceId: parentTask.id, agentId: 'main' })
    await runner.startTask(child, { ...provider(), enabledModels: ['synthetic-b:8b'] }, undefined, null)
    await waitFor(() => store.getById(child.id)?.status === 'completed', 'child completion')
    // a scheduled run whose source id happens to equal a task id is NOT a trusted parent
    const cron = store.create({ name: 'cron', prompt: 'c', triggerType: 'cronjob', triggerSourceId: parentTask.id, agentId: 'main' })
    await runner.startTask(cron, { ...provider(), enabledModels: ['synthetic-small:4b'] }, undefined, null)
    await waitFor(() => store.getById(cron.id)?.status === 'completed', 'cron completion')
    runner.dispose()
    expect(readStrandContextWindow(db, store.getById(child.id)!.sessionId!)).toBe(65536)
    expect(chatsFor('synthetic-b:8b').map(b => b.options?.num_ctx)).toEqual([65536])
    expect(readStrandContextWindow(db, store.getById(cron.id)!.sessionId!)).toBeNull()
    expect(chatsFor('synthetic-small:4b').map(b => b.options?.num_ctx)).toEqual([undefined])
    // nothing global was written: the parent strand stays as the user left it
    expect(readStrandContextWindow(db, 'parent')).toBeNull()
    db.close()
  })

  it('Eco over the native path in a task: the first request after the tool call is the frozen projection, the original is persisted and recallable by its owner only', async () => {
    const db = initDatabase(path.join(tmpDir, 'eco.db'))
    const store = new TaskStore(db)
    strand(db, 'eco-parent')
    setStrandEcoEnabled(db, 'eco-parent', true)
    setStrandContextWindow(db, 'eco-parent', 65536)
    const runner = makeRunner(db)
    scripts['synthetic-a:8b'] = [tool, completed]
    const task = store.create({ name: 'native eco', prompt: 'run the synthetic tests', triggerType: 'user', agentId: 'main' })
    await runner.startTask(task, provider(), undefined, 'eco-parent')
    await waitFor(() => store.getById(task.id)?.status === 'completed', 'completion', 15000, () => store.getById(task.id))
    runner.dispose()
    const second = chatsFor('synthetic-a:8b')[1]
    expect(second.options?.num_ctx).toBe(65536)
    const toolMsg = second.messages.find(m => m.role === 'tool')!
    expect(toolMsg.tool_name).toBe('shell')
    expect(toolMsg.content).toContain('[eco: shell result compacted once')
    expect(toolMsg.content).toContain(MIDDLE_MARK)
    expect(toolMsg.content).not.toContain('src/m450.test.ts')
    const sessionId = store.getById(task.id)!.sessionId!
    const rows = db.prepare("SELECT id, eco_original, metadata FROM chat_messages WHERE session_id = ? AND role = 'tool'").all(sessionId) as Array<{ id: number; eco_original: string | null; metadata: string }>
    expect(rows.length).toBe(1)
    expect(rows[0].eco_original).toContain('src/m450.test.ts')
    // the generated native tool id is the one the transcript references
    const meta = JSON.parse(rows[0].metadata) as { toolCallId?: string }
    expect(typeof meta.toolCallId).toBe('string')
    expect(toolMsg.content).toContain(`message_id=${rows[0].id}`)
    db.close()
  })
})
