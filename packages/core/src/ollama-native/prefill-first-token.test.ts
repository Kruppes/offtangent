import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { initDatabase } from '../database.js'
import type { Database } from '../database.js'
import { TurnRunner } from '../turn-runner.js'
import type { TurnAgentLike, TurnEvent } from '../turn-runner.js'
import type { ResponseChunk } from '../agent-runtime-types.js'
import { PROVIDER_STALL_KIND, formatProviderStallContent, parseProviderStallMetadata } from '../provider-stall.js'
import { streamNativeOllama } from './native-request.js'
import { isLocalInferenceBusy, resetLocalInferenceActivityForTest } from '../local-inference-activity.js'
import {
  NATIVE_FIRST_TOKEN_BASE_MS, NATIVE_FIRST_TOKEN_HARD_CAP_MS, nativeFirstTokenBudgetMs,
} from '../provider-phase.js'
import { summarizeNativeRequest, formatNativeRequestDiagnostics } from './request-diagnostics.js'

/*
 * Synthetic only (plan 2026-10-05-native-ollama-prefill-fix): fake clock, fake
 * inner stream, no network, no real model, no real conversation content.
 *
 * Repro of the 2026-10-05 incident shape: a native local request whose prompt
 * prefill takes ~120 s produces NO event until then. With one global 90 s idle
 * abort the turn died (and was retried into the same runner queue) before the
 * first token.
 */

const SESSION_ID = 'session-prefill-synthetic'
const USER_ID = 7
const THRESHOLDS = { stallWarnMs: 30_000, stallAbortMs: 90_000, watchdogIntervalMs: 1_000 }

function freshDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
  return db
}

function model(): Model<Api> {
  return {
    id: 'synthetic-native:1b', name: 'synthetic', api: 'ollama-chat' as Api, provider: 'synthetic-ollama', baseUrl: 'http://ollama.invalid:11434',
    reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024,
  } as Model<Api>
}

function message(text: string): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: 'ollama-chat', provider: 'synthetic-ollama', model: 'synthetic-native:1b',
    usage: { input: 30_000, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 30_003, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: 0,
  } as AssistantMessage
}

type Step = { afterMs: number; event: 'thinking' | 'text' | 'done' | 'error' | 'empty-done' }

/** Fake inner stream: silent for the prefill, then the scripted events. Honors abort. */
function fakeInner(steps: Step[], seen: { aborted: boolean }) {
  return (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
    const out = createAssistantMessageEventStream()
    void (async () => {
      const partial = message('')
      for (const step of steps) {
        const aborted = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), step.afterMs)
          options?.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(true) }, { once: true })
        })
        if (aborted) {
          seen.aborted = true
          out.push({ type: 'error', reason: 'aborted', error: { ...partial, stopReason: 'aborted', errorMessage: 'Request was aborted' } } as AssistantMessageEvent)
          out.end()
          return
        }
        if (step.event === 'thinking') out.push({ type: 'thinking_delta', contentIndex: 0, delta: '.', partial } as AssistantMessageEvent)
        if (step.event === 'text') out.push({ type: 'text_delta', contentIndex: 0, delta: 'answer', partial } as AssistantMessageEvent)
        if (step.event === 'error') {
          out.push({ type: 'error', reason: 'error', error: { ...partial, stopReason: 'error', errorMessage: 'synthetic runner failure' } } as AssistantMessageEvent)
          out.end()
          return
        }
        if (step.event === 'empty-done') {
          out.push({ type: 'done', reason: 'stop', message: message('') } as AssistantMessageEvent)
          out.end()
          return
        }
        if (step.event === 'done') {
          out.push({ type: 'done', reason: 'stop', message: message('answer') } as AssistantMessageEvent)
          out.end()
          return
        }
      }
    })()
    return out
  }
}

/** Agent that runs one native request per attempt through the real wrapper. */
function nativeAgent(steps: Step[], opts: { promptChars?: number; native?: boolean } = {}) {
  const seen = { aborted: false, attempts: 0, logs: [] as string[] }
  let controller = new AbortController()
  const context: Context = {
    systemPrompt: 'synthetic system',
    messages: [{ role: 'user', content: 'x'.repeat(opts.promptChars ?? 3_000), timestamp: 1 }],
  }
  const agent: TurnAgentLike = {
    sendMessage: async function* (): AsyncGenerator<ResponseChunk> {
      seen.attempts++
      controller = new AbortController()
      const inner = fakeInner(steps, seen)
      const stream = opts.native === false
        ? inner(model(), context, { signal: controller.signal })
        : streamNativeOllama(inner as never, model(), context, { signal: controller.signal } as SimpleStreamOptions, {
          loadFacts: async () => ({}), sessionId: SESSION_ID, log: (line) => { seen.logs.push(line) },
        })
      for await (const ev of stream) {
        if (ev.type === 'thinking_delta') yield { type: 'thinking', text: ev.delta }
        else if (ev.type === 'text_delta') yield { type: 'text', text: ev.delta }
        else if (ev.type === 'error') {
          yield { type: 'error', error: ev.error.errorMessage ?? 'error' }
          return
        } else if (ev.type === 'done') {
          yield { type: 'done' }
          return
        }
      }
    },
    abort: vi.fn(() => { controller.abort() }),
  }
  return { agent, seen }
}

function chunks(events: TurnEvent[]): ResponseChunk[] {
  return events.flatMap(e => (e.type === 'chunk' ? [e.chunk] : []))
}

function stallRows(db: Database) {
  return (db.prepare(`SELECT content, metadata FROM chat_messages WHERE role = 'system' AND json_extract(metadata, '$.kind') = ?`)
    .all(PROVIDER_STALL_KIND) as Array<{ content: string; metadata: string }>)
    .map(r => ({ content: r.content, metadata: parseProviderStallMetadata(r.metadata)! }))
}

function start(agent: TurnAgentLike, overrides: Record<string, unknown> = {}) {
  const db = freshDb()
  const runner = new TurnRunner({ db, getAgent: () => agent, ...THRESHOLDS, ...overrides })
  const events: TurnEvent[] = []
  runner.subscribe(USER_ID, (e) => { events.push(e) })
  runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'synthetic' })
  return { db, runner, events }
}

describe('native first-token budget', () => {
  afterEach(() => { vi.useRealTimers(); resetLocalInferenceActivityForTest() })

  it('is explicit, conservative and bounded', () => {
    expect(nativeFirstTokenBudgetMs(0, 90_000)).toBe(NATIVE_FIRST_TOKEN_BASE_MS)
    expect(nativeFirstTokenBudgetMs(undefined, 90_000)).toBe(NATIVE_FIRST_TOKEN_BASE_MS)
    expect(nativeFirstTokenBudgetMs(Number.NaN, 90_000)).toBe(NATIVE_FIRST_TOKEN_BASE_MS)
    // 30k uncached tokens at the assumed 100 tok/s = 300 s + 120 s allowance.
    expect(nativeFirstTokenBudgetMs(30_000, 90_000)).toBe(420_000)
    // Never shorter than the regular abort threshold.
    expect(nativeFirstTokenBudgetMs(0, 200_000)).toBe(200_000)
    // Hard ceiling for huge prompts.
    expect(nativeFirstTokenBudgetMs(10_000_000, 90_000)).toBe(NATIVE_FIRST_TOKEN_HARD_CAP_MS)
  })

  it('CONTROL (unchanged for non-native providers): 120 s of silence still aborts at the regular 90 s', async () => {
    vi.useFakeTimers()
    const { agent } = nativeAgent([{ afterMs: 120_000, event: 'text' }, { afterMs: 1, event: 'done' }], { native: false })
    const { events } = start(agent, { retryPolicy: { enabled: false } })
    await vi.advanceTimersByTimeAsync(95_000)
    const err = chunks(events).find(c => c.type === 'error')
    expect(err?.error).toContain('Provider stopped responding')
  })

  it('native: 120 s prefill then output completes instead of being aborted at 90 s', async () => {
    vi.useFakeTimers()
    const { agent, seen } = nativeAgent([
      { afterMs: 120_000, event: 'thinking' },
      { afterMs: 5_000, event: 'text' },
      { afterMs: 1, event: 'done' },
    ])
    const { db, runner, events } = start(agent)
    // H5: while the native request prefills, background work on the same
    // server+model sees the runner as busy (Legacy /v1 URL of the same server too).
    await vi.advanceTimersByTimeAsync(60_000)
    expect(isLocalInferenceBusy('http://ollama.invalid:11434/v1', 'synthetic-native:1b')).toBe(true)
    await vi.advanceTimersByTimeAsync(70_000)
    // Request over and no AgentCore turn holds the key (F9): idle at once, no linger.
    expect(isLocalInferenceBusy('http://ollama.invalid:11434', 'synthetic-native:1b')).toBe(false)

    const types = chunks(events).map(c => c.type)
    expect(types).not.toContain('error')
    expect(types).toContain('text')
    expect(types).toContain('done')
    expect(seen.attempts).toBe(1)
    expect(seen.aborted).toBe(false)
    expect(runner.hasActiveTurn(USER_ID)).toBe(false)

    // Transparent: the wait was shown as prompt processing and resolved.
    const warn = chunks(events).find(c => c.type === 'stall_warning')
    expect(warn?.text).toContain('Local model is still processing the prompt')
    const rows = stallRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.metadata.phase).toBe('first_token')
    expect(rows[0]!.metadata.outcome).toBe('recovered')
    // ~3000 chars → ~1000 conservative tokens → base allowance + ~10 s.
    expect(rows[0]!.metadata.estimatedInputTokens).toBeGreaterThan(1_000)
    expect(rows[0]!.metadata.budgetMs).toBe(nativeFirstTokenBudgetMs(rows[0]!.metadata.estimatedInputTokens, 90_000))

    // Data-minimal diagnostics: counts/lengths only, never the content.
    const diag = seen.logs.find(l => l.startsWith('[native-diag] req=') && l.includes('msgs='))!
    expect(diag).toContain('msgs=1')
    expect(diag).toContain('roles=user=1')
    expect(diag).toContain('chars=3000')
    expect(diag).not.toContain('xxxx')
    expect(diag).not.toContain('synthetic system')
    expect(seen.logs.some(l => /end=done .*first_output_ms=120000/.test(l))).toBe(true)
  })

  it('native: a request that never produces output is aborted at its bounded budget, immediately and without auto-retry', async () => {
    vi.useFakeTimers()
    const { agent, seen } = nativeAgent([{ afterMs: 10 * 60 * 60_000, event: 'text' }], { promptChars: 30_000 })
    const { db, runner, events } = start(agent)
    const budget = nativeFirstTokenBudgetMs(Math.ceil(30_000 / 3) + 10, 90_000)

    await vi.advanceTimersByTimeAsync(budget - 5_000)
    expect(chunks(events).some(c => c.type === 'error')).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)
    const err = chunks(events).find(c => c.type === 'error')
    expect(err?.error).toContain('first-token budget')
    expect(seen.aborted).toBe(true)
    expect(seen.attempts).toBe(1)
    expect(chunks(events).some(c => c.type === 'retry_scheduled')).toBe(false)
    expect(runner.hasActiveTurn(USER_ID)).toBe(false)
    const rows = stallRows(db)
    expect(rows[rows.length - 1]!.metadata).toMatchObject({ phase: 'first_token', outcome: 'aborted' })
  })

  it('native: a hang AFTER the first output keeps the regular bounded stall protection', async () => {
    vi.useFakeTimers()
    const { agent, seen } = nativeAgent([
      { afterMs: 10_000, event: 'thinking' },
      { afterMs: 10 * 60 * 60_000, event: 'text' },
    ])
    const { events } = start(agent, { retryPolicy: { enabled: false } })
    await vi.advanceTimersByTimeAsync(10_000 + 95_000)
    const err = chunks(events).find(c => c.type === 'error')
    expect(err?.error).toContain('Provider stopped responding')
    expect(seen.aborted).toBe(true)
  })

  it('user cancel during the first-token wait aborts the native request at once', async () => {
    vi.useFakeTimers()
    const { agent, seen } = nativeAgent([{ afterMs: 10 * 60 * 60_000, event: 'text' }])
    const { runner } = start(agent)
    await vi.advanceTimersByTimeAsync(60_000)
    runner.abortTurn(USER_ID)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen.aborted).toBe(true)
    expect(runner.hasActiveTurn(USER_ID)).toBe(false)
  })

  // Review F2: the end of a request WITHOUT a first token must never be shown
  // as "started answering" — only real output is a recovery.
  it('F2: a provider error before the first token closes the wait as error, not recovered', async () => {
    vi.useFakeTimers()
    const { agent } = nativeAgent([{ afterMs: 45_000, event: 'error' }])
    const { db, runner, events } = start(agent, { retryPolicy: { enabled: false } })
    await vi.advanceTimersByTimeAsync(46_000)
    expect(runner.hasActiveTurn(USER_ID)).toBe(false)
    const rows = stallRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.metadata).toMatchObject({ phase: 'first_token', outcome: 'error' })
    expect(rows[0]!.content).not.toContain('started answering')
    const resolved = chunks(events).filter(c => c.type === 'stall_resolved')
    expect(resolved.map(c => c.stall?.outcome)).toEqual(['error'])
  })

  it('F2: a user cancel during the first-token wait closes the wait as canceled, not recovered', async () => {
    vi.useFakeTimers()
    const { agent } = nativeAgent([{ afterMs: 10 * 60 * 60_000, event: 'text' }])
    const { db, runner } = start(agent)
    await vi.advanceTimersByTimeAsync(60_000)
    runner.abortTurn(USER_ID)
    await vi.advanceTimersByTimeAsync(1)
    const rows = stallRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.metadata).toMatchObject({ phase: 'first_token', outcome: 'canceled' })
    expect(rows[0]!.content).not.toContain('started answering')
  })

  it('F2: a request that ends without any output closes the wait as ended, not recovered', async () => {
    vi.useFakeTimers()
    const { agent } = nativeAgent([{ afterMs: 45_000, event: 'empty-done' }])
    const { db, runner } = start(agent, { retryPolicy: { enabled: false } })
    await vi.advanceTimersByTimeAsync(46_000)
    expect(runner.hasActiveTurn(USER_ID)).toBe(false)
    const rows = stallRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.metadata).toMatchObject({ phase: 'first_token', outcome: 'ended' })
    expect(rows[0]!.content).not.toContain('started answering')
  })

  it('F2: texts of the no-output outcomes never claim an answer started', () => {
    for (const outcome of ['ended', 'error', 'canceled'] as const) {
      const text = formatProviderStallContent({ startedAt: '', durationMs: 50_000, outcome, phase: 'first_token', budgetMs: 100_000 } as never)
      expect(text).not.toContain('started answering')
      expect(text).toContain('no output')
    }
  })
})

describe('native request diagnostics', () => {
  it('reports counts, roles, lengths and Eco markers, never text; hashes only when opted in', () => {
    const context = {
      systemPrompt: 'SECRET-SYSTEM',
      messages: [
        { role: 'user', content: 'SECRET-USER-TEXT', timestamp: 1 },
        { role: 'toolResult', toolCallId: 'c1', toolName: 'read_file', content: [{ type: 'text', text: 'SECRET-TOOL' }], details: { eco: { rowId: 1 } }, isError: false, timestamp: 2 },
        { role: 'toolResult', toolCallId: 'c2', toolName: 'read_file', content: [{ type: 'text', text: 'SECRET-TOOL' }], isError: false, timestamp: 3 },
      ],
    } as unknown as Context
    const plain = summarizeNativeRequest(context, false)
    expect(plain).toMatchObject({ messageCount: 3, roles: { user: 1, toolResult: 2 }, ecoFrozenResults: 1, systemChars: 13 })
    expect(plain.perMessage).toEqual(['u:16', 't:11', 't:11'])
    const hashed = summarizeNativeRequest(context, true)
    expect(hashed.perMessage[1]).toMatch(/^t:11:[0-9a-f]{8}$/)
    // Identical content → identical keyed hash inside one process (doubling detection).
    expect(hashed.perMessage[1]!.split(':')[2]).toBe(hashed.perMessage[2]!.split(':')[2])
    const line = formatNativeRequestDiagnostics({ requestId: 'r1', estimatedInputTokens: 10, diag: hashed })
    expect(line).not.toContain('SECRET')
  })

  it('stall text for a first-token wait names the phase and budget', () => {
    expect(formatProviderStallContent({ startedAt: 'x', durationMs: 31_000, phase: 'first_token', budgetMs: 420_000, estimatedInputTokens: 30_000 }))
      .toContain('waiting up to 420s')
  })
})
