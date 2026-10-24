import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import type { ProviderConfig } from './provider-config.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai'
import { invalidateKnownValues } from './secret-boundary.js'
import { invalidateSecretHandleCache, sealSecret } from './secret-store.js'
import { formatContinuationContext } from './task-handoff.js'
import { ABORT_HANDOFF_WRAPUP_NOTE, hasTokenLikeRun } from './task-budget.js'
import { formatTaskInjection } from './task-runner.js'

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

/**
 * Script the fake agent runs through. Each entry is one tool round trip; the
 * agent finally reports "completed" — which is exactly the dangerous case:
 * a guarded task must NOT end up completed just because the model said so
 * after the abort.
 */
const script: {
  /** `result` overrides the tool result text (default `ok`). */
  calls: Array<{ toolName: string; args: unknown; result?: string; after?: () => void }>
  /** When set, prompt() throws this message after the scripted calls. */
  throwError?: string | null
  aborted: boolean
  steered: string[]
  /** Optional per-prompt rounds (pause/resume): consumed one per prompt() call. */
  rounds: Array<{ calls: Array<{ toolName: string; args: unknown }>; final: string }>
} = {
  calls: [],
  aborted: false,
  steered: [],
  rounds: [],
}

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation(() => {
    let subscribeFn: ((event: unknown) => void) | null = null
    const messages: unknown[] = []
    return {
      subscribe: vi.fn((fn: (event: unknown) => void) => {
        subscribeFn = fn
        return () => { subscribeFn = null }
      }),
      prompt: vi.fn(async () => {
        const round = script.rounds.shift()
        const calls = round ? round.calls : script.calls
        let i = messages.length
        for (const call of calls) {
          i++
          subscribeFn?.({ type: 'tool_execution_start', toolCallId: `tc-${i}`, toolName: call.toolName, args: call.args })
          subscribeFn?.({
            type: 'tool_execution_end',
            toolCallId: `tc-${i}`,
            toolName: call.toolName,
            result: { content: [{ type: 'text', text: (call as { result?: string }).result ?? 'ok' }] },
            isError: false,
          })
          ;(call as { after?: () => void }).after?.()
          const assistantMessage = {
            role: 'assistant',
            content: [{ type: 'text', text: `step ${i}` }],
            provider: 'test-provider',
            model: 'test-model',
            usage: { input: 1000, output: 10, cacheRead: 500, cacheWrite: 0, cost: { total: 0.001 } },
          }
          subscribeFn?.({ type: 'message_end', message: assistantMessage })
          messages.push(assistantMessage)
        }
        if (script.throwError) throw new Error(script.throwError)
        const final = {
          role: 'assistant',
          content: [{ type: 'text', text: round ? round.final : 'STATUS: completed\nSUMMARY: all good' }],
          provider: 'test-provider',
          model: 'test-model',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
        }
        subscribeFn?.({ type: 'message_end', message: final })
        subscribeFn?.({ type: 'agent_end', messages: [] })
        messages.push(final)
      }),
      abort: vi.fn(() => { script.aborted = true }),
      steer: vi.fn((msg: { content: Array<{ text: string }> }) => { script.steered.push(msg.content[0].text) }),
      state: { get messages() { return messages } },
    }
  }),
}))

const mockProvider: ProviderConfig = {
  id: 'test-provider-id',
  name: 'test-provider',
  type: 'openai',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'http://localhost:1234',
  apiKey: 'test-key',
  enabledModels: ['test-model'],
  models: [],
  status: 'connected',
  authMethod: 'api-key',
}

/**
 * S0-A third review: the runner-built HANDOFF consists of a closed set of
 * fixed phrases plus numbers, ISO timestamps, the task id, tool names of the
 * run, error classes and paths from handoffPath. Remove all allowed tokens;
 * nothing may be left.
 */
const HANDOFF_FIXED_PHRASES = [
  'Task aborted by the runner, error class:', 'Task failed with an exception, error class:',
  'The raw error text is not published here.', 'Task:', 'Ended:', 'Ran:', 'min of', 'min budget,', 'tool calls',
  'Error class:', 'HANDOFF:', 'Goal: see the prompt of task', 'State: aborted by the runner after',
  '(the budget warning had been sent).', '(no budget warning reached the agent before the abort).',
  'This handoff was generated by the runner, not written by the agent.', ABORT_HANDOFF_WRAPUP_NOTE,
  'Files written in this run:', 'none recorded', 'write(s) outside the shown roots (paths withheld)',
  'Tool calls per tool:', 'call(s),', 'error(s)', 'Last', 'tool calls (oldest first):', 'ok', 'error',
  'hard max-duration abort', 'progress guard tripped', 'run error', 'aborted',
  'The runner ended this run; no agent-written state was recorded.',
  'Open: everything the task prompt asks for that the files above do not show as done.',
  'Next step: start a successor with `continuation_of` this task id; verify the written files first, then continue from the HANDOFF the model wrote.',
]
/** Tool names the test runner registers (stubs; the agent itself is mocked). */
const REGISTERED_TOOLS = ['shell', 'write_file', 'read_file', 'edit_file'].map(name => ({
  name, label: name, description: name, parameters: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
})) as unknown as TaskRunnerOptions['tools']

/** Closed phrases of the restart refusal summary (REVIEW-S0-A-4). */
const RESTART_FIXED_PHRASES = [
  'server restart — not resumed, error class:', 'provider_unavailable', 'model_unavailable', 'lean_local_refused',
  'provider:', 'model:', 'other_provider', 'other_model', 'test-provider-id',
  'Restart the task with an available model.', 'Restart the task on a local provider.',
]

/**
 * REVIEW-S0-A-4: the same limits as `handoffPath` — at most 3 segments and
 * 48 characters below the root, `[A-Za-z0-9._-]` only, no run of 12+
 * alphanumerics with a digit. A path that is not allowed stays in the text
 * and makes the assertion fail.
 */
function stripAllowedPaths(text: string): string {
  return text.replace(/(\/workspace|\/mnt\/workspace|\/data\/memory)((?:\/[A-Za-z0-9._-]+)*)(\/?)/g, (match, root: string, below: string) => {
    if (!below) return ' '
    const rest = below.slice(1)
    const ok = rest.split('/').length <= 3 && rest.length <= 48 && !hasTokenLikeRun(rest)
    return ok ? ' ' : match
  })
}

function assertVocabularyOnly(text: string, taskId: string): void {
  // Error classes first: the short phrase `error` would otherwise cut `provider_error`.
  let rest = text.replace(/\b(?:timeout|tool_call_budget|token_budget|repeated_call|loop_detected|provider_error|cancelled|unknown)\b/g, ' ')
  for (const phrase of [...HANDOFF_FIXED_PHRASES, ...RESTART_FIXED_PHRASES].sort((a, b) => b.length - a.length)) rest = rest.split(phrase).join(' ')
  rest = rest.split(taskId).join(' ')
  rest = stripAllowedPaths(rest)
  rest = rest
    .replace(/\b(?:shell|write_file|read_file|edit_file|other_tool)\b/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, ' ')
    .replace(/\?/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[\s.,:;()\-]+/g, '')
  expect(rest, `non-vocabulary text in the runner HANDOFF: ${rest}`).toBe('')
}

function repeat(n: number, toolName: string, args: unknown) {
  return Array.from({ length: n }, () => ({ toolName, args }))
}

describe('TaskRunner progress guard', () => {
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let dbPath: string
  let completions: Array<{ taskId: string; status: string }>
  let injections: Array<{ taskId: string; injection: string }>

  function makeRunner(): TaskRunner {
    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      // REVIEW-S0-A-4: the run registers real tool names, so the HANDOFF's
      // registration check (foreign name -> other_tool) is exercised.
      tools: REGISTERED_TOOLS,
      onTaskComplete: (taskId, injection) => {
        completions.push({ taskId, status: store.getById(taskId)?.status ?? 'unknown' })
        injections.push({ taskId, injection })
      },
      sessionManager: new SessionManager({ db }),
    }
    return new TaskRunner(options)
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `ot-task-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    store = new TaskStore(db)
    completions = []
    injections = []
    script.calls = []
    script.throwError = null
    script.rounds = []
    script.aborted = false
    script.steered = []
    runner = makeRunner()
  })

  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    runner.dispose()
    db.close()
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  })

  it('fails a task that repeats one identical tool call', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 0, repeatedToolCalls: 3, maxInputTokens: 0 } })
    script.calls = repeat(6, 'read_file', { path: '/same' })

    const task = store.create({ name: 'Zombie', prompt: 'work', triggerType: 'agent', sessionId: 'guard-1' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    const row = store.getById(task.id)!
    expect(row.status).toBe('failed')
    expect(row.resultStatus).toBe('failed')
    expect(row.errorMessage).toContain('read_file')
    expect(row.resultSummary).toContain('error class: repeated_call')
    expect(script.aborted).toBe(true)

    // The "completed" the model produced after the abort must not win.
    expect(completions).toHaveLength(1)
    expect(completions[0].status).toBe('failed')

    const guardRows = db.prepare(
      "SELECT input, output FROM tool_calls WHERE session_id = ? AND tool_name = 'task_guard'"
    ).all('guard-1') as Array<{ input: string; output: string }>
    expect(guardRows).toHaveLength(1)
    expect(JSON.parse(guardRows[0].input).guard).toBe('repeated_tool_calls')
    expect(JSON.parse(guardRows[0].output).repeats).toBe(3)
  })

  it('fails a task that exceeds the tool call cap', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 4, repeatedToolCalls: 0, maxInputTokens: 0 } })
    script.calls = Array.from({ length: 10 }, (_, i) => ({ toolName: 'shell', args: { command: `echo ${i}` } }))

    const task = store.create({ name: 'Grinder', prompt: 'work', triggerType: 'agent', sessionId: 'guard-2' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    const row = store.getById(task.id)!
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toContain('tool call cap of 4')
    expect(row.toolCallCount).toBe(4)
  })

  it('warns once at 80 % of the tool call cap and hands over on the hard abort (S0-A / A3)', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 10, repeatedToolCalls: 0, maxInputTokens: 0 } })
    script.calls = [
      { toolName: 'write_file', args: { path: '/workspace/proj/notes.md', content: 'x' } },
      ...Array.from({ length: 14 }, (_, i) => ({ toolName: 'shell', args: { command: `echo ${i}` } })),
    ]

    const task = store.create({ name: 'Long haul', prompt: 'work', triggerType: 'agent', sessionId: 'guard-a3' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    // Exactly one warning, sent for the tool-call budget at call 8 of 10.
    expect(script.steered).toHaveLength(1)
    expect(script.steered[0]).toContain('budget="tool_calls"')
    expect(script.steered[0]).toContain('8 calls of 10 calls')

    const row = store.getById(task.id)!
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toContain('tool call cap of 10')
    expect(row.resultSummary).not.toContain('No result was produced')
    expect(row.resultSummary).toContain('HANDOFF:')
    expect(row.resultSummary).toContain('/workspace/proj/notes.md')
    expect(row.resultSummary).toContain('budget warning had been sent')
  })

  it('warns exactly once per run across pause and resume (S0-A / A3 review)', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 20, repeatedToolCalls: 0, maxInputTokens: 0 } })
    script.rounds = [
      // 16 of 20 calls = 80 %: the warning fires, then the task asks a question.
      { calls: repeat(16, 'shell', { command: 'echo a' }), final: 'STATUS: question\nSUMMARY: Which one?' },
      // After the resume the seeded guard is already past the threshold.
      { calls: repeat(2, 'shell', { command: 'echo b' }), final: 'STATUS: completed\nSUMMARY: done' },
    ]
    const task = store.create({ name: 'Pause twice', prompt: 'work', triggerType: 'agent', sessionId: 'guard-a3-resume' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    const paused = store.getById(task.id)!
    expect(paused.status).toBe('paused')
    expect(script.steered).toHaveLength(1)
    expect(script.steered[0]).toContain('budget="tool_calls"')
    expect(paused.budgetWarnedAt).toBeTruthy()

    expect(await runner.resumeTask(task.id, 'the first one')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 150))

    const done = store.getById(task.id)!
    expect(done.status).toBe('completed')
    expect(done.toolCallCount).toBe(18)
    expect(script.steered).toHaveLength(1)
  })

  it('gives a continuation_of successor its own warning (S0-A / A3 review)', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 10, repeatedToolCalls: 0, maxInputTokens: 0 } })
    script.calls = repeat(12, 'shell', { command: 'echo c' })
    const first = store.create({ name: 'Predecessor', prompt: 'work', triggerType: 'agent', sessionId: 'guard-a3-pred' })
    await runner.startTask(first, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))
    const predecessor = store.getById(first.id)!
    expect(predecessor.status).toBe('failed')
    expect(predecessor.budgetWarnedAt).toBeTruthy()
    expect(script.steered).toHaveLength(1)

    const successor = store.create({
      name: 'Successor',
      prompt: `${formatContinuationContext(predecessor)}\n\ncontinue`,
      triggerType: 'agent',
      sessionId: 'guard-a3-succ',
    })
    expect(successor.budgetWarnedAt ?? null).toBeNull()
    await runner.startTask(successor, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(script.steered).toHaveLength(2)
    expect(store.getById(successor.id)!.budgetWarnedAt).toBeTruthy()
  })

  it('fails a task that blows the input token budget', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 0, repeatedToolCalls: 0, maxInputTokens: 3000 } })
    script.calls = Array.from({ length: 10 }, (_, i) => ({ toolName: 'shell', args: { command: `echo ${i}` } }))

    const task = store.create({ name: 'Burner', prompt: 'work', triggerType: 'agent', sessionId: 'guard-3' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    const row = store.getById(task.id)!
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toContain('input tokens')
    // Two responses at 1500 input each cross the 3000 budget.
    expect(row.promptTokens).toBe(2000)
  })

  it('frees the provider session resources of exactly the finished task session', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 300, repeatedToolCalls: 5, maxInputTokens: 30_000_000 } })
    script.calls = [{ toolName: 'shell', args: { command: 'ls' } }]
    // pi-ai's Codex adapter registers its WebSocket cleanup the same way.
    const cleaned: Array<string | undefined> = []
    const unregister = registerSessionResourceCleanup((sessionId?: string) => { cleaned.push(sessionId) })
    try {
      const task = store.create({ name: 'Cleanup', prompt: 'work', triggerType: 'agent', sessionId: 'guard-cleanup' })
      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 150))

      expect(store.getById(task.id)!.status).toBe('completed')
      expect(cleaned).toEqual(['guard-cleanup'])
    } finally {
      unregister()
    }
  })

  it('lets a normal task finish and records a task_usage metric row', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 300, repeatedToolCalls: 5, maxInputTokens: 30_000_000 } })
    script.calls = [
      { toolName: 'shell', args: { command: 'ls' } },
      { toolName: 'read_file', args: { path: '/a' } },
    ]

    const task = store.create({ name: 'Healthy', prompt: 'work', triggerType: 'agent', sessionId: 'guard-4' })
    await runner.startTask(task, mockProvider)
    await new Promise(resolve => setTimeout(resolve, 150))

    const row = store.getById(task.id)!
    expect(row.status).toBe('completed')
    expect(row.resultSummary).toBe('all good')

    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ? AND tool_name = 'task_guard'")
      .get('guard-4')).toEqual({ n: 0 })

    const usage = db.prepare(
      "SELECT output FROM tool_calls WHERE session_id = ? AND tool_name = 'task_usage'"
    ).all('guard-4') as Array<{ output: string }>
    expect(usage).toHaveLength(1)
    const payload = JSON.parse(usage[0].output)
    expect(payload.taskId).toBe(task.id)
    expect(payload.toolCalls).toBe(2)
    expect(payload.promptTokens).toBe(2010)
    expect(payload.cacheRead).toBe(1000)
    // 1000 / (2010 + 1000)
    expect(payload.cacheReadRatio).toBeCloseTo(0.3322, 3)
  })

  describe('abort HANDOFF and the secret boundary (S0-A review, blocking)', () => {
    let secretDir: string
    let previousEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
      secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-task-guard-secret-'))
      fs.mkdirSync(path.join(secretDir, 'config'), { recursive: true })
      previousEnv = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
      process.env.DATA_DIR = secretDir
      process.env.ENCRYPTION_KEY = 'test-key-for-guard-canary'
      invalidateSecretHandleCache()
      invalidateKnownValues()
    })

    afterEach(() => {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(secretDir, { recursive: true, force: true })
      invalidateSecretHandleCache()
      invalidateKnownValues()
    })

    it('a registered canary in a shell command never reaches resultSummary, tasks.handoff or the successor prompt', async () => {
      // A registered test value (never a real credential), random per run.
      const canary = `S0aCanary${Math.random().toString(36).slice(2, 12)}Zq7${Date.now().toString(36)}`
      sealSecret(canary, 'password', 'form')
      invalidateKnownValues()
      // An unregistered value behind a credential flag: only the argHint
      // reduction can keep it out.
      const unregistered = `Unreg${Math.random().toString(36).slice(2, 14)}Xy9`

      setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 4, repeatedToolCalls: 0, maxInputTokens: 0 } })
      script.calls = [
        { toolName: 'write_file', args: { path: '/workspace/proj/state.md', content: canary } },
        { toolName: 'shell', args: { command: `${canary} | tee /dev/null` } },
        { toolName: 'shell', args: { command: `curl -H X-Key:${canary} https://example.invalid/?token=${canary}` } },
        { toolName: 'shell', args: { command: `mysql --password ${unregistered} -e 'select 1'` } },
        { toolName: 'shell', args: { command: 'echo after the cap' } },
      ]

      const task = store.create({ name: 'Canary run', prompt: 'work', triggerType: 'agent', sessionId: 'guard-canary' })
      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 150))

      const row = store.getById(task.id)!
      expect(row.status).toBe('failed')
      expect(row.errorMessage).toContain('tool call cap of 4')
      // The handoff is still useful: tool names, counts and written paths survive.
      expect(row.resultSummary).toContain('HANDOFF:')
      expect(row.resultSummary).toContain('/workspace/proj/state.md')
      expect(row.resultSummary).toContain('- shell: 3 call(s), 0 error(s)')

      expect(row.resultSummary).not.toContain(canary)
      expect(row.resultSummary).not.toContain(unregistered)
      expect(row.handoff).toBeTruthy()
      expect(row.handoff).not.toContain(canary)
      expect(row.handoff).not.toContain(unregistered)

      const successorPrompt = formatContinuationContext(row)
      expect(successorPrompt).toContain('<continuation_of')
      expect(successorPrompt).not.toContain(canary)
      expect(successorPrompt).not.toContain(unregistered)

      // Same check on the raw column values, in case a getter normalises.
      const raw = db.prepare('SELECT result_summary, handoff FROM tasks WHERE id = ?').get(task.id) as { result_summary: string; handoff: string }
      expect(`${raw.result_summary}\n${raw.handoff}`).not.toContain(canary)
    })

    it('unregistered values in free arguments, paths and result previews never reach resultSummary, tasks.handoff, the successor prompt or the injection (S0-A second review)', async () => {
      // Five bypass shapes from REVIEW-S0-A-2 § 1, each with its OWN random
      // value that is NOT registered in the secret index: only the
      // value-free HANDOFF can keep them out, the sealing cannot.
      const rnd = (tag: string) => `${tag}${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
      const v = {
        curlPass: rnd('Cu'),
        echoToken: rnd('Ec'),
        mysqlToken: rnd('My'),
        pathToken: rnd('Pa'),
        previewToken: rnd('Pr'),
        // S0-A third review: runner-side free text.
        taskName: rnd('Tn'),
        exception: rnd('Ex'),
        urlToken: rnd('Ut'),
        abortReason: rnd('Ar'),
        // REVIEW-S0-A-4: a syntactically valid, MCP-like tool name that is
        // not registered (letters only, so only the registration check can
        // hold it back, not the token-run check).
        foreignTool: `Zq${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`,
      }
      setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 6, repeatedToolCalls: 0, maxInputTokens: 0 } })
      script.calls = [
        { toolName: 'shell', args: { command: `curl -u user ${v.curlPass} https://example.invalid/` } },
        { toolName: 'shell', args: { command: `echo ${v.echoToken}` } },
        { toolName: 'shell', args: { command: `mysql -p${v.mysqlToken} -e 'select 1'` } },
        { toolName: 'write_file', args: { path: `/tmp/${v.pathToken}.txt`, content: 'x' } },
        { toolName: 'write_file', args: { path: `/workspace/proj/${v.pathToken}.txt`, content: 'x' } },
        // A value spread over short segments (each < 12 chars).
        { toolName: 'write_file', args: { path: '/workspace/ab12cd/ef34gh/ij56kl/mn78op.txt', content: 'x' } },
        { toolName: 'shell', args: { command: 'make' }, result: `done ${v.previewToken}` },
        { toolName: 'shell', args: { command: 'echo after the cap' } },
      ]

      const task = store.create({ name: `Negative canary ${v.taskName}`, prompt: 'work', triggerType: 'agent', sessionId: 'guard-neg-canary' })
      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 150))

      const row = store.getById(task.id)!
      expect(row.status).toBe('failed')
      expect(row.errorMessage).toContain('tool call cap of 6')
      expect(row.resultSummary).toContain('HANDOFF:')
      // Metadata survives: per-tool counts, the shortened directory of the
      // token-named file under /workspace, the wrap-up hint.
      expect(row.resultSummary).toContain('- shell: 3 call(s), 0 error(s)')
      expect(row.resultSummary).toContain('- write_file: 3 call(s), 0 error(s)')
      expect(row.resultSummary).toContain('- /workspace/\n')
      expect(row.resultSummary).toContain('1 write(s) outside the shown roots (paths withheld)')
      expect(row.resultSummary).toContain('wrap-up step')

      const successorPrompt = formatContinuationContext(row)
      expect(successorPrompt).toContain('<continuation_of')
      const raw = db.prepare('SELECT result_summary, handoff FROM tasks WHERE id = ?').get(task.id) as { result_summary: string; handoff: string }
      expect(raw.handoff).toBeTruthy()
      const injection = injections.find(i => i.taskId === task.id)?.injection ?? ''
      expect(injection).toContain('HANDOFF:')
      // Split path: no segment of it is shown, only the root.
      expect(`${row.resultSummary}\n${row.handoff}`).not.toMatch(/ab12cd|ef34gh|ij56kl|mn78op/)

      // Run 2: an exception whose text carries a value and a URL with a query token.
      script.calls = [{ toolName: 'shell', args: { command: 'make' } }]
      script.throwError = `boom ${v.exception} while fetching https://api.example.invalid/x?token=${v.urlToken}&a=1`
      setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 0, repeatedToolCalls: 0, maxInputTokens: 0 } })
      const task2 = store.create({ name: `Exception ${v.taskName}`, prompt: 'work', triggerType: 'agent', sessionId: 'guard-neg-canary-2' })
      await runner.startTask(task2, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 150))
      const row2 = store.getById(task2.id)!
      expect(row2.status).toBe('failed')
      expect(row2.resultSummary).toContain('error class: unknown')

      // Run 3: an abort with a free-text reason.
      script.throwError = null
      script.calls = [
        { toolName: `mcp.${v.foreignTool}:INJECT`, args: {} },
        { toolName: 'shell', args: { command: 'make' }, after: () => runner.abortTask(task3.id, `Stopped by orchestrator: ${v.abortReason}`, { handoff: true }) },
        { toolName: 'shell', args: { command: 'make' } },
      ]
      const task3 = store.create({ name: `Abort ${v.taskName}`, prompt: 'work', triggerType: 'agent', sessionId: 'guard-neg-canary-3' })
      await runner.startTask(task3, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 150))
      const row3 = store.getById(task3.id)!
      expect(row3.status).toBe('failed')
      expect(row3.resultSummary).toContain('error class: cancelled')
      expect(row3.resultSummary).toContain('- other_tool: 1 call(s), 0 error(s)')

      const surfaces: Record<string, string> = {}
      for (const [label, r] of [['cap', row], ['exception', row2], ['abort', row3]] as const) {
        const rawRow = db.prepare('SELECT result_summary, handoff FROM tasks WHERE id = ?').get(r.id) as { result_summary: string | null; handoff: string | null }
        surfaces[`${label}.resultSummary`] = r.resultSummary ?? ''
        surfaces[`${label}.handoff`] = r.handoff ?? ''
        surfaces[`${label}.successorPrompt`] = formatContinuationContext(r)
        surfaces[`${label}.rawColumns`] = `${rawRow.result_summary}\n${rawRow.handoff}`
        surfaces[`${label}.injection`] = injections.find(i => i.taskId === r.id)?.injection ?? ''
        expect(surfaces[`${label}.injection`], `${label} injection missing`).toContain('<task_injection')
        expect(surfaces[`${label}.handoff`], `${label} handoff missing`).toBeTruthy()
      }
      for (const [name, value] of Object.entries(v)) {
        for (const [surface, text] of Object.entries(surfaces)) {
          expect(text.includes(value), `${name} leaked into ${surface}`).toBe(false)
        }
      }

      // Allowlist over the whole runner-built HANDOFF text: only vocabulary
      // words, numbers, timestamps, task ids, tool names of the run and
      // allowed paths may appear.
      for (const r of [row, row2, row3]) {
        assertVocabularyOnly(r.handoff ?? '', r.id)
        assertVocabularyOnly(r.resultSummary ?? '', r.id)
      }
    })

    it('after pause and resume, a foreign tool name shows only as other_tool (REVIEW-S0-A-4)', async () => {
      const foreign = `mcp.look${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}:INJECT`
      setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 3, repeatedToolCalls: 0, maxInputTokens: 0 } })
      script.rounds = [
        { calls: [{ toolName: 'shell', args: { command: 'ls' } }], final: 'STATUS: question\nSUMMARY: Which one?' },
        { calls: [{ toolName: foreign, args: {} }, { toolName: 'shell', args: { command: 'a' } }, { toolName: 'shell', args: { command: 'b' } }], final: 'STATUS: completed\nSUMMARY: done' },
      ]
      const task = store.create({ name: 'Resume foreign tool', prompt: 'work', triggerType: 'agent', sessionId: 'guard-resume-foreign' })
      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(store.getById(task.id)!.status).toBe('paused')
      expect(await runner.resumeTask(task.id, 'the first one')).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 150))

      const row = store.getById(task.id)!
      expect(row.status).toBe('failed')
      expect(row.resultSummary).toContain('HANDOFF:')
      expect(row.resultSummary).toContain('- other_tool: 1 call(s), 0 error(s)')
      const surfaces = {
        resultSummary: row.resultSummary ?? '',
        handoff: row.handoff ?? '',
        successorPrompt: formatContinuationContext(row),
        injection: injections.find(i => i.taskId === task.id)?.injection ?? '',
      }
      expect(surfaces.injection).toContain('<task_injection')
      for (const [surface, text] of Object.entries(surfaces)) {
        expect(text.includes(foreign.slice(4, 16)), `foreign tool name leaked into ${surface}`).toBe(false)
      }
      assertVocabularyOnly(row.handoff ?? '', row.id)
      assertVocabularyOnly(row.resultSummary ?? '', row.id)
    })

    it('a task the restart recovery refuses never publishes its stored provider or model value (REVIEW-S0-A-4)', async () => {
      const rnd = (tag: string) => `${tag}${Array.from({ length: 9 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`
      const v = { provider: rnd('Pv'), model: rnd('Md'), leanProvider: rnd('Lp') }
      const routing = { source: 'policy', kind: 'general', difficulty: 'medium', tier: null, family: null, modelId: v.model, thinking: null, thinkingSource: 'default', reason: 'test' } as never
      const gone = store.create({ name: 'Gone provider', prompt: 'work', triggerType: 'agent', sessionId: 'guard-restart-1', provider: v.provider, model: v.model, routing })
      const disabled = store.create({ name: 'Disabled model', prompt: 'work', triggerType: 'agent', sessionId: 'guard-restart-2', provider: mockProvider.id, model: v.model, routing })
      const lean = store.create({ name: 'Lean gone', prompt: 'work', triggerType: 'agent', sessionId: 'guard-restart-3', provider: v.leanProvider, workerProfile: 'lean_local', outputSchema: '{"type":"object"}' } as never)
      for (const t of [gone, disabled, lean]) store.update(t.id, { status: 'running' })

      const result = await runner.recoverTasks(id => (id === mockProvider.id ? mockProvider : null), mockProvider)
      expect(result).toEqual({ resumed: 0, failed: 3 })

      const rows = [gone, disabled, lean].map(t => store.getById(t.id)!)
      expect(rows[0].resultSummary).toContain('provider_unavailable, provider: other_provider')
      expect(rows[1].resultSummary).toContain(`model_unavailable, provider: ${mockProvider.id}, model: other_model`)
      expect(rows[2].resultSummary).toContain('provider_unavailable, provider: other_provider')
      // The raw diagnosis stays internal.
      expect(rows[0].errorMessage).toContain(v.provider)
      for (const row of rows) {
        expect(row.status).toBe('failed')
        expect(row.resultSummary).toContain('error class: provider_error')
        const surfaces = {
          resultSummary: row.resultSummary ?? '',
          successorPrompt: formatContinuationContext(row),
          injection: formatTaskInjection(row, 1),
        }
        for (const [name, value] of Object.entries(v)) {
          for (const [surface, text] of Object.entries(surfaces)) {
            expect(text.includes(value), `${name} leaked into ${surface} of ${row.name}`).toBe(false)
          }
        }
        assertVocabularyOnly(row.resultSummary ?? '', row.id)
      }
    })

    it('the vocabulary assertion applies the handoffPath limits to paths (REVIEW-S0-A-4)', () => {
      const id = 'task-x'
      assertVocabularyOnly('Task: task-x\n- /workspace/proj/notes.md\n- /workspace/', id)
      // 4 segments, > 48 characters, a 12+ run with a digit: each stays in the text.
      expect(() => assertVocabularyOnly('- /workspace/a/b/c/d.md', id)).toThrow()
      expect(() => assertVocabularyOnly(`- /workspace/${'abcdefghij.'.repeat(5)}md`, id)).toThrow()
      expect(() => assertVocabularyOnly('- /workspace/proj/abcdef123456.md', id)).toThrow()
    })

    it('redacts a known value in an older handoff row on its way into the successor prompt', async () => {
      const canary = `S0aOldRow${Math.random().toString(36).slice(2, 12)}Qp4`
      sealSecret(canary, 'password', 'form')
      invalidateKnownValues()
      const task = store.create({ name: 'Old row', prompt: 'work', triggerType: 'agent', sessionId: 'guard-old-row' })
      store.update(task.id, { status: 'failed', handoff: `HANDOFF:\n- shell (command=${canary})` })
      const prompt = formatContinuationContext(store.getById(task.id)!)
      expect(prompt).not.toContain(canary)
      expect(prompt).toContain('{{secret:')
    })
  })
})
