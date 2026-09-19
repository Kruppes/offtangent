import { EventEmitter } from 'node:events'

export interface QueuedMessage {
  id: string
  type: 'user_message' | 'task_injection'
  payload: {
    userId: string
    text: string
    source: string
    /**
     * Persona the turn belongs to. Queues are per persona (one queue protects
     * exactly one AgentRuntime), so this is constant per queue — it is carried
     * on the message anyway so a blocker can be named without reaching back
     * into AgentCore.
     */
    agentId: string
    /**
     * Strand the turn runs on, when the caller already knows it. `null` for
     * legacy callers that let the SessionManager resolve the session inside
     * the turn; a blocker without a session id is reported with `title: null`.
     */
    sessionId: string | null
  }
}

/** The turn currently holding a queue's lock (see {@link MessageQueue.describe}). */
export interface ActiveTurnInfo {
  agentId: string
  sessionId: string | null
  /** Epoch ms when the turn took the lock (may precede the provider call by the semaphore wait). */
  startedAt: number
}

/** What a caller needs to render "your turn has to wait" (see plan D3). */
export interface QueueSnapshot {
  /** Turns that hold a slot but not the lock yet. */
  waiting: number
  /** The turn holding the lock, or null when the queue is idle. */
  active: ActiveTurnInfo | null
}

/**
 * Global cap on turns running at the same time, shared by all per-persona
 * queues (plan D2). Per-persona queues remove the process-wide serialization,
 * but the provider connections, CPU and memory behind a turn are still shared,
 * so an unbounded fan-out across personas is not wanted either.
 *
 * Acquired AFTER the persona lock, never before: a persona must never be able
 * to run two turns at once, and acquiring in the other order could let a
 * persona's second turn hold a global slot while waiting for its own lock
 * (self-deadlock of the slot, starvation of the other personas).
 *
 * Fair FIFO handover: a released slot goes to the longest-waiting acquirer
 * instead of being re-raced, so a busy persona cannot starve a quiet one.
 */
export class TurnSemaphore {
  private running = 0
  private readonly waiters: Array<() => void> = []

  constructor(readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) throw new Error(`TurnSemaphore limit must be >= 1, got ${limit}`)
  }

  /** Turns holding a slot right now. */
  get active(): number {
    return this.running
  }

  /** Turns waiting for a slot right now. */
  get waiting(): number {
    return this.waiters.length
  }

  /**
   * Take a slot, waiting if all are taken. The returned release function is
   * idempotent — the queue calls it from several paths (normal end, consumer
   * walking away, watchdog) and must never hand back the same slot twice.
   */
  async acquire(): Promise<() => void> {
    if (this.running < this.limit) {
      this.running++
    } else {
      await new Promise<void>(resolve => this.waiters.push(resolve))
      // Handed over an already-counted slot: `running` stays as it is.
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.running--
    }
  }
}

/**
 * Thrown into the consumer of a queued turn when the watchdog expires.
 * The queue lock has already been force-released at that point, so
 * subsequent messages proceed normally.
 */
export class QueueTurnTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`Turn produced no output for ${Math.round(idleMs / 1000)}s (queue idle watchdog) and was abandoned`)
    this.name = 'QueueTurnTimeoutError'
  }
}

/**
 * Idle window for the queue-level backstop: a turn is abandoned only after this
 * long with NO output flowing (no chunk yielded) — it is NOT a total-runtime
 * cap. A turn that keeps streaming tokens / running tools re-arms it on every
 * chunk and may run for hours (massive autonomous agentic coding). This sits
 * ABOVE the agent-runtime inactivity guard (20 min) so that one fires first and
 * settles the run cleanly; the queue backstop only matters if that mechanism
 * itself wedges (incident 2026-07-20: a blind wall-clock cap wrongly killed a
 * still-working Kimi turn). Raise via AXIOM_QUEUE_TURN_MAX_MS for workloads with
 * single tool calls longer than the window (e.g. multi-hour builds).
 */
const DEFAULT_MAX_TURN_MS = (() => {
  const raw = Number(process.env.AXIOM_QUEUE_TURN_MAX_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000
})()

/**
 * In-memory message queue that serializes all inputs to the main agent.
 * Both user chat messages and task result injections go through this queue
 * to prevent concurrent processing collisions.
 *
 * Uses a simple mutex pattern: acquires a lock before processing,
 * releases it when the consumer finishes iterating the response.
 *
 * A progress-aware idle watchdog force-releases the lock after `maxTurnMs` of
 * NO output (re-armed on every yielded chunk, so a turn actively streaming for
 * hours is never abandoned) — only a genuinely stuck turn (hung completion,
 * dead consumer) trips it. The stuck turn's consumer receives a
 * QueueTurnTimeoutError on its next iteration step; the underlying processor is
 * closed best-effort but never awaited — it may be stuck on a promise that
 * never settles.
 */
export class MessageQueue extends EventEmitter {
  private pendingCount = 0
  /** Turns that hold the lock right now (0 or 1). */
  private activeCount = 0
  /** Enqueued but not yet holding the lock, in FIFO order. */
  private readonly waitingMessages: QueuedMessage[] = []
  /** The turn holding the lock, or null while the queue is idle. */
  private activeTurn: ActiveTurnInfo | null = null
  private lockPromise: Promise<void> = Promise.resolve()
  private readonly maxTurnMs: number
  /** Shared across all per-persona queues; see {@link TurnSemaphore}. */
  private readonly semaphore: TurnSemaphore | undefined

  constructor(options?: { maxTurnMs?: number; semaphore?: TurnSemaphore }) {
    super()
    this.maxTurnMs = options?.maxTurnMs ?? DEFAULT_MAX_TURN_MS
    this.semaphore = options?.semaphore
  }

  /**
   * Enqueue a message for sequential processing.
   * Returns a wrapped async iterable from the processor.
   * The next queued message won't start until this iterable is fully consumed
   * (or the watchdog gives up on it).
   */
  async enqueue<T>(
    type: 'user_message' | 'task_injection',
    userId: string,
    text: string,
    source: string,
    processor: (msg: QueuedMessage) => AsyncIterable<T>,
    meta?: { agentId?: string; sessionId?: string | null },
  ): Promise<AsyncIterable<T>> {
    const msg: QueuedMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      payload: {
        userId,
        text,
        source,
        agentId: meta?.agentId ?? 'main',
        sessionId: meta?.sessionId ?? null,
      },
    }

    this.pendingCount++
    this.waitingMessages.push(msg)
    this.emit('enqueued', msg)

    // Wait for our turn
    const previousLock = this.lockPromise
    let releaseFn: () => void
    this.lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve
    })

    await previousLock
    this.pendingCount--
    const waitingIndex = this.waitingMessages.indexOf(msg)
    if (waitingIndex >= 0) this.waitingMessages.splice(waitingIndex, 1)
    this.activeCount++
    // Holding the lock is what blocks this persona's next turn, so the turn
    // counts as active from here on — including the (usually short) wait for a
    // global concurrency slot below.
    this.activeTurn = { agentId: msg.payload.agentId, sessionId: msg.payload.sessionId, startedAt: Date.now() }

    // Global concurrency cap, taken AFTER the persona lock (plan D2). Released
    // by `releaseOnce` on every path — normal end, abandoned consumer, watchdog.
    const releaseSlot = this.semaphore ? await this.semaphore.acquire() : undefined

    // Rejects when the watchdog fires; raced against every iteration step so
    // a consumer stuck in `await next()` is woken up with the error.
    let expire: ((err: Error) => void) | undefined
    const expiry = new Promise<never>((_, reject) => {
      expire = reject
    })
    // The race below may already have thrown out of the consumer by the time
    // this settles again — keep it from surfacing as an unhandled rejection.
    expiry.catch(() => {})

    let released = false
    const idleMs = this.maxTurnMs
    let watchdog: ReturnType<typeof setTimeout> | undefined

    const releaseOnce = (): void => {
      if (released) return
      released = true
      this.activeCount--
      this.activeTurn = null
      clearTimeout(watchdog)
      // Hand the global slot back BEFORE the persona lock so a turn waiting on
      // this queue does not find the semaphore still occupied by the turn it
      // just replaced.
      releaseSlot?.()
      releaseFn!()
    }

    // Progress-aware watchdog: abandon the turn only after `idleMs` of NO output
    // (no chunk yielded), NOT after a fixed wall-clock budget. A turn that keeps
    // streaming tokens or running tools re-arms it on every chunk and can run
    // for hours (massive autonomous agentic work). Only genuine silence — a run
    // truly stuck with nothing coming through — trips it.
    const arm = (): void => {
      if (released) return
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        if (released) return
        const err = new QueueTurnTimeoutError(idleMs)
        console.error(`[message-queue] ${err.message} (type=${msg.type}, source=${msg.payload.source}) — force-releasing lock so queued messages proceed`)
        this.emit('turn-timeout', msg)
        releaseOnce()
        expire!(err)
      }, idleMs)
      if (typeof watchdog === 'object' && 'unref' in watchdog) watchdog.unref()
    }
    arm()

    // We now have the lock — run the processor
    const iterable = processor(msg)

    // Wrap iterable to release lock when fully consumed
    const wrapped = async function* (): AsyncIterable<T> {
      const it = iterable[Symbol.asyncIterator]()
      try {
        while (true) {
          const res = await Promise.race([it.next(), expiry])
          if (res.done) break
          arm() // progress — reset the idle timer
          yield res.value
        }
      } finally {
        releaseOnce()
        // Close the underlying generator without awaiting it: if the watchdog
        // tripped, it is stuck on a promise that may never settle, and its
        // generator body only resumes (running finally blocks) if it ever does.
        try {
          void Promise.resolve(it.return?.(undefined as never)).catch(() => {})
        } catch {
          // ignore — best-effort cleanup only
        }
      }
    }

    const stream = wrapped()

    // A consumer may drop the turn before it ever pulls a chunk (it gave up
    // while waiting for the lock). Closing a generator that never started does
    // NOT run its body — and with it not the `finally` that releases the lock —
    // so the release is attached to the iterator itself. `releaseOnce` is
    // idempotent, so the normal path is unaffected.
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        const it = stream[Symbol.asyncIterator]()
        return {
          next: value => it.next(value),
          return: async (value?: unknown) => {
            releaseOnce()
            return it.return ? it.return(value as never) : { done: true as const, value: value as T }
          },
          throw: err => it.throw!(err),
        }
      },
    }
  }

  /**
   * Get the number of pending (waiting) messages
   */
  get length(): number {
    return this.pendingCount
  }

  /**
   * Turns ahead of a message enqueued right now: the waiting ones PLUS the
   * one currently holding the lock. `length` alone reads 0 while a single
   * turn is streaming, which is exactly when a newcomer has to wait.
   */
  get busy(): number {
    return this.pendingCount + this.activeCount
  }

  /**
   * Who is in this queue right now (plan D3): how many turns wait, and which
   * one holds the lock. The caller turns that into a user-visible position
   * (`waiting + active + 1` for a turn enqueued now) and resolves the blocker's
   * strand title itself — the queue knows ids, not titles.
   */
  describe(): QueueSnapshot {
    return {
      waiting: this.pendingCount,
      active: this.activeTurn ? { ...this.activeTurn } : null,
    }
  }

  /**
   * 1-based place of the first still-waiting turn of `sessionId`, or null when
   * that strand has nothing waiting. The turn holding the lock is NOT counted:
   * it is running, not pending, and `pendingTurn` (REST) means "waiting".
   */
  pendingPositionOf(sessionId: string): number | null {
    const index = this.waitingMessages.findIndex(msg => msg.payload.sessionId === sessionId)
    if (index < 0) return null
    return this.activeCount + index + 1
  }
}
