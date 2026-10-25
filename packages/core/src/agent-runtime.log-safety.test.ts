/**
 * Review K0-K2-3 #2: the turn loop of the agent runtime logs provider errors
 * by class only. A provider can echo the prompt (a clock dictation) in its
 * error body; neither the message nor the stack of that error may reach any
 * console level. What the client receives is unchanged (the error chunk keeps
 * the message, that surface is reviewed separately).
 *
 * The private generator `executePromptWithRetry` is driven on a minimal
 * stand-in for the runtime, so no provider, database or model is needed.
 */
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PiAgentRuntimeForTests as AgentRuntime } from './agent-runtime.js'
import { SteerSlot } from './steer.js'

const MARKER = 'PRIVATE_CLOCK_DICTATION_MARKER_007'

type Listener = (event: { type: string; messages?: unknown[] }) => void

interface StandIn {
  [key: string]: unknown
}

function standIn(options: { fail: () => Error; midStream?: boolean; providerManager?: unknown }): StandIn {
  let listener: Listener | null = null
  return {
    agentId: 'main',
    currentSessionId: null,
    askUserBlockingClaimed: false,
    promptChannel: 'web',
    promptUser: undefined,
    providerManager: options.providerManager ?? null,
    // S1-D (merged from main): streamPrompt settles the steer slot in its
    // finally block; the stand-in needs the real one.
    steerSlot: new SteerSlot(),
    agent: {
      subscribe: (fn: Listener) => { listener = fn; return () => { listener = null } },
      prompt: async () => {
        if (options.midStream) {
          // First event is drained and yielded at once; the second one arrives
          // while the consumer holds the generator at that yield, so the
          // rejection lands with a non-empty queue = a mid-stream error.
          listener?.({ type: 'agent_start' })
          await new Promise(res => setTimeout(res, 5))
          listener?.({ type: 'message_update' })
        }
        throw options.fail()
      },
      continue: async () => { throw options.fail() },
      abort: () => {},
      state: { messages: [] },
    },
    refreshAskUserOffer: () => {},
    refreshSystemPrompt: () => {},
    refreshCodemodeTool: () => {},
    processEvent: (event: { type: string }) => (event.type === 'agent_start' ? [{ type: 'text', text: '' }] : []),
    sanitizeInMemoryHistory: () => false,
    clearMessages: () => {},
  }
}

async function drive(self: StandIn): Promise<{ chunks: Array<{ type: string; error?: string; rawError?: string }>; thrown: unknown }> {
  const run = (AgentRuntime.prototype as unknown as Record<string, (...args: unknown[]) => AsyncIterable<{ type: string; error?: string; rawError?: string }>>)
    .executePromptWithRetry!.call(self, `diktat ${MARKER}`, 'sess-clock-1')
  const chunks: Array<{ type: string; error?: string; rawError?: string }> = []
  let thrown: unknown = null
  const iterator = run[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      chunks.push(next.value)
      // Hold the generator at its yield for a moment (see the stand-in prompt).
      if (chunks.length === 1) await new Promise(res => setTimeout(res, 20))
    }
  } catch (err) {
    thrown = err
  }
  return { chunks, thrown }
}

let seen: unknown[] = []
let spies: Array<ReturnType<typeof vi.spyOn>> = []

beforeEach(() => {
  seen = []
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { seen.push(...args) }))
})

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
})

/** Everything any console level saw; Error objects with message and stack. */
function logged(): string {
  return seen.map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: 5 }))).join('\n')
}

const echo = (): Error => Object.assign(new Error(`400 invalid request: "${MARKER}"`), { status: 400 })

describe('agent runtime log safety (review K0-K2-3 #2)', () => {
  // Since review K0-K2-4 #2 the client chunk carries a fixed text plus class
  // too; the raw message stays in the in-process `rawError` for the runner.
  it('pre-stream error without fallback: class in the log and in the public chunk text', async () => {
    const { chunks, thrown } = await drive(standIn({ fail: echo }))
    expect(thrown).toBeNull()
    expect(chunks).toEqual([
      { type: 'error', error: 'The model provider reported an error (http_400).' },
      { type: 'done' },
    ])
    // In-process only: readable, but never enumerated, serialized or inspected.
    expect(chunks[0]!.rawError).toBe(`400 invalid request: "${MARKER}"`)
    expect(Object.keys(chunks[0]!)).not.toContain('rawError')
    expect(JSON.stringify(chunks)).not.toContain(MARKER)
    expect(inspect(chunks, { depth: 5 })).not.toContain(MARKER)
    expect(JSON.stringify({ ...chunks[0] })).not.toContain(MARKER)
    expect(logged()).not.toContain(MARKER)
    expect(logged()).toContain('Agent prompt error (pre-stream, session sess-clock-1): http_400')
  })

  it('pre-stream error with fallback: the swap notice carries the class only', async () => {
    const stop = new Error('stop after the swap notice')
    const providerManager = {
      getOperatingMode: () => 'normal',
      getFallbackProvider: () => ({ id: 'fallback' }),
      // The retry itself is not under test; stop right after the log line.
      swapToFallback: () => { throw stop },
    }
    const fail = (): Error => Object.assign(new Error(`503 overloaded, request was: ${MARKER}`), { status: 503 })
    const { thrown } = await drive(standIn({ fail, providerManager }))
    expect(thrown).toBe(stop)
    expect(logged()).not.toContain(MARKER)
    expect(logged()).toContain('[AgentRuntime] Pre-stream error detected (session sess-clock-1), swapping to fallback provider: http_503')
  })

  it('mid-stream error: class in the log and in the public chunk text', async () => {
    const { chunks, thrown } = await drive(standIn({ fail: echo, midStream: true }))
    expect(thrown).toBeNull()
    expect(chunks).toContainEqual({
      type: 'error',
      error: 'The model provider reported an error (http_400).',
    })
    expect(chunks.find(c => c.type === 'error')!.rawError).toBe(`400 invalid request: "${MARKER}"`)
    expect(JSON.stringify(chunks)).not.toContain(MARKER)
    expect(inspect(chunks, { depth: 5 })).not.toContain(MARKER)
    expect(logged()).not.toContain(MARKER)
    expect(logged()).toContain('Agent prompt error (mid-stream, session sess-clock-1): http_400')
    expect(logged()).toContain('Agent mid-stream error surfaced to user (session sess-clock-1): http_400')
  })
})
