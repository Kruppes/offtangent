/**
 * Per-persona queues + one shared concurrency limit (plan 2026-09-19, D2/D3).
 *
 * The queue used to be process-wide, so a 23-minute turn of one persona made
 * every other persona's turn wait (incident 2026-09-18, capture answered after
 * 20 min). Queues are per persona now; what stays global is the number of
 * turns running at the same time, because provider connections and memory are
 * shared. These tests pin both halves and the release paths of the semaphore —
 * a slot that leaks is a process that stops answering.
 */
import { describe, it, expect } from 'vitest'
import { MessageQueue, TurnSemaphore } from './message-queue.js'

/** A processor that yields nothing until `release()` is called. */
function gate(): { processor: () => AsyncIterable<string>; started: Promise<void>; release: () => void } {
  let releaseFn: () => void = () => {}
  let startedFn: () => void = () => {}
  const gateOpen = new Promise<void>((resolve) => { releaseFn = resolve })
  const started = new Promise<void>((resolve) => { startedFn = resolve })
  return {
    processor: () => (async function* () {
      startedFn()
      await gateOpen
      yield 'done'
    })(),
    started,
    release: releaseFn,
  }
}

async function drain(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/** Let pending microtasks/timers settle so queue state is observable. */
const settle = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('TurnSemaphore', () => {
  it('caps concurrent holders at the limit and hands slots over in FIFO order', async () => {
    const semaphore = new TurnSemaphore(2)
    const releaseA = await semaphore.acquire()
    const releaseB = await semaphore.acquire()
    expect(semaphore.active).toBe(2)

    const order: string[] = []
    const c = semaphore.acquire().then((release) => { order.push('c'); return release })
    const d = semaphore.acquire().then((release) => { order.push('d'); return release })
    await settle()
    expect(order).toEqual([])
    expect(semaphore.waiting).toBe(2)

    releaseA()
    await settle()
    expect(order).toEqual(['c'])
    releaseB()
    await settle()
    expect(order).toEqual(['c', 'd'])
    ;(await c)()
    ;(await d)()
    expect(semaphore.active).toBe(0)
  })

  it('ignores a double release so a slot is never handed out twice', async () => {
    const semaphore = new TurnSemaphore(1)
    const release = await semaphore.acquire()
    release()
    release()
    expect(semaphore.active).toBe(0)
    const second = await semaphore.acquire()
    expect(semaphore.active).toBe(1)
    second()
  })

  it('refuses a limit below 1 instead of silently serializing or uncapping', () => {
    expect(() => new TurnSemaphore(0)).toThrow(/limit must be >= 1/)
    expect(() => new TurnSemaphore(Number.NaN)).toThrow(/limit must be >= 1/)
  })
})

describe('MessageQueue isolation', () => {
  it('does not let one persona queue block another', async () => {
    const semaphore = new TurnSemaphore(3)
    const bob = new MessageQueue({ semaphore })
    const main = new MessageQueue({ semaphore })

    const slow = gate()
    const bobTurn = bob.enqueue('user_message', 'u', 'long hotfix', 'web', slow.processor, { agentId: 'bob', sessionId: 's-bob' })
    const bobStream = await bobTurn
    const bobDrained = drain(bobStream)
    await slow.started

    // bob is busy; main must run right through.
    const mainStream = await main.enqueue('user_message', 'u', 'capture', 'web', () => (async function* () { yield 'fast' })(), { agentId: 'main', sessionId: 's-main' })
    expect(await drain(mainStream)).toEqual(['fast'])
    expect(bob.describe().active).toEqual({ agentId: 'bob', sessionId: 's-bob', startedAt: expect.any(Number) })
    expect(main.describe()).toEqual({ waiting: 0, active: null })

    slow.release()
    expect(await bobDrained).toEqual(['done'])
    expect(bob.describe().active).toBeNull()
  })

  it('still serializes two turns of the SAME persona', async () => {
    const queue = new MessageQueue({ semaphore: new TurnSemaphore(3) })
    const order: string[] = []
    const first = gate()

    const firstStream = await queue.enqueue('user_message', 'u', 'one', 'web', first.processor, { agentId: 'bob', sessionId: 's1' })
    const firstDone = drain(firstStream).then(() => { order.push('one') })
    await first.started

    const secondPending = queue.enqueue('user_message', 'u', 'two', 'web', () => (async function* () { yield 'x' })(), { agentId: 'bob', sessionId: 's2' })
    await settle()
    expect(queue.describe()).toEqual({ waiting: 1, active: { agentId: 'bob', sessionId: 's1', startedAt: expect.any(Number) } })
    // A turn enqueued now would be third: one running, one waiting.
    expect(queue.pendingPositionOf('s2')).toBe(2)
    expect(queue.pendingPositionOf('s-unknown')).toBeNull()
    expect(order).toEqual([])

    first.release()
    await firstDone
    await drain(await secondPending)
    order.push('two')
    expect(order).toEqual(['one', 'two'])
    expect(queue.describe()).toEqual({ waiting: 0, active: null })
  })

  it('caps turns across personas at the shared limit', async () => {
    const semaphore = new TurnSemaphore(2)
    const queues = ['a', 'b', 'c'].map(() => new MessageQueue({ semaphore }))
    const gates = ['a', 'b', 'c'].map(() => gate())
    const streams = await Promise.all([0, 1].map(i =>
      queues[i].enqueue('user_message', 'u', `t${i}`, 'web', gates[i].processor, { agentId: `p${i}`, sessionId: `s${i}` }),
    ))

    const drained = streams.map(drain)
    await Promise.all([gates[0].started, gates[1].started])
    expect(semaphore.active).toBe(2)

    // Third persona: own queue is free, but no global slot left.
    const thirdPending = queues[2].enqueue('user_message', 'u', 't2', 'web', gates[2].processor, { agentId: 'p2', sessionId: 's2' })
    let thirdReady = false
    void thirdPending.then(() => { thirdReady = true })
    await settle(20)
    expect(thirdReady).toBe(false)
    expect(semaphore.waiting).toBe(1)
    // It holds its own persona lock already, so it shows as active there.
    expect(queues[2].describe().active?.agentId).toBe('p2')

    gates[0].release()
    await drained[0]
    await settle()
    expect(thirdReady).toBe(true)

    gates[1].release()
    gates[2].release()
    await drained[1]
    await drain(await thirdPending)
    expect(semaphore.active).toBe(0)
  })

  it('hands the concurrency slot back when the idle watchdog abandons a turn', async () => {
    const semaphore = new TurnSemaphore(1)
    const queue = new MessageQueue({ maxTurnMs: 30, semaphore })
    const stuck = new Promise<never>(() => {})

    const stream = await queue.enqueue('user_message', 'u', 'stuck', 'web', () => (async function* () {
      await stuck
      yield 'never'
    })(), { agentId: 'bob', sessionId: 's-stuck' })
    expect(semaphore.active).toBe(1)

    await expect(drain(stream)).rejects.toThrow(/queue idle watchdog/)
    expect(semaphore.active).toBe(0)
    expect(queue.describe()).toEqual({ waiting: 0, active: null })

    // The slot is usable again — by this queue and by any other.
    const other = new MessageQueue({ semaphore })
    expect(await drain(await other.enqueue('user_message', 'u', 'next', 'web', () => (async function* () { yield 'ok' })(), { agentId: 'main', sessionId: 's-next' }))).toEqual(['ok'])
  })

  it('hands the concurrency slot back when the consumer walks away before pulling a chunk', async () => {
    const semaphore = new TurnSemaphore(1)
    const queue = new MessageQueue({ semaphore })
    const stream = await queue.enqueue('user_message', 'u', 'abandoned', 'web', () => (async function* () { yield 'unread' })(), { agentId: 'bob', sessionId: 's-abandon' })

    const iterator = stream[Symbol.asyncIterator]()
    await iterator.return?.(undefined as never)
    expect(semaphore.active).toBe(0)
    expect(queue.describe().active).toBeNull()

    expect(await drain(await queue.enqueue('user_message', 'u', 'next', 'web', () => (async function* () { yield 'ok' })(), { agentId: 'bob', sessionId: 's-next' }))).toEqual(['ok'])
  })

  it('defaults the blocker metadata for legacy callers that pass no persona', async () => {
    const queue = new MessageQueue()
    const seen: Array<{ agentId: string; sessionId: string | null }> = []
    queue.on('enqueued', (msg: { payload: { agentId: string; sessionId: string | null } }) => seen.push(msg.payload))
    await drain(await queue.enqueue('user_message', 'u', 'legacy', 'web', () => (async function* () { yield 'ok' })()))
    expect(seen).toEqual([expect.objectContaining({ agentId: 'main', sessionId: null, text: 'legacy' })])
  })
})
