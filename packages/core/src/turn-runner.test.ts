import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike, TurnEvent, TurnInfo } from './turn-runner.js'
import type { ResponseChunk, TurnErrorInfo } from './agent-runtime-types.js'
import { PROVIDER_STALL_KIND } from './provider-stall.js'
import type { ProviderStallMetadata } from './provider-stall.js'
import { TURN_ERROR_KIND, parseTurnErrorMetadata } from './turn-error.js'
import type { TurnErrorMetadata } from './turn-error.js'
import type { Database } from './database.js'

const SESSION_ID = 'session-turn-runner'
const USER_ID = 7

interface ChatRow {
  role: string
  content: string
  metadata: string | null
}

function rows(db: Database): ChatRow[] {
  return db.prepare(
    'SELECT role, content, metadata FROM chat_messages WHERE session_id = ? ORDER BY id'
  ).all(SESSION_ID) as ChatRow[]
}

interface StallRow {
  id: number
  content: string
  metadata: ProviderStallMetadata
}

function stallRows(db: Database): StallRow[] {
  const all = db.prepare(
    'SELECT id, role, content, metadata FROM chat_messages WHERE session_id = ? ORDER BY id'
  ).all(SESSION_ID) as Array<{ id: number; role: string; content: string; metadata: string | null }>

  return all
    .map(r => ({ id: r.id, content: r.content, metadata: JSON.parse(r.metadata ?? '{}') as ProviderStallMetadata }))
    .filter(r => r.metadata.kind === PROVIDER_STALL_KIND)
}

interface ErrorRow {
  id: number
  content: string
  metadata: TurnErrorMetadata
}

function errorRows(db: Database): ErrorRow[] {
  const all = db.prepare(
    'SELECT id, role, content, metadata FROM chat_messages WHERE session_id = ? ORDER BY id'
  ).all(SESSION_ID) as Array<{ id: number; role: string; content: string; metadata: string | null }>

  return all
    .map(r => ({ id: r.id, role: r.role, content: r.content, metadata: parseTurnErrorMetadata(r.metadata) }))
    .filter((r): r is ErrorRow & { role: string } => r.metadata !== null)
}

function errorChunk(events: TurnEvent[]): ResponseChunk | undefined {
  return events
    .filter(e => e.type === 'chunk')
    .map(e => (e as { chunk: ResponseChunk }).chunk)
    .find(c => c.type === 'error')
}

function stallChunks(events: TurnEvent[]): ResponseChunk[] {
  return events
    .filter(e => e.type === 'chunk')
    .map(e => (e as { chunk: ResponseChunk }).chunk)
    .filter(c => c.type === 'stall_warning' || c.type === 'stall_resolved')
}

/** Points config lookups at an isolated `settings.json` for the test. */
function useSettingsFile(settings: Record<string, unknown>): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-turn-runner-'))
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'settings.json'), JSON.stringify(settings), 'utf-8')
  process.env.DATA_DIR = dir
}

function freshDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
  return db
}

/** An agent whose stream is driven manually so tests control chunk timing. */
function controllableAgent() {
  const queue: ResponseChunk[] = []
  const waiters: Array<() => void> = []
  let done = false
  let failure: Error | null = null

  const wake = () => { while (waiters.length) waiters.shift()!() }

  const push = (chunk: ResponseChunk) => { queue.push(chunk); wake() }
  const finish = () => { done = true; wake() }
  const fail = (err: Error) => { failure = err; wake() }

  const agent: TurnAgentLike = {
    sendMessage: async function* () {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        if (failure) throw failure
        if (done) return
        await new Promise<void>((resolve) => { waiters.push(resolve) })
      }
    },
    abort: vi.fn(() => { done = true; wake() }),
  }

  return { agent, push, finish, fail }
}

function scriptedAgent(chunks: ResponseChunk[]): TurnAgentLike {
  return {
    sendMessage: async function* () {
      for (const chunk of chunks) yield chunk
    },
    abort: vi.fn(),
  }
}

/**
 * An agent that plays a different script per attempt (the last script repeats),
 * so retry behavior can be driven without timing games.
 */
function sequenceAgent(scripts: ResponseChunk[][]) {
  const calls: string[] = []
  const agent: TurnAgentLike = {
    sendMessage: async function* (): AsyncGenerator<ResponseChunk> {
      const script = scripts[Math.min(calls.length, scripts.length - 1)]!
      calls.push('sendMessage')
      for (const chunk of script) yield chunk
    },
    retryTurn: async function* (): AsyncGenerator<ResponseChunk> {
      const script = scripts[Math.min(calls.length, scripts.length - 1)]!
      calls.push('retryTurn')
      for (const chunk of script) yield chunk
    },
    abort: vi.fn(),
  }
  return { agent, calls }
}

/** First attempt hangs until aborted, later attempts play `followUp`. */
function stallingThenAnsweringAgent(followUp: ResponseChunk[]) {
  let attempts = 0
  let release: (() => void) | null = null
  const stream = async function* (): AsyncGenerator<ResponseChunk> {
    attempts++
    if (attempts === 1) {
      await new Promise<void>((resolve) => { release = resolve })
      return
    }
    for (const chunk of followUp) yield chunk
  }

  const agent: TurnAgentLike = {
    sendMessage: stream,
    retryTurn: stream,
    abort: vi.fn(() => { release?.() }),
  }
  return { agent, attempts: () => attempts }
}

function retryChunks(events: TurnEvent[]): ResponseChunk[] {
  return events
    .filter(e => e.type === 'chunk')
    .map(e => (e as { chunk: ResponseChunk }).chunk)
    .filter(c => c.type === 'retry_scheduled')
}

function collect(events: TurnEvent[]) {
  return (event: TurnEvent) => { events.push(event) }
}

function chunkTypes(events: TurnEvent[]): string[] {
  return events.filter(e => e.type === 'chunk').map(e => (e as { chunk: ResponseChunk }).chunk.type)
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function startRunner(db: Database, agent: TurnAgentLike | null, overrides = {}) {
  return new TurnRunner({ db, getAgent: () => agent, ...overrides })
}

describe('TurnRunner', () => {
  it('replays the buffered partial turn to a consumer that attaches mid-turn, then continues live', async () => {
    const db = freshDb()
    const { agent, push, finish } = controllableAgent()
    const runner = startRunner(db, agent)

    const first: TurnEvent[] = []
    const detachFirst = runner.subscribe(USER_ID, collect(first))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })

    push({ type: 'thinking', thinking: 'Hmm,' })
    push({ type: 'text', text: 'Partial' })
    await waitFor(() => chunkTypes(first).length === 2)

    // The driving consumer disappears (page reload / socket drop).
    detachFirst()

    const late: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(late))

    // Replay: turn_start + both chunks so far, all flagged as replay.
    expect(late.map(e => e.type)).toEqual(['turn_start', 'chunk', 'chunk'])
    expect(late.every(e => e.replay === true)).toBe(true)
    expect(chunkTypes(late)).toEqual(['thinking', 'text'])
    // Every event (not only turn_start) names the thread it belongs to, so a
    // client with several open threads of one persona can route it.
    expect(late.every(e => e.sessionId === SESSION_ID)).toBe(true)

    // …and then live continuation on the same subscription.
    push({ type: 'text', text: ' rest' })
    push({ type: 'done' })
    finish()
    await waitFor(() => late.some(e => e.type === 'turn_end'))

    const liveTexts = late
      .filter(e => e.type === 'chunk' && !e.replay)
      .map(e => (e as { chunk: ResponseChunk }).chunk)
      .filter(c => c.type === 'text')
      .map(c => c.text)
    expect(liveTexts).toEqual([' rest'])

    // The turn kept running while nobody was attached, and the full response
    // (both halves) was persisted.
    const assistant = rows(db).filter(r => r.role === 'assistant' && !r.metadata)
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toBe('Partial rest')
  })

  it('delivers identical streams to multiple concurrent subscribers', async () => {
    const db = freshDb()
    const runner = startRunner(db, scriptedAgent([
      { type: 'thinking', thinking: 'think' },
      { type: 'text', text: 'answer' },
      { type: 'done' },
    ]))

    const tabA: TurnEvent[] = []
    const tabB: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(tabA))
    runner.subscribe(USER_ID, collect(tabB))

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => tabA.some(e => e.type === 'turn_end'))

    expect(chunkTypes(tabA)).toEqual(['thinking', 'text', 'done'])
    expect(tabB).toEqual(tabA)
  })

  it('keeps the turn running and persists the response when every consumer detaches', async () => {
    const db = freshDb()
    const { agent, push, finish } = controllableAgent()
    const runner = startRunner(db, agent)

    const events: TurnEvent[] = []
    const detach = runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })

    push({ type: 'text', text: 'start' })
    await waitFor(() => chunkTypes(events).length === 1)
    detach()

    expect(runner.hasActiveTurn(USER_ID)).toBe(true)
    expect(agent.abort).not.toHaveBeenCalled()

    push({ type: 'text', text: '-end' })
    push({ type: 'done' })
    finish()
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const assistant = rows(db).filter(r => r.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toBe('start-end')
  })

  it('reports a live turn per session (strand_busy guard, SPEC 7.5b)', async () => {
    const db = freshDb()
    const { agent, push, finish } = controllableAgent()
    const runner = startRunner(db, agent)

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })

    push({ type: 'text', text: 'working' })
    await waitFor(() => chunkTypes(events).length === 1)

    expect(runner.hasActiveTurnInSession(USER_ID, SESSION_ID)).toBe(true)
    // A turn in ANOTHER strand of the same user must not block that strand.
    expect(runner.hasActiveTurnInSession(USER_ID, 'other-session')).toBe(false)
    expect(runner.hasActiveTurnInSession(999, SESSION_ID)).toBe(false)

    push({ type: 'done' })
    finish()
    await waitFor(() => !runner.hasActiveTurn(USER_ID))
    expect(runner.hasActiveTurnInSession(USER_ID, SESSION_ID)).toBe(false)
  })

  it('tells send_file_to_user whether a persisting turn carries this strand', async () => {
    const db = freshDb()
    const { agent, push, finish } = controllableAgent()
    const runner = startRunner(db, agent)

    // No turn yet: a file handed over now would never reach a row.
    expect(runner.hasPersistingTurnInSession(SESSION_ID)).toBe(false)

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    push({ type: 'text', text: 'working' })
    await waitFor(() => chunkTypes(events).length === 1)

    // Matched by strand id alone — the runner key differs per channel.
    expect(runner.hasPersistingTurnInSession(SESSION_ID)).toBe(true)
    expect(runner.hasPersistingTurnInSession('other-session')).toBe(false)

    push({ type: 'done' })
    finish()
    await waitFor(() => !runner.hasActiveTurn(USER_ID))
    expect(runner.hasPersistingTurnInSession(SESSION_ID)).toBe(false)
  })

  it('reports no carrier for a turn without a numeric user (channel that persists nothing)', async () => {
    const db = freshDb()
    const { agent, push, finish } = controllableAgent()
    const runner = startRunner(db, agent)
    const events: TurnEvent[] = []
    runner.subscribe('tg:42', collect(events))
    runner.startTurn({ userId: null, agentUserId: 'tg:42', sessionId: SESSION_ID, text: 'hi' })
    push({ type: 'text', text: 'working' })
    await waitFor(() => chunkTypes(events).length === 1)

    // The transcript of such a turn writes nothing, so the tool must deliver
    // the file itself instead of trusting the turn.
    expect(runner.hasPersistingTurnInSession(SESSION_ID)).toBe(false)

    push({ type: 'done' })
    finish()
    await waitFor(() => !runner.hasActiveTurn('tg:42'))
  })

  it('persists thinking, tool and assistant rows in stream order', async () => {
    const db = freshDb()
    const runner = startRunner(db, scriptedAgent([
      { type: 'thinking', thinking: 'Hmm,' },
      { type: 'thinking', thinking: ' ok.' },
      { type: 'tool_call_start', toolName: 'search', toolCallId: 'tc-1', toolArgs: { q: 'x' } },
      { type: 'tool_call_end', toolName: 'search', toolCallId: 'tc-1', toolResult: { ok: true } },
      { type: 'text', text: 'Answer.' },
      { type: 'done' },
    ]))

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const persisted = rows(db)
    expect(persisted.map(r => r.role)).toEqual(['assistant', 'tool', 'assistant'])

    expect(JSON.parse(persisted[0]!.metadata!)).toEqual({ kind: 'thinking' })
    expect(persisted[0]!.content).toBe('Hmm, ok.')

    expect(persisted[1]!.content).toBe('Tool: search')
    expect(JSON.parse(persisted[1]!.metadata!)).toEqual({
      toolName: 'search',
      toolCallId: 'tc-1',
      toolArgs: { q: 'x' },
      toolResult: { ok: true },
      toolIsError: false,
    })

    expect(persisted[2]!.content).toBe('Answer.')
    expect(persisted[2]!.metadata).toBeNull()
  })

  it('emits and persists preamble tool calls ahead of the agent stream', async () => {
    const db = freshDb()
    const runner = startRunner(db, scriptedAgent([{ type: 'text', text: 'Answer.' }, { type: 'done' }]))
    const events: TurnEvent[] = []
    runner.subscribe(String(USER_ID), collect(events))

    runner.startTurn({
      userId: USER_ID,
      sessionId: SESSION_ID,
      text: 'hi',
      preambleToolCalls: [{ toolName: 'read_file', toolArgs: { path: '/x/SKILL.md' }, toolResult: { ok: true } }],
    })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(chunkTypes(events)).toEqual(['tool_call_start', 'tool_call_end', 'text', 'done'])
    const persisted = rows(db)
    expect(persisted.map(r => r.role)).toEqual(['tool', 'assistant'])
    const meta = JSON.parse(persisted[0]!.metadata!)
    expect(meta).toMatchObject({ toolName: 'read_file', toolArgs: { path: '/x/SKILL.md' }, toolResult: { ok: true }, toolIsError: false })
    expect(meta.toolCallId).toMatch(/^preamble-/)
  })

  it('emits an attachment event and merges uploads into the assistant row metadata', async () => {
    const db = freshDb()
    const upload = {
      kind: 'file' as const,
      originalName: 'report.md',
      storedName: 'abc-report.md',
      relativePath: '2026/04/20/abc-report.md',
      urlPath: '/api/uploads/2026/04/20/abc-report.md',
      mimeType: 'text/markdown',
      size: 42,
    }
    const runner = startRunner(db, scriptedAgent([
      { type: 'tool_call_start', toolName: 'send_file_to_user', toolCallId: 'tc-1' },
      { type: 'tool_call_end', toolName: 'send_file_to_user', toolCallId: 'tc-1', toolResult: { details: { uploadedFile: upload } } },
      { type: 'text', text: 'Here you go.' },
      { type: 'done' },
    ]))

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'file please' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const attachments = events.filter(e => e.type === 'attachment')
    expect(attachments).toHaveLength(1)

    const assistantRow = rows(db).find(r => r.role === 'assistant')!
    const meta = JSON.parse(assistantRow.metadata!) as { files: Array<{ relativePath: string }> }
    expect(meta.files[0]!.relativePath).toBe(upload.relativePath)
  })

  it('keeps the caption of an attachment on the event and in the assistant row metadata', async () => {
    const db = freshDb()
    const upload = {
      kind: 'image' as const,
      originalName: 'chart.png',
      storedName: 'abc-chart.png',
      relativePath: '2026/09/14/abc-chart.png',
      urlPath: '/api/uploads/2026/09/14/abc-chart.png',
      mimeType: 'image/png',
      size: 4096,
      caption: 'Probe-Diagramm (400x300 PNG)',
    }
    const runner = startRunner(db, scriptedAgent([
      { type: 'tool_call_start', toolName: 'send_file_to_user', toolCallId: 'tc-1' },
      { type: 'tool_call_end', toolName: 'send_file_to_user', toolCallId: 'tc-1', toolResult: { details: { uploadedFile: upload, caption: upload.caption } } },
      { type: 'done' },
    ]))

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'chart please' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const attachment = events.find(e => e.type === 'attachment')
    expect(attachment && 'attachment' in attachment ? attachment.attachment.caption : undefined)
      .toBe('Probe-Diagramm (400x300 PNG)')

    const assistantRow = rows(db).find(r => r.role === 'assistant')!
    const meta = JSON.parse(assistantRow.metadata!) as { files: Array<{ caption?: string }> }
    expect(meta.files[0]!.caption).toBe('Probe-Diagramm (400x300 PNG)')
  })

  it('aborts the running turn, propagates the abort to the agent and still emits done', async () => {
    const db = freshDb()
    const { agent, push } = controllableAgent()
    const runner = startRunner(db, agent)

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })

    push({ type: 'thinking', thinking: 'half a thought' })
    await waitFor(() => chunkTypes(events).length === 1)

    expect(runner.abortTurn(USER_ID)).toBe(true)
    expect(agent.abort).toHaveBeenCalledTimes(1)
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(chunkTypes(events)).toEqual(['thinking', 'done'])
    // Partial reasoning survives the abort so a reload shows what happened.
    const thinkingRow = rows(db).find(r => r.metadata?.includes('thinking'))
    expect(thinkingRow!.content).toBe('half a thought')
    // No assistant text was produced, so no empty assistant row is written.
    expect(rows(db).filter(r => r.role === 'assistant' && !r.metadata)).toHaveLength(0)

    expect(runner.abortTurn(USER_ID)).toBe(false)
  })

  it('reports an agent error as an error chunk followed by done', async () => {
    const db = freshDb()
    const runner = startRunner(db, {
      sendMessage: async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'partial' }
        throw new Error('provider exploded')
      },
      abort: vi.fn(),
    })

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(chunkTypes(events)).toEqual(['text', 'error', 'done'])
    const errorChunk = events.find(e => e.type === 'chunk' && e.chunk.type === 'error') as { chunk: ResponseChunk }
    expect(errorChunk.chunk.error).toContain('provider exploded')
  })

  it('does not replay or resurrect anything for a fresh runner over the same database', async () => {
    const db = freshDb()
    const { agent, push } = controllableAgent()
    const runner = startRunner(db, agent)

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    push({ type: 'thinking', thinking: 'mid-flight' })
    push({ type: 'text', text: 'partial answer' })
    await waitFor(() => rows(db).length === 1)

    const rowsBefore = rows(db).length

    // Simulate a backend restart: a brand-new runner over the same DB.
    const restarted = startRunner(db, agent)
    const events: TurnEvent[] = []
    restarted.subscribe(USER_ID, collect(events))

    expect(events).toEqual([])
    expect(restarted.hasActiveTurn(USER_ID)).toBe(false)
    expect(rows(db)).toHaveLength(rowsBefore)
  })

  it('replays a just-finished turn inside the retention window and nothing after it', async () => {
    const db = freshDb()
    const runner = startRunner(db, scriptedAgent([
      { type: 'text', text: 'done already' },
      { type: 'done' },
    ]), { completedTurnRetentionMs: 60_000 })

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const reconnect: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(reconnect))
    expect(reconnect.map(e => e.type)).toEqual(['turn_start', 'chunk', 'chunk', 'turn_end'])
    expect(reconnect.every(e => e.replay === true)).toBe(true)

    const expired = startRunner(db, scriptedAgent([{ type: 'done' }]), { completedTurnRetentionMs: 0 })
    expired.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !expired.hasActiveTurn(USER_ID))
    const nothing: TurnEvent[] = []
    expired.subscribe(USER_ID, collect(nothing))
    expect(nothing).toEqual([])
  })

  it('serializes concurrent turns for the same user', async () => {
    const db = freshDb()
    const seen: string[] = []
    const runner = startRunner(db, {
      sendMessage: async function* (_userId: string, text: string): AsyncGenerator<ResponseChunk> {
        seen.push(`start:${text}`)
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        yield { type: 'text', text }
        yield { type: 'done' }
        seen.push(`end:${text}`)
      },
      abort: vi.fn(),
    })

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'one' })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'two' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID), 2000)

    expect(seen).toEqual(['start:one', 'end:one', 'start:two', 'end:two'])
    expect(rows(db).map(r => r.content)).toEqual(['one', 'two'])
  })


  describe('stall watchdog', () => {
    const originalDataDir = process.env.DATA_DIR

    afterEach(() => {
      vi.useRealTimers()
      if (originalDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = originalDataDir
    })

    it('warns, persists a provider_stall row and resolves it in place when the provider recovers', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent, push, finish } = controllableAgent()
      const runner = startRunner(db, agent, {
        stallWarnMs: 30_000,
        stallAbortMs: 90_000,
        watchdogIntervalMs: 1_000,
      })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)

      // Nothing yet — the provider is merely slow, not stalled.
      await vi.advanceTimersByTimeAsync(29_000)
      expect(stallChunks(events)).toEqual([])

      await vi.advanceTimersByTimeAsync(2_000)
      const [warning] = stallChunks(events)
      expect(warning?.type).toBe('stall_warning')

      const persistedOnWarn = stallRows(db)
      expect(persistedOnWarn).toHaveLength(1)
      expect(persistedOnWarn[0]!.content).toContain('Provider has not responded')
      expect(persistedOnWarn[0]!.metadata.outcome).toBeNull()
      expect(persistedOnWarn[0]!.metadata.resolvedAt).toBeNull()
      expect(persistedOnWarn[0]!.metadata.durationMs).toBeGreaterThanOrEqual(30_000)
      // The row id travels on the chunk so live clients can update in place.
      expect(warning!.stall!.messageId).toBe(persistedOnWarn[0]!.id)

      push({ type: 'text', text: 'back' })
      await vi.advanceTimersByTimeAsync(1)

      const [, resolved] = stallChunks(events)
      expect(resolved?.type).toBe('stall_resolved')
      expect(resolved!.stall).toMatchObject({
        messageId: persistedOnWarn[0]!.id,
        startedAt: warning!.stall!.startedAt,
        outcome: 'recovered',
      })
      expect(resolved!.stall!.resolvedAt).toBeDefined()

      // Updated, not duplicated and not deleted.
      const persistedOnResolve = stallRows(db)
      expect(persistedOnResolve).toHaveLength(1)
      expect(persistedOnResolve[0]!.id).toBe(persistedOnWarn[0]!.id)
      expect(persistedOnResolve[0]!.metadata.outcome).toBe('recovered')
      expect(persistedOnResolve[0]!.metadata.durationMs).toBeGreaterThanOrEqual(31_000)
      expect(persistedOnResolve[0]!.content).toContain('Provider recovered')

      push({ type: 'done' })
      finish()
      await vi.advanceTimersByTimeAsync(1)
      expect(runner.hasActiveTurn(USER_ID)).toBe(false)
    })

    it('finalizes the stall row as aborted when the abort threshold is reached', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent } = controllableAgent()
      const runner = startRunner(db, agent, {
        stallWarnMs: 30_000,
        stallAbortMs: 90_000,
        watchdogIntervalMs: 1_000,
        // Retry behavior of a stall abort has its own test below.
        retryPolicy: { enabled: false },
      })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(31_000)
      expect(stallChunks(events).map(c => c.type)).toEqual(['stall_warning'])

      await vi.advanceTimersByTimeAsync(60_000)
      expect(chunkTypes(events)).toEqual(['stall_warning', 'stall_resolved', 'error', 'done'])

      const [, resolved] = stallChunks(events)
      expect(resolved!.stall!.outcome).toBe('aborted')
      expect(resolved!.stall!.durationMs).toBeGreaterThanOrEqual(90_000)

      const errorChunk = events.find(e => e.type === 'chunk' && e.chunk.type === 'error') as { chunk: ResponseChunk }
      expect(errorChunk.chunk.error).toContain('Provider stopped responding')
      expect(agent.abort).toHaveBeenCalled()

      const persisted = stallRows(db)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]!.metadata.outcome).toBe('aborted')
      expect(persisted[0]!.metadata.resolvedAt).not.toBeNull()
      expect(persisted[0]!.content).toContain('Provider stopped responding')
    })

    it('takes warn/abort thresholds from the settings file when not overridden', async () => {
      useSettingsFile({ watchdog: { stallWarnMs: 5_000, stallAbortMs: 12_000 } })
      vi.useFakeTimers()

      const db = freshDb()
      const { agent } = controllableAgent()
      const runner = startRunner(db, agent, { watchdogIntervalMs: 1_000 })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(4_000)
      expect(stallChunks(events)).toEqual([])

      await vi.advanceTimersByTimeAsync(2_000)
      expect(stallChunks(events).map(c => c.type)).toEqual(['stall_warning'])

      await vi.advanceTimersByTimeAsync(7_000)
      expect(stallChunks(events).map(c => c.type)).toEqual(['stall_warning', 'stall_resolved'])
      expect(stallRows(db)[0]!.metadata.outcome).toBe('aborted')
    })
  })

  describe('auto-retry', () => {
    const originalDataDir = process.env.DATA_DIR

    afterEach(() => {
      vi.useRealTimers()
      if (originalDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = originalDataDir
    })

    it('restarts the turn on transient errors with 2s/4s backoff and discards the failed attempts', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent, calls } = sequenceAgent([
        [{ type: 'text', text: 'half an answer' }, { type: 'error', error: '429 Too Many Requests' }, { type: 'done' }],
        [{ type: 'thinking', thinking: 'second try' }, { type: 'error', error: '503 Service Unavailable' }, { type: 'done' }],
        [{ type: 'text', text: 'Finally.' }, { type: 'done' }],
      ])
      const runner = startRunner(db, agent, {
        retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 2_000 },
      })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)

      expect(retryChunks(events).map(c => c.retry)).toMatchObject([
        { attempt: 1, maxRetries: 3, delayMs: 2_000, error: '429 Too Many Requests' },
      ])
      expect(retryChunks(events)[0]!.text).toContain('retrying (1/3)')

      // A consumer attaching during the backoff must not rebuild the partial
      // answer of the attempt that was just thrown away.
      const reattached: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(reattached))
      expect(reattached.map(e => e.type)).toEqual(['turn_start', 'chunk'])
      expect(chunkTypes(reattached)).toEqual(['retry_scheduled'])

      // Nothing happens before the backoff elapses.
      await vi.advanceTimersByTimeAsync(1_900)
      expect(calls).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(200)
      expect(calls).toHaveLength(2)
      expect(retryChunks(events).map(c => c.retry!.delayMs)).toEqual([2_000, 4_000])

      await vi.advanceTimersByTimeAsync(4_000)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(chunkTypes(events)).toEqual([
        'text', 'retry_scheduled', 'thinking', 'retry_scheduled', 'text', 'done',
      ])
      // The restarts continue the transcript instead of re-sending the message.
      expect(calls).toEqual(['sendMessage', 'retryTurn', 'retryTurn'])

      // Only the successful attempt survives: no duplicate user message, no
      // half answer and no thinking block from the discarded attempts.
      expect(rows(db).map(r => ({ role: r.role, content: r.content }))).toEqual([
        { role: 'assistant', content: 'Finally.' },
      ])
    })

    it('discards tool rows of a failed attempt', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent } = sequenceAgent([
        [
          { type: 'tool_call_start', toolName: 'search', toolCallId: 'tc-1' },
          { type: 'tool_call_end', toolName: 'search', toolCallId: 'tc-1', toolResult: { ok: true } },
          { type: 'error', error: 'fetch failed' },
        ],
        [{ type: 'text', text: 'answer' }, { type: 'done' }],
      ])
      const runner = startRunner(db, agent, { retryPolicy: { maxRetries: 1, baseDelayMs: 1_000 } })

      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      // The tool row written by the discarded attempt is rolled back.
      expect(rows(db).map(r => ({ role: r.role, content: r.content }))).toEqual([
        { role: 'assistant', content: 'answer' },
      ])
    })

    it('re-emits preamble tool calls on the retried attempt so exactly one row survives', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent } = sequenceAgent([
        [{ type: 'error', error: 'fetch failed' }],
        [{ type: 'text', text: 'answer' }, { type: 'done' }],
      ])
      const runner = startRunner(db, agent, { retryPolicy: { maxRetries: 1, baseDelayMs: 1_000 } })

      runner.startTurn({
        userId: USER_ID,
        sessionId: SESSION_ID,
        text: 'hi',
        preambleToolCalls: [{ toolName: 'read_file', toolArgs: { path: '/x/SKILL.md' }, toolResult: {} }],
      })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(rows(db).map(r => ({ role: r.role, content: r.content }))).toEqual([
        { role: 'tool', content: 'Tool: read_file' },
        { role: 'assistant', content: 'answer' },
      ])
    })

    it('retries a watchdog stall abort', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent, attempts } = stallingThenAnsweringAgent([
        { type: 'text', text: 'back from the dead' },
        { type: 'done' },
      ])
      const runner = startRunner(db, agent, {
        stallWarnMs: 30_000,
        stallAbortMs: 90_000,
        watchdogIntervalMs: 1_000,
        retryPolicy: { maxRetries: 3, baseDelayMs: 2_000 },
      })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(91_000)

      const [retry] = retryChunks(events)
      expect(retry?.retry).toMatchObject({ attempt: 1, delayMs: 2_000 })
      expect(retry!.retry!.error).toContain('Provider stopped responding')
      expect(agent.abort).toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(attempts()).toBe(2)
      expect(chunkTypes(events)).toEqual([
        'stall_warning', 'stall_resolved', 'retry_scheduled', 'text', 'done',
      ])
      // The stall notice is real history and stays, unlike the failed attempt.
      expect(stallRows(db)).toHaveLength(1)
      expect(rows(db).filter(r => r.role === 'assistant').map(r => r.content)).toEqual(['back from the dead'])
    })

    it('never retries a user abort', async () => {
      const db = freshDb()
      const { agent, push } = controllableAgent()
      const runner = startRunner(db, agent, { retryPolicy: { maxRetries: 3, baseDelayMs: 1 } })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })

      push({ type: 'text', text: 'partial' })
      await waitFor(() => chunkTypes(events).length === 1)
      runner.abortTurn(USER_ID)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(chunkTypes(events)).toEqual(['text', 'done'])
      expect(retryChunks(events)).toEqual([])
    })

    it('fails fast on terminal provider errors', async () => {
      const db = freshDb()
      const { agent, calls } = sequenceAgent([
        [{ type: 'error', error: 'insufficient_quota: You exceeded your current quota, please check your billing details' }],
        [{ type: 'text', text: 'never reached' }, { type: 'done' }],
      ])
      const runner = startRunner(db, agent, { retryPolicy: { maxRetries: 3, baseDelayMs: 1 } })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(chunkTypes(events)).toEqual(['error', 'done'])
      expect(calls).toHaveLength(1)
      const error = events.find(e => e.type === 'chunk' && e.chunk.type === 'error') as { chunk: ResponseChunk }
      expect(error.chunk.error).toContain('insufficient_quota')
    })

    it('ends in a terminal error chunk once the retry budget is exhausted', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent, calls } = sequenceAgent([
        [{ type: 'error', error: '502 Bad Gateway' }],
      ])
      const runner = startRunner(db, agent, { retryPolicy: { maxRetries: 2, baseDelayMs: 2_000 } })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(4_000)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(retryChunks(events).map(c => c.retry!.delayMs)).toEqual([2_000, 4_000])
      expect(chunkTypes(events)).toEqual(['retry_scheduled', 'retry_scheduled', 'error', 'done'])
      expect(calls).toHaveLength(3)
      const error = events.find(e => e.type === 'chunk' && e.chunk.type === 'error') as { chunk: ResponseChunk }
      expect(error.chunk.error).toBe('502 Bad Gateway')
    })

    it('takes the retry policy from the settings file when not overridden', async () => {
      useSettingsFile({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 500 } })
      vi.useFakeTimers()

      const db = freshDb()
      const { agent } = sequenceAgent([
        [{ type: 'error', error: 'socket hang up' }],
        [{ type: 'text', text: 'recovered' }, { type: 'done' }],
      ])
      const runner = startRunner(db, agent)

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)

      expect(retryChunks(events).map(c => c.retry)).toMatchObject([{ attempt: 1, maxRetries: 1, delayMs: 500 }])

      await vi.advanceTimersByTimeAsync(500)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))
      expect(chunkTypes(events)).toEqual(['retry_scheduled', 'text', 'done'])
    })

    it('does not retry when the policy is disabled in the settings file', async () => {
      useSettingsFile({ retry: { enabled: false } })
      const db = freshDb()
      const { agent, calls } = sequenceAgent([
        [{ type: 'error', error: '429 Too Many Requests' }],
        [{ type: 'text', text: 'never reached' }, { type: 'done' }],
      ])
      const runner = startRunner(db, agent)

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(chunkTypes(events)).toEqual(['error', 'done'])
      expect(calls).toHaveLength(1)
    })

    it('ends the turn when the user aborts during the retry backoff', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent, calls } = sequenceAgent([
        [{ type: 'error', error: '500 internal error' }],
        [{ type: 'text', text: 'never reached' }, { type: 'done' }],
      ])
      const runner = startRunner(db, agent, { retryPolicy: { maxRetries: 3, baseDelayMs: 10_000 } })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)
      expect(retryChunks(events)).toHaveLength(1)

      runner.abortTurn(USER_ID)
      await vi.advanceTimersByTimeAsync(0)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(chunkTypes(events)).toEqual(['retry_scheduled', 'done'])
      expect(calls).toHaveLength(1)
    })
  })

  describe('manual retry', () => {
    it('continues the transcript instead of re-sending the user message', async () => {
      const db = freshDb()
      const { agent, calls } = sequenceAgent([[{ type: 'text', text: 'Second time lucky.' }, { type: 'done' }]])
      const runner = startRunner(db, agent)

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.retryTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(calls).toEqual(['retryTurn'])
      expect(chunkTypes(events)).toEqual(['text', 'done'])
      // The answer streams like a normal turn and no user row is duplicated:
      // the runner never writes one, and the agent continues the transcript.
      expect(rows(db).map(r => ({ role: r.role, content: r.content }))).toEqual([
        { role: 'assistant', content: 'Second time lucky.' },
      ])
    })

    it('falls back to a fresh prompt when the agent cannot continue', async () => {
      const db = freshDb()
      const agent = scriptedAgent([{ type: 'text', text: 'answer' }, { type: 'done' }])
      const runner = startRunner(db, agent)

      runner.retryTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(rows(db).map(r => r.content)).toEqual(['answer'])
    })
  })

  describe('terminal errors', () => {
    afterEach(() => { vi.useRealTimers() })

    it('persists a non-retryable provider error with its full text', async () => {
      const db = freshDb()
      const providerError = 'AuthenticationError: 401 Unauthorized — token refresh failed for provider "anthropic"'
      const runner = startRunner(db, scriptedAgent([{ type: 'error', error: providerError }]))

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      const persisted = errorRows(db)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]!.content).toContain(providerError)
      expect(persisted[0]!.metadata).toMatchObject({
        kind: TURN_ERROR_KIND,
        cause: 'non_retryable',
        error: providerError,
        attempts: 0,
        retryable: false,
      })
      expect(Date.parse(persisted[0]!.metadata.occurredAt)).not.toBeNaN()

      // The chunk mirrors the row (id + text), so live rendering and a history
      // reload produce the very same bubble.
      const chunk = errorChunk(events)!
      expect(chunk.error).toBe(providerError)
      expect(chunk.text).toBe(persisted[0]!.content)
      expect(chunk.errorInfo).toMatchObject({
        messageId: persisted[0]!.id,
        cause: 'non_retryable',
        retryable: false,
      })
    })

    it('marks an exhausted retry budget as retryable in the persisted metadata', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent } = sequenceAgent([[{ type: 'error', error: '502 Bad Gateway' }]])
      const runner = startRunner(db, agent, { retryPolicy: { maxRetries: 2, baseDelayMs: 1_000 } })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(2_000)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      const persisted = errorRows(db)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]!.metadata).toMatchObject({
        cause: 'retry_exhausted',
        error: '502 Bad Gateway',
        attempts: 2,
        retryable: true,
      })
      expect(persisted[0]!.content).toContain('after 2 retries')
      expect(errorChunk(events)!.errorInfo).toMatchObject({ cause: 'retry_exhausted', attempts: 2 })
    })

    it('replays the error notice to a consumer that attaches after the turn failed', async () => {
      const db = freshDb()
      const runner = startRunner(db, scriptedAgent([{ type: 'error', error: 'invalid_api_key' }]))

      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      // A page reload right after the failure: the reloaded client rebuilds the
      // bubble from the replay, keyed by the same persisted row id.
      const reconnect: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(reconnect))

      expect(chunkTypes(reconnect)).toEqual(['error', 'done'])
      expect(reconnect.every(e => e.replay === true)).toBe(true)
      expect(errorChunk(reconnect)!.errorInfo!.messageId).toBe(errorRows(db)[0]!.id)
    })

    it('hangs a retry action off the persisted error and announces the failure', async () => {
      const db = freshDb()
      const failures: Array<{ userId: number | null; sessionId: string; retryActionId?: string; messageId?: number }> = []
      const runner = startRunner(db, scriptedAgent([{ type: 'error', error: 'invalid_api_key' }]), {
        onTurnFailed: ({ turn, error }: { turn: TurnInfo; error: TurnErrorInfo }) => {
          failures.push({
            userId: turn.userId,
            sessionId: turn.sessionId,
            retryActionId: error.retryActionId,
            messageId: error.messageId,
          })
        },
      })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      const persisted = errorRows(db)[0]!
      const retryActionId = persisted.metadata.retryActionId
      expect(retryActionId).toMatch(/^turn-retry-/)
      // Live chunk, persisted row and failure hook agree on the action id, so
      // the button is the same one before and after a reload.
      expect(errorChunk(events)!.errorInfo!.retryActionId).toBe(retryActionId)
      expect(failures).toEqual([{
        userId: USER_ID,
        sessionId: SESSION_ID,
        retryActionId,
        messageId: persisted.id,
      }])
    })

    it('does not persist an error row for a user abort', async () => {
      const db = freshDb()
      const { agent, push } = controllableAgent()
      const runner = startRunner(db, agent)

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })

      push({ type: 'text', text: 'partial' })
      await waitFor(() => chunkTypes(events).length === 1)
      runner.abortTurn(USER_ID)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(errorRows(db)).toEqual([])
    })
  })

  it('surfaces a missing agent as a persisted error instead of hanging', async () => {
    const db = freshDb()
    const runner = startRunner(db, null)

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(chunkTypes(events)).toEqual(['error', 'done'])
    expect(errorRows(db)[0]!.metadata).toMatchObject({
      cause: 'agent_unavailable',
      error: 'Agent core not available',
      retryable: true,
    })
  })

  describe('lifecycle callbacks', () => {
    // Consumers use the pair as a gauge (active requests), so an unmatched end
    // would decrement a concurrently running turn.
    it('pairs onTurnStart with onTurnEnd even when the turn never reaches the agent', async () => {
      const db = freshDb()
      const started: TurnInfo[] = []
      const ended: TurnInfo[] = []
      const runner = startRunner(db, null, {
        onTurnStart: (turn: TurnInfo) => { started.push(turn) },
        onTurnEnd: (turn: TurnInfo) => { ended.push(turn) },
      })

      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(started.map(t => t.turnId)).toEqual(ended.map(t => t.turnId))
      expect(started).toHaveLength(1)
    })

    it('pairs the callbacks for a turn aborted before it started', async () => {
      const db = freshDb()
      const { agent } = controllableAgent()
      const started: TurnInfo[] = []
      const ended: TurnInfo[] = []
      const runner = startRunner(db, agent, {
        onTurnStart: (turn: TurnInfo) => { started.push(turn) },
        onTurnEnd: (turn: TurnInfo) => { ended.push(turn) },
      })

      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      runner.abortTurn(USER_ID)
      await waitFor(() => !runner.hasActiveTurn(USER_ID))

      expect(started.map(t => t.turnId)).toEqual(ended.map(t => t.turnId))
    })
  })

  it('drops the replay buffer of a completed turn once its retention window passed', async () => {
    const db = freshDb()
    const runner = startRunner(db, scriptedAgent([{ type: 'text', text: 'Hi' }]), {
      completedTurnRetentionMs: 10,
    })

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const early: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(early))()
    expect(early.length).toBeGreaterThan(0)

    // Retention elapses without anyone attaching: the buffer must be released
    // instead of lingering until the next subscribe.
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })

    const late: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(late))()
    expect(late).toEqual([])
  })
})
