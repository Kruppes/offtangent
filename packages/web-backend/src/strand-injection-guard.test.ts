/** Real AgentCore/MessageQueue/SessionManager path; only the provider runtime
 * is controlled by promises so running and waiting injection windows are deterministic. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStrandsService } from './api/modules/strands/service.js'
import { TaskStore } from '@axiom/core'
import { AgentCore } from '@axiom/core'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import type { ResponseChunk, TurnStreamChunk } from '@axiom/core'

const { gates, started } = vi.hoisted(() => ({
  /** text -> resolver that lets that prompt finish. */
  gates: new Map<string, () => void>(),
  /** Prompts that reached a runtime, in order. */
  started: [] as string[],
}))

vi.mock('../../core/src/memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
  resolveAgentMemoryDir: vi.fn(() => undefined),
}))

vi.mock('../../core/src/pi-models.js', () => ({
  completeSimple: vi.fn(async () => 'summary'),
}))

vi.mock('../../core/src/config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('../../core/src/agent-runtime.js', () => ({
  createAgentRuntime: vi.fn(() => {
    const messages: Array<{ role: string; text: string }> = []
    return {
      streamPrompt: vi.fn(async function* (raw: string): AsyncGenerator<ResponseChunk> {
        // The runtime receives the prompt with the turn's context block and
        // trailing time context; key the gates on the user text itself.
        const text = raw.trim()
        started.push(text)
        await new Promise<void>((resolve) => { gates.set(text, resolve) })
        messages.push({ role: 'assistant', text })
        yield { type: 'text', text: `reply to ${text}` }
        yield { type: 'done' }
      }),
      retryLastTurn: vi.fn(async function* (): AsyncGenerator<ResponseChunk> { yield { type: 'done' } }),
      refreshSystemPrompt: vi.fn(),
      getCurrentTimeContext: vi.fn(() => ''),
      swapProvider: vi.fn(),
      getProviderManager: vi.fn(() => undefined),
      setProviderManager: vi.fn(),
      clearMessages: vi.fn(),
      getMessages: vi.fn(() => messages),
      setMessages: vi.fn(),
      abort: vi.fn(),
      getStateSnapshot: vi.fn(() => ({ modelId: 'mock-model', toolNames: [], messageCount: messages.length })),
      getCurrentModel: vi.fn(() => ({ id: 'mock-model' })),
      getCurrentApiKey: vi.fn(() => 'mock-key'),
      getCurrentProvider: vi.fn(() => null),
      setThinkingLevel: vi.fn(),
    }
  }),
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


/** Consume a turn stream in the background, dropping the queue control chunks. */
function run(stream: AsyncIterable<TurnStreamChunk>): { done: Promise<string[]> } {
  const done = (async () => {
    const out: string[] = []
    for await (const chunk of stream) {
      if (chunk.type === 'queue_waiting' || chunk.type === 'queue_started') continue
      if (chunk.type === 'text' && chunk.text) out.push(chunk.text)
    }
    return out
  })()
  return { done }
}


describe('strand identity guard with real AgentCore task-injection queues', () => {
  let db: Database
  let agent: AgentCore

  beforeEach(() => {
    fs.mkdirSync(path.join(process.env.DATA_DIR!, 'agents', 'coder'), { recursive: true })
    gates.clear()
    started.length = 0
    db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    agent = new AgentCore({ model: makeModel(), apiKey: 'k', db, systemPrompt: 'sp' })
  })

  afterEach(() => { db.close() })

  for (const scenario of ['running', 'waiting'] as const) {
    it(`blocks identity changes while a real task injection is ${scenario}, then allows them without changing worker identity`, async () => {
      const strand = agent.getSessionManager().createThread('1', 'main', 'Injection strand')
      const service = createStrandsService({ db, getAgentCore: () => agent })
      const evict = vi.spyOn(agent, 'evictSessionTranscript')
      const store = new TaskStore(db)
      const worker = store.create({ name: 'Specialist', prompt: 'work', triggerType: 'user', agentId: 'coder', delegatedBy: 'main', sessionId: strand.id })
      store.update(worker.id, { status: 'running' })
      const originalWorker = store.getById(worker.id)
      const blocker = scenario === 'waiting'
        ? run(agent.sendMessage('1', 'blocking turn', 'web', undefined, 'main', strand.id)) : null
      if (blocker) await vi.waitFor(() => expect(gates.has('blocking turn')).toBe(true))
      const chunks: ResponseChunk[] = []
      agent.setOnTaskInjectionChunk(chunk => { chunks.push(chunk) })
      // The actual public injection entry point enqueues synchronously. No
      // mocked busy flag, private queue or injection handler is used here.
      const injection = agent.injectTaskResult('injected result', '1', strand.id, 'injection-test', 'main')
      expect(agent.getPendingMessageCount('main', strand.id)).toBe(scenario === 'waiting' ? 2 : 1)
      if (scenario === 'running') await vi.waitFor(() => expect(gates.has('injected result')).toBe(true))
      else expect(gates.has('injected result')).toBe(false)
      for (const patch of [{ agentId: 'main', workingMode: 'auto' as const }, { agentId: 'main', workingMode: 'main' as const }]) {
        // Mode changes evict too, so they need the same protection.
        if (patch.workingMode === 'auto') expect(() => service.patchStrand(1, strand.id, patch)).toThrowError(expect.objectContaining({ status: 409, code: 'strand_busy' }))
        else expect(service.patchStrand(1, strand.id, patch).agentId).toBe('main')
      }
      expect(() => service.patchStrand(1, strand.id, { agentId: 'coder' })).toThrowError(expect.objectContaining({ status: 409, code: 'strand_busy' }))
      expect(evict).not.toHaveBeenCalled()
      expect(agent.getSessionManager().getThread('1', strand.id)).toMatchObject({ agentId: 'main', workingMode: 'main' })
      if (blocker) {
        gates.get('blocking turn')!()
        await blocker.done
        await vi.waitFor(() => expect(gates.has('injected result')).toBe(true))
        expect(() => service.patchStrand(1, strand.id, { workingMode: 'auto' })).toThrowError(expect.objectContaining({ status: 409, code: 'strand_busy' }))
      }
      gates.get('injected result')!()
      await injection
      expect(agent.getPendingMessageCount('main', strand.id)).toBe(0)
      expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'reply to injected result', sessionId: strand.id, injectionId: 'injection-test' })]))
      expect(service.patchStrand(1, strand.id, { agentId: 'coder' })).toMatchObject({ agentId: 'coder', workingMode: 'main' })
      expect(evict).toHaveBeenCalledTimes(2)
      expect(service.patchStrand(1, strand.id, { agentId: 'main', workingMode: 'auto' })).toMatchObject({ agentId: 'main', workingMode: 'auto' })
      expect(store.getById(worker.id)).toEqual(originalWorker)
    })
  }

})
