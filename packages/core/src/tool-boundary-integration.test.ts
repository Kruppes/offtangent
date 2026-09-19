import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'

// Mirror agent-swap.test.ts mocking to avoid filesystem/provider access.
vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
}))

vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

function makeModel() {
  return {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude',
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: false,
    input: ['text' as const, 'image' as const],
    cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  }
}

// --- Orphan history builders (shaped like pi-ai messages) ---

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } as unknown as AgentMessage
}
function assistantWithCall(id: string, stopReason = 'toolUse'): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'x' }, { type: 'toolCall', id, name: 'shell', arguments: {} }],
    api: 'anthropic', provider: 'anthropic', model: 'claude',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 1,
  } as unknown as AgentMessage
}
function toolResult(id: string): AgentMessage {
  return { role: 'toolResult', toolCallId: id, toolName: 'shell', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 1 } as unknown as AgentMessage
}

/**
 * Reach the transformContext net the runtime installs on the underlying
 * PiAgent. This is the exact function pi-ai calls in streamAssistantResponse,
 * right before converting the history to provider messages.
 */
function getTransformContext(agentCore: AgentCore): (m: AgentMessage[]) => Promise<AgentMessage[]> {
  const agent = agentCore.getAgent('main') as unknown as {
    transformContext?: (m: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
  }
  expect(typeof agent.transformContext).toBe('function')
  return (m: AgentMessage[]) => agent.transformContext!(m)
}

describe('tool_use/tool_result boundary invariant — runtime integration', () => {
  let db: Database
  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  it('the runtime installs a transformContext net on the underlying agent', () => {
    const agentCore = new AgentCore({ model: makeModel(), apiKey: 'sk', db, tools: [] })
    const agent = agentCore.getAgent('main') as unknown as { transformContext?: unknown }
    expect(typeof agent.transformContext).toBe('function')
  })

  it('strips a leading orphan tool_result before the request is built (the messages[0] incident)', async () => {
    const agentCore = new AgentCore({ model: makeModel(), apiKey: 'sk', db, tools: [] })
    const transform = getTransformContext(agentCore)

    // Exactly the shape pi-ai would reject: a tool_result at index 0 whose
    // originating assistant (stopReason error/aborted) was dropped upstream.
    const orphaned: AgentMessage[] = [
      toolResult('toolu_orphan'),
      assistantWithCall('toolu_ok'),
      toolResult('toolu_ok'),
      user('carry on'),
    ]

    const sent = await transform(orphaned)
    // The leading orphan is gone; the valid pair survives intact.
    expect((sent[0] as { role: string }).role).not.toBe('toolResult')
    expect(sent.some(m => (m as { role: string; toolCallId?: string }).toolCallId === 'toolu_orphan')).toBe(false)
    expect(sent.some(m => (m as { role: string; toolCallId?: string }).toolCallId === 'toolu_ok')).toBe(true)
  })

  it('leaves a valid history untouched through the net (no false positives)', async () => {
    const agentCore = new AgentCore({ model: makeModel(), apiKey: 'sk', db, tools: [] })
    const transform = getTransformContext(agentCore)
    const valid: AgentMessage[] = [
      user('run a tool'),
      assistantWithCall('toolu_1'),
      toolResult('toolu_1'),
    ]
    const sent = await transform(valid)
    expect(sent).toEqual(valid)
  })

  it('post-turn: clearMessages repairs nothing on empty and keeps snapshot count sane', () => {
    // Sanity: injecting an orphan into state.messages and running the runtime's
    // own snapshot path reflects the raw count; the transformContext net (not
    // the snapshot) is what protects the wire. This guards the wiring contract.
    const agentCore = new AgentCore({ model: makeModel(), apiKey: 'sk', db, tools: [] })
    const agent = agentCore.getAgent('main')
    agent.state.messages = [toolResult('toolu_orphan'), user('hi')]
    expect(agentCore.getRuntimeStateSnapshot('main').messageCount).toBe(2)
  })
})
