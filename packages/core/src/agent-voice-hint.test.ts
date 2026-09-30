/**
 * The automatic voice reply tells the agent — per turn, in the USER text —
 * that the server already speaks this answer, so the agent must not attach a
 * second audio file. This covers BOTH turn paths that produce an assistant
 * answer for a user: the interactive turn and the task-injection turn.
 *
 * The hint must never reach the system prompt (cached prefix), and it must be
 * absent for a user who did not switch voice replies on.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { setVoiceRepliesEnabled } from './user-settings.js'
import { VOICE_REPLY_TURN_HINT } from './voice-note.js'

const { streamPromptMock } = vi.hoisted(() => ({ streamPromptMock: vi.fn() }))

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
}))

vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('./agent-runtime.js', () => ({
  createAgentRuntime: vi.fn(() => ({
    streamPrompt: streamPromptMock,
    retryLastTurn: streamPromptMock,
    refreshSystemPrompt: vi.fn(),
    getCurrentTimeContext: vi.fn(() => '<current_time>Current time: 12:00 (UTC)</current_time>'),
    swapProvider: vi.fn(),
    getProviderManager: vi.fn(() => undefined),
    clearMessages: vi.fn(),
    abort: vi.fn(),
    getStateSnapshot: vi.fn(() => ({ modelId: 'mock-model', toolNames: [], messageCount: 0 })),
    getCurrentModel: vi.fn(() => ({ id: 'mock-model' })),
    getCurrentApiKey: vi.fn(() => 'mock-key'),
    setThinkingLevel: vi.fn(),
  })),
  createYoloTools: vi.fn(() => []),
  isRetryablePreStreamError: vi.fn(() => false),
}))

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

let db: Database
let agent: AgentCore

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'admin')
  streamPromptMock.mockReset()
  streamPromptMock.mockImplementation(async function* () {
    yield { type: 'text', text: 'answer' }
    yield { type: 'done' }
  })
  agent = new AgentCore({ model: makeModel(), apiKey: 'sk-test', db, tools: [] })
})

afterEach(async () => {
  await agent.dispose()
  db.close()
})

/** The prompt text the runtime was handed for call `index`. */
function promptOf(index = 0): string {
  return streamPromptMock.mock.calls[index]![0] as string
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* consume */ }
}

describe('voice reply turn hint', () => {
  it('is absent while the switch is off (interactive and task injection)', async () => {
    await drain(agent.sendMessage('1', 'Wie wird das Wetter?'))
    await agent.injectTaskResult('<task_injection>fertig</task_injection>', '1', '11111111-2222-3333-4444-555555555555')

    expect(streamPromptMock).toHaveBeenCalledTimes(2)
    expect(promptOf(0)).not.toContain('<voice_reply>')
    expect(promptOf(1)).not.toContain('<voice_reply>')
  })

  it('rides along in the user text of an interactive turn when the switch is on', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    await drain(agent.sendMessage('1', 'Wie wird das Wetter?'))

    const prompt = promptOf(0)
    expect(prompt).toContain(VOICE_REPLY_TURN_HINT)
    expect(prompt).toContain('Wie wird das Wetter?')
    // The user's own text stays first, the hint is appended after it.
    expect(prompt.indexOf('Wie wird das Wetter?')).toBeLessThan(prompt.indexOf('<voice_reply>'))
  })

  it('rides along in a task-injection turn too', async () => {
    setVoiceRepliesEnabled(db, 1, true)
    await agent.injectTaskResult('<task_injection>fertig</task_injection>', '1', '11111111-2222-3333-4444-555555555555')

    const prompt = promptOf(0)
    expect(prompt).toContain('<task_injection>fertig</task_injection>')
    expect(prompt).toContain(VOICE_REPLY_TURN_HINT)
  })

  it('stays out of another user\'s turn', async () => {
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'bob', 'x', 'user')
    setVoiceRepliesEnabled(db, 1, true)
    await drain(agent.sendMessage('2', 'Und bei mir?'))

    expect(promptOf(0)).not.toContain('<voice_reply>')
  })
})
