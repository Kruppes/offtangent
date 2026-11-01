/**
 * ClockExchangeTracker (companion K2, KONZEPT-COMPANION §2.2–2.5).
 *
 * Follows the answer turns of one spoken question from the clock and turns
 * their text deltas into the short, spoken part the clock shows (and, with
 * B3', speaks). One entry per exchange, ONLY in memory, forgotten after
 * 15 minutes. It writes nothing into the strand and nothing into the capture
 * tables: a restart loses running exchanges, the answer is in the strand
 * anyway.
 *
 * Source of the deltas: `TurnRunner.subscribe` (per user), filtered on the
 * `turnIds` the captures service reported for this capture (K1 finding: the
 * turn id does not reach the ChatEventBus). A split capture has several
 * turns (§3): the clock speaks the answer of the FIRST turn only and shows
 * the other parts as "+1 Thema abgelegt: <Titel>" (`more_parts`); when their
 * answers are done, the exchange reports `answer_ready`.
 *
 * Spoken part (decision E2 = H2): the clock answer style asks the model for a
 * first paragraph of one or two short spoken sentences. The tracker releases
 * that paragraph sentence by sentence and stops at the first blank line or at
 * {@link CLOCK_SPOKEN_MAX} characters. Only when the model ignored H2 and not
 * a single sentence fits into the limit, H3 runs: a short version from a small
 * model (`shorten`), with a word cut as the last resort.
 *
 * The released text is append-only: the long-poll cursor is a character
 * offset into it, so a repeated poll with the same cursor gets the same delta.
 */
import { stripInteractionFencesForVoice } from '@axiom/core'

/** Upper bound of the spoken part on the clock (§2.3). */
export const CLOCK_SPOKEN_MAX = 300
/** An exchange is forgotten this long after its start (§2.2). */
export const CLOCK_EXCHANGE_TTL_MS = 15 * 60_000
/** No text this long after the start: the overlay closes, `background` (§2.5). */
export const CLOCK_BACKGROUND_AFTER_MS = 60_000
/** At most this many exchanges are kept; the oldest go first. */
export const CLOCK_EXCHANGE_MAX = 200
/** Raw text kept per turn; the spoken part is long done before this. */
const RAW_TEXT_MAX = 16_000
/** Events of turns nobody registered yet (race between startTurn and register). */
const ORPHAN_TURNS_MAX = 8
const ORPHAN_TTL_MS = 30_000
const ORPHAN_EVENTS_MAX = 400
/** Upper bound of the H3 call; the deterministic cut follows after it. */
export const CLOCK_SHORTEN_TIMEOUT_MS = 8_000

export type ClockExchangePhase =
  | 'queued'
  | 'thinking'
  | 'speaking'
  | 'done'
  | 'background'
  | 'noted'
  | 'needs_choice'
  | 'pending'
  | 'error'

const TERMINAL: ReadonlySet<ClockExchangePhase> = new Set(['done', 'noted', 'needs_choice', 'pending', 'error'])

/** The spoken turn of an exchange: the one of part 0, never a later part (§1.4). */
function primaryTurn<T extends { partIndex: number }>(entry: { turns: T[] }): T | null {
  return entry.turns.find(t => t.partIndex === 0) ?? null
}

/** The slice of a turn event the tracker reads (structural: `TurnEvent` of @axiom/core). */
export interface TrackedTurnEvent {
  type: string
  turnId: string
  sessionId?: string
  chunk?: {
    type: string
    text?: string
    toolName?: string
    toolIsError?: boolean
    toolResult?: unknown
    error?: string
  }
}

export interface ClockTurnSource {
  subscribe: (user: number | string, subscriber: (event: TrackedTurnEvent) => void) => () => void
}

export interface RegisterExchangeInput {
  exchangeId: string
  deviceId: string
  userId: number
  strandId: string | null
  strandTitle: string | null
  persona: string | null
  /** Runner ids of the answer turns, in part order (CaptureResult.turnIds). */
  turnIds: Array<{ partIndex: number; turnId: string }>
  /** Phase without turn: `noted`, `needs_choice` or `pending`; ignored when turnIds is set. */
  phase?: ClockExchangePhase
  /** Error code of an exchange that starts as `error`. */
  error?: string | null
  /** Wait state at the start (CaptureResult.turn). */
  queue?: { position: number; blockedByTitle: string | null } | null
  /** Strand titles of the other parts of a split capture (§3). */
  moreParts?: Array<{ title: string | null }>
  /** The POST answer's `state` at the first upload; a repeat answers it again. */
  initialState?: string | null
}

interface TurnTrack {
  turnId: string
  partIndex: number
  raw: string
  /** Released spoken text of this turn (append-only). */
  spoken: string
  spokenDone: boolean
  /** The model ignored H2; the turn waits for H3 at its end. */
  overLimit: boolean
  /** H3 is running for this turn. */
  shortening: boolean
  ended: boolean
  error: string | null
}

interface ExchangeEntry {
  exchangeId: string
  deviceId: string
  userId: number
  strandId: string | null
  strandTitle: string | null
  persona: string | null
  turns: TurnTrack[]
  initialState: string | null
  phase: ClockExchangePhase
  /** Spoken text of the first turn (§3); the cursor indexes into it. */
  text: string
  spokenDone: boolean
  truncated: boolean
  queue: { position: number; blockedByTitle: string | null } | null
  moreParts: Array<{ title: string | null }>
  taskIds: string[]
  backgrounded: boolean
  answerReady: boolean
  answerReadyAt: number | null
  error: string | null
  startedAt: number
  firstTextAt: number | null
  doneAt: number | null
  rev: number
  waiters: Set<() => void>
  backgroundTimer: ReturnType<typeof setTimeout> | null
  /** Fires the TTL prune for an exchange with followed turns (MINOR-2). */
  ttlTimer: ReturnType<typeof setTimeout> | null
}

/** What `GET /voice/:exchangeId` answers (snake_case is the wire). */
export interface ClockExchangeView {
  exchange_id: string
  state: ClockExchangePhase
  text_delta: string
  cursor: number
  spoken_done: boolean
  truncated: boolean
  strand_title: string | null
  persona: string | null
  queue: { position: number; blocked_by_title: string | null } | null
  /** Other parts of a split capture: "+n Thema abgelegt: <Titel>". */
  more_parts: Array<{ title: string | null }>
  task_ids: string[]
  answer_ready: boolean
  error: string | null
  rev: number
}

/** A finished background answer, for the clock state's event list (§2.5). */
export interface ClockAnswerReady {
  exchangeId: string
  userId: number
  deviceId: string
  persona: string | null
  strandTitle: string | null
  at: number
}

export interface ClockExchangeTrackerOptions {
  /** The TurnRunner; null while the agent core is not up. */
  getTurnSource: () => ClockTurnSource | null
  /** H3: short spoken version of a long first paragraph. Null = word cut only. */
  shorten?: ((text: string, maxChars: number, strandId?: string | null) => Promise<string | null>) | null
  /** Called when a backgrounded answer is ready (wake call of the clock, notifier.ts). */
  onAnswerReady?: (ready: ClockAnswerReady) => void
  now?: () => number
  backgroundAfterMs?: number
  ttlMs?: number
  shortenTimeoutMs?: number
}

// ---- spoken part ------------------------------------------------------------

/** Markdown that has no place on an LED panel or in a voice. */
function flattenForVoice(text: string): string {
  return text
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
}

/** End of the last complete sentence in `text` (index after its terminator), or 0. */
function lastSentenceEnd(text: string, limit: number): number {
  let end = 0
  const pattern = /[.!?…]["»“”')]*(?=\s|$)/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    const after = m.index + m[0].length
    if (after > limit) break
    end = after
  }
  return end
}

const SENTENCE_END = /[.!?…]["»“”')]*$/

/**
 * `text` (one finished unit, e.g. a closed paragraph) as whole sentences
 * within `max` (review K0-K2, MINOR-1). A unit that ends without a
 * terminator is a finished sentence all the same and gets a period (trailing
 * `:`/`,`/dash dropped), so the ear hears an end; if that does not fit, the
 * whole sentences up to `max` remain. `dropped` says text was left out;
 * an empty `text` means not even one sentence fits.
 */
export function wholeSentences(text: string, max: number): { text: string; dropped: boolean } {
  const flat = text.trim()
  if (!flat) return { text: '', dropped: false }
  const unit = flat.replace(/[\s,;:–—-]+$/, '')
  if (unit && unit.length <= max && SENTENCE_END.test(unit)) return { text: unit, dropped: false }
  if (unit && unit.length + 1 <= max) return { text: `${unit}.`, dropped: false }
  const end = lastSentenceEnd(flat, max)
  return { text: end > 0 ? flat.slice(0, end) : '', dropped: true }
}

/**
 * Word cut for the H3 last resort: at most `max` characters, ending in "…".
 * The one documented exception to "whole sentences" (§2.3): it only runs when
 * not one sentence of the answer fits into `max` and the model gave no usable
 * short version; the ellipsis marks the cut for the ear and the panel.
 */
export function cutAtWord(text: string, max: number): string {
  const flat = text.trim()
  if (flat.length <= max) return flat
  const head = flat.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`
}

/** Residue of an interaction block that a filter must never let through to the ear. */
const BLOCK_RESIDUE = /```|offtangent[-\w]*\s*\{|\{\s*"kind"\s*:/i

/**
 * The H3 model's short version, made safe for the clock, or null when it is
 * unusable (then the word cut of the source follows). Same filter as a
 * streamed answer: interaction fences out, markdown flattened; a version that
 * carried a card or still shows block residue is rejected as a whole; one
 * that is too long keeps its whole sentences up to `max`.
 */
export function shortenedForVoice(text: string | null | undefined, max = CLOCK_SPOKEN_MAX): string | null {
  if (!text) return null
  const stripped = stripInteractionFencesForVoice(text)
  if (stripped.hadCard) return null
  const flat = flattenForVoice(stripped.text).trim()
  if (!flat || BLOCK_RESIDUE.test(flat)) return null
  return wholeSentences(flat, max).text || null
}

export interface SpokenCut {
  /** Text that may be released now (a prefix of what follows). */
  text: string
  /** The spoken part is complete. */
  complete: boolean
  /** No sentence fits into the limit: H3 has to shorten. */
  overLimit: boolean
  /** The answer goes on after the spoken part ("Rest in der App"). */
  truncated: boolean
}

/**
 * The spoken part of a (possibly still streaming) answer (H2). Pure, for the
 * tests: `final` says the turn has ended.
 */
export function spokenPart(raw: string, final: boolean, max = CLOCK_SPOKEN_MAX): SpokenCut {
  let body = stripInteractionFencesForVoice(raw).text
  if (!final) {
    // Never release half a fence opener or half a markdown marker.
    const fence = body.indexOf('```')
    if (fence >= 0) body = body.slice(0, fence)
  }
  const breakAt = body.search(/\n[ \t]*\n/)
  const paragraph = breakAt >= 0 ? body.slice(0, breakAt) : body
  const rest = breakAt >= 0 ? body.slice(breakAt).trim() : ''
  const closed = breakAt >= 0 || final
  const flat = flattenForVoice(paragraph).trim()

  if (closed && flat.length <= max) {
    if (!flat) return { text: '', complete: true, overLimit: false, truncated: rest.length > 0 }
    // Whole sentences also for a paragraph that ends without a terminator (MINOR-1).
    const whole = wholeSentences(flat, max)
    if (whole.text) return { text: whole.text, complete: true, overLimit: false, truncated: rest.length > 0 || whole.dropped }
    return { text: '', complete: false, overLimit: true, truncated: true }
  }
  if (flat.length <= max) {
    // Still streaming: whole sentences only (B3' speaks them one by one).
    return { text: flat.slice(0, lastSentenceEnd(flat, max)), complete: false, overLimit: false, truncated: false }
  }
  // H2 ignored: the paragraph does not fit. Whole sentences up to the limit.
  const end = lastSentenceEnd(flat, max)
  if (end > 0) return { text: flat.slice(0, end), complete: true, overLimit: false, truncated: true }
  return { text: '', complete: false, overLimit: true, truncated: true }
}

// ---- tracker ----------------------------------------------------------------

/** The id of a task a `create_task` tool call started, if the result names one. */
export function createdTaskId(toolResult: unknown): string | null {
  if (!toolResult || typeof toolResult !== 'object') return null
  const details = (toolResult as { details?: { taskId?: unknown } }).details
  if (details && typeof details.taskId === 'string' && details.taskId) return details.taskId
  const content = (toolResult as { content?: Array<{ type?: string; text?: unknown }> }).content
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item?.text !== 'string') continue
      const m = /Task ID:\s*([A-Za-z0-9_-]{4,64})/.exec(item.text)
      if (m) return m[1]
    }
  }
  return null
}

export class ClockExchangeTracker {
  private readonly entries = new Map<string, ExchangeEntry>()
  private readonly byTurn = new Map<string, ExchangeEntry>()
  private readonly subscriptions = new Map<string, { source: ClockTurnSource; unsubscribe: () => void }>()
  private readonly orphans = new Map<string, { at: number; events: TrackedTurnEvent[] }>()
  /** Open `watch()` calls per user (an upload between STT and registration). */
  private readonly watching = new Map<string, number>()
  private readonly now: () => number
  private readonly backgroundAfterMs: number
  private readonly ttlMs: number
  private readonly shortenTimeoutMs: number

  constructor(private readonly options: ClockExchangeTrackerOptions) {
    this.now = options.now ?? Date.now
    this.backgroundAfterMs = options.backgroundAfterMs ?? CLOCK_BACKGROUND_AFTER_MS
    this.ttlMs = options.ttlMs ?? CLOCK_EXCHANGE_TTL_MS
    this.shortenTimeoutMs = options.shortenTimeoutMs ?? CLOCK_SHORTEN_TIMEOUT_MS
  }

  /**
   * Starts following an exchange. Idempotent: a repeated upload with the same
   * exchange id (same capture) keeps the running entry untouched.
   */
  register(input: RegisterExchangeInput): void {
    this.prune()
    if (this.entries.has(input.exchangeId)) return
    const turns = [...input.turnIds]
      .sort((a, b) => a.partIndex - b.partIndex)
      .map(t => ({
        turnId: t.turnId, partIndex: t.partIndex, raw: '', spoken: '', spokenDone: false,
        overLimit: false, shortening: false, ended: false, error: null,
      }))
    // Only part 0 is spoken (§1.4, review K0-K2 MAJOR-4). Without a part-0
    // turn the exchange is terminal at once with the phase the route gave
    // (needs_choice for a part 0 in the tray); turns of other parts are still
    // followed, for answer_ready.
    const spoken = turns.some(t => t.partIndex === 0)
    const phase: ClockExchangePhase = spoken
      ? (input.queue ? 'queued' : 'thinking')
      : (input.phase && TERMINAL.has(input.phase) ? input.phase : turns.length > 0 ? 'needs_choice' : 'noted')
    const entry: ExchangeEntry = {
      exchangeId: input.exchangeId,
      deviceId: input.deviceId,
      userId: input.userId,
      strandId: input.strandId,
      strandTitle: input.strandTitle,
      persona: input.persona,
      turns,
      initialState: input.initialState ?? null,
      phase,
      text: '',
      spokenDone: !spoken,
      truncated: false,
      queue: spoken ? input.queue ?? null : null,
      moreParts: input.moreParts ?? [],
      taskIds: [],
      backgrounded: false,
      answerReady: false,
      answerReadyAt: null,
      error: !spoken && phase === 'error' ? input.error ?? 'failed' : null,
      startedAt: this.now(),
      firstTextAt: null,
      doneAt: !spoken ? this.now() : null,
      rev: 1,
      waiters: new Set(),
      backgroundTimer: null,
      ttlTimer: null,
    }
    if (!spoken) {
      if (phase === 'noted') entry.text = input.strandTitle ? `Notiert: ${input.strandTitle}` : 'Notiert'
      else if (phase === 'needs_choice') entry.text = 'Rückfrage in der App'
    }
    this.entries.set(entry.exchangeId, entry)
    while (this.entries.size > CLOCK_EXCHANGE_MAX) {
      const oldest = this.entries.keys().next().value as string
      this.forget(oldest)
    }
    if (turns.length === 0) return

    for (const turn of turns) this.byTurn.set(turn.turnId, entry)
    this.ensureSubscribed(entry.userId)
    // The TTL also ends a turn that never reports its end: without this
    // timer the expiry (and the unsubscribe) waited for the next request.
    entry.ttlTimer = setTimeout(() => this.prune(), this.ttlMs + 1)
    entry.ttlTimer.unref?.()
    // Events that arrived between the runner's start and this registration.
    for (const turn of turns) {
      const parked = this.orphans.get(turn.turnId)
      if (!parked) continue
      this.orphans.delete(turn.turnId)
      for (const event of parked.events) this.onEvent(event)
    }
    if (!TERMINAL.has(entry.phase)) {
      entry.backgroundTimer = setTimeout(() => this.maybeBackground(entry), this.backgroundAfterMs)
      entry.backgroundTimer.unref?.()
    }
  }

  /**
   * Subscribes to the user's turns BEFORE the capture starts one, so that no
   * early chunk is missed (events of a not yet registered turn are parked).
   */
  watch(userId: number): void {
    const key = String(userId)
    this.watching.set(key, (this.watching.get(key) ?? 0) + 1)
    this.ensureSubscribed(userId)
  }

  /**
   * Ends a `watch()` (review K0-K2, MINOR-2). The route calls it once per
   * `watch()`, after the exchange is registered or the upload failed; the
   * subscription is dropped as soon as the user has neither an open watch
   * nor a turn the tracker still follows.
   */
  unwatch(userId: number): void {
    const key = String(userId)
    const open = (this.watching.get(key) ?? 0) - 1
    if (open > 0) this.watching.set(key, open)
    else this.watching.delete(key)
    this.releaseIfIdle(userId)
  }

  /** Users with a live TurnRunner subscription (tests, diagnostics). */
  subscribedUsers(): number[] {
    return [...this.subscriptions.keys()].map(Number)
  }

  has(exchangeId: string): boolean {
    this.prune()
    return this.entries.has(exchangeId)
  }

  /** First turn id and first POST state of a known exchange (for a repeated upload). */
  firstAnswer(exchangeId: string): { turnId: string | null; initialState: string | null } | null {
    const entry = this.entries.get(exchangeId)
    if (!entry) return null
    return { turnId: primaryTurn(entry)?.turnId ?? null, initialState: entry.initialState }
  }

  /** Owner check for the route: the exchange belongs to this device. */
  ownedBy(exchangeId: string, deviceId: string): boolean {
    return this.entries.get(exchangeId)?.deviceId === deviceId
  }

  /**
   * The view for a client that has read `cursor` characters. `privacy` drops
   * every plain text (device privacy mode).
   */
  view(exchangeId: string, cursor: number, privacy = false): ClockExchangeView | null {
    this.prune()
    const entry = this.entries.get(exchangeId)
    if (!entry) return null
    this.maybeBackground(entry)
    const from = Math.max(0, Math.min(Number.isFinite(cursor) ? Math.floor(cursor) : 0, entry.text.length))
    return {
      exchange_id: entry.exchangeId,
      state: entry.phase,
      text_delta: privacy ? '' : entry.text.slice(from),
      cursor: entry.text.length,
      spoken_done: entry.spokenDone,
      truncated: entry.truncated,
      strand_title: privacy ? null : entry.strandTitle,
      persona: entry.persona,
      queue: entry.phase === 'queued' && entry.queue
        ? { position: entry.queue.position, blocked_by_title: privacy ? null : entry.queue.blockedByTitle }
        : null,
      more_parts: entry.moreParts.map(p => ({ title: privacy ? null : p.title })),
      task_ids: [...entry.taskIds],
      answer_ready: entry.answerReady,
      error: entry.error,
      rev: entry.rev,
    }
  }

  /**
   * Resolves when the exchange has text beyond `cursor`, a phase other than
   * `knownState`, is terminal — or after `timeoutMs`. `signal` ends the wait
   * early (client gone).
   */
  async waitForChange(
    exchangeId: string, cursor: number, knownState: string | null, timeoutMs: number, signal?: AbortSignal,
  ): Promise<void> {
    const entry = this.entries.get(exchangeId)
    if (!entry) return
    // Without a known phase the poll waits for text or any phase change.
    const known = knownState ?? entry.phase
    const ready = () => entry.text.length > cursor || entry.phase !== known || TERMINAL.has(entry.phase)
    this.maybeBackground(entry)
    if (ready()) return
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = () => {
        if (timer) clearTimeout(timer)
        entry.waiters.delete(check)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const check = () => { if (ready()) done() }
      entry.waiters.add(check)
      timer = setTimeout(done, timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** Task ids started by the answer of a live exchange (E4: "aus deiner Frage"). */
  questionTaskIds(userId: number): Set<string> {
    this.prune()
    const ids = new Set<string>()
    for (const entry of this.entries.values()) {
      if (entry.userId !== userId) continue
      for (const id of entry.taskIds) ids.add(id)
    }
    return ids
  }

  /** Background answers that finished and have not expired (§2.5). */
  answersReady(userId: number): ClockAnswerReady[] {
    this.prune()
    const out: ClockAnswerReady[] = []
    for (const entry of this.entries.values()) {
      if (entry.userId !== userId || !entry.answerReady || entry.answerReadyAt === null) continue
      out.push({
        exchangeId: entry.exchangeId, userId: entry.userId, deviceId: entry.deviceId,
        persona: entry.persona, strandTitle: entry.strandTitle, at: entry.answerReadyAt,
      })
    }
    return out
  }

  /** Latency marks of an exchange (ms after start), for logs and tests. */
  timing(exchangeId: string): { firstTextMs: number | null; doneMs: number | null } | null {
    const entry = this.entries.get(exchangeId)
    if (!entry) return null
    return {
      firstTextMs: entry.firstTextAt === null ? null : entry.firstTextAt - entry.startedAt,
      doneMs: entry.doneAt === null ? null : entry.doneAt - entry.startedAt,
    }
  }

  dispose(): void {
    for (const sub of this.subscriptions.values()) sub.unsubscribe()
    this.subscriptions.clear()
    this.watching.clear()
    for (const id of [...this.entries.keys()]) this.forget(id)
    this.orphans.clear()
  }

  // ---- internals ----------------------------------------------------------

  private ensureSubscribed(userId: number): void {
    const source = this.options.getTurnSource()
    if (!source) return
    const key = String(userId)
    const current = this.subscriptions.get(key)
    if (current && current.source === source) return
    current?.unsubscribe()
    // One subscription per user while it is needed: from `watch()` (before
    // the turn exists) until the user's last followed turn ended, its
    // exchange expired or the upload was given up (releaseIfIdle).
    const unsubscribe = source.subscribe(userId, event => {
      try {
        this.onEvent(event)
      } catch (err) {
        console.error('[clock-exchange] event handling failed:', (err as Error)?.name ?? typeof err)
      }
    })
    this.subscriptions.set(key, { source, unsubscribe })
  }

  private onEvent(event: TrackedTurnEvent): void {
    const entry = this.byTurn.get(event.turnId)
    if (!entry) {
      this.park(event)
      return
    }
    const turn = entry.turns.find(t => t.turnId === event.turnId)
    if (!turn || turn.ended) return
    if (event.type === 'turn_start') {
      if (entry.phase === 'queued' && turn === primaryTurn(entry)) this.setPhase(entry, 'thinking')
      return
    }
    if (event.type === 'turn_end') {
      this.endTurn(entry, turn)
      return
    }
    if (event.type !== 'chunk' || !event.chunk) return
    const chunk = event.chunk
    if (chunk.type === 'text' && typeof chunk.text === 'string') {
      if (turn.raw.length < RAW_TEXT_MAX) turn.raw += chunk.text
      if (entry.phase === 'queued' && turn === primaryTurn(entry)) this.setPhase(entry, 'thinking')
      this.advance(entry, turn, false)
    } else if (chunk.type === 'tool_call_end' && chunk.toolName === 'create_task' && !chunk.toolIsError) {
      const taskId = createdTaskId(chunk.toolResult)
      if (taskId && !entry.taskIds.includes(taskId)) {
        entry.taskIds.push(taskId)
        this.bump(entry)
      }
    } else if (chunk.type === 'error') {
      turn.error = 'turn_failed'
    } else if (chunk.type === 'done') {
      this.endTurn(entry, turn)
    }
  }

  /** Events of a turn no exchange claims (yet): kept briefly, bounded. */
  private park(event: TrackedTurnEvent): void {
    const now = this.now()
    for (const [id, parked] of this.orphans) {
      if (now - parked.at > ORPHAN_TTL_MS) this.orphans.delete(id)
    }
    let parked = this.orphans.get(event.turnId)
    if (!parked) {
      if (event.type !== 'turn_start' && event.type !== 'chunk') return
      parked = { at: now, events: [] }
      this.orphans.set(event.turnId, parked)
      while (this.orphans.size > ORPHAN_TURNS_MAX) this.orphans.delete(this.orphans.keys().next().value as string)
    }
    if (parked.events.length < ORPHAN_EVENTS_MAX) parked.events.push(event)
  }

  private endTurn(entry: ExchangeEntry, turn: TurnTrack): void {
    if (turn.ended) return
    turn.ended = true
    this.advance(entry, turn, true)
    this.releaseIfIdle(entry.userId)
  }

  /**
   * Drops the user's subscription when nothing needs its events any more:
   * no open `watch()` and no registered turn that has not ended (review
   * K0-K2, MINOR-2). Parked orphan events go with the last subscription.
   */
  private releaseIfIdle(userId: number): void {
    const key = String(userId)
    const sub = this.subscriptions.get(key)
    if (!sub) return
    if ((this.watching.get(key) ?? 0) > 0) return
    for (const entry of this.entries.values()) {
      if (entry.userId === userId && entry.turns.some(t => !t.ended)) return
    }
    this.subscriptions.delete(key)
    sub.unsubscribe()
    if (this.subscriptions.size === 0) this.orphans.clear()
  }

  /** Releases the spoken text of `turn` and recomputes the exchange. */
  private advance(entry: ExchangeEntry, turn: TurnTrack, final: boolean): void {
    if (turn !== primaryTurn(entry)) {
      // Other parts of a split capture are not spoken; only their end counts.
      this.recompute(entry)
      return
    }
    if (!turn.spokenDone && !turn.overLimit) {
      const cut = spokenPart(turn.raw, final)
      if (cut.text.length > turn.spoken.length && cut.text.startsWith(turn.spoken)) turn.spoken = cut.text
      if (cut.truncated) entry.truncated = true
      if (cut.overLimit) {
        turn.overLimit = true
        if (final) this.runShorten(entry, turn)
      } else if (cut.complete) {
        turn.spokenDone = true
      }
    } else if (turn.overLimit && final) {
      this.runShorten(entry, turn)
    }
    this.recompute(entry)
  }

  /** H3: one short version per turn, then the word cut. */
  private runShorten(entry: ExchangeEntry, turn: TurnTrack): void {
    if (turn.spokenDone || turn.shortening) return
    turn.shortening = true
    const source = flattenForVoice(stripInteractionFencesForVoice(turn.raw).text).trim()
    const finish = (text: string | null) => {
      // The model's answer is untrusted text like any answer: it goes through
      // the same fence filter and sentence/length rule (review K0-K2, MAJOR-1).
      turn.spoken = shortenedForVoice(text, CLOCK_SPOKEN_MAX) ?? cutAtWord(source, CLOCK_SPOKEN_MAX)
      turn.spokenDone = true
      this.recompute(entry)
    }
    const shorten = this.options.shorten
    if (!shorten) {
      finish(null)
      return
    }
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; finish(null) } }, this.shortenTimeoutMs)
    timer.unref?.()
    shorten(source, CLOCK_SPOKEN_MAX, entry.strandId).then(
      text => { if (!settled) { settled = true; clearTimeout(timer); finish(text) } },
      () => { if (!settled) { settled = true; clearTimeout(timer); finish(null) } },
    )
  }

  private recompute(entry: ExchangeEntry): void {
    // The clock speaks the first turn only (§3); the others are answer_ready.
    const primary = primaryTurn(entry)
    const others = entry.turns.filter(t => t !== primary)
    let changed = false
    if (primary && primary.spoken.length > entry.text.length && primary.spoken.startsWith(entry.text)) {
      entry.text = primary.spoken
      changed = true
      if (entry.firstTextAt === null) entry.firstTextAt = this.now()
    }
    if (primary && primary.spokenDone !== entry.spokenDone) { entry.spokenDone = primary.spokenDone; changed = true }

    let phase = entry.phase
    if (!primary) {
      // Terminal since register; nothing to speak.
    } else if (primary.ended && primary.spokenDone) {
      const failed = primary.error !== null && entry.text === ''
      phase = failed ? 'error' : 'done'
      entry.error = failed ? 'turn_failed' : null
    } else if (entry.text.length > 0 && !entry.backgrounded) {
      phase = 'speaking'
    }
    if (phase !== entry.phase && !(TERMINAL.has(entry.phase))) {
      entry.phase = entry.backgrounded && !TERMINAL.has(phase) ? 'background' : phase
      changed = true
      if (TERMINAL.has(entry.phase)) {
        entry.doneAt = this.now()
        if (entry.backgroundTimer) { clearTimeout(entry.backgroundTimer); entry.backgroundTimer = null }
      }
    }
    // answer_ready: a backgrounded answer finished, or the answers of the
    // other parts of a split capture are done (§2.5, §3).
    const backgroundDone = entry.backgrounded && entry.phase === 'done'
    const othersDone = others.length > 0 && others.every(t => t.ended) && others.some(t => t.error === null)
    if (!entry.answerReady && (backgroundDone || (othersDone && TERMINAL.has(entry.phase)))) {
      entry.answerReady = true
      entry.answerReadyAt = this.now()
      changed = true
      try {
        this.options.onAnswerReady?.({
          exchangeId: entry.exchangeId, userId: entry.userId, deviceId: entry.deviceId,
          persona: entry.persona, strandTitle: entry.strandTitle, at: entry.answerReadyAt,
        })
      } catch { /* the wake call is best effort */ }
    }
    if (changed) this.bump(entry)
  }

  /** True while an exchange of this user waits for its spoken answer. */
  busy(userId: number): boolean {
    this.prune()
    for (const entry of this.entries.values()) {
      if (entry.userId === userId && !TERMINAL.has(entry.phase) && entry.phase !== 'background') return true
    }
    return false
  }

  /** 60 s without any text: the clock closes the overlay, the answer runs on (§2.5). */
  private maybeBackground(entry: ExchangeEntry): void {
    if (entry.backgrounded || TERMINAL.has(entry.phase) || entry.text.length > 0) return
    if (this.now() - entry.startedAt < this.backgroundAfterMs) return
    entry.backgrounded = true
    entry.phase = 'background'
    this.bump(entry)
  }

  private setPhase(entry: ExchangeEntry, phase: ClockExchangePhase): void {
    if (entry.phase === phase || entry.backgrounded) return
    entry.phase = phase
    this.bump(entry)
  }

  private bump(entry: ExchangeEntry): void {
    entry.rev += 1
    for (const waiter of [...entry.waiters]) waiter()
  }

  private forget(exchangeId: string): void {
    const entry = this.entries.get(exchangeId)
    if (!entry) return
    this.entries.delete(exchangeId)
    for (const turn of entry.turns) {
      if (this.byTurn.get(turn.turnId) === entry) this.byTurn.delete(turn.turnId)
    }
    if (entry.backgroundTimer) clearTimeout(entry.backgroundTimer)
    if (entry.ttlTimer) clearTimeout(entry.ttlTimer)
    for (const waiter of [...entry.waiters]) waiter()
    this.releaseIfIdle(entry.userId)
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [id, entry] of this.entries) {
      if (entry.startedAt > cutoff) break
      this.forget(id)
    }
  }
}
