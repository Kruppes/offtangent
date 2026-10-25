/**
 * The trigger side of the strand auto-title: the gate runs synchronously, the
 * model call does not, the kill switch holds, and nothing ever throws into a
 * chat turn — also not when the local model is down.
 */
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateStrandAutoTitle, initDatabase } from '@axiom/core'
import type { AutoTitleResult, Database, ResolvedRouterModel } from '@axiom/core'
import { getAutoTitleSettings, resetAutoTitleInFlight, triggerStrandAutoTitle } from './strand-auto-title-trigger.js'

let db: Database
const silent = { log: () => {}, warn: () => {}, error: () => {} }

const LOCAL: ResolvedRouterModel = {
  spec: 'ollama:qwen3.8:27b-mlx', threshold: null, providerId: 'ollama', providerName: 'Ollama', modelId: 'qwen3.8:27b-mlx', composite: 'ollama:qwen3.8:27b-mlx',
}
const CLOUD: ResolvedRouterModel = {
  spec: 'claude-haiku-5-5', threshold: null, providerId: 'anthropic', providerName: 'Anthropic', modelId: 'claude-haiku-5-5', composite: 'anthropic:claude-haiku-5-5',
}

function addStrand(id: string, source: string = 'derived'): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written, agent_id, title, title_source, archived)
     VALUES (?, 1, '1', 'web', 'interactive', datetime('now'), datetime('now'), 0, 0, 'main', 'Hallo, kannst du mir', ?, 0)`,
  ).run(id, source)
}

function addTurns(id: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    for (const role of ['user', 'assistant']) {
      db.prepare(
        `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
         VALUES (?, 1, ?, 'Die Gießkanne am Bootshaus', 'main', datetime('now'))`,
      ).run(id, role)
    }
  }
}

function settled(): { promise: Promise<AutoTitleResult>; resolve: (r: AutoTitleResult) => void } {
  let resolve!: (r: AutoTitleResult) => void
  const promise = new Promise<AutoTitleResult>((res) => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
  resetAutoTitleInFlight()
})

afterEach(() => {
  db.close()
})

describe('getAutoTitleSettings', () => {
  it('is on by default and only off on an explicit false', () => {
    expect(getAutoTitleSettings(() => ({}))).toEqual({ enabled: true })
    expect(getAutoTitleSettings(() => ({ autoTitle: {} }))).toEqual({ enabled: true })
    expect(getAutoTitleSettings(() => ({ autoTitle: { enabled: false } }))).toEqual({ enabled: false })
    expect(getAutoTitleSettings(() => { throw new Error('corrupt') })).toEqual({ enabled: true })
  })
})

describe('triggerStrandAutoTitle', () => {
  it('refuses a strand before turn 4 without calling the model', () => {
    addStrand('s1')
    addTurns('s1', 3)
    let calls = 0
    expect(triggerStrandAutoTitle({
      db, sessionId: 's1', trigger: 'message',
      deps: { console: silent, loadSettings: () => ({}), evaluate: async () => { calls += 1; return { outcome: 'none' } } },
    })).toBe(false)
    expect(calls).toBe(0)
  })

  it('refuses a manual title', () => {
    addStrand('s1', 'manual')
    addTurns('s1', 10)
    expect(triggerStrandAutoTitle({
      db, sessionId: 's1', trigger: 'message',
      deps: { console: silent, loadSettings: () => ({}), evaluate: async () => ({ outcome: 'none' }) },
    })).toBe(false)
  })

  it('obeys the kill switch', () => {
    addStrand('s1')
    addTurns('s1', 4)
    expect(triggerStrandAutoTitle({
      db, sessionId: 's1', trigger: 'message',
      deps: { console: silent, loadSettings: () => ({ autoTitle: { enabled: false } }), evaluate: async () => ({ outcome: 'none' }) },
    })).toBe(false)
  })

  it('returns before the model answers and drops a second trigger while in flight', async () => {
    addStrand('s1')
    addTurns('s1', 4)
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    const done = settled()
    let calls = 0
    const deps = {
      console: silent,
      loadSettings: () => ({}),
      evaluate: async () => { calls += 1; await gate; return { outcome: 'kept' as const } },
    }
    expect(triggerStrandAutoTitle({ db, sessionId: 's1', trigger: 'message', onSettled: done.resolve, deps })).toBe(true)
    expect(triggerStrandAutoTitle({ db, sessionId: 's1', trigger: 'session_end', deps })).toBe(false)
    release()
    expect((await done.promise).outcome).toBe('kept')
    expect(calls).toBe(1)
  })

  it('swallows a throwing evaluation', async () => {
    addStrand('s1')
    addTurns('s1', 4)
    const errors: unknown[] = []
    expect(triggerStrandAutoTitle({
      db, sessionId: 's1', trigger: 'message',
      deps: { console: { ...silent, error: (...args: unknown[]) => { errors.push(args) } }, loadSettings: () => ({}), evaluate: async () => { throw new Error('boom') } },
    })).toBe(true)
    await new Promise(res => setTimeout(res, 0))
    expect(errors.length).toBe(1)
  })

  it('Ollama down: falls back to the cloud entry and writes an ai title', async () => {
    addStrand('s1')
    addTurns('s1', 4)
    const done = settled()
    const calls: string[] = []
    triggerStrandAutoTitle({
      db, sessionId: 's1', trigger: 'message', onSettled: done.resolve,
      deps: {
        console: silent,
        loadSettings: () => ({}),
        evaluate: (database, id, trigger) => evaluateStrandAutoTitle(database, id, trigger, {
          chain: [LOCAL, CLOUD],
          complete: async (entry) => {
            calls.push(entry.composite)
            if (entry === LOCAL) throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
            return '{"title": "Gießkanne Bootshaus"}'
          },
        }),
      },
    })
    const result = await done.promise
    expect(calls).toEqual([LOCAL.composite, CLOUD.composite])
    expect(result).toMatchObject({ outcome: 'changed', model: CLOUD.composite })
    expect(db.prepare('SELECT title, title_source, previous_title FROM sessions WHERE id = ?').get('s1')).toEqual({
      title: 'Gießkanne Bootshaus', title_source: 'ai', previous_title: 'Hallo, kannst du mir',
    })
  })
})

describe('log safety (review K0-K2-3 #1)', () => {
  const MARKER = 'PRIVATE_CLOCK_DICTATION_MARKER_007'

  /** Every console level the trigger may use; Error objects are inspected with their stack. */
  function recordingConsole(): { console: Pick<typeof console, 'log' | 'warn' | 'error'>; text: () => string; lines: () => number } {
    const seen: unknown[][] = []
    const push = (...args: unknown[]) => { seen.push(args) }
    return {
      console: { log: push, warn: push, error: push },
      text: () => seen.flat().map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: 5 }))).join('\n'),
      lines: () => seen.length,
    }
  }

  function addClockStrand(id: string): void {
    db.prepare(
      `INSERT INTO sessions (id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written, agent_id, title, title_source, archived)
       VALUES (?, 1, '1', 'clock', 'interactive', datetime('now'), datetime('now'), 0, 0, 'main', 'Hallo, kannst du mir', 'derived', 0)`,
    ).run(id)
  }

  it('a provider echo of the dictation never reaches the log (the reviewer probe)', async () => {
    addClockStrand('s1')
    addTurns('s1', 4)
    const out = recordingConsole()
    const done = settled()
    expect(triggerStrandAutoTitle({
      db, sessionId: 's1', trigger: 'message', onSettled: done.resolve,
      deps: {
        console: out.console,
        loadSettings: () => ({}),
        evaluate: (d, id, t) => evaluateStrandAutoTitle(d, id, t, {
          chain: [LOCAL],
          complete: async () => { throw new Error(`review:stub: upstream echoed ${MARKER}`) },
        }),
      },
    })).toBe(true)
    const result = await done.promise
    expect(result.outcome).toBe('error')
    expect(out.lines()).toBe(1)
    expect(out.text()).toContain('[auto-title] Strand s1: no title (ollama:qwen3.8:27b-mlx: error)')
    expect(out.text()).not.toContain(MARKER)
  })

  it('a successful title is logged as length and source, never verbatim (review K0-K2-4 #1)', async () => {
    addClockStrand('s1')
    addTurns('s1', 4)
    const out = recordingConsole()
    const done = settled()
    expect(triggerStrandAutoTitle({
      db, sessionId: 's1', trigger: 'message', onSettled: done.resolve,
      deps: {
        console: out.console,
        loadSettings: () => ({}),
        evaluate: (d, id, t) => evaluateStrandAutoTitle(d, id, t, {
          chain: [LOCAL],
          complete: async () => `{"title":"${MARKER}"}`,
        }),
      },
    })).toBe(true)
    const result = await done.promise
    expect(result.outcome).toBe('changed')
    expect(result.title).toBe(MARKER)
    expect(out.text()).toBe(`[auto-title] Strand s1: renamed (title length ${MARKER.length}, ollama:qwen3.8:27b-mlx, trigger message)`)
    expect(out.text()).not.toContain(MARKER)
  })

  it('a failing gate logs a class, not the message', () => {
    const out = recordingConsole()
    const throwing = { prepare: () => { throw new Error(`gate ${MARKER}`) } } as unknown as Database
    expect(triggerStrandAutoTitle({
      db: throwing, sessionId: 's1', trigger: 'message',
      deps: { console: out.console, loadSettings: () => ({}), evaluate: async () => ({ outcome: 'none' }) },
    })).toBe(false)
    expect(out.text()).toBe('[auto-title] Gate failed for strand s1: error')
  })

  it('a throwing evaluation logs a class, neither message nor stack', async () => {
    addClockStrand('s1')
    addTurns('s1', 4)
    const out = recordingConsole()
    expect(triggerStrandAutoTitle({
      db, sessionId: 's1', trigger: 'message',
      deps: { console: out.console, loadSettings: () => ({}), evaluate: async () => { throw new RangeError(`boom ${MARKER}`) } },
    })).toBe(true)
    await new Promise(res => setTimeout(res, 0))
    expect(out.text()).toBe('[auto-title] Failed for strand s1: range_error')
  })
})
