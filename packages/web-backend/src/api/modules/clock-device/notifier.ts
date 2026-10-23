/**
 * Wake call for the LED clock (SCHNITTSTELLE.md, "Weckruf").
 *
 * The clock polls `GET /api/device/clock/state` every 15 s. To make a finished
 * task, a new question or a board update show up at once, the backend writes
 * `PATCH http://<clock>/api/v1/apps/Offtangent/data {"rev": n}`; the Berry app
 * sees a new `rev` and fetches the state immediately.
 *
 * Rules this module keeps, deliberately:
 *  * **No content.** The body is exactly `{"rev": <int>}`. The clock fetches
 *    the real state over its own token; nothing else crosses this wire.
 *  * **Never blocks the phone push.** {@link ClockNotifier.observe} is
 *    synchronous, never throws, and only schedules a timer. The HTTP call runs
 *    detached with a hard timeout (≤ 2 s); every failure is logged and dropped.
 *  * **Off unless configured.** Without `CLOCK_WAKE_URL` there is no notifier
 *    at all; `CLOCK_WAKE_ENABLED=false` turns a configured one off. A user
 *    without an active (non-revoked) clock device is never woken.
 *  * **LAN only.** The URL must be plain http(s) to a private IPv4 address or
 *    a `.local`/`.lan` host name; anything else is refused at startup.
 */
import type { Database } from '@axiom/core'
import type { PushDoorbell, PushKind } from '../../../push/sender.js'
import { ClockDeviceRegistry } from './registry.js'
import { buildClockState } from './state.js'
import { isLanAddress } from './route.js'

/** Doorbell kinds that change what the clock shows. `turn_done` does not. */
export const CLOCK_WAKE_KINDS: ReadonlySet<PushKind> = new Set<PushKind>(['task_done', 'error', 'question', 'feed_item'])

export const CLOCK_WAKE_TIMEOUT_MS = 2_000
/** Lets the triggering write settle and folds a burst into one call. */
export const CLOCK_WAKE_DEBOUNCE_MS = 500

export interface ClockWakeConfig {
  /** Full PATCH target, e.g. `http://clock.local/api/v1/apps/Offtangent/data`. */
  url: string
}

type Logger = { info: (msg: string) => void; warn: (msg: string) => void }
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>

/**
 * Reads the wake configuration from the environment. Returns null (= no wake
 * calls) when unset, switched off, or not a LAN target; `reason` says why.
 */
export function resolveClockWakeConfig(env: NodeJS.ProcessEnv = process.env): { config: ClockWakeConfig | null; reason: string } {
  const raw = env.CLOCK_WAKE_URL?.trim()
  if (!raw) return { config: null, reason: 'CLOCK_WAKE_URL not set' }
  const enabled = env.CLOCK_WAKE_ENABLED?.trim().toLowerCase()
  if (enabled && ['0', 'false', 'off', 'no'].includes(enabled)) {
    return { config: null, reason: 'CLOCK_WAKE_ENABLED is off' }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { config: null, reason: 'CLOCK_WAKE_URL is not a URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { config: null, reason: 'CLOCK_WAKE_URL must be http(s)' }
  }
  if (parsed.username || parsed.password) {
    return { config: null, reason: 'CLOCK_WAKE_URL must not carry credentials' }
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const lanName = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(local|lan)$/.test(host)
  // isLanAddress excludes loopback: the wake target is the clock, never this host.
  if (!lanName && !isLanAddress(host)) {
    return { config: null, reason: 'CLOCK_WAKE_URL must point into the local network' }
  }
  const appName = (env.CLOCK_WAKE_APP?.trim() || 'Offtangent')
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(appName)) {
    return { config: null, reason: 'CLOCK_WAKE_APP must be a plain app name' }
  }
  const url = `${parsed.protocol}//${parsed.host}/api/v1/apps/${appName}/data`
  return { config: { url }, reason: 'ok' }
}

export interface ClockNotifierOptions {
  db: Database
  config: ClockWakeConfig
  fetch?: FetchLike
  logger?: Logger
  timeoutMs?: number
  debounceMs?: number
}

export class ClockNotifier {
  private readonly registry: ClockDeviceRegistry
  private readonly fetchImpl: FetchLike
  private readonly logger: Logger
  private readonly timeoutMs: number
  private readonly debounceMs: number
  private readonly pending = new Map<number, ReturnType<typeof setTimeout>>()
  /** user id -> last rev the clock was woken with; an unchanged rev is not sent again. */
  private readonly lastRev = new Map<number, number>()
  private failureLogged = false

  constructor(private readonly options: ClockNotifierOptions) {
    this.registry = new ClockDeviceRegistry(options.db)
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
    this.logger = options.logger ?? { info: msg => console.log(msg), warn: msg => console.warn(msg) }
    this.timeoutMs = Math.min(options.timeoutMs ?? CLOCK_WAKE_TIMEOUT_MS, CLOCK_WAKE_TIMEOUT_MS)
    this.debounceMs = options.debounceMs ?? CLOCK_WAKE_DEBOUNCE_MS
  }

  /**
   * PushSender observer. Synchronous, never throws, never awaits: the phone
   * doorbell continues regardless of what happens here.
   */
  observe(doorbell: PushDoorbell): void {
    try {
      if (!CLOCK_WAKE_KINDS.has(doorbell.kind)) return
      const userId = doorbell.userId
      if (this.pending.has(userId)) return
      const timer = setTimeout(() => {
        this.pending.delete(userId)
        void this.wake(userId)
      }, this.debounceMs)
      timer.unref?.()
      this.pending.set(userId, timer)
    } catch (err) {
      this.logger.warn(`[clock] wake scheduling failed: ${(err as Error).message}`)
    }
  }

  /** Sends the wake call now. Resolves to true when the clock acknowledged it. Never rejects. */
  async wake(userId: number): Promise<boolean> {
    try {
      const devices = this.registry.listForUser(userId).filter(device => device.revokedAt === null)
      if (devices.length === 0) return false
      // The rev is computed exactly like GET /state for that device, so the
      // clock can skip the fetch when nothing it shows has changed.
      const device = devices[0]!
      const { rev } = buildClockState(this.options.db, { userId, privacy: device.privacy })
      if (this.lastRev.get(userId) === rev) return false
      const response = await this.fetchImpl(this.options.config.url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rev }),
        // Never follow a 3xx: the call must not leave the LAN target it was
        // configured with (a redirect could point anywhere).
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) {
        this.logOnce(`[clock] wake call answered HTTP ${response.status}`)
        return false
      }
      this.lastRev.set(userId, rev)
      this.failureLogged = false
      return true
    } catch (err) {
      this.logOnce(`[clock] wake call failed: ${(err as Error).name}: ${(err as Error).message}`)
      return false
    }
  }

  /** Clears pending timers (shutdown, tests). */
  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  /** A clock that is off would otherwise log one line per task. */
  private logOnce(message: string): void {
    if (this.failureLogged) return
    this.failureLogged = true
    this.logger.warn(`${message} (further failures muted until the next success)`)
  }
}
