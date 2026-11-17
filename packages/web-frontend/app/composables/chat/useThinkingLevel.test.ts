import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import type { SettingsThinkingLevel } from '@axiom/core/contracts'
import { resetThinkingLevelForTest, THINKING_REQUEST_TIMEOUT_MS, THINKING_SEND_WAIT_MS, useThinkingLevel, type ThinkingLevelSource } from './useThinkingLevel'

/**
 * The page-wide thinking-level state behind Home and the strand composer:
 * serialized writes, latest-read-wins, reads deferred behind writes, and a
 * reset on every session change. A fake source with hand-released answers
 * stands in for `GET`/`PUT /api/settings`.
 */
interface Deferred<T> { resolve: (value: T) => void; reject: (error: unknown) => void }
function fakeSource(key = 'test:thinking') {
  const reads: Deferred<SettingsThinkingLevel | null>[] = []
  const writes: { level: SettingsThinkingLevel; d: Deferred<void> }[] = []
  const source: ThinkingLevelSource = {
    key,
    read: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }) }),
    write: level => new Promise((resolve, reject) => { writes.push({ level, d: { resolve, reject } }) }),
  }
  return { source, reads, writes }
}
/** A clear refusal: the server answered with an HTTP error. */
function refused(status = 500) { return Object.assign(new Error(`HTTP ${status}`), { status }) }
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

const scopes: EffectScope[] = []
function use(source: ThinkingLevelSource, opts: { admin?: boolean; session?: string | null } = {}) {
  const isAdmin = ref(opts.admin ?? true)
  const session = ref<string | null>(opts.session === undefined ? 'u1' : opts.session)
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => useThinkingLevel(isAdmin, source, session))!
  return { state, isAdmin, session, scope }
}

afterEach(() => {
  vi.useRealTimers()
  scopes.splice(0).forEach(s => s.stop())
  resetThinkingLevelForTest()
})

describe('useThinkingLevel: overlapping writes (P1b)', () => {
  it('writes one level after the other and releases only once the level picked last is confirmed', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('off'); await flush()

    let settledWith: boolean | undefined
    void state.change('high')
    void state.change('low')
    void state.settled().then((ok) => { settledWith = ok })
    await flush()
    // Only one PUT is open at a time.
    expect(writes.map(w => w.level)).toEqual(['high'])
    expect(state.current.value).toBe('low')
    expect(state.saving.value).toBe(true)

    writes[0]!.d.resolve(); await flush()
    // `high` is confirmed, but `low` was picked last: still not settled.
    expect(settledWith).toBeUndefined()
    expect(writes.map(w => w.level)).toEqual(['high', 'low'])
    expect(state.saving.value).toBe(true)

    writes[1]!.d.resolve(); await flush()
    expect(settledWith).toBe(true)
    expect(state.saving.value).toBe(false)
    expect(state.current.value).toBe('low')
    expect(state.known.value).toBe(true)
  })

  it('rolls back to the level the server confirmed last when the final write fails', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('off'); await flush()

    const first = state.change('high')
    const second = state.change('low')
    writes[0]!.d.resolve(); await flush()
    writes[1]!.d.reject(refused()); await flush()
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    // The server holds `high` now; that is what the picker must show.
    expect(state.current.value).toBe('high')
    expect(state.known.value).toBe(true)
    expect(state.saveError.value).toBe(true)
  })

  it('skips a failed intermediate level and still writes the one picked last', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('off'); await flush()

    const done = state.change('high')
    void state.change('medium')
    writes[0]!.d.reject(new Error('500')); await flush()
    expect(writes.map(w => w.level)).toEqual(['high', 'medium'])
    writes[1]!.d.resolve(); await flush()
    expect(await done).toBe(true)
    expect(state.current.value).toBe('medium')
    expect(state.saveError.value).toBe(false)
  })
})

describe('useThinkingLevel: page-wide pending writes (P1a)', () => {
  it('a second instance (Home opened again) sees the open write and waits for it', async () => {
    const { source, reads, writes } = fakeSource()
    const first = use(source)
    void first.state.load(); reads[0]!.resolve('xhigh'); await flush()
    void first.state.change('minimal')
    first.scope.stop() // Home left while the PUT is open

    const second = use(source)
    expect(second.state.saving.value).toBe(true)
    expect(second.state.current.value).toBe('minimal')
    let settledWith: boolean | undefined
    void second.state.settled().then((ok) => { settledWith = ok })
    await flush()
    expect(settledWith).toBeUndefined()
    writes[0]!.d.resolve(); await flush()
    expect(settledWith).toBe(true)
  })
})

describe('useThinkingLevel: reads (P2)', () => {
  it('applies only the read requested last, even when an older answer arrives later', async () => {
    const { source, reads } = fakeSource()
    const { state } = use(source)
    void state.load()
    void state.load()
    reads[1]!.resolve('low'); await flush()
    reads[0]!.resolve('high'); await flush()
    expect(state.current.value).toBe('low')
    expect(state.known.value).toBe(true)
  })

  it('defers a read asked for during a write and runs it afterwards', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('off'); await flush()
    void state.change('high')
    void state.load() // e.g. tab came back while saving
    await flush()
    expect(reads).toHaveLength(1)
    writes[0]!.d.resolve(); await flush()
    expect(reads).toHaveLength(2)
    reads[1]!.resolve('medium'); await flush() // changed elsewhere meanwhile
    expect(state.current.value).toBe('medium')
  })
})

describe('useThinkingLevel: session changes', () => {
  it('forgets the level on a user switch and drops answers from the old session', async () => {
    const { source, reads } = fakeSource()
    const { state, session } = use(source, { session: 'u1' })
    void state.load(); reads[0]!.resolve('high'); await flush()
    expect(state.known.value).toBe(true)

    void state.load() // still open when the user changes
    session.value = 'u2'
    expect(state.known.value).toBe(false)
    expect(state.current.value).toBe('off')
    reads[1]!.resolve('xhigh'); await flush()
    expect(state.known.value).toBe(false)
    expect(state.current.value).toBe('off')
  })

  it('a non-admin (or a new mount after losing the role) never sees the earlier admin value', async () => {
    const { source, reads } = fakeSource()
    const admin = use(source, { session: 'u1' })
    void admin.state.load(); reads[0]!.resolve('high'); await flush()
    admin.scope.stop()

    const other = use(source, { admin: false, session: 'u1' })
    expect(other.state.known.value).toBe(false)
    expect(other.state.current.value).toBe('off')
    await other.state.load()
    expect(reads).toHaveLength(1) // a non-admin does not read
  })

  it('logging out while a send waits for a write releases it as failed, and the late answer is dropped', async () => {
    const { source, reads, writes } = fakeSource()
    const { state, isAdmin } = use(source)
    void state.load(); reads[0]!.resolve('off'); await flush()
    void state.change('high')
    const waiting = state.settled()
    isAdmin.value = false
    expect(await waiting).toBe(false)
    writes[0]!.d.resolve(); await flush()
    expect(state.known.value).toBe(false)
    expect(state.saving.value).toBe(false)
  })
})

describe('useThinkingLevel: round 3 findings', () => {
  it('P1: a write of the old session lands before the new session writes, so the server ends with the level shown', async () => {
    // Server applies PUTs in arrival order; a PUT counts as arrived when it is issued.
    let server: SettingsThinkingLevel = 'off'
    const { source, reads, writes } = fakeSource()
    const wrapped: ThinkingLevelSource = { key: source.key, read: source.read, write: (level, signal) => { server = level; return source.write(level, signal) } }
    const { state, isAdmin } = use(wrapped)
    void state.load(); reads[0]!.resolve('off'); await flush()
    void state.change('high') // PUT high open
    isAdmin.value = false // logout
    isAdmin.value = true // login again: reads, behind the open PUT
    void state.change('low')
    await flush()
    expect(writes.map(w => w.level)).toEqual(['high']) // `low` waits for the old PUT
    writes[0]!.d.resolve(); await flush()
    expect(writes.map(w => w.level)).toEqual(['high', 'low'])
    writes[1]!.d.resolve(); await flush()
    expect(server).toBe('low')
    expect(state.current.value).toBe('low')
    expect(state.known.value).toBe(true)
  })

  it('P1: an applied write whose answer got lost is read again, not rolled back', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('off'); await flush()
    const done = state.change('high')
    writes[0]!.d.reject(new TypeError('Failed to fetch')); await flush() // applied, answer lost
    expect(state.known.value).toBe(false)
    expect(state.saving.value).toBe(true)
    expect(reads).toHaveLength(2) // read again automatically
    reads[1]!.resolve('high'); await flush()
    expect(await done).toBe(true)
    expect(state.current.value).toBe('high')
    expect(state.known.value).toBe(true)
    expect(state.saveError.value).toBe(false)
  })

  it('P1/Z3: an unclear write whose read fails leaves the level unknown and holds the next send once', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('off'); await flush()
    const done = state.change('high')
    writes[0]!.d.reject(new TypeError('Failed to fetch')); await flush()
    reads[1]!.reject(new TypeError('Failed to fetch')); await flush()
    expect(await done).toBe(false)
    expect(state.known.value).toBe(false)
    expect(state.saveUnclear.value).toBe(true)
    expect(state.loadError.value).toBe(true)
    expect(state.readyNow()).toBe(false)
    // The held send tries one read; it fails, so this one send is held.
    const ready = state.readyToSend()
    await flush()
    reads[2]!.reject(new Error('offline')); await flush()
    expect(await ready).toBe('failed')
    // Z4: the next send goes out with the server's level, still unknown here.
    expect(state.readyNow()).toBe(true)
    expect(await state.readyToSend()).toBe('ready')
    expect(reads).toHaveLength(3)
  })

  it('Z3: a read during the held send that finds another level holds once and names it; the next send goes out', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('off'); await flush()
    void state.change('high')
    writes[0]!.d.reject(new TypeError('Failed to fetch')); await flush()
    reads[1]!.reject(new TypeError('Failed to fetch')); await flush()
    const ready = state.readyToSend(); await flush()
    reads[2]!.resolve('off'); await flush()
    expect(await ready).toBe('failed')
    expect(state.saveError.value).toBe(true)
    expect(state.known.value).toBe(true)
    expect(state.current.value).toBe('off')
    expect(await state.readyToSend()).toBe('ready')
  })

  it('Z3: a read during the held send that confirms the level picked sends at once', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('off'); await flush()
    void state.change('high')
    writes[0]!.d.reject(new TypeError('Failed to fetch')); await flush()
    reads[1]!.reject(new TypeError('Failed to fetch')); await flush()
    const ready = state.readyToSend(); await flush()
    reads[2]!.resolve('high'); await flush()
    expect(await ready).toBe('ready')
    expect(state.saveError.value).toBe(false)
  })

  it('P2: the admin identity arriving after the mount reads the level', async () => {
    const { source, reads } = fakeSource()
    const { state, isAdmin, session } = use(source, { admin: false, session: null })
    void state.load() // mount: nobody known yet, no read
    expect(reads).toHaveLength(0)
    session.value = 'u1'
    isAdmin.value = true
    await flush()
    expect(reads).toHaveLength(1)
    reads[0]!.resolve('medium'); await flush()
    expect(state.current.value).toBe('medium')
    expect(state.known.value).toBe(true)
  })

  it('P2: switching the owner reads again for the new owner', async () => {
    const { source, reads } = fakeSource()
    const { state, session } = use(source, { session: 'u1' })
    void state.load(); reads[0]!.resolve('high'); await flush()
    session.value = 'u2'; await flush()
    expect(reads).toHaveLength(2)
    reads[1]!.resolve('low'); await flush()
    expect(state.current.value).toBe('low')
  })

  it('P3: the test reset works for sources without a key, every time', async () => {
    for (let round = 0; round < 3; round++) {
      const { source, reads } = fakeSource('')
      const keyless: ThinkingLevelSource = { read: source.read, write: source.write }
      const first = use(keyless)
      expect(first.state.known.value).toBe(false)
      void first.state.load(); reads[0]!.resolve('high'); await flush()
      expect(first.state.known.value).toBe(true)
      scopes.splice(0).forEach(s => s.stop())
      resetThinkingLevelForTest()
      const second = use(keyless)
      expect(second.state.known.value).toBe(false)
      expect(second.state.current.value).toBe('off')
      scopes.splice(0).forEach(s => s.stop())
      resetThinkingLevelForTest()
    }
  })

  it('rule 4: a PUT that never answers is given up as unclear and read again', async () => {
    vi.useFakeTimers()
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('off'); await vi.advanceTimersByTimeAsync(0)
    const done = state.change('high')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(THINKING_REQUEST_TIMEOUT_MS)
    expect(reads).toHaveLength(2)
    reads[1]!.resolve('off'); await vi.advanceTimersByTimeAsync(0)
    expect(await done).toBe(false)
    expect(state.saving.value).toBe(false)
    expect(state.known.value).toBe(true)
    expect(state.current.value).toBe('off')
    expect(state.saveError.value).toBe(true)
  })

  it('rule 4: a GET that never answers becomes a read error', async () => {
    vi.useFakeTimers()
    const { source, reads } = fakeSource()
    const { state } = use(source)
    void state.load()
    await vi.advanceTimersByTimeAsync(THINKING_REQUEST_TIMEOUT_MS)
    expect(reads).toHaveLength(1)
    expect(state.loadError.value).toBe(true)
    expect(state.known.value).toBe(false)
  })

  it('rule 4: a waiting send gives up after the send deadline', async () => {
    vi.useFakeTimers()
    const { source, reads } = fakeSource()
    const wrapped: ThinkingLevelSource = { key: source.key, read: source.read, write: () => new Promise(() => {}) }
    const { state } = use(wrapped)
    void state.load(); reads[0]!.resolve('off'); await vi.advanceTimersByTimeAsync(0)
    void state.change('high')
    const ready = state.readyToSend()
    let result: string | undefined
    void ready.then((r) => { result = r })
    await vi.advanceTimersByTimeAsync(THINKING_REQUEST_TIMEOUT_MS) // PUT given up, read starts and hangs
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(THINKING_SEND_WAIT_MS - THINKING_REQUEST_TIMEOUT_MS)
    expect(result).toBe('timeout')
  })

  it('Z4: an unknown level alone never holds; a read error does not block sending', async () => {
    const { source, reads } = fakeSource()
    const { state } = use(source)
    void state.load()
    expect(state.readyNow()).toBe(true)
    reads[0]!.reject(new Error('offline')); await flush()
    expect(state.loadError.value).toBe(true)
    expect(state.known.value).toBe(false)
    expect(state.readyNow()).toBe(true)
    expect(await state.readyToSend()).toBe('ready')
    expect(reads).toHaveLength(1)
  })

  it('Z4: settings down for good and no own change: the first send goes out', async () => {
    const down: ThinkingLevelSource = { key: 'test:down', read: () => Promise.reject(new TypeError('Failed to fetch')), write: () => Promise.reject(refused(503)) }
    const { state } = use(down)
    await state.load(); await flush()
    expect(state.loadError.value).toBe(true)
    expect(await state.readyToSend()).toBe('ready')
    expect(await state.readyToSend()).toBe('ready')
  })

  it('Z3/Z4: settings down for good with an unresolved own change: held once, the second send goes out', async () => {
    let down = false
    const { source, reads, writes } = fakeSource()
    const flaky: ThinkingLevelSource = {
      key: source.key,
      read: s => down ? Promise.reject(new TypeError('Failed to fetch')) : source.read(s),
      write: (l, s) => down ? Promise.reject(new TypeError('Failed to fetch')) : source.write(l, s),
    }
    const { state } = use(flaky)
    void state.load(); reads[0]!.resolve('low'); await flush()
    const done = state.change('high')
    down = true
    writes[0]!.d.reject(new TypeError('Failed to fetch')); await flush()
    expect(await done).toBe(false)
    expect(state.saveUnclear.value).toBe(true)
    expect(await state.readyToSend()).toBe('failed')
    expect(await state.readyToSend()).toBe('ready')
    expect(await state.readyToSend()).toBe('ready')
  })

  it('Z2: a send that waited for a refused save is held once; the next goes out with the level rolled back to', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('low'); await flush()
    void state.change('high')
    const ready = state.readyToSend()
    writes[0]!.d.reject(refused()); await flush()
    expect(await ready).toBe('failed')
    expect(state.current.value).toBe('low')
    expect(state.known.value).toBe(true)
    expect(state.saveError.value).toBe(true)
    expect(await state.readyToSend()).toBe('ready')
  })

  it('Z1: a send that waited goes out only when the server confirmed the level shown at the tap', async () => {
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('low'); await flush()
    void state.change('high')
    const ready = state.readyToSend()
    // Picked again during the wait: the server ends with medium, not the level shown at the tap.
    void state.change('medium')
    writes[0]!.d.resolve(); await flush()
    writes[1]!.d.resolve(); await flush()
    expect(await ready).toBe('failed')
    expect(state.current.value).toBe('medium')
    const second = state.readyToSend()
    expect(await second).toBe('ready')
  })

  it('Z4 earlier session, seed 718299 sequence 418: a PUT of the previous session on the wire neither holds nor delays a send of the new one', async () => {
    const { source, reads, writes } = fakeSource()
    // 0. server off, u1 admin, Home open
    const { state, session } = use(source)
    void state.load()
    // 1. pick low on Home: PUT low goes on the wire and stays there
    void state.change('low'); await flush()
    expect(writes.map(w => w.level)).toEqual(['low'])
    // 3./4. same login again, send on Home: an own save is open, the send waits
    session.value = 'u1'; await flush()
    let first: string | undefined
    void state.readyToSend().then((r) => { first = r })
    // 6. login u2 admin: the old session's PUT is still on the wire
    session.value = 'u2'; await flush()
    expect(first).toBe('cancelled')
    // 7. send on Home of u2 without an own change: goes out at once
    expect(state.readyNow()).toBe(true)
    expect(await state.readyToSend()).toBe('ready')
    // 8. an own change of u2 still waits for the wire: one PUT at a time
    void state.change('medium'); await flush()
    expect(writes).toHaveLength(1)
    expect(state.readyNow()).toBe(false)
    writes[0]!.d.resolve(); await flush()
    expect(writes.map(w => w.level)).toEqual(['low', 'medium'])
    void reads
  })

  it('Z8: an aborted wait (Home left) answers cancelled at once, leaves no timer and does not use up the one held send', async () => {
    vi.useFakeTimers()
    const { source, reads, writes } = fakeSource()
    const { state } = use(source)
    void state.load(); reads[0]!.resolve('low'); await vi.advanceTimersByTimeAsync(0)
    void state.change('high'); await vi.advanceTimersByTimeAsync(0)
    const timersBefore = vi.getTimerCount()
    const controller = new AbortController()
    let result: string | undefined
    void state.readyToSend(controller.signal).then((r) => { result = r })
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(timersBefore + 1)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe('cancelled')
    // The 45 s wait timer is gone with it.
    expect(vi.getTimerCount()).toBe(timersBefore)
    // The save goes on and is confirmed; an already aborted signal never waits.
    writes[0]!.d.resolve(); await vi.advanceTimersByTimeAsync(0)
    expect(state.current.value).toBe('high')
    expect(await state.readyToSend(controller.signal)).toBe('cancelled')
    expect(await state.readyToSend()).toBe('ready')
  })

  it('Z8: an identity change while a send waits answers cancelled, not failed', async () => {
    const { source, reads, writes } = fakeSource()
    const { state, isAdmin } = use(source)
    void state.load(); reads[0]!.resolve('low'); await flush()
    void state.change('high'); await flush()
    const ready = state.readyToSend()
    isAdmin.value = false; await flush()
    expect(await ready).toBe('cancelled')
    writes[0]!.d.resolve(); await flush()
  })

  it('rule 6: a non-admin is never held and never reads', async () => {
    const { source, reads } = fakeSource()
    const { state } = use(source, { admin: false })
    expect(state.readyNow()).toBe(true)
    expect(await state.readyToSend()).toBe('ready')
    expect(reads).toHaveLength(0)
  })
})
