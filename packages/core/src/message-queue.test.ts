import { describe, it, expect, vi } from 'vitest'
import { MessageQueue, QueueTurnTimeoutError } from './message-queue.js'
import type { QueuedMessage } from './message-queue.js'

describe('MessageQueue', () => {
  describe('sequential processing', () => {
    it('processes messages one at a time', async () => {
      const queue = new MessageQueue()
      const processingOrder: string[] = []

      const processor = (msg: QueuedMessage) => {
        return (async function* () {
          processingOrder.push(`start:${msg.payload.text}`)
          await new Promise(resolve => setTimeout(resolve, 20))
          yield { type: 'text', text: msg.payload.text }
          processingOrder.push(`end:${msg.payload.text}`)
        })()
      }

      // Enqueue two messages — they should serialize
      const p1 = queue.enqueue('user_message', 'user1', 'msg1', 'web', processor)
      const p2 = queue.enqueue('user_message', 'user1', 'msg2', 'web', processor)

      // msg1 starts immediately, msg2 waits
      const iter1 = await p1
      for await (const _ of iter1) { /* consume */ }

      // Now msg2 can proceed
      const iter2 = await p2
      for await (const _ of iter2) { /* consume */ }

      // Verify sequential: msg1 completes before msg2 starts
      expect(processingOrder).toEqual([
        'start:msg1', 'end:msg1',
        'start:msg2', 'end:msg2',
      ])
    })

    it('handles three messages sequentially', async () => {
      const queue = new MessageQueue()
      const order: number[] = []

      const processor = (msg: QueuedMessage) => {
        const num = parseInt(msg.payload.text)
        return (async function* () {
          order.push(num)
          yield num
        })()
      }

      const p1 = queue.enqueue('user_message', 'u', '1', 'web', processor)
      const p2 = queue.enqueue('user_message', 'u', '2', 'web', processor)
      const p3 = queue.enqueue('user_message', 'u', '3', 'web', processor)

      for await (const _ of await p1) { /* consume */ }
      for await (const _ of await p2) { /* consume */ }
      for await (const _ of await p3) { /* consume */ }

      expect(order).toEqual([1, 2, 3])
    })
  })

  describe('busy', () => {
    it('counts the running turn, not only the waiting ones', async () => {
      const queue = new MessageQueue()
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => { release = r })
      const processor = () => (async function* () {
        yield { type: 'text', text: 'a' }
        await gate
        yield { type: 'text', text: 'b' }
      })()

      expect(queue.busy).toBe(0)
      const iter = await queue.enqueue('user_message', 'u', 'm', 'web', processor)
      const it = iter[Symbol.asyncIterator]()
      await it.next() // turn is streaming and holds the lock
      expect(queue.length).toBe(0)
      expect(queue.busy).toBe(1)

      const p2 = queue.enqueue('user_message', 'u', 'm2', 'web', processor)
      await new Promise((r) => setImmediate(r))
      expect(queue.busy).toBe(2)

      release()
      await it.next()
      await it.next()
      const iter2 = await p2
      for await (const _ of iter2) { /* consume */ }
      expect(queue.busy).toBe(0)
    })
  })

  describe('task injection ordering', () => {
    it('processes task injections in queue order with user messages', async () => {
      const queue = new MessageQueue()
      const processed: string[] = []

      const processor = (msg: QueuedMessage) => {
        return (async function* () {
          processed.push(`${msg.type}:${msg.payload.text}`)
          yield { type: 'text', text: msg.payload.text }
        })()
      }

      const p1 = queue.enqueue('user_message', 'user1', 'hello', 'web', processor)
      const p2 = queue.enqueue('task_injection', 'system', 'result', 'task', processor)

      for await (const _ of await p1) { /* consume */ }
      for await (const _ of await p2) { /* consume */ }

      expect(processed).toEqual([
        'user_message:hello',
        'task_injection:result',
      ])
    })

    it('interleaves user messages and task injections correctly', async () => {
      const queue = new MessageQueue()
      const processed: string[] = []

      const processor = (msg: QueuedMessage) => {
        return (async function* () {
          processed.push(msg.payload.text)
          yield msg.payload.text
        })()
      }

      const p1 = queue.enqueue('user_message', 'u', 'user1', 'web', processor)
      const p2 = queue.enqueue('task_injection', 's', 'task1', 'task', processor)
      const p3 = queue.enqueue('user_message', 'u', 'user2', 'web', processor)

      for await (const _ of await p1) { /* consume */ }
      for await (const _ of await p2) { /* consume */ }
      for await (const _ of await p3) { /* consume */ }

      expect(processed).toEqual(['user1', 'task1', 'user2'])
    })
  })

  describe('queue management', () => {
    it('reports pending count correctly', async () => {
      const queue = new MessageQueue()
      const processed: string[] = []

      // A processor that yields immediately
      const processor = (msg: QueuedMessage) => {
        return (async function* () {
          processed.push(msg.payload.text)
          yield msg.payload.text
        })()
      }

      // First enqueue resolves immediately (no contention)
      // Second enqueue waits for first to complete
      const p1 = queue.enqueue('user_message', 'u', 'msg1', 'web', processor)

      // Before consuming, enqueue a second (it increments pending)
      const p2 = queue.enqueue('user_message', 'u', 'msg2', 'web', processor)

      // Both enqueued but p1 acquired lock synchronously so pendingCount
      // may be 1 or 2 depending on microtask timing. p2 is definitely waiting.
      expect(queue.length).toBeGreaterThanOrEqual(1)

      // Consume first
      const iter1 = await p1
      for await (const _ of iter1) { /* consume */ }

      // Consume second
      const iter2 = await p2
      for await (const _ of iter2) { /* consume */ }

      expect(processed).toEqual(['msg1', 'msg2'])
      expect(queue.length).toBe(0)
    })
  })

  describe('event emission', () => {
    it('emits enqueued event', async () => {
      const queue = new MessageQueue()
      const enqueued: QueuedMessage[] = []
      queue.on('enqueued', (msg: QueuedMessage) => enqueued.push(msg))

      const processor = () => (async function* () { yield 'ok' })()

      const iter = await queue.enqueue('user_message', 'user1', 'hello', 'web', processor)
      for await (const _ of iter) { /* consume */ }

      expect(enqueued).toHaveLength(1)
      expect(enqueued[0].payload.text).toBe('hello')
      expect(enqueued[0].type).toBe('user_message')
    })
  })

  it('releases the lock when a consumer drops the turn before pulling a chunk', async () => {
    const queue = new MessageQueue()
    let started = 0
    const processor = () => (async function* () { started++; yield 'chunk' })()

    // The consumer gave up while queued: it closes the iterator without ever
    // calling next(), so the generator body (and its lock release) never runs.
    const abandoned = await queue.enqueue('user_message', 'u', 'dropped', 'web', processor)
    await abandoned[Symbol.asyncIterator]().return?.(undefined as never)
    expect(started).toBe(0)

    const chunks: string[] = []
    for await (const chunk of await queue.enqueue('user_message', 'u', 'next', 'web', processor)) {
      chunks.push(chunk as string)
    }
    expect(chunks).toEqual(['chunk'])
    expect(queue.busy).toBe(0)
  })

  describe('turn watchdog', () => {
    it('force-releases the lock when a turn hangs forever', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const queue = new MessageQueue({ maxTurnMs: 50 })
      const timeouts: QueuedMessage[] = []
      queue.on('turn-timeout', (msg: QueuedMessage) => timeouts.push(msg))

      // Simulates the 2026-07-19 incident: a completion promise that never
      // settles, before the first chunk is ever yielded.
      const stuckProcessor = () => {
        return (async function* () {
          await new Promise(() => { /* never settles */ })
          yield 'unreachable'
        })()
      }
      const okProcessor = () => (async function* () { yield 'ok' })()

      const p1 = queue.enqueue('user_message', 'u', 'stuck', 'telegram', stuckProcessor)
      const p2 = queue.enqueue('user_message', 'u', 'next', 'telegram', okProcessor)

      // The stuck turn's consumer is woken up with the watchdog error…
      const iter1 = await p1
      await expect(async () => {
        for await (const _ of iter1) { /* consume */ }
      }).rejects.toThrow(QueueTurnTimeoutError)

      // …and the queued message behind it proceeds normally.
      const chunks: string[] = []
      for await (const chunk of await p2) chunks.push(chunk as string)
      expect(chunks).toEqual(['ok'])
      expect(timeouts).toHaveLength(1)
      expect(timeouts[0].payload.text).toBe('stuck')
      vi.restoreAllMocks()
    })

    it('force-releases the lock even when nobody consumes the stuck turn', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const queue = new MessageQueue({ maxTurnMs: 50 })

      const stuckProcessor = () => {
        return (async function* () {
          await new Promise(() => { /* never settles */ })
          yield 'unreachable'
        })()
      }
      const okProcessor = () => (async function* () { yield 'ok' })()

      // Acquire the lock but never iterate the returned iterable (dead consumer).
      await queue.enqueue('user_message', 'u', 'stuck', 'web', stuckProcessor)

      const chunks: string[] = []
      for await (const chunk of await queue.enqueue('user_message', 'u', 'next', 'web', okProcessor)) {
        chunks.push(chunk as string)
      }
      expect(chunks).toEqual(['ok'])
      vi.restoreAllMocks()
    })

    it('does not interfere with turns that finish in time', async () => {
      const queue = new MessageQueue({ maxTurnMs: 1000 })
      const processor = () => {
        return (async function* () {
          await new Promise(resolve => setTimeout(resolve, 20))
          yield 'done'
        })()
      }

      const chunks: string[] = []
      for await (const chunk of await queue.enqueue('user_message', 'u', 'm', 'web', processor)) {
        chunks.push(chunk as string)
      }
      expect(chunks).toEqual(['done'])

      // Watchdog from the finished turn must not fire afterwards.
      await new Promise(resolve => setTimeout(resolve, 60))
      const again: string[] = []
      for await (const chunk of await queue.enqueue('user_message', 'u', 'm2', 'web', processor)) {
        again.push(chunk as string)
      }
      expect(again).toEqual(['done'])
    })

    it('throws mid-stream when a turn hangs after yielding some chunks', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const queue = new MessageQueue({ maxTurnMs: 50 })

      const processor = () => {
        return (async function* () {
          yield 'first'
          await new Promise(() => { /* never settles */ })
          yield 'unreachable'
        })()
      }

      const received: string[] = []
      let caught: unknown
      try {
        for await (const chunk of await queue.enqueue('user_message', 'u', 'm', 'telegram', processor)) {
          received.push(chunk as string)
        }
      } catch (err) {
        caught = err
      }
      expect(received).toEqual(['first'])
      expect(caught).toBeInstanceOf(QueueTurnTimeoutError)
      vi.restoreAllMocks()
    })

    it('does NOT abandon a long turn that keeps producing output past the window', async () => {
      // The watchdog is idle-based, not a total-runtime cap: a turn that yields
      // a chunk every 20ms runs well past the 50ms window without being killed
      // (models massive multi-hour agentic work that keeps streaming).
      const queue = new MessageQueue({ maxTurnMs: 50 })
      const processor = () => {
        return (async function* () {
          for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 20))
            yield `chunk-${i}`
          }
        })()
      }

      const received: string[] = []
      for await (const chunk of await queue.enqueue('user_message', 'u', 'm', 'web', processor)) {
        received.push(chunk as string)
      }
      // 10 chunks over ~200ms (4× the 50ms window) all arrive — no timeout.
      expect(received).toHaveLength(10)
      expect(received[9]).toBe('chunk-9')
    })
  })

  describe('error handling', () => {
    it('releases lock even if processor throws', async () => {
      const queue = new MessageQueue()

      const failingProcessor = () => {
        // eslint-disable-next-line require-yield -- intentionally throws before yielding to test error path
        return (async function* () {
          throw new Error('processor error')
        })()
      }

      const successProcessor = () => {
        return (async function* () {
          yield 'success'
        })()
      }

      // First message will fail
      const p1 = queue.enqueue('user_message', 'u', 'fail', 'web', failingProcessor)
      const iter1 = await p1
      try {
        for await (const _ of iter1) { /* consume */ }
      } catch {
        // expected
      }

      // Second message should still work (lock released)
      const p2 = queue.enqueue('user_message', 'u', 'ok', 'web', successProcessor)
      const iter2 = await p2
      const chunks: string[] = []
      for await (const chunk of iter2) {
        chunks.push(chunk as string)
      }
      expect(chunks).toEqual(['success'])
    })
  })
})
