/**
 * Tests for generateSessionSummary (session-end daily log with open threads).
 *
 * We test the behavior through the SessionManager + AgentCore integration:
 * the summary returned from generateSessionSummary is written verbatim to the
 * daily file, so we verify both the LLM prompt content and the output format.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── Mocks must be hoisted before any imports that load the mocked modules ─────

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
  getMemoryDir: vi.fn(() => '/tmp/test-memory'),
}))

vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    getApiKeyForProvider: vi.fn().mockResolvedValue('test-key'),
    buildModel: vi.fn().mockReturnValue({ id: 'mock-model' }),
    loadProvidersDecrypted: vi.fn().mockReturnValue({ providers: [] }),
    estimateCost: vi.fn().mockReturnValue(0),
  }
})

vi.mock('./skill-config.js', () => ({
  loadSkills: vi.fn().mockReturnValue({ skills: [] }),
  getSkillDecrypted: vi.fn(),
}))

vi.mock('./web-tools.js', () => ({
  createBuiltinWebTools: vi.fn(() => []),
}))

vi.mock('./stt-tool.js', () => ({
  createTranscribeAudioTool: vi.fn(() => ({})),
}))

vi.mock('./stt.js', () => ({
  loadSttSettings: vi.fn().mockReturnValue({ enabled: false }),
}))

vi.mock('./agent-skills.js', () => ({
  createAgentSkillTools: vi.fn(() => []),
  getAgentSkillsForPrompt: vi.fn(() => []),
  getAgentSkillsCount: vi.fn(() => 0),
  getAgentSkillsDir: vi.fn(() => '/tmp/test-agent-skills'),
  trackAgentSkillUsage: vi.fn(),
  currentPlatform: vi.fn(() => 'linux'),
}))

vi.mock('./workspace.js', () => ({
  getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
}))

vi.mock('./token-logger.js', () => ({
  logTokenUsage: vi.fn(),
  logToolCall: vi.fn(),
}))

// Mock pi-ai completeSimple so we can control LLM responses
vi.mock('./pi-models.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    completeSimple: vi.fn(),
  }
})

// ── Imports after mocks ────────────────────────────────────────────────────────

import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { completeSimple } from './pi-models.js'
import { appendToDailyFile } from './memory.js'

const mockCompleteSimple = vi.mocked(completeSimple)
const mockAppendToDailyFile = vi.mocked(appendToDailyFile)

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeModel() {
  return {
    id: 'gpt-4o',
    name: 'GPT-4o',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text' as const, 'image' as const],
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

function makeCompleteSimpleResponse(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    model: 'gpt-4o',
    api: 'openai-completions' as const,
    provider: 'openai',
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('generateSessionSummary (schema delta, SPEC 11.2)', () => {
  let db: Database
  let tmpDir: string
  let memoryDir: string

  type SummaryAccess = {
    generateSessionSummary: (userId: string, history?: string, sessionId?: string) => Promise<string>
  }

  function makeAgent() {
    return new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
      memoryDir,
    }) as unknown as SummaryAccess
  }

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `axiom-summary-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    memoryDir = path.join(tmpDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })

    db = initDatabase(':memory:')
    mockCompleteSimple.mockReset()
    mockAppendToDailyFile.mockReset()
  })

  afterEach(() => {
    if (db) db.close()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sends conversation history to completeSimple and renders the merged schema', async () => {
    mockCompleteSimple.mockResolvedValueOnce(
      makeCompleteSimpleResponse('{"goal":"Deploy with Docker.","add":{"decisions":["Discussed Docker deployment options."]}}')
    )

    const summary = await makeAgent().generateSessionSummary('user1', 'User: How do I deploy with Docker?\nAssistant: Use docker compose up.', 'sess-1')

    expect(mockCompleteSimple).toHaveBeenCalledOnce()
    const [, callOptions, requestOptions] = mockCompleteSimple.mock.calls[0]
    expect(callOptions.messages[0].content).toContain('How do I deploy with Docker?')
    expect(callOptions.messages[0].content).not.toContain('<previous_summary')
    // claude-sonnet-5 answers a request carrying `temperature` with a 400.
    expect(requestOptions).not.toHaveProperty('temperature')
    expect(summary).toBe('Deploy with Docker.\n- Discussed Docker deployment options.')

    const row = db.prepare('SELECT version, schema_json FROM session_summaries WHERE session_id = ?').get('sess-1') as { version: number; schema_json: string }
    expect(row.version).toBe(1)
    expect(JSON.parse(row.schema_json).decisions).toEqual(['Discussed Docker deployment options.'])
  })

  it('passes the previous version to the model and merges the delta into version 2', async () => {
    mockCompleteSimple
      .mockResolvedValueOnce(makeCompleteSimpleResponse('{"goal":"Ship PDF upload.","add":{"open":["PR #15 review pending"]}}'))
      .mockResolvedValueOnce(makeCompleteSimpleResponse('{"add":{"decisions":["PR #15 merged"]},"resolve":{"open":["PR #15 review pending"]}}'))
    const agent = makeAgent()
    await agent.generateSessionSummary('user1', 'User: start the PR\nAssistant: started', 'sess-2')
    const second = await agent.generateSessionSummary('user1', 'User: merge it\nAssistant: merged', 'sess-2')

    const [, secondCall] = mockCompleteSimple.mock.calls[1]
    expect(secondCall.messages[0].content).toContain('<previous_summary version="1">')
    expect(secondCall.messages[0].content).toContain('PR #15 review pending')
    expect(second).toBe('Ship PDF upload.\n- PR #15 merged')
    expect(second).not.toContain('### Open Threads')
    const latest = db.prepare('SELECT MAX(version) AS v FROM session_summaries WHERE session_id = ?').get('sess-2') as { v: number }
    expect(latest.v).toBe(2)
  })

  it('rejects a non JSON answer, keeps the previous version and logs the rejection', async () => {
    mockCompleteSimple
      .mockResolvedValueOnce(makeCompleteSimpleResponse('{"goal":"G","add":{"decisions":["A"]}}'))
      .mockResolvedValueOnce(makeCompleteSimpleResponse('Discussed PR workflow.\n\n### Open Threads\n- something'))
    const agent = makeAgent()
    await agent.generateSessionSummary('user1', 'User: a\nAssistant: b', 'sess-3')
    const second = await agent.generateSessionSummary('user1', 'User: c\nAssistant: d', 'sess-3')
    expect(second).toBe('G\n- A')
    const count = db.prepare('SELECT COUNT(*) AS n FROM session_summaries WHERE session_id = ?').get('sess-3') as { n: number }
    expect(count.n).toBe(1)
  })

  it('returns an empty string for a rejected first delta so nothing is written', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeCompleteSimpleResponse('not json'))
    const summary = await makeAgent().generateSessionSummary('user1', 'User: a\nAssistant: b', 'sess-4')
    expect(summary).toBe('')
  })

  it('returns no summary when the provider rejects the request', async () => {
    mockCompleteSimple.mockResolvedValueOnce({
      ...makeCompleteSimpleResponse(''),
      content: [],
      stopReason: 'error' as const,
      errorMessage: '400 `temperature` is deprecated for this model.',
    })

    const summary = await makeAgent().generateSessionSummary('user1', 'User: tell me a story\nAssistant: Once upon a time...')

    // Must not fabricate a summary: an "Empty session." placeholder would be
    // written to the daily memory file as if the conversation had no content.
    expect(summary).toBe('')
    expect(mockAppendToDailyFile).not.toHaveBeenCalled()
  })

  it('prompt demands a JSON delta and explains open items', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeCompleteSimpleResponse('{"empty":true}'))
    await makeAgent().generateSessionSummary('user1', 'User: hi\nAssistant: hello')
    const [, callOptions] = mockCompleteSimple.mock.calls[0]
    expect(callOptions.systemPrompt).toContain('JSON delta')
    expect(callOptions.systemPrompt).toContain('unfinished tasks')
    expect(callOptions.systemPrompt).not.toContain('Offene Fäden')
    expect(callOptions.systemPrompt).toContain('# Activity Log')
    expect(callOptions.systemPrompt).toContain('---')
  })

  it('renders open items under ### Open Threads', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeCompleteSimpleResponse(
      '{"goal":"Two features.","add":{"decisions":["Discussed PR for PDF upload extraction and open threads feature."],"open":["PR for PDF-upload-extraction started, result not yet confirmed","Open threads feature discussed, PR not yet started"]}}',
    ))
    const summary = await makeAgent().generateSessionSummary('user1', 'User: Lets work on two things...\nAssistant: Sure.', 'sess-5')
    expect(summary).toMatch(/^Two features\./)
    expect(summary).toContain('\n\n### Open Threads\n')
    expect(summary).toContain('- PR for PDF-upload-extraction started')
    expect(summary).toContain('- Open threads feature discussed, PR not yet started')
  })

  it('returns "Empty session." for {"empty":true} without a previous version', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeCompleteSimpleResponse('{"empty": true}'))
    const summary = await makeAgent().generateSessionSummary('user1', 'User: hi\nAssistant: hi', 'sess-6')
    expect(summary).toBe('Empty session.')
    const count = db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('returns "Empty session." when no conversation history is provided', async () => {
    const summary = await makeAgent().generateSessionSummary('user1', undefined)
    expect(summary).toBe('Empty session.')
    expect(mockCompleteSimple).not.toHaveBeenCalled()
  })

  it('returns no summary when completeSimple throws', async () => {
    mockCompleteSimple.mockRejectedValueOnce(new Error('LLM unavailable'))
    const summary = await makeAgent().generateSessionSummary('user1', 'User: Hello\nAssistant: Hi')
    expect(summary).toBe('')
    expect(mockAppendToDailyFile).not.toHaveBeenCalled()
  })

  it('uses a single completeSimple call', async () => {
    mockCompleteSimple.mockResolvedValue(makeCompleteSimpleResponse('{"add":{"decisions":["Task started."],"open":["Something open"]}}'))
    await makeAgent().generateSessionSummary('user1', 'User: Start a task\nAssistant: Task started.')
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1)
  })
})
