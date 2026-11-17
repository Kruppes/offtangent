import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, ref, type EffectScope } from 'vue'
import { SETTINGS_THINKING_LEVELS, type SettingsThinkingLevel } from '@axiom/core/contracts'
import { resetThinkingLevelForTest, THINKING_REQUEST_TIMEOUT_MS, THINKING_SEND_WAIT_MS, useThinkingLevel, type ThinkingLevelSource } from './useThinkingLevel'

/**
 * Model test for the page-wide thinking-level state (Home + strand picker).
 *
 * A simulated server applies PUTs in the order they are processed and can
 * answer, lose an answer (applied, answer gone), refuse (HTTP error, not
 * applied) or never answer (the client deadline fires; applied or not).
 * "Settings broken" makes every request to /api/settings fail from then on.
 * Random event sequences with a fixed seed drive users, pages and requests;
 * after each sequence everything is answered (or fails, when broken) and timed
 * out, and the rules are checked in that rest state, followed by up to two
 * send attempts (no dead end, Z4). On a failure the seed, the sequence number
 * and the events are printed.
 *
 * Home is modelled as the UI behaves: one send at a time per Home (`busy`
 * while a send waits), the send path calls `readyNow()` and then
 * `readyToSend(signal)` like CaptureHome, leaving Home aborts the signal.
 *
 * Send rules checked (reduced promise Z1 to Z4 and Z8, see useThinkingLevel.ts):
 * - no released send while an own save is open or a PUT of this session is on
 *   the wire;
 * - a send without an own change and without an own save is neither held nor
 *   delayed (`readyNow()` true), also with a PUT of an earlier session on the wire;
 * - no capture from a Home that was left, nor after the identity changed while
 *   the send waited (Z8: 'cancelled'); 'cancelled' only for one of these;
 * - at most one capture per accepted send;
 * - a send that waited for an own save goes out only when the server holds the
 *   level shown at the tap;
 * - a held send needs a reason: it waited for an own save, or an own change was
 *   unresolved; at most one hold per own change without waiting;
 * - every held send ends as 'failed' or 'timeout' (Home shows a message for both);
 * - no dead end: with all saves done, at most two attempts give exactly one
 *   released send, also when every request to /api/settings fails.
 */

const SEEDS = [20261116, 718299, 914197]
const SEQUENCES = 1200
const MIN_EVENTS = 10
const MAX_EVENTS = 30

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface User { id: string; admin: boolean }
interface Live {
  id: number
  kind: 'GET' | 'PUT'
  /** `ownerEpoch` of the session that issued the request. */
  epoch: number
  level?: SettingsThinkingLevel
  resolve: (value: SettingsThinkingLevel | null | void) => void
  reject: (error: unknown) => void
}
interface Page {
  kind: 'home' | 'strand'
  scope: EffectScope
  state: ReturnType<typeof useThinkingLevel>
  /** Home: a send waits (the UI takes no second send meanwhile); its abort is the unmount. */
  waiting: AbortController | null
  closed: boolean
}

function refused() { return Object.assign(new Error('HTTP 500'), { status: 500 }) }

async function settle() { for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0) }

/** How often the Z8 paths and a dropped send occur in a run; a run that never reaches them proves nothing. */
const coverage = { leftWhileWaiting: 0, identityWhileWaiting: 0, cancelled: 0, captures: 0 }

async function runSequence(rand: () => number, length: number, log: string[]): Promise<void> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
  let server: SettingsThinkingLevel = pick(SETTINGS_THINKING_LEVELS)
  let nextId = 1
  const live: Live[] = []
  const violations: string[] = []
  const user = ref<User | null>({ id: 'u1', admin: true })
  const isAdmin = computed(() => !!user.value?.admin)
  const session = computed(() => user.value?.id ?? null)
  const fail = (message: string) => { violations.push(message) }
  /** Every request to /api/settings fails from now on. */
  let broken = false
  const brokenError = () => rand() < 0.5 ? refused() : new TypeError('Failed to fetch')
  /** Own changes (picks) of the current owner, and the holds without waiting per change. */
  let picks = 0
  let ownerKey = 'u1:true'
  /** Bumped on every login/logout: a send whose session ended while it waited is dropped, not held. */
  let sessionSerial = 0
  const heldPerPick = new Map<number, number>()
  /** Bumped whenever the admin identity the composable keys on changes (admin id or nobody). */
  let ownerEpoch = 0
  let ownerId: string | null = 'u1'
  /** Captures per accepted send (index = send id). */
  const captures: number[] = []

  const source: ThinkingLevelSource = {
    key: 'model:thinking',
    read: (signal) => new Promise<SettingsThinkingLevel | null>((resolve, reject) => {
      if (!user.value?.admin) fail(`GET /api/settings while ${user.value ? 'a non-admin' : 'nobody'} is signed in`)
      if (broken) { reject(brokenError()); return }
      const request: Live = { id: nextId++, kind: 'GET', epoch: ownerEpoch, resolve: resolve as Live['resolve'], reject }
      live.push(request)
      signal?.addEventListener('abort', () => { const i = live.indexOf(request); if (i >= 0) live.splice(i, 1) })
    }),
    write: (level, signal) => new Promise<void>((resolve, reject) => {
      if (live.some(r => r.kind === 'PUT')) fail(`PUT ${level} issued while another PUT is on the wire`)
      if (!user.value?.admin) fail(`PUT while ${user.value ? 'a non-admin' : 'nobody'} is signed in`)
      if (broken) { reject(brokenError()); return }
      const request: Live = { id: nextId++, kind: 'PUT', epoch: ownerEpoch, level, resolve: resolve as Live['resolve'], reject }
      live.push(request)
      signal?.addEventListener('abort', () => { const i = live.indexOf(request); if (i >= 0) live.splice(i, 1) })
    }),
  }

  const pages: Page[] = []
  const sends: Promise<void>[] = []
  function open(kind: Page['kind']) {
    const scope = effectScope()
    const state = scope.run(() => useThinkingLevel(isAdmin, source, session))!
    pages.push({ kind, scope, state, waiting: null, closed: false })
    void state.load()
  }
  /** Unmount: CaptureHome aborts its waiting send, then the scope ends. */
  function close(page: Page) {
    page.closed = true
    page.waiting?.abort()
    page.scope.stop()
    pages.splice(pages.indexOf(page), 1)
  }
  const anyState = () => pages[0]?.state
  const putOnWire = () => live.some(r => r.kind === 'PUT')
  const ownPutOnWire = () => live.some(r => r.kind === 'PUT' && r.epoch === ownerEpoch)

  function take(kind?: Live['kind']): Live | undefined {
    const candidates = live.filter(r => !kind || r.kind === kind)
    if (!candidates.length) return undefined
    const request = pick(candidates)
    live.splice(live.indexOf(request), 1)
    return request
  }

  function checkStep(where: string) {
    const state = anyState()
    if (!state) return
    if (!isAdmin.value && state.known.value) fail(`${where}: a non-admin sees a known level`)
    if (isAdmin.value && state.known.value && !putOnWire() && state.current.value !== server) {
      fail(`${where}: shows ${state.current.value} as known, server holds ${server}`)
    }
  }

  /**
   * One send attempt on Home, as CaptureHome does it: ignored while this Home
   * is busy, `readyNow()` first, then `readyToSend(signal)`. Resolves to `true`
   * when a capture is posted, `null` when the tap was not taken (busy).
   */
  function send(page: Page): Promise<boolean | null> {
    if (page.waiting) return Promise.resolve(null)
    const at = log.length
    const state = page.state
    const ownSave = state.saving.value
    const ownPut = ownPutOnWire()
    const shown = state.current.value
    const pickAtTap = picks
    const serialAtTap = sessionSerial
    const epochAtTap = ownerEpoch
    const sendId = captures.push(0) - 1
    const capture = () => {
      if (page.closed) fail(`capture from a Home that was left (send at event ${at})`)
      if (ownerEpoch !== epochAtTap) fail(`capture after the identity changed while the send waited (event ${at})`)
      captures[sendId]! += 1
      coverage.captures++
      if (captures[sendId]! > 1) fail(`send at event ${at} gave ${captures[sendId]} captures`)
      return true
    }
    const release = (waited: boolean) => {
      if (!isAdmin.value) return capture()
      if (state.saving.value) fail(`send released (event ${at}) while an own save is open`)
      if (ownPutOnWire()) fail(`send released (event ${at}) while a PUT of this session is on the wire`)
      if (waited && server !== shown) fail(`send released (event ${at}) after waiting for a save of ${shown}, server holds ${server}`)
      return capture()
    }
    if (!isAdmin.value || state.readyNow()) return Promise.resolve(release(false))
    // Z4: without an own change, an own save or an own PUT on the wire a send is not even delayed.
    if (!ownSave && !ownPut && pickAtTap === 0) fail(`send delayed (event ${at}) without an own change and without an own save`)
    const controller = new AbortController()
    page.waiting = controller
    const result = state.readyToSend(controller.signal).then((r) => {
      if (page.waiting === controller) page.waiting = null
      if (r === 'cancelled') {
        coverage.cancelled++
        if (!page.closed && ownerEpoch === epochAtTap) fail(`send cancelled (event ${at}) without leaving Home or a change of identity`)
        return false
      }
      if (r === 'ready') return release(ownSave)
      if (r !== 'failed' && r !== 'timeout') fail(`send (event ${at}) ended as ${String(r)}, no message for it`)
      if (serialAtTap !== sessionSerial) return false
      if (!ownSave) {
        if (pickAtTap === 0) fail(`send held (event ${at}) without an own change and without an own save`)
        const held = (heldPerPick.get(pickAtTap) ?? 0) + 1
        heldPerPick.set(pickAtTap, held)
        if (held > 1) fail(`send held (event ${at}) a second time for the same unresolved own change`)
      }
      return false
    })
    sends.push(result.then(() => {}))
    return result
  }

  function onUserChange() {
    sessionSerial++
    const key = `${user.value?.id ?? '-'}:${!!user.value?.admin}`
    if (key !== ownerKey) { picks = 0; heldPerPick.clear() }
    ownerKey = key
    const id = user.value?.admin ? user.value.id : null
    if (id !== ownerId) { ownerEpoch++; ownerId = id }
  }

  const events: { name: string; weight: number; run: () => Promise<string | null> | string | null }[] = [
    { name: 'pick', weight: 5, run: () => {
      const page = pages.length && isAdmin.value ? pick(pages) : undefined
      if (!page) return null
      const level = pick(SETTINGS_THINKING_LEVELS)
      if (!(page.state.current.value === level && page.state.known.value && !page.state.saving.value)) picks++
      void page.state.change(level)
      return `pick ${level} on ${page.kind}`
    } },
    { name: 'answer', weight: 6, run: () => {
      const r = take()
      if (!r) return null
      if (r.kind === 'PUT') { server = r.level!; r.resolve() } else r.resolve(server)
      return `answer ${r.kind}#${r.id}${r.level ? ` ${r.level}` : ''} (server ${server})`
    } },
    { name: 'lose', weight: 3, run: () => {
      const r = take()
      if (!r) return null
      if (r.kind === 'PUT') server = r.level!
      r.reject(new TypeError('Failed to fetch'))
      return `lose answer of ${r.kind}#${r.id}${r.level ? ` ${r.level} (applied)` : ''}`
    } },
    { name: 'refuse', weight: 3, run: () => {
      const r = take()
      if (!r) return null
      r.reject(refused())
      return `refuse ${r.kind}#${r.id}${r.level ? ` ${r.level}` : ''}`
    } },
    { name: 'deadline', weight: 2, run: async () => {
      const put = live.find(r => r.kind === 'PUT')
      const applied = !!put && rand() < 0.5
      if (put && applied) server = put.level!
      await vi.advanceTimersByTimeAsync(THINKING_REQUEST_TIMEOUT_MS)
      return `deadline passes${put ? ` (PUT ${put.level} ${applied ? 'applied' : 'not applied'})` : ''}`
    } },
    { name: 'logout', weight: 1, run: () => { user.value = null; onUserChange(); return 'logout' } },
    { name: 'login', weight: 2, run: () => {
      const next: User = { id: rand() < 0.6 ? 'u1' : 'u2', admin: rand() < 0.75 }
      user.value = next
      onUserChange()
      return `login ${next.id} ${next.admin ? 'admin' : 'non-admin'}`
    } },
    { name: 'openHome', weight: 2, run: () => { open('home'); return 'open Home' } },
    { name: 'closeHome', weight: 1, run: () => {
      const page = pages.find(p => p.kind === 'home')
      if (!page) return null
      close(page); return 'close Home'
    } },
    { name: 'openStrand', weight: 1, run: () => { open('strand'); return 'open strand' } },
    { name: 'closeStrand', weight: 1, run: () => {
      const page = pages.find(p => p.kind === 'strand')
      if (!page) return null
      close(page); return 'close strand'
    } },
    { name: 'tabVisible', weight: 1, run: () => {
      if (!pages.length) return null
      for (const page of pages) void page.state.load()
      return 'tab visible'
    } },
    { name: 'send', weight: 3, run: () => {
      const page = pages.find(p => p.kind === 'home')
      if (!page) return null
      const busy = !!page.waiting
      void send(page); return busy ? 'send on Home (busy, not taken)' : 'send on Home'
    } },
    { name: 'leaveWaiting', weight: 3, run: () => {
      const page = pages.find(p => p.kind === 'home' && p.waiting)
      if (!page) return null
      coverage.leftWhileWaiting++
      close(page); return 'leave Home while its send waits'
    } },
    { name: 'identityWaiting', weight: 3, run: () => {
      if (!pages.some(p => p.kind === 'home' && p.waiting)) return null
      const next: User | null = rand() < 0.25 ? null : { id: user.value?.id === 'u1' ? 'u2' : 'u1', admin: rand() < 0.75 }
      user.value = next
      onUserChange()
      coverage.identityWhileWaiting++
      return `identity changes while a send waits: ${next ? `login ${next.id} ${next.admin ? 'admin' : 'non-admin'}` : 'logout'}`
    } },
    { name: 'broken', weight: 1, run: () => {
      if (broken) return null
      broken = true
      // Requests on the wire fail too; a PUT is not applied.
      for (const r of live.splice(0)) r.reject(brokenError())
      return 'settings broken for good'
    } },
  ]
  const total = events.reduce((sum, e) => sum + e.weight, 0)

  open('home')
  await settle()
  log.push(`start: server ${server}, u1 admin, Home open`)
  while (log.length <= length) {
    let roll = rand() * total
    const event = events.find((e) => { roll -= e.weight; return roll < 0 }) ?? events[0]!
    const line = await event.run()
    await settle()
    if (line) { log.push(line); checkStep(line) }
  }

  // Rest: an admin has Home open, every request is answered (or fails, when
  // broken) and every deadline passed.
  if (!pages.some(p => p.kind === 'home')) open('home')
  const answerAll = async () => {
    for (let round = 0; round < 50 && live.length; round++) {
      const r = live.shift()!
      if (broken) r.reject(brokenError())
      else if (r.kind === 'PUT') { server = r.level!; r.resolve() } else r.resolve(server)
      await settle()
    }
  }
  await answerAll()
  await vi.advanceTimersByTimeAsync(THINKING_SEND_WAIT_MS + THINKING_REQUEST_TIMEOUT_MS)
  await answerAll()
  await Promise.all(sends)
  await settle()
  if (live.length) fail(`rest: ${live.length} requests still open`)
  const home = pages.find(p => p.kind === 'home')!
  const state = home.state
  if (state.saving.value) fail('rest: still saving')
  if (!isAdmin.value) {
    if (state.known.value) fail('rest: a non-admin sees a known level')
    if (!state.readyNow()) fail('rest: a non-admin cannot send')
  } else {
    if (state.known.value && state.current.value !== server) fail(`rest: shows ${state.current.value} as known, server holds ${server}`)
    if (!state.known.value && !state.loadError.value) fail('rest: level unknown without a read error')
  }
  // No dead end (Z4): all saves are done; at most two attempts give exactly one released send.
  let released = 0
  for (let attempt = 0; attempt < 2 && released === 0; attempt++) {
    const done = send(home)
    let finished = false
    void done.then(() => { finished = true })
    for (let round = 0; round < 20 && !finished; round++) {
      await answerAll()
      await vi.advanceTimersByTimeAsync(THINKING_REQUEST_TIMEOUT_MS)
    }
    if (!finished) { fail(`rest: send attempt ${attempt + 1} never ended`); break }
    const outcome = await done
    if (outcome === null) { fail(`rest: send attempt ${attempt + 1} not taken, Home still busy`); break }
    if (outcome) released++
  }
  if (released !== 1) fail(`rest: two send attempts gave ${released} released sends${broken ? ' (settings broken)' : ''}`)
  for (const page of [...pages]) close(page)
  if (violations.length) throw new Error(violations.join('\n'))
}

describe('useThinkingLevel model test', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetThinkingLevelForTest()
  })

  it.each(SEEDS)(`keeps the rules over ${SEQUENCES} random sequences (seed %i)`, async (SEED) => {
    vi.useFakeTimers()
    Object.assign(coverage, { leftWhileWaiting: 0, identityWhileWaiting: 0, cancelled: 0, captures: 0 })
    const rand = mulberry32(SEED)
    for (let n = 0; n < SEQUENCES; n++) {
      const length = MIN_EVENTS + Math.floor(rand() * (MAX_EVENTS - MIN_EVENTS + 1))
      const log: string[] = []
      try {
        await runSequence(rand, length, log)
      } catch (error) {
        const message = `seed ${SEED}, sequence ${n}:\n${(error as Error).message}\nevents:\n${log.map((l, i) => `  ${i}. ${l}`).join('\n')}`
        expect.fail(message)
      }
      resetThinkingLevelForTest()
    }
    expect(coverage.leftWhileWaiting).toBeGreaterThanOrEqual(20)
    expect(coverage.identityWhileWaiting).toBeGreaterThanOrEqual(20)
    expect(coverage.cancelled).toBeGreaterThanOrEqual(20)
    expect(coverage.captures).toBeGreaterThan(500)
    console.info(`seed ${SEED}: ${SEQUENCES} sequences, coverage ${JSON.stringify(coverage)}`)
  }, 120_000)
})
