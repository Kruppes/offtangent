/**
 * The push sender (PROTOCOL chapter 7, slice 2).
 *
 * One entry point, `send()`, called from the proactive paths: a turn that
 * ended, a background task that finished, failed or asked a question. It
 * fans the doorbell out to every enabled device of the user and keeps the
 * registry honest about what FCM said.
 *
 * Decisions that are deliberate and would otherwise look like omissions:
 *
 *  * **Send by default, never guess about presence.** An open WebSocket is not
 *    a reason to stay silent: the phone may have the strand in the background,
 *    a second device may be the one that is actually in front of the user, and
 *    a socket that is open is not a socket that is watched. Suppressing a
 *    notification while the user is looking at the strand is the app's job
 *    (it knows which screen is in front), not the backend's. An instance that
 *    disagrees can turn the backend side gate on with
 *    `PUSH_SUPPRESS_WHEN_CLIENT_ONLINE`, see {@link PushPresencePolicy}; the
 *    default stays `off` because a suppressed doorbell fails silently while a
 *    redundant one is merely noisy.
 *  * **No content travels, unless the operator says otherwise.** The ADR's
 *    payload rule stands by default: `title` and `body` are labels derived
 *    from the event (persona, kind, task name is NOT included), never message
 *    text. The app fetches the strand head through the tunnel to fill in the
 *    real line. An instance that would rather have the excerpt on the wire
 *    sets `PUSH_PREVIEW_CHARS` to a positive number; then, and only then, a
 *    `turn_done` carries the strand title and a shortened excerpt of the
 *    answer. That is a deliberate, reversible trade: the excerpt travels
 *    through Google.
 *  * **Coalescing, not queueing.** At most one doorbell per strand per
 *    {@link COALESCE_WINDOW_MS}. A suppressed doorbell is dropped, not
 *    deferred: the later event would arrive stale and the app re-fetches the
 *    strand head anyway.
 *  * **One retry, only for transient failures.** A token FCM calls
 *    `UNREGISTERED` or `INVALID_ARGUMENT` is disabled on the spot; retrying it
 *    would only earn another 404.
 */
import type { PushDevice, PushDeviceRegistry } from './device-registry.js'
import type { FcmClient, FcmSendResult } from './fcm-client.js'

export type PushKind = 'turn_done' | 'task_done' | 'question' | 'error'

export interface PushDoorbell {
  userId: number
  kind: PushKind
  strandId: string
  agentId: string
  /** Short label, no message content. Defaults to the persona id. */
  title?: string
  /** Short label, no message content. Defaults to a phrase for the kind. */
  body?: string
  /** `chat_messages.id` of the row that triggered this, when there is one. */
  messageId?: number | string | null
  /**
   * Raw text of the answer. Only collected when `PUSH_PREVIEW_CHARS > 0`;
   * {@link buildPayload} shortens it and drops it when previews are off, so
   * no call site can leak content past the switch.
   */
  preview?: string | null
  /** Overrides the send time; only tests set it. */
  sentAt?: string
}

/**
 * How an open WebSocket of the same user affects a doorbell.
 *
 *  * `off` (default, and what PROTOCOL chapter 7 describes): presence is
 *    ignored, the backend always sends and the app decides what to show.
 *  * `turn`: a `turn_done` is dropped while a client of that user is
 *    connected, because that answer is already on a screen in front of the
 *    user. Task results, questions and errors still ring.
 *  * `all`: every doorbell is dropped while a client is connected.
 */
export type PushPresencePolicy = 'off' | 'turn' | 'all'

export interface PushSendOutcome {
  /** Devices FCM accepted the message for. */
  delivered: number
  /** Devices that failed (after the retry) without being disabled. */
  failed: number
  /** Devices switched off because FCM said the token is gone. */
  disabled: number
  /** True when the doorbell never left because of the coalescing window. */
  coalesced: boolean
  /** True when the doorbell never left because a client of that user is online. */
  suppressed: boolean
  /** FCM message names, in device order. Empty when nothing was sent. */
  messageNames: string[]
}

/** At most one doorbell per strand in this window. */
export const COALESCE_WINDOW_MS = 10_000

/** How long FCM may hold a doorbell for an offline device. */
const TTL_SECONDS = 600

/** FCM error codes that mean the token is dead. No retry, disable the device. */
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'NOT_FOUND'])

/** FCM error codes worth exactly one more attempt. */
const TRANSIENT_CODES = new Set(['UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED'])

export interface PushSenderOptions {
  registry: PushDeviceRegistry
  client: FcmClient
  /** Structured log sink; defaults to console. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  now?: () => number
  /** Set to 0 in tests that do not want to wait for the retry backoff. */
  retryDelayMs?: number
  /** Default `off`. See {@link PushPresencePolicy}. */
  presencePolicy?: PushPresencePolicy
  /** Characters of the answer that may travel in the payload. `0` (default) means none. */
  previewChars?: number
  /** True while that user has a live `/ws/chat` connection. Only read when the policy asks for it. */
  isClientOnline?: (userId: number) => boolean
}

export class PushSender {
  private readonly registry: PushDeviceRegistry
  private readonly client: FcmClient
  private readonly logger: NonNullable<PushSenderOptions['logger']>
  private readonly now: () => number
  private readonly retryDelayMs: number
  private readonly presencePolicy: PushPresencePolicy
  private readonly isClientOnline: (userId: number) => boolean
  /** Read by the triggers: only a positive value makes them load the answer text at all. */
  readonly previewChars: number
  /** strand id -> timestamp of the last doorbell that went out for it. */
  private readonly lastSentByStrand = new Map<string, number>()
  /** The "no service account" warning is worth one line per process, not one per turn. */
  private warnedUnconfigured = false

  constructor(options: PushSenderOptions) {
    this.registry = options.registry
    this.client = options.client
    this.logger = options.logger ?? {
      info: msg => console.log(msg),
      warn: msg => console.warn(msg),
      error: msg => console.error(msg),
    }
    this.now = options.now ?? Date.now
    this.retryDelayMs = options.retryDelayMs ?? 500
    this.presencePolicy = options.presencePolicy ?? 'off'
    this.isClientOnline = options.isClientOnline ?? (() => false)
    this.previewChars = clampPreviewChars(options.previewChars ?? 0)
  }

  /** True when a service account is configured and readable. */
  isConfigured(): boolean {
    return this.client.isConfigured()
  }

  async send(doorbell: PushDoorbell): Promise<PushSendOutcome> {
    const empty: PushSendOutcome = {
      delivered: 0, failed: 0, disabled: 0, coalesced: false, suppressed: false, messageNames: [],
    }

    const devices = this.registry.activeForUser(doorbell.userId)
    if (devices.length === 0) return empty
    if (!this.client.isConfigured()) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true
        this.logger.warn('[push] No FCM service account configured, doorbells are dropped')
      }
      return empty
    }
    // Presence is checked before the coalescing window is stamped: a doorbell
    // that was never sent must not silence the next one.
    if (this.isSuppressedByPresence(doorbell)) {
      return { ...empty, suppressed: true }
    }
    if (this.isCoalesced(doorbell)) {
      return { ...empty, coalesced: true }
    }
    this.lastSentByStrand.set(this.coalesceKey(doorbell), this.now())

    const data = buildPayload(doorbell, doorbell.sentAt ?? new Date(this.now()).toISOString(), this.previewChars)
    const priority = priorityFor(doorbell.kind)

    const outcome: PushSendOutcome = { ...empty, messageNames: [] }
    for (const device of devices) {
      const result = await this.sendToDevice(device, data, priority, doorbell.strandId)
      if (result.ok) {
        outcome.delivered += 1
        if (result.name) outcome.messageNames.push(result.name)
        this.registry.markSuccess(device.token)
        continue
      }
      if (DEAD_TOKEN_CODES.has(result.errorCode ?? '')) {
        outcome.disabled += 1
        this.registry.disable(device.token)
        this.logger.warn(`[push] Device disabled (${result.errorCode}) for user ${device.userId}`)
        continue
      }
      outcome.failed += 1
      this.registry.markFailure(device.token)
      this.logger.warn(`[push] Doorbell failed (${result.status} ${result.errorCode ?? 'unknown'}) for user ${device.userId}`)
    }
    return outcome
  }

  /** Fire and forget for the event paths: a push must never break a turn. */
  sendDetached(doorbell: PushDoorbell): void {
    this.send(doorbell).catch(err => {
      this.logger.error(`[push] Doorbell threw: ${(err as Error).message}`)
    })
  }

  private isSuppressedByPresence(doorbell: PushDoorbell): boolean {
    if (this.presencePolicy === 'off') return false
    if (this.presencePolicy === 'turn' && doorbell.kind !== 'turn_done') return false
    try {
      return this.isClientOnline(doorbell.userId)
    } catch {
      // A presence checker that throws must not cost a notification.
      return false
    }
  }

  private coalesceKey(doorbell: PushDoorbell): string {
    return `${doorbell.userId}:${doorbell.strandId}`
  }

  private isCoalesced(doorbell: PushDoorbell): boolean {
    const last = this.lastSentByStrand.get(this.coalesceKey(doorbell))
    if (last === undefined) return false
    return this.now() - last < COALESCE_WINDOW_MS
  }

  private async sendToDevice(
    device: PushDevice,
    data: Record<string, string>,
    priority: 'high' | 'normal',
    strandId: string,
  ): Promise<FcmSendResult> {
    const message = { token: device.token, data, priority, ttlSeconds: TTL_SECONDS, collapseKey: strandId }
    let result: FcmSendResult
    try {
      result = await this.client.send(message)
    } catch (err) {
      result = { ok: false, status: 0, errorCode: 'TRANSPORT', errorMessage: (err as Error).message }
    }
    if (result.ok) return result
    const retryable = TRANSIENT_CODES.has(result.errorCode ?? '')
      || result.errorCode === 'TRANSPORT'
      || result.status >= 500
      || result.status === 429
    if (!retryable) return result

    if (this.retryDelayMs > 0) await delay(this.retryDelayMs)
    try {
      return await this.client.send(message)
    } catch (err) {
      return { ok: false, status: 0, errorCode: 'TRANSPORT', errorMessage: (err as Error).message }
    }
  }
}

/** `question` and `error` wake the device now; the rest can wait for the next window. */
export function priorityFor(kind: PushKind): 'high' | 'normal' {
  return kind === 'question' || kind === 'error' ? 'high' : 'normal'
}

/**
 * The wire payload. Data only, every value a string (FCM rejects anything
 * else), no message content. Two fields are deliberate duplicates so that no
 * client has to guess: `persona` repeats `agentId` for the slice 0 app (0.5.0
 * to 0.7.2, which only knows `persona`), and `sessionId` repeats `strandId`
 * because a strand is a session row and other clients address it under that
 * name. `strandId` plus `messageId` is what a deep link needs.
 */
export function buildPayload(doorbell: PushDoorbell, sentAt: string, previewChars = 0): Record<string, string> {
  const title = doorbell.title?.trim() || doorbell.agentId
  const body = doorbell.body?.trim() || defaultBody(doorbell.kind)
  const data: Record<string, string> = {
    kind: doorbell.kind,
    strandId: doorbell.strandId,
    sessionId: doorbell.strandId,
    agentId: doorbell.agentId,
    persona: doorbell.agentId,
    title,
    body,
    sentAt,
  }
  if (doorbell.messageId !== undefined && doorbell.messageId !== null) {
    data.messageId = String(doorbell.messageId)
  }
  // The single place where content can reach the wire. With the default of 0
  // the field never exists, whatever a call site put into `preview`.
  const preview = shortenPreview(doorbell.preview, previewChars)
  if (preview) data.preview = preview
  return data
}

/**
 * Collapses whitespace and cuts at `limit` characters, on a word boundary when
 * one is near the end, with a trailing ellipsis. Returns null when previews are
 * off or nothing is left.
 */
export function shortenPreview(raw: string | null | undefined, limit: number): string | null {
  const chars = clampPreviewChars(limit)
  if (chars === 0) return null
  const flat = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return null
  if (flat.length <= chars) return flat
  const cut = flat.slice(0, chars)
  const lastSpace = cut.lastIndexOf(' ')
  const body = lastSpace > chars * 0.6 ? cut.slice(0, lastSpace) : cut
  return `${body.trimEnd()}\u2026`
}

/** Previews are capped hard: the payload limit is 4 KB and this is a label, not a reader. */
export function clampPreviewChars(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), MAX_PREVIEW_CHARS)
}

/** Upper bound for `PUSH_PREVIEW_CHARS`. */
export const MAX_PREVIEW_CHARS = 300

function defaultBody(kind: PushKind): string {
  switch (kind) {
    case 'turn_done': return 'There is a new answer'
    case 'task_done': return 'A background task finished'
    case 'question': return 'A background task is waiting for you'
    case 'error': return 'Something went wrong'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Reads `PUSH_SUPPRESS_WHEN_CLIENT_ONLINE`. Accepted: `off`/`false`/`0`/`no`
 * (default), `turn`/`turn_done`, `all`/`true`/`1`/`yes`. Anything else falls
 * back to `off` on purpose: a typo must not silence the phone, because a
 * missing doorbell is invisible while a redundant one is merely noisy.
 */
/**
 * Reads `PUSH_PREVIEW_CHARS`. `0`, unset or unparseable means no content on
 * the wire, which is the ADR default. A positive number is clamped to
 * {@link MAX_PREVIEW_CHARS}.
 */
export function resolvePreviewChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PUSH_PREVIEW_CHARS?.trim()
  if (!raw) return 0
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return 0
  return clampPreviewChars(parsed)
}

export function resolvePresencePolicy(env: NodeJS.ProcessEnv = process.env): PushPresencePolicy {
  const raw = env.PUSH_SUPPRESS_WHEN_CLIENT_ONLINE?.trim().toLowerCase()
  if (!raw) return 'off'
  if (raw === 'turn' || raw === 'turn_done') return 'turn'
  if (raw === 'all' || raw === 'true' || raw === '1' || raw === 'yes') return 'all'
  return 'off'
}
