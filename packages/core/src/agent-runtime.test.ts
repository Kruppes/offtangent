import { publicProviderError } from './log-safe-error.js'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAgentRuntime } from './agent-runtime.js'
import type { AgentRuntimePiAgentAccess } from './agent-runtime.js'
import { initDatabase } from './database.js'
import { setStrandEcoEnabled } from './eco-mode-store.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { assembleSystemPrompt } from './memory.js'
import { logTokenUsage, logToolCall } from './token-logger.js'
import * as providerConfig from './provider-config.js'
import { requestProbeDroppedCount, resetRequestProbeCounters } from './request-probe.js'
import { loadConfig } from './config.js'
import { closeSharedMcpManager } from './mcp-client.js'
import { invalidateKnownValues } from './secret-boundary.js'
import { subscribeProviderPhase, STREAM_ACTIVITY_SIGNAL_INTERVAL_MS } from './provider-phase.js'
import type { ProviderPhaseEvent } from './provider-phase.js'

const runtimeHarness = vi.hoisted(() => ({
  promptBehaviors: [] as Array<(agent: { emit: (event: unknown) => void; request: (context: unknown) => void }, text: string) => Promise<void>>,
  promptCalls: [] as string[],
  continueCalls: 0,
  afterToolCall: null as null | ((ctx: unknown) => Promise<unknown>),
}))

vi.mock('@earendil-works/pi-agent-core', () => {
  class MockAgent {
    public state: { systemPrompt: string; model: unknown; tools: AgentTool[]; messages: unknown[] }
    private listeners = new Set<(event: unknown) => void>()
    private streamFn: (model: unknown, context: unknown, options: unknown) => unknown

    constructor(options: { initialState: { systemPrompt: string; model: unknown; tools: AgentTool[] }; afterToolCall?: (ctx: unknown) => Promise<unknown>; streamFn: (model: unknown, context: unknown, options: unknown) => unknown }) {
      runtimeHarness.afterToolCall = options.afterToolCall ?? null
      this.streamFn = options.streamFn
      this.state = {
        ...options.initialState,
        messages: [],
      }
    }

    subscribe(listener: (event: unknown) => void): () => void {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }

    async prompt(text: string): Promise<void> {
      runtimeHarness.promptCalls.push(text)
      const behavior = runtimeHarness.promptBehaviors.shift()
      if (behavior) {
        await behavior(this, text)
      }
    }

    async continue(): Promise<void> {
      runtimeHarness.continueCalls++
      const behavior = runtimeHarness.promptBehaviors.shift()
      if (behavior) {
        await behavior(this, '<continue>')
      }
    }

    emit(event: unknown): void {
      for (const listener of this.listeners) {
        listener(event)
      }
    }

    request(context: unknown): void { void this.streamFn(this.state.model, context, {}) }

    abort(): void {}
  }

  return { Agent: MockAgent }
})

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  getMemoryDir: vi.fn(() => '/tmp/test-memory'),
  assembleSystemPrompt: vi.fn(() => 'runtime system prompt'),
}))

vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  getConfigDir: vi.fn(() => '/tmp/axiom-agent-runtime-test-config'),
  loadConfig: vi.fn(() => ({
    language: 'de',
    timezone: 'Europe/Berlin',
    builtinTools: { webSearch: { enabled: true } },
  })),
}))

vi.mock('./skill-config.js', () => ({
  loadSkills: vi.fn(() => ({
    skills: [
      { name: 'Enabled skill', description: 'desc', path: '/skills/enabled', enabled: true, contextAccess: 'global' },
      { name: 'Disabled skill', description: 'desc', path: '/skills/disabled', enabled: false },
    ],
  })),
  getSkillDecrypted: vi.fn(),
}))

vi.mock('./stt.js', () => ({
  loadSttSettings: vi.fn(() => ({ enabled: true })),
}))

vi.mock('./stt-tool.js', () => ({
  createTranscribeAudioTool: vi.fn(() => ({ name: 'transcribe_audio', execute: vi.fn() })),
}))

vi.mock('./web-tools.js', () => ({
  createBuiltinWebTools: vi.fn(() => [{ name: 'builtin_web_tool', execute: vi.fn() }]),
}))

vi.mock('./agent-skills.js', () => ({
  createAgentSkillTools: vi.fn(() => [{ name: 'agent_skill_tool', execute: vi.fn() }]),
  getAgentSkillsForPrompt: vi.fn(() => [{ name: 'recent skill', description: 'desc', location: '/skills-agent/recent' }]),
  listScopedAgentSkills: vi.fn(() => [{ name: 'recent skill', description: 'desc', location: '/skills-agent/recent' }]),
  filterAndAnnotateAgentSkills: vi.fn((entries) => entries),
  scopedAgentSkillsDir: vi.fn(() => '/skills-agent/scoped-fixture'),
  getAgentSkillsCount: vi.fn(() => 1),
  getAgentSkillsDir: vi.fn(() => '/skills-agent'),
  trackAgentSkillUsage: vi.fn(),
  currentPlatform: vi.fn(() => 'linux'),
}))

vi.mock('./memories-tool.js', () => ({
  createSearchMemoriesTool: vi.fn(() => ({ name: 'search_memories', execute: vi.fn() })),
}))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    estimateCost: vi.fn(() => 0),
    getApiKeyForProvider: vi.fn().mockResolvedValue('fallback-key'),
    buildModel: vi.fn((provider: { enabledModels?: string[] }) => ({ id: provider.enabledModels?.[0] })),
  }
})

vi.mock('./token-logger.js', () => ({
  logTokenUsage: vi.fn(),
  logToolCall: vi.fn(),
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

describe('AgentRuntime boundary', () => {
  beforeEach(() => {
    runtimeHarness.promptBehaviors = []
    runtimeHarness.promptCalls = []
    runtimeHarness.continueCalls = 0
    vi.mocked(assembleSystemPrompt).mockClear()
    vi.mocked(logToolCall).mockClear()
  })

  it('joins usage through the real runtime gate across turns, tool loop and an aborted request', async () => {
    resetRequestProbeCounters()
    const stream = vi.spyOn(providerConfig, 'buildStreamFn').mockReturnValue((() => ({ })) as never)
    try {
      const db = initDatabase(':memory:')
      db.prepare("INSERT INTO sessions (id, source, type) VALUES ('probe-integration', 'web', 'interactive')").run()
      const actualLogger = await vi.importActual<typeof import('./token-logger.js')>('./token-logger.js')
      vi.mocked(logTokenUsage).mockImplementation(actualLogger.logTokenUsage)
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db, tools: [] })
      const makeContext = (n: number) => ({ systemPrompt: 'runtime system prompt', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: `turn ${n}` }], timestamp: n }] })
      const finish = (agent: { emit: (event: unknown) => void }, n: number) => agent.emit({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider: 'openai', model: 'gpt-4o',
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 50, cost: { total: 0.1 } }, stopReason: 'stop',
      }, n })
      runtimeHarness.promptBehaviors.push(async agent => {
        agent.request(makeContext(1)); finish(agent, 1)
        await new Promise(resolve => setTimeout(resolve, 0))
        agent.request(makeContext(2)); finish(agent, 2)
        agent.emit({ type: 'agent_end', messages: [] })
      })
      for await (const _ of runtime.streamPrompt('first', 'probe-integration')) { /* drain */ }
      runtimeHarness.promptBehaviors.push(async agent => {
        agent.request(makeContext(3)) // no message_end: aborted stream has no usage row
        agent.request(makeContext(4)); finish(agent, 4)
        agent.emit({ type: 'agent_end', messages: [] })
      })
      for await (const _ of runtime.streamPrompt('second', 'probe-integration')) { /* drain */ }
      const rows = db.prepare('SELECT p.usage_id, p.session_id, p.turn_seq, u.session_id AS usage_session FROM request_probe p JOIN token_usage u ON u.id=p.usage_id ORDER BY p.id')
        .all() as Array<{ usage_id: number; session_id: string; usage_session: string; turn_seq: number }>
      expect(rows).toHaveLength(3)
      expect(rows.map(r => r.turn_seq)).toEqual([0, 1, 1])
      expect(rows.every(r => r.usage_id > 0 && r.session_id === 'probe-integration' && r.usage_session === r.session_id)).toBe(true)
      expect(requestProbeDroppedCount()).toBe(1)
    } finally { stream.mockRestore(); vi.mocked(logTokenUsage).mockReset() }
  })

  it('wires tools behind a single runtime boundary', () => {
    const db = initDatabase(':memory:')
    const customTool = { name: 'custom_tool', execute: vi.fn() } as unknown as AgentTool

    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [customTool],
    })

    const toolNames = runtime.getStateSnapshot().toolNames
    expect(toolNames).toEqual(expect.arrayContaining([
      'custom_tool',
      'search_memories',
      'builtin_web_tool',
      'transcribe_audio',
      'agent_skill_tool',
      'shell',
      'read_file',
      'write_file',
      'edit_file',
      'list_files',
    ]))
  })

  it('assembles system prompt via runtime boundary with config + skills context', () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
      memoryDir: '/tmp/memory',
      baseInstructions: 'base rules',
    })

    runtime.refreshSystemPrompt('telegram', { username: 'alice' })

    const promptCalls = vi.mocked(assembleSystemPrompt).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall).toBeDefined()
    expect(latestCall?.language).toBe('de')
    expect(latestCall?.timezone).toBe('Europe/Berlin')
    expect(latestCall?.channel).toBe('telegram')
    expect(latestCall?.currentUser).toEqual({ username: 'alice' })
    expect(latestCall?.builtinTools).toEqual({ webSearch: { enabled: true }, stt: { enabled: true } })
    expect(latestCall?.skills).toEqual(expect.arrayContaining([
      { name: 'Enabled skill', description: 'desc', location: '/skills/enabled' },
      { name: 'recent skill', description: 'desc', location: '/skills-agent/recent' },
    ]))
    // No promptProfile configured → historical full-prompt defaults.
    expect(latestCall?.recentDays).toBe(3)
    expect(latestCall?.includeWikiPages).toBe(true)
    expect(latestCall?.includeAxiomDocs).toBe(true)
    // No instanceIdentity in settings.json → nothing passed, block stays off.
    expect(latestCall?.instanceIdentity).toBeUndefined()
  })

  it('passes instanceIdentity from settings.json into system prompt assembly', () => {
    const mockedLoadConfig = vi.mocked(loadConfig)
    const previous = mockedLoadConfig.getMockImplementation()
    mockedLoadConfig.mockImplementation(() => ({
      language: 'de',
      timezone: 'Europe/Berlin',
      instanceIdentity: { name: 'Offtangent', notes: 'host-a' },
    }))

    try {
      const db = initDatabase(':memory:')
      const runtime = createAgentRuntime({
        model: makeModel(),
        apiKey: 'sk-primary',
        db,
        tools: [],
      })

      runtime.refreshSystemPrompt()

      const latestCall = vi.mocked(assembleSystemPrompt).mock.calls.at(-1)?.[0]
      expect(latestCall?.instanceIdentity).toEqual({ name: 'Offtangent', notes: 'host-a' })
    } finally {
      mockedLoadConfig.mockImplementation(previous!)
    }
  })

  it('applies the provider promptProfile "slim" to system prompt assembly', () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
      providerConfig: {
        id: 'local-1',
        name: 'Local Ollama',
        type: 'openai-completions',
        providerType: 'ollama',
        provider: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        enabledModels: ['llama3'],
        promptProfile: 'slim',
      },
    })

    runtime.refreshSystemPrompt()

    const latestCall = vi.mocked(assembleSystemPrompt).mock.calls.at(-1)?.[0]
    expect(latestCall).toBeDefined()
    expect(latestCall?.recentDays).toBe(1)
    expect(latestCall?.includeWikiPages).toBe(false)
    expect(latestCall?.includeAxiomDocs).toBe(false)
  })

  it('orchestrates prompt execution events into runtime response chunks', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      })
      agent.emit({
        type: 'tool_execution_start',
        toolName: 'search_memories',
        toolCallId: 'tool-1',
        args: { query: 'test' },
      })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'search_memories',
        toolCallId: 'tool-1',
        isError: false,
        result: { matches: [] },
      })
      agent.emit({
        type: 'agent_end',
        messages: [],
      })
    })

    const chunks = [] as Array<{ type: string }>
    for await (const chunk of runtime.streamPrompt('hello', 'session-1')) {
      chunks.push({ type: chunk.type })
    }

    expect(chunks.map(c => c.type)).toEqual(['text', 'tool_call_start', 'tool_call_end', 'done'])
    expect(logToolCall).toHaveBeenCalledTimes(1)
  })

  // Built-in tools can report failures via
  // `details.error: true` while pi-agent-core leaves `isError` false.
  it('classifies tool results with details.error as failures in chunks and the tool_calls log', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db, tools: [] })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({ type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tool-err', args: { path: 'missing.txt' } })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'read_file',
        toolCallId: 'tool-err',
        isError: false,
        result: { content: [{ type: 'text', text: 'Error reading file: ENOENT' }], details: { error: true } },
      })
      agent.emit({ type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tool-ok', args: { path: 'a.txt' } })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'read_file',
        toolCallId: 'tool-ok',
        isError: false,
        result: { content: [{ type: 'text', text: 'hello' }], details: {} },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const errorFlags: Array<boolean | undefined> = []
    for await (const chunk of runtime.streamPrompt('read', 'session-1')) {
      if (chunk.type === 'tool_call_end') errorFlags.push(chunk.toolIsError)
    }

    expect(errorFlags).toEqual([true, false])
    const statuses = vi.mocked(logToolCall).mock.calls.slice(-2).map(call => call[1].status)
    expect(statuses).toEqual(['error', 'success'])
    db.close()
  })

  it('forwards thinking_delta events as thinking response chunks', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Hmm,' },
      })
      agent.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: ' weighing options.' },
      })
      agent.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Done.' },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const chunks = [] as Array<{ type: string; text?: string; thinking?: string }>
    for await (const chunk of runtime.streamPrompt('hello', 'session-1')) {
      chunks.push({ type: chunk.type, text: chunk.text, thinking: chunk.thinking })
    }

    expect(chunks.map(c => c.type)).toEqual(['thinking', 'thinking', 'text', 'done'])
    expect(chunks[0]!.thinking).toBe('Hmm,')
    expect(chunks[1]!.thinking).toBe(' weighing options.')
    expect(chunks[2]!.text).toBe('Done.')
  })

  it('freezes a long details.error result as an error in chat metadata, projection, tool log and event', async () => {
    const db = initDatabase(':memory:')
    db.prepare("INSERT INTO users(id, username, password_hash) VALUES (1, 'fixture', 'x')").run()
    db.prepare("INSERT INTO sessions(id, user_id, agent_id) VALUES ('eco-chat', 1, 'main')").run()
    setStrandEcoEnabled(db, 'eco-chat', true)
    const realLogger = await vi.importActual<typeof import('./token-logger.js')>('./token-logger.js')
    vi.mocked(logToolCall).mockImplementationOnce((database, record) => realLogger.logToolCall(database, record))
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'k', db, tools: [] })
    const result = { content: [{ type: 'text', text: `FAIL test\n${'  passed test\n'.repeat(700)}` }], details: { error: true } }
    runtimeHarness.promptBehaviors.push(async (agent) => {
      const toolCall = { id: 'chat-eco-call', name: 'shell' }
      agent.emit({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: toolCall.name, args: { command: 'npm test' } })
      const frozen = await runtimeHarness.afterToolCall!({ toolCall, args: { command: 'npm test' }, result, isError: false }) as { content: typeof result.content; details: unknown }
      expect(frozen).toBeDefined()
      agent.emit({ type: 'tool_execution_end', toolCallId: toolCall.id, toolName: toolCall.name, result: frozen, isError: false })
      agent.emit({ type: 'agent_end', messages: [] })
    })
    const chunks = [] as Array<{ type: string; toolIsError?: boolean }>
    for await (const chunk of runtime.streamPrompt('test', 'eco-chat')) chunks.push(chunk)
    expect(chunks.find(c => c.type === 'tool_call_end')?.toolIsError).toBe(true)
    const row = db.prepare("SELECT metadata FROM chat_messages WHERE session_id = 'eco-chat' AND eco_original IS NOT NULL").get() as { metadata: string }
    expect(JSON.parse(row.metadata).toolIsError).toBe(true)
    expect(JSON.parse(row.metadata).toolResult.content[0].text).toContain('Status: error')
    const statuses = db.prepare("SELECT status FROM tool_calls WHERE session_id = 'eco-chat'").all() as Array<{ status: string }>
    expect(statuses.map(r => r.status)).toContain('error')
    db.close()
  })

  it('surfaces a provider error message as an error chunk instead of ending silently', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    // pi-agent-core reports auth failures (expired key, failed OAuth refresh)
    // as an assistant message with `stopReason: 'error'` — it never throws.
    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          provider: 'openai',
          model: 'gpt-4o',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          stopReason: 'error',
          errorMessage: '401 Unauthorized: token refresh failed',
        },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const chunks = [] as Array<{ type: string; error?: string }>
    for await (const chunk of runtime.streamPrompt('hello', 'session-1')) {
      chunks.push({ type: chunk.type, error: chunk.error })
    }

    expect(chunks.map(c => c.type)).toEqual(['error', 'done'])
    // Review K0-K2-4 #2: the chunk carries the public form (fixed text + class).
    expect(chunks[0]!.error).toBe(publicProviderError('401 Unauthorized: token refresh failed'))
    expect(chunks[0]!.error).toBe('The model provider reported an error (auth).')
  })

  it('does not report a user abort as an error', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          provider: 'openai',
          model: 'gpt-4o',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          stopReason: 'aborted',
        },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const chunks = [] as Array<{ type: string }>
    for await (const chunk of runtime.streamPrompt('hello', 'session-1')) {
      chunks.push({ type: chunk.type })
    }

    expect(chunks.map(c => c.type)).toEqual(['done'])
  })

  it('retries the failed turn by continuing the transcript instead of re-sending the user message', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()
    piAgent.state.messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429' },
    ] as never

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Second try.' } })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const chunks = [] as Array<{ type: string; text?: string }>
    for await (const chunk of runtime.retryLastTurn('hello', 'session-1')) {
      chunks.push({ type: chunk.type, text: chunk.text })
    }

    expect(chunks.map(c => c.type)).toEqual(['text', 'done'])
    expect(runtimeHarness.continueCalls).toBe(1)
    expect(runtimeHarness.promptCalls).toEqual([])
    // The failed assistant message is gone; the user message is not duplicated.
    // Retry must re-resolve scope and refresh the system message too.
    expect((piAgent.state.messages as Array<{ role: string }>).map(m => m.role)).toEqual(['system', 'user'])
  })

  it('falls back to a fresh prompt when the transcript has nothing to continue from', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({ type: 'agent_end', messages: [] })
    })

    for await (const _chunk of runtime.retryLastTurn('hello', 'session-1')) { /* drain */ }

    expect(runtimeHarness.continueCalls).toBe(0)
    expect(runtimeHarness.promptCalls).toEqual(['hello'])
  })

  // Incident 2026-09-15: one strand's stall watchdog aborted the agent
  // process-wide and killed the live run of a different strand.
  it('routes a scoped abort only to the session the runtime is actually running', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })
    const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()
    const abortSpy = vi.spyOn(piAgent, 'abort')

    // Nothing running: a scoped abort must not touch the runtime.
    runtime.abort({ sessionId: 'session-a' })
    expect(abortSpy).not.toHaveBeenCalled()

    let releasePrompt: (() => void) | null = null
    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working' } })
      await new Promise<void>((resolve) => { releasePrompt = resolve })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const stream = runtime.streamPrompt('hello', 'session-a')[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.value?.type).toBe('text')

    // Foreign strand's watchdog — must be ignored.
    runtime.abort({ sessionId: 'session-b' })
    expect(abortSpy).not.toHaveBeenCalled()

    // Own session — must land.
    runtime.abort({ sessionId: 'session-a' })
    expect(abortSpy).toHaveBeenCalledTimes(1)

    // No scope at all keeps the historical blanket behaviour.
    runtime.abort()
    expect(abortSpy).toHaveBeenCalledTimes(2)

    releasePrompt!()
    while (!(await stream.next()).done) { /* drain */ }

    // Run is over: scoped aborts no longer reach it.
    runtime.abort({ sessionId: 'session-a' })
    expect(abortSpy).toHaveBeenCalledTimes(2)
  })
})

// Codemode wiring in the interactive runtime (plan 2026-10-08-codemode).
// Synthetic settings only; the tool itself is covered in codemode-tool*.test.ts.
describe('AgentRuntime codemode wiring', () => {
  const baseConfig = { language: 'de', timezone: 'Europe/Berlin', builtinTools: { webSearch: { enabled: true } } }

  function withConfig<T>(codemode: unknown, fn: () => T | Promise<T>): Promise<T> {
    const mockedLoadConfig = vi.mocked(loadConfig)
    const previous = mockedLoadConfig.getMockImplementation()
    mockedLoadConfig.mockImplementation(() => ({ ...baseConfig, ...(codemode === undefined ? {} : { codemode }) }))
    return Promise.resolve(fn()).finally(() => mockedLoadConfig.mockImplementation(previous!))
  }

  beforeEach(() => {
    runtimeHarness.promptBehaviors = []
    runtimeHarness.promptCalls = []
  })

  it('registers no codemode tool by default (mode off)', async () => {
    await withConfig(undefined, () => {
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'k', db: initDatabase(':memory:'), tools: [] })
      expect(runtime.getStateSnapshot().toolNames).not.toContain('codemode')
    })
  })

  it('registers codemode for an allowlisted model and not for another one', async () => {
    await withConfig({ mode: 'coding' }, () => {
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'k', db: initDatabase(':memory:'), tools: [] })
      expect(runtime.getStateSnapshot().toolNames).toContain('codemode')
    })
    await withConfig({ mode: 'coding', models: ['claude-'] }, () => {
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'k', db: initDatabase(':memory:'), tools: [] })
      expect(runtime.getStateSnapshot().toolNames).not.toContain('codemode')
    })
  })

  it('re-reads the setting per turn and drops the tool on a swap to a non-allowlisted model', async () => {
    const runtime = await withConfig(undefined, () =>
      createAgentRuntime({ model: makeModel(), apiKey: 'k', db: initDatabase(':memory:'), tools: [] }))
    expect(runtime.getStateSnapshot().toolNames).not.toContain('codemode')

    await withConfig({ mode: 'readonly', models: ['gpt-'] }, async () => {
      runtimeHarness.promptBehaviors.push(async (agent) => { agent.emit({ type: 'agent_end', messages: [] }) })
      for await (const _chunk of runtime.streamPrompt('hello', 'session-cm')) { /* drain */ }
      expect(runtime.getStateSnapshot().toolNames).toContain('codemode')

      runtime.swapProvider({ enabledModels: ['local-model'] } as never, 'k2')
      expect(runtime.getStateSnapshot().modelId).toBe('local-model')
      expect(runtime.getStateSnapshot().toolNames).not.toContain('codemode')
    })
  })

  it('never Eco-freezes a call a codemode script issued', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'k', db, tools: [] })
    const internals = runtime as unknown as { currentSessionId: string | null; freezeEcoToolResult: (ctx: unknown) => Promise<unknown> }
    internals.currentSessionId = 'session-eco'
    const prepare = vi.spyOn(db, 'prepare')
    const ctx = (id: string) => ({ toolCall: { id, name: 'read_file' }, result: { content: [{ type: 'text', text: 'x' }] } })

    // Nested id: returns before even looking up the strand's Eco mode.
    expect(await internals.freezeEcoToolResult(ctx('toolu_parent/cm-1'))).toBeUndefined()
    expect(prepare).not.toHaveBeenCalled()
    // A model-issued id takes the normal Eco path (reads the strand mode).
    await internals.freezeEcoToolResult(ctx('toolu_parent'))
    expect(prepare).toHaveBeenCalled()
  })
})

/**
 * Runtime -> watchdog wiring of `stream_activity` (plan
 * 2026-10-09-provider-silence). Synthetic events only: a model streaming a
 * long tool call produces `message_update` events that map to no chunk; the
 * runtime must still tell the session's stall watchdog that the stream is
 * alive, throttled, and must stay quiet for chunk-producing output.
 */
describe('AgentRuntime stream_activity signal', () => {
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

  beforeEach(() => {
    runtimeHarness.promptBehaviors = []
    runtimeHarness.promptCalls = []
    runtimeHarness.continueCalls = 0
    // Only Date is faked: setTimeout stays real so the runtime loop drains.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function run(sessionId: string, behavior: (agent: { emit: (event: unknown) => void }) => Promise<void>) {
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-synthetic', db: initDatabase(':memory:'), tools: [] })
    const own: ProviderPhaseEvent[] = []
    const other: ProviderPhaseEvent[] = []
    const offOwn = subscribeProviderPhase(sessionId, e => own.push(e))
    const offOther = subscribeProviderPhase('unrelated-session', e => other.push(e))
    runtimeHarness.promptBehaviors.push(behavior)
    const chunks: string[] = []
    try {
      for await (const chunk of runtime.streamPrompt('synthetic prompt', sessionId)) chunks.push(chunk.type)
    } finally {
      offOwn()
      offOther()
    }
    return { own, other, chunks }
  }

  const toolcallDelta = (delta: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta } })

  it('signals stream_activity for tool-call streaming that yields no chunk, throttled per session', async () => {
    const { own, other, chunks } = await run('session-sa', async (agent) => {
      agent.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } })
      for (let i = 0; i < 5; i++) agent.emit(toolcallDelta(`{"x":${i}`))
      await tick()
      // Still inside the throttle window: no second signal.
      vi.setSystemTime(Date.now() + STREAM_ACTIVITY_SIGNAL_INTERVAL_MS - 1)
      agent.emit(toolcallDelta('more'))
      await tick()
      // Past the window: the next chunk-less update signals again.
      vi.setSystemTime(Date.now() + 2)
      agent.emit(toolcallDelta('more'))
      agent.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end' } })
      await tick()
      agent.emit({ type: 'agent_end', messages: [] })
    })

    expect(own.filter(e => e.phase === 'stream_activity')).toHaveLength(2)
    expect(other).toHaveLength(0)
    expect(chunks).toEqual(['done'])
  })

  it('does not signal stream_activity for chunk-producing or non-message events', async () => {
    const { own, chunks } = await run('session-sb', async (agent) => {
      agent.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } })
      agent.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })
      agent.emit({ type: 'tool_execution_start', toolName: 'search_memories', toolCallId: 't-1', args: { query: 'q' } })
      agent.emit({ type: 'tool_execution_end', toolName: 'search_memories', toolCallId: 't-1', isError: false, result: { matches: [] } })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    expect(own.filter(e => e.phase === 'stream_activity')).toHaveLength(0)
    expect(chunks).toEqual(['thinking', 'text', 'tool_call_start', 'tool_call_end', 'done'])
  })
})


describe('persisted strand working mode in the actual runtime prompt', () => {
  it('shares Main base instructions, changes only the mode policy and keeps specialist/task runtimes direct', () => {
    const db = initDatabase(':memory:')
    db.prepare("INSERT INTO sessions (id, session_user, source, type, agent_id, working_mode) VALUES ('mode-strand', '1', 'web', 'interactive', 'main', 'main')").run()
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'test', db, tools: [], memoryDir: '/workspace/test-memory', baseInstructions: 'shared base' })
    const agent = (runtime as typeof runtime & AgentRuntimePiAgentAccess).getAgent()
    // Match native pi-agent-core >= 0.87: systemPrompt is derived from transcript.
    Object.defineProperty(agent.state, 'systemPrompt', { configurable: true, get: () => (agent.state.messages[0] as unknown as { content?: string })?.content ?? '' })
    runtime.refreshSystemPrompt('web', undefined, 'main', 'mode-strand')
    const mainPrompt = String((agent.state.messages[0] as unknown as { content: string }).content)
    expect(mainPrompt).toContain('Main is inline-first')
    expect(mainPrompt).not.toContain('Auto is delegation-first')
    db.prepare("UPDATE sessions SET working_mode = 'auto' WHERE id = 'mode-strand'").run()
    runtime.refreshSystemPrompt('web', undefined, 'main', 'mode-strand')
    const autoPrompt = String((agent.state.messages[0] as unknown as { content: string }).content)
    expect(autoPrompt).toContain('Auto is delegation-first')
    expect(autoPrompt).toContain('checking delegated results')
    expect(autoPrompt).not.toContain('Main is inline-first')
    expect(mainPrompt.split('<strand_working_mode')[0]).toBe(autoPrompt.split('<strand_working_mode')[0])
    runtime.refreshSystemPrompt('web', undefined, 'coder', 'mode-strand')
    expect(String((agent.state.messages[0] as unknown as { content: string }).content)).not.toContain('<strand_working_mode')
    runtime.refreshSystemPrompt()
    expect(String((agent.state.messages[0] as unknown as { content: string }).content)).not.toContain('<strand_working_mode')
    db.close()
  })
})

// MCP wiring in the interactive runtime (plan MCP support). Synthetic stdio
// server from src/__fixtures__; the client itself is covered in mcp-client.test.ts.
describe('AgentRuntime MCP wiring', () => {
  const baseConfig = { language: 'de', timezone: 'Europe/Berlin', builtinTools: { webSearch: { enabled: true } } }
  const fixture = new URL('./__fixtures__/mcp-test-server.mjs', import.meta.url).pathname

  function withConfig<T>(mcp: unknown, fn: () => T | Promise<T>): Promise<T> {
    const mockedLoadConfig = vi.mocked(loadConfig)
    const previous = mockedLoadConfig.getMockImplementation()
    mockedLoadConfig.mockImplementation(() => ({ ...baseConfig, ...(mcp === undefined ? {} : { mcp }) }))
    return Promise.resolve(fn()).finally(() => mockedLoadConfig.mockImplementation(previous!))
  }

  async function runTurn(runtime: ReturnType<typeof createAgentRuntime>, sessionId: string) {
    runtimeHarness.promptBehaviors.push(async (agent) => { agent.emit({ type: 'agent_end', messages: [] }) })
    for await (const _chunk of runtime.streamPrompt('hello', sessionId)) { /* drain */ }
  }

  beforeEach(() => {
    runtimeHarness.promptBehaviors = []
    runtimeHarness.promptCalls = []
  })
  afterEach(async () => {
    await closeSharedMcpManager()
  })

  it('adds no MCP tools when the mcp block is missing', async () => {
    await withConfig(undefined, async () => {
      const runtime = createAgentRuntime(opts())
      await runTurn(runtime, 'session-mcp-off')
      expect(runtime.getStateSnapshot().toolNames.some(n => n.startsWith('mcp_'))).toBe(false)
    })
  })

  const opts = (agentId = 'main', userId: number | null = 1) => ({ model: makeModel(), apiKey: 'k', db: initDatabase(':memory:'), tools: [], agentId, getCurrentToolUserId: () => userId ?? undefined })
  const server = (extra: Record<string, unknown> = {}) => ({ transport: 'stdio', command: process.execPath, args: [fixture, 'stdio'], personas: ['main'], users: ['1'], dataClass: 'cloud_ok', ...extra })

  it('adds the discovered tools at turn start only for an allowed persona and user', async () => {
    await withConfig({ enabled: true, servers: { test: server() } }, async () => {
      const main = createAgentRuntime(opts())
      expect(main.getStateSnapshot().toolNames).not.toContain('mcp_test_echo')
      await runTurn(main, 'session-mcp-main')
      expect(main.getStateSnapshot().toolNames).toContain('mcp_test_echo')

      const other = createAgentRuntime(opts('bob'))
      await runTurn(other, 'session-mcp-bob')
      expect(other.getStateSnapshot().toolNames.some(n => n.startsWith('mcp_'))).toBe(false)

      // Review P1-2: an unlisted or unauthenticated user gets nothing.
      for (const userId of [2, null]) {
        const stranger = createAgentRuntime(opts('main', userId))
        await runTurn(stranger, `session-mcp-user-${userId}`)
        expect(stranger.getStateSnapshot().toolNames.some(n => n.startsWith('mcp_'))).toBe(false)
      }
    })
    // Config removed: the next turn drops the tools again.
    await withConfig(undefined, async () => {
      const runtime = createAgentRuntime(opts())
      await runTurn(runtime, 'session-mcp-removed')
      expect(runtime.getStateSnapshot().toolNames.some(n => n.startsWith('mcp_'))).toBe(false)
    })
  }, 30_000)

  it('offers a local_only (default) server to no cloud model (review P1-3)', async () => {
    const { dataClass: _drop, ...localOnly } = server()
    await withConfig({ enabled: true, servers: { test: localOnly } }, async () => {
      const runtime = createAgentRuntime(opts())
      await runTurn(runtime, 'session-mcp-local-only')
      expect(runtime.getStateSnapshot().toolNames.some(n => n.startsWith('mcp_'))).toBe(false)
    })
  }, 30_000)

  it('never sends a known secret from remote tool metadata to the model (review P1-1)', async () => {
    const secret = 'dummy-runtime-probe-value-one'
    process.env.MCP_RUNTIME_PROBE_API_KEY = secret
    invalidateKnownValues()
    try {
      await withConfig({ enabled: true, servers: { test: server({ env: { MCP_TEST_DESCRIPTION_SUFFIX: ` ${secret}` } }) } }, async () => {
        const runtime = createAgentRuntime(opts())
        await runTurn(runtime, 'session-mcp-secret-meta')
        const names = runtime.getStateSnapshot().toolNames
        expect(names).not.toContain('mcp_test_echo')
        expect(names).toContain('mcp_test_env_probe')
        const sent = JSON.stringify(runtimeHarness.promptCalls) + JSON.stringify(names)
        expect(sent).not.toContain(secret)
      })
    } finally {
      delete process.env.MCP_RUNTIME_PROBE_API_KEY
      invalidateKnownValues()
    }
  }, 30_000)
})
