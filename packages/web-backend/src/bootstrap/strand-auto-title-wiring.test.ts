/**
 * Wiring smoke test for the strand auto-title (plan strand-titel, review M2):
 * the runtime composition calls the trigger at the end of every successful
 * chat turn and at every session end, never for a failed turn, and the turn
 * hook returns synchronously while the (fake) evaluation is still pending.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@axiom/core'
import type { AutoTitleResult, TurnRunner as TurnRunnerType } from '@axiom/core'
import { createRuntimeComposition } from './runtime-composition.js'
import { resetAutoTitleInFlight } from '../strand-auto-title-trigger.js'

type RunnerOptions = ConstructorParameters<typeof TurnRunnerType>[0]
type SessionEndCallback = (userId: string, sessionId: string, summary: string | null, agentId: string, opts?: { background?: boolean; parked?: boolean }) => void

const captured = vi.hoisted(() => ({
  runnerOptions: null as RunnerOptions | null,
  onSessionEnd: null as SessionEndCallback | null,
  evaluations: [] as { sessionId: string; trigger: string; settle: (r: AutoTitleResult) => void }[],
}))

vi.mock('@axiom/core', async importOriginal => {
  const core = await importOriginal<typeof import('@axiom/core')>()
  class CapturingTurnRunner extends core.TurnRunner {
    constructor(options: RunnerOptions) {
      super(options)
      captured.runnerOptions = options
    }
  }
  /** Callable no-op: every property and every call returns the no-op again (not thenable). */
  const noop: unknown = new Proxy(function noopFn() {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : noop),
    apply: () => noop,
  })
  /** Minimal agent core: every method is a no-op, only the session-end hook is kept. */
  class FakeAgentCore {
    constructor() {
      return new Proxy(this, {
        get(target, prop) {
          if (prop === 'then') return undefined
          if (prop === 'setOnSessionEnd') return (cb: SessionEndCallback) => { captured.onSessionEnd = cb }
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop]
          return noop
        },
      })
    }
  }
  return {
    ...core,
    TurnRunner: CapturingTurnRunner,
    AgentCore: FakeAgentCore,
    getActiveProvider: () => ({
      id: 'p-active',
      name: 'active',
      type: 'openai-completions',
      providerType: 'openai',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['active-model'],
    }),
    planStrandAutoTitle: () => ({ run: true, turnCount: 4, retry: false }),
    evaluateStrandAutoTitle: (_db: unknown, sessionId: string, trigger: string) =>
      new Promise<AutoTitleResult>(resolve => {
        captured.evaluations.push({ sessionId, trigger, settle: resolve })
      }),
  }
})

const silent = { log: () => {}, warn: () => {}, error: () => {} }
let composition: Awaited<ReturnType<typeof createRuntimeComposition>> | null = null
let previousDataDir: string | undefined
let dataDir: string

function turn(turnId: string, sessionId: string) {
  return { turnId, userId: '1', sessionId, agentId: 'main', source: 'web' } as unknown as Parameters<NonNullable<RunnerOptions['onTurnEnd']>>[0]
}

beforeEach(async () => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-auto-title-wiring-'))
  process.env.DATA_DIR = dataDir
  captured.runnerOptions = null
  captured.onSessionEnd = null
  captured.evaluations = []
  resetAutoTitleInFlight()
  composition = await createRuntimeComposition({ logger: silent })
})

afterEach(async () => {
  await composition?.stopBackgroundServices()
  composition = null
  resetAutoTitleInFlight()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('strand auto-title wiring in the runtime composition', () => {
  it('triggers after a successful turn and returns before the evaluation settles', () => {
    const hooks = captured.runnerOptions!
    expect(hooks.onTurnEnd).toBeTypeOf('function')
    hooks.onTurnStart?.(turn('t-ok', 'strand-ok'))
    const returned = hooks.onTurnEnd!(turn('t-ok', 'strand-ok'))
    expect(returned).toBeUndefined()
    expect(captured.evaluations).toEqual([expect.objectContaining({ sessionId: 'strand-ok', trigger: 'message' })])
    // The evaluation is still pending: the turn path did not wait for it.
    captured.evaluations[0].settle({ outcome: 'kept', model: 'ollama:fake' } as AutoTitleResult)
  })

  it('does not trigger for a failed turn', () => {
    const hooks = captured.runnerOptions!
    hooks.onTurnStart?.(turn('t-fail', 'strand-fail'))
    hooks.onTurnFailed!({ turn: turn('t-fail', 'strand-fail'), error: { kind: 'non_retryable', message: 'boom' } } as never)
    hooks.onTurnEnd!(turn('t-fail', 'strand-fail'))
    expect(captured.evaluations).toEqual([])
  })

  it('triggers at session end', () => {
    expect(captured.onSessionEnd).toBeTypeOf('function')
    const db = composition!.db
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run()
    const strand = new SessionManager({ db, memoryDir: path.join(dataDir, 'memory'), timeoutMinutes: 0 }).createThread('1', 'main', 'Ending').id
    captured.onSessionEnd!('1', strand, 'Summary', 'main', { background: true })
    expect(captured.evaluations).toEqual([expect.objectContaining({ sessionId: strand, trigger: 'session_end' })])
    captured.evaluations[0].settle({ outcome: 'kept', model: 'ollama:fake' } as AutoTitleResult)
  })
})
