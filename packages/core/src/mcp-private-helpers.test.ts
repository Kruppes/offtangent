/**
 * Follow-up to review 2 / B: the automatic helpers that read a strand on
 * their own and call a model outside the turn (fact extraction, session
 * summary, auto-title, project assignment, capture router candidates,
 * delegation context, create_task) must leave a strand with private
 * (local_only) MCP data out entirely, BEFORE the data is handed over. Every
 * test runs the real helper against an in-memory database, uses a
 * non-local stand-in model and asserts that neither the private tool output
 * nor the assistant's quote of it reaches that model. A clean strand still
 * reaches it (counter check, so the gate is not simply "always off").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const piCalls: string[] = []
vi.mock('./pi-models.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pi-models.js')>()
  return {
    ...real,
    completeSimple: vi.fn(async (_model: unknown, context: unknown) => {
      piCalls.push(JSON.stringify(context))
      return { role: 'assistant', content: [{ type: 'text', text: '{"facts": []}' }], stopReason: 'stop', usage: { input: 1, output: 1 } }
    }),
  }
})

import { initDatabase, type Database } from './database.js'
import { extractAndStoreFacts } from './fact-extraction.js'
import { evaluateStrandAutoTitle } from './strand-auto-title.js'
import { evaluateStrandProject } from './project-assignment.js'
import { selectCandidates } from './capture-router.js'
import { buildDelegationContext } from './delegation-context.js'
import { createTaskTool } from './task-tools.js'
import { AgentCore } from './agent.js'
import { EMPTY_SUMMARY_TEXT } from './session-summary-schema.js'
import type { ResolvedRouterModel } from './router-model.js'

const MARKER = 'PRIVATE_MCP_OUTPUT_SYNTHETIC_662814'
const QUOTE = 'ASSISTANT_QUOTE_SYNTHETIC_552190'
const PRIV = 'private-strand'
const CLEAN = 'clean-strand'

const CLOUD: ResolvedRouterModel = {
  spec: 'claude-haiku-5-5', threshold: null, providerId: 'anthropic', providerName: 'Anthropic', modelId: 'claude-haiku-5-5', composite: 'anthropic:claude-haiku-5-5',
}
const CLOUD_MODEL = { id: 'claude-haiku-5-5', name: 'h', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as never

let db: Database

function addStrand(id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written, agent_id, title, archived, title_source)
     VALUES (?, 1, '1', 'web', 'interactive', datetime('now'), datetime('now'), 0, 0, 'main', 'Hallo, kannst du mir', 0, 'derived')`,
  ).run(id)
  for (let i = 0; i < 6; i += 1) {
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp) VALUES (?, 1, 'user', ?, 'main', datetime('now'))")
      .run(id, `Die Gießkanne am Bootshaus ist undicht ${id === PRIV ? QUOTE : ''} ${i}`)
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp) VALUES (?, 1, 'assistant', ?, 'main', datetime('now'))")
      .run(id, id === PRIV ? `Exact quote of the tool: ${QUOTE}` : `ok ${i}`)
  }
}

function markPrivate(id: string): void {
  db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, 1, 'tool', 'Tool: mcp_review_read', ?, 'main')")
    .run(id, JSON.stringify({ toolName: 'mcp_review_read', toolCallId: 'c', toolArgs: {}, toolResult: { content: [{ type: 'text', text: MARKER }], details: { mcpDataClass: 'local_only' } } }))
}

function expectNoPrivate(seen: string[]): void {
  const all = seen.join('\n')
  expect(all).not.toContain(MARKER)
  expect(all).not.toContain(QUOTE)
}

beforeEach(() => {
  piCalls.length = 0
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'tester', 'not-a-password')").run()
  addStrand(PRIV)
  markPrivate(PRIV)
  addStrand(CLEAN)
})

afterEach(() => {
  db.close()
})

describe('fact extraction', () => {
  it('skips a private strand before the model call; a clean strand still calls the model', async () => {
    const history = `User: ${QUOTE}\nAssistant: ${MARKER}`
    const result = await extractAndStoreFacts(db, 1, PRIV, history, CLOUD_MODEL, 'k')
    expect(result.skipped).toBe('mcp_private')
    expect(piCalls).toHaveLength(0)
    await extractAndStoreFacts(db, 1, CLEAN, 'User: Ich wohne in Teststadt und mag Tee.\nAssistant: Notiert, du magst Tee.', CLOUD_MODEL, 'k')
    expect(piCalls.length).toBeGreaterThan(0)
    expectNoPrivate(piCalls)
  })
})

describe('session summary', () => {
  it('returns the empty summary for a private strand without any model call', async () => {
    const fake = { db } as unknown as AgentCore
    const generate = (AgentCore.prototype as unknown as { generateSessionSummary: (u: string, h?: string, s?: string) => Promise<string> }).generateSessionSummary
    const out = await generate.call(fake, '1', `User: ${QUOTE}\nAssistant: ${MARKER}`, PRIV)
    expect(out).toBe(EMPTY_SUMMARY_TEXT)
    expect(piCalls).toHaveLength(0)
  })
})

describe('unknown scope (review 3 / P2): a missing database or strand id never means clean', () => {
  it('fact extraction without a strand id or without a database makes no model request', async () => {
    const history = `User: ${QUOTE}\nAssistant: ${MARKER}`
    expect((await extractAndStoreFacts(db, 1, '', history, CLOUD_MODEL, 'k')).skipped).toBe('mcp_private')
    expect((await extractAndStoreFacts(undefined as never, 1, CLEAN, history, CLOUD_MODEL, 'k')).skipped).toBe('mcp_private')
    expect(piCalls).toHaveLength(0)
  })

  it('session summary without a strand id or without a database makes no model request', async () => {
    const generate = (AgentCore.prototype as unknown as { generateSessionSummary: (u: string, h?: string, s?: string) => Promise<string> }).generateSessionSummary
    expect(await generate.call({ db } as unknown as AgentCore, '1', `User: ${QUOTE}\nAssistant: ${MARKER}`, undefined)).toBe(EMPTY_SUMMARY_TEXT)
    expect(await generate.call({ db: undefined } as unknown as AgentCore, '1', `User: ${QUOTE}\nAssistant: ${MARKER}`, CLEAN)).toBe(EMPTY_SUMMARY_TEXT)
    expect(piCalls).toHaveLength(0)
  })

  it('create_task inside a task with no strand id at all is refused; inside a task of a private strand too', async () => {
    const { runWithTaskExecutionContext } = await import('./task-execution-context.js')
    const createTask = vi.fn(async () => ({ id: 't1' }))
    const tool = createTaskTool({ db, taskRuntime: { createTask } as never, getParentSessionId: () => null } as never)
    const brief = { name: 'n', prompt: `${QUOTE} ${'self contained synthetic brief '.repeat(12)}` } as never
    expect(JSON.stringify(await tool.execute('c0', brief))).toContain('MCP privacy gate')
    const inPriv = await runWithTaskExecutionContext({ provider: null, taskId: 'x', sessionId: PRIV, taskSessionId: 'task-own' }, () => tool.execute('c1', brief))
    expect(JSON.stringify(inPriv)).toContain('MCP privacy gate')
    expect(createTask).not.toHaveBeenCalled()
  })
})

describe('strand auto-title', () => {
  it('never hands a private strand to the (non-local) title model', async () => {
    const prompts: string[] = []
    const complete = async (_entry: ResolvedRouterModel, prompt: string) => { prompts.push(prompt); return '{"keep": true}' }
    const result = await evaluateStrandAutoTitle(db, PRIV, 'message', { chain: [CLOUD], complete })
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'mcp_private' })
    expect(prompts).toHaveLength(0)
    await evaluateStrandAutoTitle(db, CLEAN, 'message', { chain: [CLOUD], complete })
    expect(prompts.length).toBeGreaterThan(0)
    expectNoPrivate(prompts)
  })
})

describe('project assignment', () => {
  it('never hands a private strand to the assignment model', async () => {
    db.prepare("INSERT INTO projects (id, user_id, name, color, archived, created_at, updated_at) VALUES ('prj_haus', '1', 'Haus', NULL, 0, datetime('now'), datetime('now'))").run()
    const prompts: string[] = []
    const complete = async (_entry: ResolvedRouterModel, prompt: string) => { prompts.push(prompt); return JSON.stringify({ projectId: null, confidence: 0.1, reason: 'x' }) }
    const result = await evaluateStrandProject(db, PRIV, 'message', { chain: [CLOUD], complete })
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'mcp_private' })
    expect(prompts).toHaveLength(0)
    await evaluateStrandProject(db, CLEAN, 'message', { chain: [CLOUD], complete })
    expect(prompts.length).toBeGreaterThan(0)
    expectNoPrivate(prompts)
  })
})

describe('capture router candidates', () => {
  it('drops a private strand from the candidate list handed to the router model', () => {
    const candidates = selectCandidates(db, '1', `Gießkanne Bootshaus undicht ${QUOTE}`, { pinnedStrandId: PRIV })
    const ids = candidates.map(c => c.strandId)
    expect(ids).not.toContain(PRIV)
    expect(ids).toContain(CLEAN)
    expectNoPrivate([JSON.stringify(candidates)])
  })
})

describe('delegation context', () => {
  it('passes no window, message or summary of a private strand to a task', () => {
    const privId = (db.prepare("SELECT id FROM chat_messages WHERE session_id = ? AND role = 'assistant' LIMIT 1").get(PRIV) as { id: number }).id
    for (const r of [
      buildDelegationContext({ db, mode: 'fork', parentSessionId: PRIV }),
      buildDelegationContext({ db, mode: 'selected', parentSessionId: PRIV, selection: { strandSummary: true, messageIds: [privId] } }),
    ]) {
      expect(r.block).toBeNull()
      expect(r.mode).toBe('clean')
    }
    const clean = buildDelegationContext({ db, mode: 'fork', parentSessionId: CLEAN })
    expect(clean.block).toBeTruthy()
    expectNoPrivate([String(clean.block)])
  })
})

describe('create_task', () => {
  it('refuses to start a task from a private strand and never reaches the task runtime', async () => {
    const createTask = vi.fn(async () => ({ id: 't1' }))
    const tool = createTaskTool({
      db,
      taskRuntime: { createTask } as never,
      getParentSessionId: () => PRIV,
    } as never)
    const result = await tool.execute('c1', { name: 'n', prompt: `Use this: ${QUOTE}`, context_mode: 'fork' } as never)
    expect(JSON.stringify(result)).toContain('MCP privacy gate')
    expect((result as { details: Record<string, unknown> }).details.mcpPrivate).toBe(true)
    expect(createTask).not.toHaveBeenCalled()
  })
})
