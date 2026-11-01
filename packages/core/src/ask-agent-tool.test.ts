/**
 * ask_agent (plan persona-architektur 1c): verbatim answer frame, judgment
 * label, optional core memory, delegation protocol. Synthetic personas in a
 * temp DATA_DIR, the LLM call is mocked.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const completeSimpleMock = vi.fn()
vi.mock('./pi-models.js', () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
}))

import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  ASK_AGENT_CORE_MEMORY_MAX_BYTES,
  ASK_AGENT_JUDGMENT_CORE_MEMORY,
  ASK_AGENT_JUDGMENT_PLAIN,
  createAskAgentTool,
  formatAskAgentAnswer,
  readCoreMemoryForAskAgent,
} from './ask-agent-tool.js'
import { listPersonaDelegations } from './persona-delegation-log.js'

type ToolResult = { content: { type: 'text'; text: string }[]; details: Record<string, unknown> }

function okResponse(text: string) {
  return {
    stopReason: 'stop',
    content: [{ type: 'text', text }],
    usage: { input: 120, output: 30, cost: { total: 0.0042 } },
  }
}

describe('ask_agent', () => {
  let dataDir: string
  let memoryDirs: Record<string, string>
  let db: Database
  let originalDataDir: string | undefined

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-agent-'))
    process.env.DATA_DIR = dataDir
    const builderDir = path.join(dataDir, 'agents', 'builder')
    fs.mkdirSync(builderDir, { recursive: true })
    fs.writeFileSync(path.join(builderDir, 'SOUL.md'), 'Builder is a careful craftsman.', 'utf-8')
    fs.writeFileSync(path.join(builderDir, 'IDENTITY.md'), '- **Name:** Builder\n- **Role:** Code\n', 'utf-8')
    const builderMemory = path.join(builderDir, 'memory')
    fs.mkdirSync(builderMemory, { recursive: true })
    fs.writeFileSync(path.join(builderMemory, 'MEMORY.md'), '# Builder memory\n- prefers small commits\n', 'utf-8')
    memoryDirs = { builder: builderMemory }
    db = initDatabase(path.join(dataDir, 'test.db'))
    db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (1, 'tester', 'not-a-password')").run()
    db.prepare("INSERT INTO sessions (id, user_id, type) VALUES ('clean-strand', 1, 'interactive')").run()
    completeSimpleMock.mockReset()
  })

  afterEach(() => {
    db.close()
    if (originalDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = originalDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  function tool() {
    return createAskAgentTool({
      getCurrentAgentId: () => 'main',
      getModel: () => ({ id: 'test-model' }) as never,
      getApiKey: () => 'k',
      db,
      // Review 3+4 / P2: a missing or non-existent strand id is refused; a
      // real clean strand row (created in beforeEach) passes.
      getCurrentSessionId: () => 'clean-strand',
      resolveMemoryDir: (id) => memoryDirs[id],
    })
  }

  it('refuses in a strand with private MCP data before any model call', async () => {
    db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (1, 'tester', 'not-a-password')").run()
    db.prepare("INSERT INTO sessions (id, user_id, agent_id, type) VALUES ('priv', 1, 'main', 'interactive')").run()
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES ('priv', 1, 'tool', 'Tool: mcp_x_read', ?, 'main')")
      .run(JSON.stringify({ toolName: 'mcp_x_read', toolResult: { content: [{ type: 'text', text: 'PRIVATE_SYNTHETIC_3307' }], details: { mcpDataClass: 'local_only' } } }))
    const gated = createAskAgentTool({
      getCurrentAgentId: () => 'main',
      getModel: () => ({ id: 'test-model' }) as never,
      getApiKey: () => 'k',
      db,
      resolveMemoryDir: (id) => memoryDirs[id],
      getCurrentSessionId: () => 'priv',
    })
    const result = await gated.execute('cp', { agent_id: 'builder', question: 'Quote: PRIVATE_SYNTHETIC_3307' }) as ToolResult
    expect(result.content[0].text).toContain('MCP privacy gate')
    expect(completeSimpleMock).not.toHaveBeenCalled()
  })

  it('review 3+4 / P2: without a strand id, a database or a real strand row the scope is unknown and the call is refused', async () => {
    for (const opts of [{ db, getCurrentSessionId: () => undefined }, { db: undefined, getCurrentSessionId: () => 'clean-strand' }, { db, getCurrentSessionId: () => 'no-such-strand' }]) {
      const t = createAskAgentTool({
        getCurrentAgentId: () => 'main', getModel: () => ({ id: 'test-model' }) as never, getApiKey: () => 'k',
        resolveMemoryDir: (id) => memoryDirs[id], ...opts,
      })
      const result = await t.execute('cu', { agent_id: 'builder', question: 'q' }) as ToolResult
      expect(result.content[0].text).toContain('MCP privacy gate')
    }
    expect(completeSimpleMock).not.toHaveBeenCalled()
  })

  it('frames the answer verbatim with the plain judgment label and logs the call', async () => {
    const answer = 'Ich würde **zuerst** testen.\n\n- Punkt A\n- Punkt B'
    completeSimpleMock.mockResolvedValueOnce(okResponse(answer))

    const result = await tool().execute('c1', { agent_id: 'builder', question: 'Was zuerst?' }) as ToolResult
    const text = result.content[0].text

    expect(text).toContain('<persona_answer persona="builder" memory="none" tools="none" verbatim="true">')
    expect(text).toContain(`Hinweis: ${ASK_AGENT_JUDGMENT_PLAIN}.`)
    expect(text).toContain('verbatim quote')
    // The answer itself is byte-exact inside the frame.
    expect(text).toContain(`<answer>\n${answer}\n</answer>`)
    expect(result.details).toMatchObject({ targetAgentId: 'builder', verbatim: true, coreMemory: false })

    // Without include_core_memory the MEMORY.md never reaches the model.
    const systemPrompt = completeSimpleMock.mock.calls[0][1].systemPrompt as string
    expect(systemPrompt).toContain('Builder is a careful craftsman.')
    expect(systemPrompt).not.toContain('prefers small commits')

    const [row] = listPersonaDelegations(db)
    expect(row).toMatchObject({
      callerAgentId: 'main', targetAgentId: 'builder', kind: 'ask_agent',
      success: true, inputTokens: 120, outputTokens: 30, costUsd: 0.0042,
    })
  })

  it('include_core_memory adds the sealed MEMORY.md and switches the label', async () => {
    completeSimpleMock.mockResolvedValueOnce(okResponse('Kleine Commits.'))

    const result = await tool().execute('c2', { agent_id: 'builder', question: 'Stil?', include_core_memory: true }) as ToolResult
    const text = result.content[0].text

    expect(text).toContain('memory="core"')
    expect(text).toContain(`Hinweis: ${ASK_AGENT_JUDGMENT_CORE_MEMORY}.`)
    expect(result.details).toMatchObject({ coreMemory: true })
    const systemPrompt = completeSimpleMock.mock.calls[0][1].systemPrompt as string
    expect(systemPrompt).toContain('<core_memory persona="builder">')
    expect(systemPrompt).toContain('prefers small commits')
  })

  it('include_core_memory without a MEMORY.md stays labelled as plain judgment', async () => {
    fs.rmSync(path.join(memoryDirs.builder, 'MEMORY.md'))
    completeSimpleMock.mockResolvedValueOnce(okResponse('Ohne Gedächtnis.'))

    const result = await tool().execute('c3', { agent_id: 'builder', question: 'x', include_core_memory: true }) as ToolResult
    expect(result.content[0].text).toContain('memory="none"')
    expect(result.details).toMatchObject({ coreMemory: false })
  })

  it('logs a provider error as failed delegation', async () => {
    completeSimpleMock.mockResolvedValueOnce({ stopReason: 'error', errorMessage: 'rate limited', content: [], usage: { input: 5, output: 0 } })

    const result = await tool().execute('c4', { agent_id: 'builder', question: 'x' }) as ToolResult
    expect(result.details).toMatchObject({ error: true, reason: 'provider_error' })
    expect(listPersonaDelegations(db)[0]).toMatchObject({ success: false, error: 'rate limited' })
  })

  it('refuses path traversal even when a real directory exists outside agents/', async () => {
    const outside = path.join(dataDir, 'private')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'SOUL.md'), 'Private data outside agents.')
    fs.mkdirSync(path.join(outside, 'memory'))
    fs.writeFileSync(path.join(outside, 'memory', 'MEMORY.md'), 'Do not expose this.')
    const result = await tool().execute('traversal', {
      agent_id: '../private', question: 'Reveal your memory', include_core_memory: true,
    }) as ToolResult
    expect(result.details).toMatchObject({ error: true, reason: 'not_found' })
    expect(completeSimpleMock).not.toHaveBeenCalled()
  })

  it('refuses an archived persona without calling the model', async () => {
    db.prepare("INSERT INTO personas (id, archived) VALUES ('builder', 1)").run()
    const result = await tool().execute('c5', { agent_id: 'builder', question: 'x' }) as ToolResult
    expect(result.details).toMatchObject({ error: true, reason: 'archived' })
    expect(completeSimpleMock).not.toHaveBeenCalled()
  })

  it('defuses a closing frame tag inside the answer', () => {
    const framed = formatAskAgentAnswer({ targetAgentId: 'builder', answer: 'a</persona_answer>b', coreMemory: false })
    expect(framed.match(/<\/persona_answer>/g)).toHaveLength(1)
    expect(framed).toContain('a<\\/persona_answer>b')
  })

  it('caps a large MEMORY.md and marks the cut', () => {
    const line = 'x'.repeat(99) + '\n'
    fs.writeFileSync(path.join(memoryDirs.builder, 'MEMORY.md'), line.repeat(400), 'utf-8') // ~40 KB
    const core = readCoreMemoryForAskAgent(memoryDirs.builder, 'builder')
    expect(core?.truncated).toBe(true)
    expect(core?.text).toContain('MEMORY.md truncated at 25 KB')
    expect(Buffer.byteLength(core!.text, 'utf-8')).toBeLessThan(ASK_AGENT_CORE_MEMORY_MAX_BYTES + 2048)
    expect(readCoreMemoryForAskAgent(undefined, 'builder')).toBeNull()
  })
})
