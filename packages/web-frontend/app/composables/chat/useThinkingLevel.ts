import { computed, effectScope, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type EffectScope, type Ref, type ShallowRef } from 'vue'
import { SETTINGS_THINKING_LEVELS, type SettingsThinkingLevel } from '@axiom/core/contracts'
import { useSettingsApi } from '~/api/settings'

/*
 * Contract (reduced promise until the level travels with the message, see the
 * follow-up "Pro-Strand"; source: _review/home-thinking-zusage.md):
 * Z1 wait: a Home send tapped while an own save runs waits (max 45 s) and goes
 *    out only once the server confirmed exactly the level shown at the tap.
 * Z2 hold once after a failed save: refused, unclear or deadline: that one send
 *    is held with a message, the text stays; sending again uses the server level.
 * Z3 hold once for an unresolved own change (save unclear, read again failed):
 *    the next send is held once, with the same message.
 * Z4 no dead end: after a hold the next send goes out unless an own save runs
 *    again (then Z1). Without an own unresolved change Home never holds, also
 *    when the level could not be read or /api/settings is down for good.
 * Z5 honest display: confirmed only by the answer to that very PUT or a later
 *    successful GET; an unknown level is shown as unknown on Home and in the
 *    strand (hint, read again). The strand never holds a send.
 * Z6 clear refusal: rolls back visibly to the level confirmed before, with a
 *    message; a send after that goes out with that level (intended).
 * Z1 covers every way to send (button, shortcut): the send button stays usable
 *    while an own save runs; the tap is taken and waits.
 * Z4, earlier session: a PUT of an earlier session still on the wire is no own
 *    change of the current one; a send without an own change is neither held
 *    nor delayed by it. Own writes still wait until the wire is free.
 * Z8 leaving: when Home is left (unmount) or the identity changes (logout,
 *    other user, admin role gone) while a send waits for a save, that send is
 *    dropped: nothing goes out, also not later (`readyToSend` answers
 *    'cancelled'; Home checks again right before the capture POST). The wait
 *    leaves no timer and no listener behind; the save itself goes on. A
 *    capture POST already started runs to its end as before.
 * Not promised (known limits, solved by Pro-Strand only):
 * N1 other writers (second tab, second device, the settings page),
 * N2 a PUT that reaches the server after the client deadline,
 * N3 a change by someone else between confirmation and send.
 */

/**
 * Where the thinking level lives. Today this is the one global `thinkingLevel`
 * setting; the composable only talks to this interface so a later per-strand
 * source can be passed in without touching the pickers.
 */
export interface ThinkingLevelSource {
  /**
   * Identifies the stored value: every composable using a source with the same
   * key shares one state (value, pending writes, errors) on this page. Without
   * a key the state belongs to this source object alone.
   */
  key?: string
  /** The current level, or `null` when the source has no valid value. Throws when it cannot be read. */
  read: (signal?: AbortSignal) => Promise<SettingsThinkingLevel | null>
  /**
   * Persist the level; resolves only once the server confirmed it. A clear
   * refusal throws an error with the HTTP `status` (see `isClearRejection`);
   * anything else (network error, abort, unreadable answer) counts as unclear.
   */
  write: (level: SettingsThinkingLevel, signal?: AbortSignal) => Promise<void>
}

/** Every GET and PUT is given up after this long; the result then counts as a read error or an unclear write. */
export const THINKING_REQUEST_TIMEOUT_MS = 30_000
/** A send waiting for the thinking level gives up after this long (with a message) and sends nothing. */
export const THINKING_SEND_WAIT_MS = 45_000

class ThinkingRequestTimeout extends Error {
  constructor() { super('thinking level request timed out'); this.name = 'ThinkingRequestTimeout' }
}

/** Runs one request with a deadline; the request is aborted when the deadline passes. */
function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ThinkingRequestTimeout()) }, THINKING_REQUEST_TIMEOUT_MS)
  })
  return Promise.race([run(controller.signal), deadline]).finally(() => clearTimeout(timer))
}

/**
 * A clear refusal: the server answered with an HTTP error, so the level was
 * not stored. Gateway answers (408/502/503/504) do not tell whether the
 * server applied it; like network errors, aborts and timeouts they are unclear.
 */
export function isClearRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status
  return typeof status === 'number' && status >= 400 && status < 600 && ![408, 502, 503, 504].includes(status)
}

function isThinkingLevel(value: unknown): value is SettingsThinkingLevel {
  return typeof value === 'string' && (SETTINGS_THINKING_LEVELS as readonly string[]).includes(value)
}

/** The global setting (`GET`/`PUT /api/settings`, admin only), live-applied by `AgentCore.setThinkingLevel`. */
export function settingsThinkingLevelSource(): ThinkingLevelSource {
  const settingsApi = useSettingsApi()
  return {
    key: 'settings:thinkingLevel',
    async read(signal) {
      const settings = await settingsApi.getSettings({ signal })
      return isThinkingLevel(settings.thinkingLevel) ? settings.thinkingLevel : null
    },
    async write(level, signal) {
      // Minimal body: only the one field, nothing else of the settings is resent.
      await settingsApi.updateSettings({ thinkingLevel: level }, { signal })
    },
  }
}

/**
 * The page-wide state of one source. Home and an open strand in the same tab
 * share it, so a write started on one page is still known (and awaited) after
 * navigating to the other, and a level saved on Home shows in the strand at once.
 *
 * Rules (see the tests and the model test in `useThinkingLevel.model.test.ts`):
 * 1. At most one PUT per source is on the wire, across instances and sessions
 *    (`wire` survives a session reset); every read waits for it as well.
 * 2. `known` is true only for the latest server answer (GET or confirmed PUT)
 *    of this session, while no write is open or unclear.
 * 3. A PUT without a clear refusal (network error, abort, timeout, unreadable
 *    answer) leaves the value unknown and is followed by a read; only a clear
 *    refusal rolls back to the level confirmed last.
 * 4. Every GET and PUT has a deadline (`THINKING_REQUEST_TIMEOUT_MS`), a
 *    waiting send one as well (`THINKING_SEND_WAIT_MS`).
 * 5. Every change of the admin identity reads again.
 * 6. `readyToSend` (Home): see Z1 to Z4 above. It waits for an open write and
 *    holds at most one send per failed or unresolved own change; otherwise it
 *    releases, also when the level is unknown.
 * 7. Nothing is carried over a session change.
 */
interface SharedThinkingState {
  /** `<session>` of the admin it belongs to; `null` = nobody may see a value. */
  owner: string | null
  /** Bumped on every reset: async results of an older epoch are dropped. */
  epoch: number
  current: Ref<SettingsThinkingLevel>
  known: Ref<boolean>
  loadError: Ref<boolean>
  /** The level picked last was clearly refused or not stored; the shown level is the one in force. */
  saveError: Ref<boolean>
  /** A write ended without a clear answer and the read after it failed: the level is unknown. */
  saveUnclear: Ref<boolean>
  saving: Ref<boolean>
  /** Last level the server confirmed (read or write) in this session, `null` when unknown. */
  confirmed: SettingsThinkingLevel | null
  /** Level picked last in this session (or adopted from a read); `null` before anything is known. */
  desired: SettingsThinkingLevel | null
  /** Shown value before the first write of the running chain (rollback target when nothing was confirmed). */
  beforeChain: SettingsThinkingLevel
  /** Resolves once the write chain is done: `true` = the last picked level is confirmed. */
  chain: Promise<boolean> | null
  resolveChain: ((ok: boolean) => void) | null
  /** A write of this session ended unclear; the stored level is unknown until a read answers. */
  unclear: boolean
  /** `writeVersion` of the own change a send was already held for (Z2, Z3: once per change). */
  heldVersion: number
  /** Bumped by every change, so a read that started before it cannot overwrite it. */
  writeVersion: number
  /** Bumped by every read; only the latest requested read may apply. */
  readGeneration: number
  /** A read was asked for while writing; it runs once the chain is done. */
  readQueued: boolean
  /** The PUT on the wire, of any session; settles (never rejects) when it is done. Not reset. */
  wire: Promise<void> | null
  /** `epoch` of the session that put `wire` on the wire; an older one never holds or delays a send (Z4). */
  wireEpoch: number
  /** The read requested last while it runs. */
  reading: Promise<void> | null
  /** Live composables of this source; identity changes read only while one is open. */
  instances: number
  /** Admin identity as seen by the composable created last (auth refs stay live after it is gone). */
  ownerGetter: ShallowRef<(() => string | null) | null>
  /** Read of the composable created last (it only uses this state and the source). */
  reread: (() => Promise<void>) | null
  /** Watches the identity for the whole page, also while no Home or strand is open, so an old session's chain stops at once. */
  watcher: EffectScope | null
}

function createShared(): SharedThinkingState {
  return {
    owner: null, epoch: 0,
    current: ref<SettingsThinkingLevel>('off'), known: ref(false), loadError: ref(false), saveError: ref(false),
    saveUnclear: ref(false), saving: ref(false),
    confirmed: null, desired: null, beforeChain: 'off', chain: null, resolveChain: null, unclear: false, heldVersion: -1,
    writeVersion: 0, readGeneration: 0, readQueued: false, wire: null, wireEpoch: -1, reading: null,
    instances: 0, ownerGetter: shallowRef(null), reread: null, watcher: null,
  }
}

let sharedByKey = new Map<string, SharedThinkingState>()
/** Bumped by the test reset; a page-wide watcher of an older generation stops itself. */
let pageGeneration = 0
let sharedBySource = new WeakMap<ThinkingLevelSource, SharedThinkingState>()

function sharedFor(source: ThinkingLevelSource): SharedThinkingState {
  let state = source.key ? sharedByKey.get(source.key) : sharedBySource.get(source)
  if (!state) {
    state = createShared()
    if (source.key) sharedByKey.set(source.key, state)
    else sharedBySource.set(source, state)
    const shared = state
    const generation = pageGeneration
    // Rule 5 and 7: every change of the admin identity resets the state; with a page open it reads at once.
    shared.watcher = effectScope(true)
    shared.watcher.run(() => watch(() => shared.ownerGetter.value?.() ?? null, (next) => {
      if (generation !== pageGeneration) { shared.watcher?.stop(); return }
      if (shared.owner === next) return
      resetShared(shared, next)
      if (next !== null && shared.instances > 0) void shared.reread?.()
    }, { flush: 'sync' }))
  }
  return state
}

/** Forget everything (session change, or a fresh start). Pending work of the old epoch is dropped; a PUT on the wire is still waited for. */
function resetShared(state: SharedThinkingState, owner: string | null) {
  state.owner = owner
  state.epoch++
  state.current.value = 'off'
  state.known.value = false
  state.loadError.value = false
  state.saveError.value = false
  state.saveUnclear.value = false
  state.saving.value = false
  state.confirmed = null
  state.desired = null
  state.beforeChain = 'off'
  state.unclear = false
  state.heldVersion = -1
  state.readQueued = false
  state.reading = null
  state.writeVersion++
  state.readGeneration++
  // A send still waiting for the old session's write must not go out.
  state.resolveChain?.(false)
  state.chain = null
  state.resolveChain = null
}

/** Test helper: every composable created afterwards starts from a fresh page state. Holds no state itself. */
export function resetThinkingLevelForTest(): void {
  sharedByKey.forEach(state => state.watcher?.stop())
  sharedByKey = new Map()
  sharedBySource = new WeakMap()
  pageGeneration++
}

/**
 * Thinking level quick-switch, shared by the strand composer and the Home
 * composer. Backed by the same `thinkingLevel` setting as the Settings page;
 * changes are live-applied to the agent (see `AgentCore.setThinkingLevel`).
 * Admin-only because the main agent is single-tenant — flipping this affects
 * everyone's next turn.
 *
 * The value, its pending writes and errors are shared page-wide per source
 * (see `SharedThinkingState`). `session` identifies the signed-in user: when
 * it changes, or admin rights are lost, the shared state is reset, so nobody
 * sees a level read in an earlier session and no old answer lands in a new one.
 *
 * `current` keeps its historical `'off'` start value for the strand picker;
 * `known` says whether it was actually confirmed by the server (read or
 * saved), so a surface that prints the level as text never presents the
 * placeholder as a fact.
 */
export function useThinkingLevel(
  isAdmin: Ref<boolean>,
  source: ThinkingLevelSource = settingsThinkingLevelSource(),
  session?: Ref<string | number | null | undefined>,
) {
  const shared = sharedFor(source)
  const { current, known, loadError, saveError, saveUnclear, saving } = shared
  const pickerOpen = ref(false)

  const owner = computed(() => {
    if (!isAdmin.value) return null
    const id = session ? session.value : 'default'
    return id === null || id === undefined ? null : String(id)
  })
  /** Reset the shared state when it belongs to another session (or to no admin now). `true` = an admin may use it. */
  function sync(): boolean {
    if (shared.owner !== owner.value) resetShared(shared, owner.value)
    return owner.value !== null
  }
  sync()
  // Rule 5: a new admin identity (also one that arrives after the mount) reads
  // at once; the page-wide watcher in `sharedFor` follows the composable created last.
  shared.ownerGetter.value = () => owner.value
  shared.reread = read
  if (getCurrentScope()) {
    shared.instances++
    onScopeDispose(() => { shared.instances-- })
  }

  // Brain button color encodes thinking intensity (no text label needed):
  // off=gray, minimal=white, low→xhigh progressively to red
  const brainColorClass = computed(() => {
    const map: Record<SettingsThinkingLevel, string> = {
      off: 'text-muted-foreground',
      minimal: 'text-foreground',
      low: 'text-primary',
      medium: 'text-warning',
      high: 'text-destructive',
      xhigh: 'text-destructive',
    }
    return map[current.value] ?? 'text-muted-foreground'
  })

  async function load(): Promise<void> {
    if (!sync()) return
    await read()
  }

  /** Waits until no PUT (of any session) is on the wire. `false` when `stale` turned true meanwhile. */
  async function waitForWire(stale: () => boolean): Promise<boolean> {
    while (shared.wire) {
      await shared.wire
      if (stale()) return false
    }
    return !stale()
  }

  /**
   * One GET, after any PUT on the wire. `'stale'` when a reset, a newer read or
   * a change came in meanwhile (the answer is dropped).
   */
  async function fetchLevel(): Promise<SettingsThinkingLevel | 'failed' | 'stale'> {
    const epoch = shared.epoch
    const generation = ++shared.readGeneration
    const writeVersion = shared.writeVersion
    const stale = () => epoch !== shared.epoch || generation !== shared.readGeneration || writeVersion !== shared.writeVersion
    if (shared.wire && !await waitForWire(stale)) return 'stale'
    try {
      const level = await withDeadline(signal => source.read(signal))
      if (stale()) return 'stale'
      if (level) {
        shared.confirmed = level
        shared.unclear = false
        return level
      }
    } catch {
      if (stale()) return 'stale'
    }
    shared.confirmed = null
    return 'failed'
  }

  /** A read outside a write chain; only the read requested last may apply, and none that started before a change. */
  function read(): Promise<void> {
    const running: Promise<void> = readOnce().finally(() => { if (shared.reading === running) shared.reading = null })
    shared.reading = running
    return running
  }

  async function readOnce(): Promise<void> {
    if (shared.owner === null) return
    // Reading now could undo the optimistic value; read once the writes are done.
    if (shared.chain) { shared.readQueued = true; return }
    const pickBefore = shared.unclear ? shared.desired : null
    const level = await fetchLevel()
    if (level === 'stale') return
    if (level === 'failed') {
      // Keep the strand picker's value, but do not claim it is confirmed.
      known.value = false
      loadError.value = true
      return
    }
    current.value = level
    known.value = true
    loadError.value = false
    saveUnclear.value = false
    // After an unclear write: the level picked is not what the server holds.
    if (pickBefore !== null && pickBefore !== level) saveError.value = true
    shared.desired = level
  }

  /** One PUT, after any PUT on the wire (also of an older session). */
  async function put(level: SettingsThinkingLevel, epoch: number): Promise<'ok' | 'rejected' | 'unclear' | 'stale'> {
    if (shared.wire && !await waitForWire(() => epoch !== shared.epoch)) return 'stale'
    const request = withDeadline(signal => source.write(level, signal))
    const wire: Promise<void> = request.then(() => {}, () => {})
    shared.wire = wire
    shared.wireEpoch = epoch
    try {
      await request
      return epoch === shared.epoch ? 'ok' : 'stale'
    } catch (error) {
      if (epoch !== shared.epoch) return 'stale'
      return isClearRejection(error) ? 'rejected' : 'unclear'
    } finally {
      if (shared.wire === wire) shared.wire = null
    }
  }

  /** Writes one level after the other until the server confirmed the last picked one (or it is clearly settled otherwise). */
  async function runChain(epoch: number) {
    let outcome: 'ok' | 'rejected' | 'notStored' | 'unknown'
    let lastTarget: SettingsThinkingLevel | null = null
    for (;;) {
      if (epoch !== shared.epoch) return
      if (shared.unclear && shared.desired === lastTarget) {
        // Rule 3: the last write ended unclear and nothing newer was picked: ask the server.
        const level = await fetchLevel()
        if (epoch !== shared.epoch) return
        if (level === 'stale') continue
        outcome = level === 'failed' ? 'unknown' : level === lastTarget ? 'ok' : 'notStored'
        break
      }
      if (!shared.unclear && shared.desired === shared.confirmed) { outcome = 'ok'; break }
      const target = shared.desired!
      lastTarget = target
      const result = await put(target, epoch)
      if (result === 'stale') return
      if (result === 'ok') { shared.confirmed = target; shared.unclear = false; continue }
      if (result === 'unclear') { shared.unclear = true; shared.confirmed = null; continue }
      // Clearly refused. A newer pick is written next; an earlier unclear write is read first.
      if (shared.desired !== target || shared.unclear) continue
      outcome = 'rejected'
      break
    }
    if (outcome === 'ok' || outcome === 'notStored') {
      current.value = shared.confirmed!
      known.value = true
      loadError.value = false
      saveUnclear.value = false
      saveError.value = outcome === 'notStored'
      shared.desired = shared.confirmed
    } else if (outcome === 'rejected') {
      // Rollback to what the server confirmed last, never to an optimistic value in between.
      current.value = shared.confirmed ?? shared.beforeChain
      known.value = shared.confirmed !== null
      shared.desired = shared.confirmed
      saveError.value = true
      if (shared.confirmed === null) shared.readQueued = true
    } else {
      // Unknown whether it was stored, and the read failed: no value is claimed; Retry reads again.
      known.value = false
      loadError.value = true
      saveUnclear.value = true
    }
    saving.value = false
    const resolve = shared.resolveChain
    shared.chain = null
    shared.resolveChain = null
    resolve?.(outcome === 'ok')
    if (shared.readQueued) {
      // Not `load()`: the component that started the chain may be gone by now.
      shared.readQueued = false
      void read()
    }
  }

  /**
   * Optimistic switch. Writes run one after the other; the returned promise
   * resolves once all of them are done: `true` when the server confirmed the
   * level picked last, `false` otherwise (refused: rolled back to the last
   * confirmed level; unclear: read again).
   */
  function change(level: SettingsThinkingLevel): Promise<boolean> {
    pickerOpen.value = false
    if (!sync()) return Promise.resolve(false)
    if (!shared.chain && level === current.value && known.value) return Promise.resolve(true)
    if (!shared.chain) shared.beforeChain = current.value
    shared.writeVersion++
    shared.desired = level
    current.value = level // optimistic, but not known until the server confirmed it
    known.value = false
    saveError.value = false
    saveUnclear.value = false
    if (shared.chain) return shared.chain
    saving.value = true
    shared.chain = new Promise<boolean>((resolve) => { shared.resolveChain = resolve })
    const chain = shared.chain
    void runChain(shared.epoch)
    return chain
  }

  /**
   * Waits for every pending write of this source on the page (also those
   * started by another component). `true` when nothing is pending or the level
   * picked last was confirmed, `false` otherwise.
   */
  function settled(): Promise<boolean> {
    sync()
    return shared.chain ?? Promise.resolve(true)
  }

  /** An own change is unresolved (Z3) and no send was held for it yet. */
  function unresolvedNotHeld(): boolean {
    return shared.unclear && shared.heldVersion !== shared.writeVersion
  }

  /** A PUT of the current session is on the wire (one of an earlier session does not count, Z4). */
  function ownWire(): boolean {
    return !!shared.wire && shared.wireEpoch === shared.epoch
  }

  /** Z1 to Z4 without waiting: no own write open, no own PUT on the wire, no unresolved own change still owed a hold. */
  function readyNow(): boolean {
    if (!sync()) return true
    return !shared.chain && !ownWire() && !unresolvedNotHeld()
  }

  /**
   * May a Home send go out now (Z1 to Z4)? `'ready'` = send. `'failed'` = this
   * one send is held (the own save failed, or an own change is unresolved and no
   * send was held for it yet); the next send goes out. `'timeout'` = the own
   * save was not confirmed within `THINKING_SEND_WAIT_MS`. `'cancelled'` = Z8:
   * `signal` aborted (Home left) or the identity changed while waiting; the send
   * is dropped. Waiting only happens for an own write (and an own PUT still on
   * the wire); an unknown level alone never holds.
   */
  function readyToSend(signal?: AbortSignal): Promise<'ready' | 'failed' | 'timeout' | 'cancelled'> {
    if (signal?.aborted) return Promise.resolve('cancelled')
    if (readyNow()) return Promise.resolve('ready')
    const epoch = shared.epoch
    // Z1: the level shown at the tap is the one the server has to confirm.
    const shown = current.value
    // A wait that already ended (left Home, timeout) no longer counts as the one held send.
    let over = false
    const hold = (): 'failed' => {
      if (!over && epoch === shared.epoch) shared.heldVersion = shared.writeVersion
      return 'failed'
    }
    const work = (async (): Promise<'ready' | 'failed' | 'cancelled'> => {
      let waited = false
      let readAsked = false
      // An unresolved own change: the level picked is the one that must be in force.
      const mustBe = shared.unclear ? shared.desired : null
      for (;;) {
        // Z8: the identity changed while waiting.
        if (epoch !== shared.epoch) return 'cancelled'
        if (shared.chain) {
          waited = true
          const ok = await shared.chain
          if (epoch !== shared.epoch) return 'cancelled'
          if (!ok) return hold()
          continue
        }
        if (ownWire()) { await shared.wire; continue }
        if (waited) return shared.confirmed === shown ? 'ready' : hold()
        if (unresolvedNotHeld()) {
          // Z3: try one read; only when it fails the send is held, once.
          if (readAsked) return hold()
          readAsked = true
          await (shared.reading ?? read())
          continue
        }
        // The read cleared the unresolved change, but the server holds another level: hold once (Z2).
        if (readAsked && mustBe !== null && shared.confirmed !== mustBe) return hold()
        return 'ready'
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { hold(); over = true; resolve('timeout') }, THINKING_SEND_WAIT_MS)
    })
    // Z8: leaving Home ends the wait at once; the save itself goes on.
    const aborted = new Promise<'cancelled'>((resolve) => {
      if (!signal) return
      onAbort = () => resolve('cancelled')
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return Promise.race([work, deadline, aborted]).finally(() => {
      over = true
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    })
  }

  return {
    levels: SETTINGS_THINKING_LEVELS, current, known, loadError, saveError, saveUnclear, pickerOpen, saving, brainColorClass,
    load, change, settled, readyNow, readyToSend,
  }
}

export type ThinkingLevelState = ReturnType<typeof useThinkingLevel>
