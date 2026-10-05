/**
 * Real Eco final gates (plan 2026-10-05-real-eco, review report-1e122db5):
 *  F3  raw Eco originals are only readable by a caller whose TRUSTED owner
 *      (interactive session / per-task execution context, never a missing
 *      getCurrentUserId) equals the row's trusted owner; full TaskRunner run
 *      with two users on the same persona and a shared recall tool instance.
 *  F1  conservative allowlist: whole-file reads, cat, git diff, web_fetch,
 *      email_read keep the planted BUG / auth / answer visible (passthrough).
 *  F2  exact error-signal accounting when the block cap is hit.
 * Synthetic data only, no cloud/live call.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { setStrandEcoEnabled } from './eco-mode-store.js'
import { projectToolResultSafe } from './eco-tool-projection.js'
import { createRecallMessageTool } from './recall-message-tool.js'
import { runWithTaskExecutionContext } from './task-execution-context.js'
import { TaskStore } from './task-store.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import type { ProviderConfig } from './provider-config.js'

const PRIVATE = 'USER2-PRIVATE-MIDDLE-FACT-7781'

function seedRawRow(db: Database, sessionId: string, userId: number | null): number {
  const orig = JSON.stringify({ content: [{ type: 'text', text: `${'x'.repeat(4000)}\n${PRIVATE}\n${'y'.repeat(4000)}` }], details: null })
  const r = db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, eco_original) VALUES (?, ?, 'tool', 'Tool: shell', ?, 'main', ?)")
    .run(sessionId, userId, JSON.stringify({ toolName: 'shell', toolCallId: `c-${sessionId}`, toolResult: { content: [{ type: 'text', text: '[eco: proj]' }] } }), orig)
  return Number(r.lastInsertRowid)
}

async function recallText(tool: AgentTool, id: number): Promise<string> {
  const out = await tool.execute('x', { message_id: id } as never) as { content: { text: string }[] }
  return out.content.map(c => c.text).join('')
}

describe('F3: raw Eco original owner check (unit, every caller kind)', () => {
  let db: Database
  let rowU2: number
  let rowU2NullUser: number
  beforeEach(() => {
    db = initDatabase(':memory:')
    for (const [id, n] of [[1, 'u1'], [2, 'u2']] as const) db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'h', 'user')").run(id, n)
    db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('s-u1', 1, 'main')").run()
    db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('s-u2', 2, 'main')").run()
    // task session of user2 (no own owner, parent = strand) and a sub-task below it
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id) VALUES ('t-u2', 'task', 'task', 's-u2')").run()
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id) VALUES ('t-u2-sub', 'task', 'task', 't-u2')").run()
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id) VALUES ('t-u1', 'task', 'task', 's-u1')").run()
    // cron/heartbeat task without any owner on its chain; a cycle
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id) VALUES ('t-cron', 'task', 'task', NULL)").run()
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id) VALUES ('cyc-a', 'task', 'task', NULL)").run()
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id) VALUES ('cyc-b', 'task', 'task', 'cyc-a')").run()
    db.prepare("UPDATE sessions SET parent_session_id = 'cyc-b' WHERE id = 'cyc-a'").run()
    rowU2 = seedRawRow(db, 's-u2', 2)
    rowU2NullUser = seedRawRow(db, 't-u2', null) // task tool rows keep user_id NULL
  })

  it('reviewer repro: a task-style tool (no user, no session getter, no task context) gets NOTHING (was: the raw original)', async () => {
    const tool = createRecallMessageTool({ db, getCurrentAgentId: () => 'main', getCurrentUserId: () => undefined })
    expect(await recallText(tool, rowU2)).toContain('not found')
    expect(await recallText(tool, rowU2NullUser)).toContain('not found')
    expect(await recallText(createRecallMessageTool({ db }), rowU2NullUser)).not.toContain(PRIVATE)
  })

  it('interactive: owner allowed, user1 -> user2 denied, session/user mismatch denied', async () => {
    const mk = (sid: string, uid?: number) => createRecallMessageTool({ db, getCurrentAgentId: () => 'main', getCurrentUserId: () => uid, getCurrentSessionId: () => sid })
    expect(await recallText(mk('s-u2', 2), rowU2)).toContain(PRIVATE)
    expect(await recallText(mk('s-u2', 2), rowU2NullUser)).toContain(PRIVATE)
    expect(await recallText(mk('s-u1', 1), rowU2)).toContain('not found')
    expect(await recallText(mk('s-u1'), rowU2NullUser)).toContain('not found')
    expect(await recallText(mk('s-u2', 1), rowU2)).toContain('not found') // turn user disagrees with the session owner
    expect(await recallText(mk('no-such-session', 2), rowU2)).toContain('not found')
  })

  it('background task (one SHARED tool instance, per-task ALS context): own task + sub-task allowed; foreign, cron, cycle, missing denied', async () => {
    const shared = createRecallMessageTool({ db }) // exactly like backgroundTaskTools: no user/session getter
    const as = (ctx: Record<string, unknown>) => runWithTaskExecutionContext(ctx as never, () => Promise.all([recallText(shared, rowU2), recallText(shared, rowU2NullUser)]))
    // concurrent tasks of two users on the same persona through the same instance
    const [own, sub, foreign, cron, cycle, noSession, mismatch] = await Promise.all([
      as({ taskId: 'a', agentId: 'main', taskSessionId: 't-u2', sessionId: 's-u2', userId: 2 }),
      as({ taskId: 'b', agentId: 'main', taskSessionId: 't-u2-sub', sessionId: 's-u2', userId: 2 }),
      as({ taskId: 'c', agentId: 'main', taskSessionId: 't-u1', sessionId: 's-u1', userId: 1 }),
      as({ taskId: 'd', agentId: 'main', taskSessionId: 't-cron', sessionId: null, userId: null }),
      as({ taskId: 'e', agentId: 'main', taskSessionId: 'cyc-a', sessionId: null, userId: null }),
      as({ taskId: 'f', agentId: 'main', sessionId: 's-u2', userId: 2 }),
      as({ taskId: 'g', agentId: 'main', taskSessionId: 't-u2', sessionId: 's-u2', userId: 1 }),
    ])
    expect(own.every(t => t.includes(PRIVATE))).toBe(true)
    expect(sub.every(t => t.includes(PRIVATE))).toBe(true)
    for (const denied of [foreign, cron, cycle, noSession, mismatch]) for (const t of denied) {
      expect(t).toContain('not found')
      expect(t).not.toContain(PRIVATE)
    }
    // persona scope still applies inside an owned task
    const [otherPersona] = await runWithTaskExecutionContext({ taskId: 'h', agentId: 'coder', taskSessionId: 't-u2', sessionId: 's-u2', userId: 2 } as never,
      () => Promise.all([recallText(shared, rowU2NullUser)]))
    expect(otherPersona).toContain('not found')
  })

  it('legacy (non-Eco) rows keep their old visibility rules', async () => {
    db.prepare("INSERT INTO chat_messages (id, session_id, user_id, role, content, agent_id) VALUES (900, 's-u2', 2, 'assistant', 'legacy answer', 'main')").run()
    expect(await recallText(createRecallMessageTool({ db, getCurrentAgentId: () => 'main' }), 900)).toContain('legacy answer')
  })
})

// ---------------------------------------------------------------------------
// F3 end to end: real TaskRunner + pi-agent loop + fake openai HTTP server.
// ---------------------------------------------------------------------------
let tmpDir: string
let previous: Record<string, string | undefined> = {}
let server: http.Server
let origin: string

function sseTool(res: http.ServerResponse, id: string, name: string, args: unknown) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  res.write(frame({ role: 'assistant', content: null, tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null))
  res.write(frame({}, 'tool_calls'))
  res.end('data: [DONE]\n\n')
}
function sseText(res: http.ServerResponse, text: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  res.write(frame({ role: 'assistant', content: text }, null))
  res.write(frame({}, 'stop'))
  res.end('data: [DONE]\n\n')
}

/** Stateless fake model: decides from the request alone, so tasks can run concurrently. */
const lastToolResult = new Map<string, string>()
function reply(body: { messages: Array<{ role: string; content: unknown }> }, res: http.ServerResponse) {
  const msgs = body.messages
  const last = msgs[msgs.length - 1]
  const all = JSON.stringify(msgs)
  const tag = /TASKTAG-([a-z0-9]+)/.exec(all)?.[1] ?? 'none'
  if (last?.role === 'tool') {
    lastToolResult.set(tag, typeof last.content === 'string' ? last.content : JSON.stringify(last.content))
    return sseText(res, 'STATUS: completed\nSUMMARY: synthetic done')
  }
  const recall = /RECALL-(\d+)/.exec(all)
  if (recall) return sseTool(res, `tc-${tag}`, 'recall_message', { message_id: Number(recall[1]) })
  return sseTool(res, `tc-${tag}`, 'shell', { command: 'npm test' })
}

function shellTool(): AgentTool {
  return {
    name: 'shell', label: 'Shell', description: 'Runs a shell command (test double, synthetic test log).',
    parameters: Type.Object({ command: Type.Optional(Type.String()) }),
    execute: async () => {
      const ok = Array.from({ length: 600 }, (_, i) => ` ✓ src/m${i}.test.ts (3 tests) ${i % 40}ms`)
      ok.splice(300, 0, `   note: ${PRIVATE}`)
      ok.push('      Tests  1800 passed', 'exit status 0')
      return { content: [{ type: 'text' as const, text: ok.join('\n') }], details: {} }
    },
  }
}

describe('F3 end to end: two users, same persona, shared background tools, the task itself calls recall_message', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-final-gates-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
    process.env.DATA_DIR = tmpDir
    process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
    lastToolResult.clear()
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
      req.on('end', () => { reply(JSON.parse(raw), res) })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('user2 task freezes a shell log (row user_id NULL); user2 task recalls it verbatim, user1 task on the same persona gets "not found"', async () => {
    const db = initDatabase(path.join(tmpDir, 'f3.db'))
    for (const [id, n] of [[1, 'u1'], [2, 'u2']] as const) db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'h', 'user')").run(id, n)
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES ('strand-u1', 'system', 'interactive', NULL, '1')").run()
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES ('strand-u2', 'system', 'interactive', NULL, '2')").run()
    setStrandEcoEnabled(db, 'strand-u2', true)
    setStrandEcoEnabled(db, 'strand-u1', true)
    const store = new TaskStore(db)
    const provider = {
      id: 'p-local', name: 'p-local', type: 'openai', providerType: 'openai', provider: 'openai', baseUrl: `${origin}/v1`,
      apiKey: 'none', enabledModels: ['local-test'], models: [], status: 'connected', authMethod: 'api-key',
    } as ProviderConfig
    const waiters = new Map<string, () => void>()
    // ONE shared tool array for every task, like runtime-composition's backgroundTaskTools
    const sharedTools: AgentTool[] = [shellTool(), createRecallMessageTool({ db, maxChars: 200000 })]
    const runner = new TaskRunner({
      db,
      buildModel: () => ({
        id: 'local-test', name: 'Local test', api: 'openai-completions', provider: 'openai', baseUrl: `${origin}/v1`, reasoning: false,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 2048,
      }) as unknown as ReturnType<TaskRunnerOptions['buildModel']>,
      getApiKey: async () => 'none',
      tools: sharedTools,
      onTaskComplete: (taskId: string) => { waiters.get(taskId)?.() },
      sessionManager: new SessionManager({ db }),
    } as TaskRunnerOptions)
    const run = async (name: string, prompt: string, strand: string) => {
      const task = store.create({ name, prompt, triggerType: 'user', agentId: 'main' })
      const done = new Promise<void>(r => waiters.set(task.id, r))
      await runner.startTask(task, provider, undefined, strand)
      await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error(`task ${name} timeout`)), 15000))])
      return store.getById(task.id)!
    }
    try {
      const producer = await run('producer', 'TASKTAG-prod run the tests', 'strand-u2')
      expect(producer.status).toBe('completed')
      const row = db.prepare("SELECT id, user_id, eco_original FROM chat_messages WHERE session_id = ? AND role = 'tool'").get(producer.sessionId) as { id: number; user_id: number | null; eco_original: string | null }
      expect(row.user_id).toBeNull()
      expect(row.eco_original).toContain(PRIVATE)
      expect(lastToolResult.get('prod')).toContain('[eco: shell result compacted once')
      expect(lastToolResult.get('prod')).not.toContain(PRIVATE)
      // both recall tasks run CONCURRENTLY through the same shared recall tool instance
      const [own, foreign] = await Promise.all([
        run('own', `TASKTAG-own RECALL-${row.id}`, 'strand-u2'),
        run('foreign', `TASKTAG-foreign RECALL-${row.id}`, 'strand-u1'),
      ])
      expect(own.status).toBe('completed')
      expect(foreign.status).toBe('completed')
      expect(lastToolResult.get('own')).toContain(PRIVATE)
      expect(lastToolResult.get('foreign')).toContain('not found')
      expect(lastToolResult.get('foreign')).not.toContain(PRIVATE)
      // and nothing private reached the foreign task's stored transcript
      const foreignRows = db.prepare('SELECT content, metadata FROM chat_messages WHERE session_id = ?').all(foreign.sessionId) as Array<{ content: string; metadata: string | null }>
      expect(JSON.stringify(foreignRows)).not.toContain(PRIVATE)
    } finally {
      runner.dispose()
      db.close()
    }
  }, 60000)
})

// ---------------------------------------------------------------------------
// F1 semantic gates (reviewer zz-final3) and F2 exact accounting (zz-final5)
// ---------------------------------------------------------------------------
describe('F1: content that needs a full review is never projected (planted facts stay visible without recall)', () => {
  const code = Array.from({ length: 120 }, (_, i) => `export function handler${i}(req: Req): Res {\n  const v = validate(req.body.field${i})\n  if (!v) return reject(${i})\n  return ok(compute(v, ${i}))\n}\n`).join('\n')
    .replace('return ok(compute(v, 77))', 'return ok(compute(v, 77)) // BUG-77: off-by-one in compute')
  const hunks = Array.from({ length: 80 }, (_, i) => `@@ -${i * 10},6 +${i * 10},7 @@ fn${i}\n context line ${i}\n-  old_${i}()\n+  new_${i}()\n+  extra_${i}()\n context tail ${i}\n`).join('')
  const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n' + hunks.replace('extra_41()', 'extra_41() // removes auth check')
  const article = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: ${'lorem ipsum dolor sit amet '.repeat(6)}${i === 120 ? 'THE ANSWER IS 42.' : ''}`).join('\n\n')
  const cases: Array<[string, string, unknown, string, string]> = [
    ['read_file whole source', 'read_file', { path: 'src/handlers.ts' }, code, 'BUG-77'],
    ['shell cat source', 'shell', { command: 'cat src/handlers.ts' }, code, 'BUG-77'],
    ['shell git diff', 'shell', { command: 'git diff' }, diff, 'removes auth check'],
    ['shell git diff from a test command', 'shell', { command: 'npm test' }, diff, 'removes auth check'],
    ['shell sed source page', 'shell', { command: 'sed -n 1,2000p src/handlers.ts' }, code, 'BUG-77'],
    ['ambiguous pipeline', 'shell', { command: 'npm test 2>&1 | cat - src/handlers.ts' }, code, 'BUG-77'],
    ['web_fetch article', 'web_fetch', { url: 'https://example.invalid/a' }, article, 'THE ANSWER IS 42.'],
    ['email_read body', 'email_read', { uid: 3 }, article, 'THE ANSWER IS 42.'],
    ['shell curl article', 'shell', { command: 'curl -s https://example.invalid/a' }, article, 'THE ANSWER IS 42.'],
  ]
  for (const [label, toolName, args, text, fact] of cases) {
    it(`${label}: passthrough (original, ${text.length} chars, contains "${fact}")`, () => {
      expect(text.length).toBeGreaterThan(6000)
      expect(text).toContain(fact)
      expect(projectToolResultSafe({ toolName, args, text, isError: false, refId: 5 })).toBeNull()
    })
  }
})

describe('F2: >300 error lines — exact counts, cap named, never "all errors retained"', () => {
  it('500 errors: header gives detected/shown/omitted, the cap, the first omitted line and its recall offset', () => {
    const lines: string[] = []
    for (let i = 0; i < 2000; i++) {
      lines.push(i % 4 === 0 && lines.filter(l => l.startsWith('ERROR')).length < 500 ? `ERROR E${i}: synthetic failure ${i}` : `  build step ${i} ok`)
    }
    const total = lines.filter(l => l.startsWith('ERROR')).length
    expect(total).toBe(500)
    lines.push('exit status 1')
    const text = lines.join('\n')
    const p = projectToolResultSafe({ toolName: 'shell', args: { command: 'npm run build' }, text, isError: true, refId: 9 })!
    expect(p).not.toBeNull()
    const header = p.text.split('\n')[0]
    const m = /Error signal lines: (\d+) detected, (\d+) shown, (\d+) omitted \(first (\d+) error blocks in order/.exec(header)!
    expect(m).not.toBeNull()
    const [detected, shown, omitted, blocks] = m.slice(1).map(Number)
    // exit line is a signal too and is always kept
    expect(detected).toBe(501)
    const shownInBody = p.text.split('\n').slice(1).filter(l => /^\d+\| (ERROR E|exit status)/.test(l)).length
    expect(shown).toBe(shownInBody)
    expect(omitted).toBe(detected - shown)
    expect(omitted).toBeGreaterThan(0)
    expect(header).toMatch(new RegExp(`error block cap ${blocks} reached, first omitted signal at line \\d+, recall_message offset ≈ \\d+`))
    expect(header).not.toMatch(/all errors (retained|kept)/i)
    expect(p.text).toContain('exit status 1')
    // shown errors are the FIRST ones, in order
    const shownErr = p.text.split('\n').slice(1).filter(l => /^\d+\| ERROR E/.test(l)).map(l => Number(/ERROR E(\d+)/.exec(l)![1]))
    expect(shownErr).toEqual([...shownErr].sort((a, b) => a - b))
    const firstOmittedLine = Number(/first omitted signal at line (\d+)/.exec(header)![1])
    const offset = Number(/first omitted signal at line \d+, recall_message offset ≈ (\d+)/.exec(header)![1])
    expect(text.slice(offset).startsWith(lines[firstOmittedLine - 1])).toBe(true)
    expect(lines[firstOmittedLine - 1].startsWith('ERROR')).toBe(true)
  })
})
