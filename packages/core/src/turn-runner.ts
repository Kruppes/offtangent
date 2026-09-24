import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import type {
  AbortScope,
  ResponseChunk,
  RetryInfo,
  StallInfo,
  StallOutcome,
  TurnErrorInfo,
  TurnStreamChunk,
} from './agent-runtime-types.js'
import { buildTurnErrorMetadata, formatTurnErrorContent } from './turn-error.js'
import { newTurnRetryActionId } from './turn-retry-action.js'
import type { UploadDescriptor } from './uploads.js'
import { serializeUploadsMetadata } from './uploads.js'
import { extractUploadsFromToolResult } from './send-file-tool.js'
import { deleteArtifactsForMessages, recordMessageArtifacts } from './artifact-store.js'
import {
  buildProviderStallMetadata,
  formatProviderStallContent,
  loadStallThresholds,
} from './provider-stall.js'
import type { StallThresholds } from './provider-stall.js'
import type { ModelSelection } from './model-resolution.js'
import {
  formatAuthRetryContent,
  formatRetryScheduledContent,
  isAbortError,
  isAuthError,
  isRetryableTurnError,
  loadRetryPolicy,
  retryDelayMs,
} from './turn-retry.js'
import type { RetryPolicy } from './turn-retry.js'
import type { TurnRuntimeOverrides } from './turn-overrides.js'
import { hasTurnRuntimeOverrides } from './turn-overrides.js'

/**
 * The slice of AgentCore the turn runner depends on. Keeping this narrow
 * makes the runner testable without a real agent and avoids a circular
 * dependency on `agent.ts`.
 */
export interface TurnAgentLike {
  sendMessage(
    userId: string,
    text: string,
    source?: string,
    attachments?: UploadDescriptor[],
    // Fork multi-persona: attribute the turn to a persona runtime. Defaults to
    // 'main' in AgentCore, so single-persona callers stay unchanged.
    agentId?: string,
    // Fork threads (Offtangent Stufe 1): run the turn in this explicitly
    // chosen session instead of the heuristically resolved one. Omitted =
    // legacy behaviour.
    sessionId?: string,
    turnModelOverride?: ModelSelection | null,
    turnOverrides?: TurnRuntimeOverrides | null,
  ): AsyncIterable<TurnStreamChunk>
  /**
   * Restart the failed assistant turn from the existing transcript instead of
   * re-sending the user message, so a retry never duplicates it in the model
   * context. Optional: agents without it are retried via `sendMessage`.
   */
  retryTurn?(
    userId: string,
    text: string,
    source?: string,
    attachments?: UploadDescriptor[],
    agentId?: string,
    sessionId?: string,
    turnModelOverride?: ModelSelection | null,
    turnOverrides?: TurnRuntimeOverrides | null,
  ): AsyncIterable<TurnStreamChunk>
  /**
   * Cancel live agent runs. A scope restricts the abort to one session (and
   * persona); without it every run in the process dies, which is only correct
   * for blanket cancellations.
   */
  abort(scope?: AbortScope): void
}

export interface TurnInfo {
  turnId: string
  /**
   * Identity handed to the agent and used to group turns/subscribers. For web
   * users this is the numeric user id as a string; an approved but unlinked
   * Telegram chat uses its `telegram-<id>` pseudo identity.
   */
  agentUserId: string
  /** `chat_messages.user_id`; null when the channel has no linked web user. */
  userId: number | null
  sessionId: string
  /**
   * Persona the turn belongs to. Turns are keyed per user, not per persona,
   * so a consumer of `onTurnEnd` (the push sender) needs it here to name the
   * doorbell and to reach the right strand.
   */
  agentId: string
  startedAt: number
}

/**
 * Everything a consumer needs to render a turn. Emitted live and replayed
 * verbatim (with `replay: true`) when a consumer attaches mid-turn.
 */
/**
 * Fields every turn event carries. `agentId` is the fork's multi-persona
 * attribution: the runner keys turns per user (not per persona), so a client
 * subscribed to one user may receive turns of several personas interleaved
 * and needs the id on each event to route them.
 */
interface TurnEventBase {
  turnId: string
  agentId: string
  /**
   * Thread the turn persists into. Stamped on EVERY event (not only
   * `turn_start`) so a client with several open threads of the same persona
   * can route each frame; without it two threads of one persona are
   * indistinguishable on the wire.
   */
  sessionId: string
  replay?: boolean
}

export type TurnEvent =
  | ({ type: 'turn_start'; sessionId: string } & TurnEventBase)
  | ({ type: 'chunk'; chunk: ResponseChunk } & TurnEventBase)
  | ({ type: 'attachment'; attachment: UploadDescriptor } & TurnEventBase)
  | ({ type: 'system'; text: string } & TurnEventBase)
  | ({ type: 'turn_end' } & TurnEventBase)

export type TurnSubscriber = (event: TurnEvent) => void

/** `Omit` that distributes over a union instead of collapsing it to the common members. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A turn event as emitters produce it; `emit()` stamps `agentId` on top. */
type UnstampedTurnEvent = DistributiveOmit<TurnEvent, 'agentId' | 'sessionId'>

/**
 * A tool call that did not come from the agent but should appear in the turn
 * as if it had (persisted, replayed, rendered). Used by slash commands that
 * do work on the user's behalf before the agent runs, e.g. `/skill` reading a
 * SKILL.md.
 */
export interface TurnPreambleToolCall {
  toolName: string
  toolArgs: unknown
  toolResult: unknown
}

export interface StartTurnInput {
  /**
   * Numeric user the persisted rows belong to. `null` for channels without a
   * linked web user (an approved but unassigned Telegram chat) — such turns
   * stream normally but persist nothing, matching pre-runner behavior.
   */
  userId: number | null
  /**
   * Agent-facing identity, also the subscription key. Defaults to
   * `String(userId)`, which is what the web chat uses; Telegram passes the
   * same value for linked users so both channels attach to the same turn.
   */
  agentUserId?: string
  sessionId: string
  text: string
  source?: string
  attachments?: UploadDescriptor[]
  /**
   * Fork multi-persona: the persona this turn is attributed to. Threaded into
   * the agent call AND the persisted `chat_messages.agent_id`. Defaults to
   * 'main' when omitted (the web chat channel is always 'main').
   */
  agentId?: string
  /**
   * Fork threads (Offtangent Stufe 1): the thread the user explicitly picked.
   * Passed to `sendMessage`/`retryTurn` so the agent activates exactly this
   * session (no topic-shift detection) and runs on its transcript.
   *
   * Separate from {@link StartTurnInput.sessionId}, which is where the turn's
   * rows are persisted: threading the persistence id into the agent would
   * silently switch every existing caller (Telegram, companion) onto the
   * explicit path and disable topic-shift detection for them.
   */
  explicitSessionId?: string
  /** One-shot model selection; it outranks the strand pin and is not persisted. */
  turnModelOverride?: ModelSelection | null
  /**
   * One-shot thinking level / style instruction for this turn (quick capture
   * mode). Applied around the single stream and restored afterwards, so the
   * persona's configured behaviour is unchanged for every other channel.
   */
  turnOverrides?: TurnRuntimeOverrides | null
  /**
   * Restart a failed turn from the existing transcript instead of prompting
   * with `text` again (manual retry). Set via {@link TurnRunner.retryTurn}.
   */
  continueFromTranscript?: boolean
  /** Synthetic tool calls emitted at the start of the turn, before the agent streams. */
  preambleToolCalls?: TurnPreambleToolCall[]
}

export interface TurnRunnerOptions {
  /**
   * Where turns are persisted. `null` disables persistence entirely (a channel
   * running without the web database); streaming, buffering and retry still
   * work unchanged.
   */
  db: Database | null
  /** Resolves the live agent. May return null while the runtime boots. */
  getAgent: () => TurnAgentLike | null
  /**
   * Idle time before a "provider is slow" notice is emitted. Overrides
   * `settings.json` → `watchdog.stallWarnMs` (default 30 s).
   */
  stallWarnMs?: number
  /**
   * Idle time before the turn is hard-aborted. Overrides `settings.json` →
   * `watchdog.stallAbortMs` (default 90 s).
   */
  stallAbortMs?: number
  /** Watchdog tick interval (default 5 s). */
  watchdogIntervalMs?: number
  /**
   * Auto-retry policy overrides. Fields set here win over `settings.json` →
   * `retry` (defaults: enabled, 3 retries, 2000 ms base delay).
   */
  retryPolicy?: Partial<RetryPolicy>
  /**
   * How long a finished turn stays replayable. Covers the "refresh right as
   * the answer completes" case: the client strips its trailing assistant/tool
   * messages and rebuilds them from the replay, so no duplicates appear.
   */
  completedTurnRetentionMs?: number
  /**
   * Re-resolve the credentials of the provider a turn is talking to after it
   * answered with an authentication error, and report whether retrying the
   * call makes sense. OAuth providers return true (the access token was
   * refreshed / re-read from disk), static API keys return false so a wrong
   * key still fails fast. Called at most once per turn.
   */
  recoverAuth?: (context: {
    agentId: string
    sessionId: string
    providerId: string | null
    error: string
  }) => Promise<boolean>
  /**
   * The model a starting turn will actually talk to, resolved once at start
   * and frozen for the turn's lifetime. Read back through
   * {@link TurnRunner.getRunningTurnModel} so the UI shows the model that is
   * answering instead of the globally effective one, which may change (global
   * model switch, persona pin) while the turn still streams.
   */
  resolveStartModel?: (context: {
    userId: number | null
    sessionId: string
    agentId: string
    turnOverride: ModelSelection | null
  }) => TurnStartModel | null
  onTurnStart?: (turn: TurnInfo) => void
  onTurnEnd?: (turn: TurnInfo) => void
  /**
   * Called once a turn ended terminally, after the `turn_error` row was
   * written. Channels use this to hang a manual-retry action off the error
   * (`error.retryActionId`).
   */
  onTurnFailed?: (failure: { turn: TurnInfo; error: TurnErrorInfo }) => void
}

/**
 * The model a running turn is bound to. A superset of {@link ModelSelection}
 * so callers can pass the resolved `EffectiveModel` (with its `source`)
 * straight through to the UI.
 */
export interface TurnStartModel extends ModelSelection {
  /** Where the selection came from when it was frozen ('turn', 'global', ...). */
  source?: string
  degradedReason?: string
}

interface TurnState {
  turnModelOverride?: ModelSelection | null
  /** Model frozen at turn start (see `resolveStartModel`). */
  startModel?: TurnStartModel | null
  id: string
  /** Subscription/queue key — see {@link TurnInfo.agentUserId}. */
  key: string
  userId: number | null
  sessionId: string
  /** Fork multi-persona: persona attribution for persisted rows. */
  agentId: string
  startedAt: number
  buffer: TurnEvent[]
  /** Turn-level abort: user initiated, never retried. */
  abortController: AbortController
  /** Per-attempt abort (watchdog stall): kills one attempt, not the turn. */
  attemptController: AbortController
  ended: boolean
  endedAt: number | null
}

/**
 * Result of one attempt at streaming the turn. `willRetry` is decided where
 * the attempt is run so the transcript rows of a doomed attempt are dropped
 * before the next one starts.
 */
type AttemptResult =
  | { status: 'completed' }
  | { status: 'aborted' }
  | {
    status: 'failed'
    error: string
    retryable: boolean
    willRetry: boolean
    /** The retry is the one-shot credential recovery, not a policy retry. */
    authRetry?: boolean
  }

const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000
const DEFAULT_COMPLETED_TURN_RETENTION_MS = 60_000

function preambleChunks(calls: TurnPreambleToolCall[] | undefined): ResponseChunk[] {
  if (!calls || calls.length === 0) return []
  return calls.flatMap((call) => {
    const toolCallId = `preamble-${randomUUID()}`
    return [
      { type: 'tool_call_start', toolName: call.toolName, toolCallId, toolArgs: call.toolArgs },
      { type: 'tool_call_end', toolName: call.toolName, toolCallId, toolResult: call.toolResult, toolIsError: false },
    ] satisfies ResponseChunk[]
  })
}

/**
 * Persist one row, or skip when the turn has no place to store it (no
 * database, or a channel without a linked web user).
 */
function saveChatMessage(
  db: Database | null,
  sessionId: string,
  userId: number | null,
  role: 'user' | 'assistant' | 'tool' | 'system',
  content: string,
  metadata?: string,
  // Fork multi-persona: persist the persona the row belongs to. Defaults to
  // 'main' so single-persona/web callers keep the historical value.
  agentId: string = 'main',
): number | null {
  if (!db || userId === null) return null
  const result = db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sessionId, userId, role, content, metadata ?? null, agentId)
  return Number(result.lastInsertRowid)
}

function updateChatMessage(db: Database, id: number, content: string, metadata: string): void {
  db.prepare('UPDATE chat_messages SET content = ?, metadata = ? WHERE id = ?').run(content, metadata, id)
}

/** Resolves `true` when the delay elapsed, `false` when `signal` aborted first. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Owns the full lifecycle of an agent turn, decoupled from any connection.
 *
 * A turn keeps running (and keeps persisting) when the driving socket goes
 * away; every event is buffered so late or reconnecting consumers can replay
 * the partial turn and then continue live. Turns are never recovered across a
 * process restart — the buffer is in-memory only and a lost turn simply ends.
 */
export class TurnRunner {
  private readonly db: Database | null
  private readonly getAgent: () => TurnAgentLike | null
  private readonly stallWarnMs?: number
  private readonly stallAbortMs?: number
  private readonly watchdogIntervalMs: number
  private readonly retryPolicyOverrides?: Partial<RetryPolicy>
  private readonly completedTurnRetentionMs: number
  private readonly onTurnStart?: (turn: TurnInfo) => void
  private readonly onTurnEnd?: (turn: TurnInfo) => void
  private readonly onTurnFailed?: (failure: { turn: TurnInfo; error: TurnErrorInfo }) => void
  private readonly recoverAuth?: TurnRunnerOptions['recoverAuth']
  private readonly resolveStartModel?: TurnRunnerOptions['resolveStartModel']

  private readonly subscribers = new Map<string, Set<TurnSubscriber>>()
  /** Turns that are queued or streaming, per user. */
  private readonly liveTurns = new Map<string, Set<TurnState>>()
  /** Most recently finished turn per user, kept for the retention window. */
  private readonly recentTurns = new Map<string, TurnState>()
  /**
   * Serializes turns per user AND persona so the chunk streams of one persona
   * never interleave. Keyed per persona since 2026-09-19 (plan Fix 2a): the
   * state a turn mutates is the persona's AgentRuntime, and AgentCore's queue
   * is per persona too, so a long turn of `bob` must not hold up `main`
   * (incident 2026-09-18: a capture answer waited 20 min). Turns of the SAME
   * persona still run strictly one after another; the global fan-out is capped
   * by AgentCore's TurnSemaphore.
   */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(options: TurnRunnerOptions) {
    this.db = options.db
    this.getAgent = options.getAgent
    this.stallWarnMs = options.stallWarnMs
    this.stallAbortMs = options.stallAbortMs
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS
    this.retryPolicyOverrides = options.retryPolicy
    this.completedTurnRetentionMs = options.completedTurnRetentionMs ?? DEFAULT_COMPLETED_TURN_RETENTION_MS
    this.onTurnStart = options.onTurnStart
    this.onTurnEnd = options.onTurnEnd
    this.onTurnFailed = options.onTurnFailed
    this.recoverAuth = options.recoverAuth
    this.resolveStartModel = options.resolveStartModel
  }

  /**
   * Register a consumer for every turn of `userId`. If a turn is currently
   * running (or finished within the retention window) its buffered events are
   * replayed synchronously, flagged with `replay: true`, before any live event
   * is delivered.
   */
  // Consumed cross-workspace (web-backend, telegram); Fallow cannot resolve the
  // @axiom/core exports map, so it sees no caller outside this class.
  // fallow-ignore-next-line unused-class-member
  subscribe(user: number | string, subscriber: TurnSubscriber): () => void {
    const key = String(user)
    let set = this.subscribers.get(key)
    if (!set) {
      set = new Set()
      this.subscribers.set(key, set)
    }
    set.add(subscriber)

    const replayTarget = this.getReplayableTurn(key)
    if (replayTarget) {
      for (const event of replayTarget.buffer) {
        try {
          subscriber({ ...event, replay: true })
        } catch (err) {
          console.error('[turn-runner] replay subscriber failed:', err)
        }
      }
    }

    return () => {
      const current = this.subscribers.get(key)
      if (!current) return
      current.delete(subscriber)
      if (current.size === 0) this.subscribers.delete(key)
    }
  }

  /** True while a turn for this user is queued or streaming. */
  // Called through the TurnRetryRunnerLike interface and cross-workspace; Fallow
  // attributes neither to this class.
  // fallow-ignore-next-line unused-class-member
  hasActiveTurn(user: number | string): boolean {
    const turns = this.liveTurns.get(String(user))
    if (!turns) return false
    for (const turn of turns) {
      if (!turn.ended) return true
    }
    return false
  }

  /**
   * True while a turn of this user is queued or streaming IN THAT SESSION.
   * Archive and delete of a strand refuse with `strand_busy` on this signal
   * (SPEC 7.5b); a turn running in a DIFFERENT strand of the same user must
   * not block it, which is why {@link hasActiveTurn} is too coarse here.
   */
  // Consumed cross-workspace (web-backend strands service); Fallow cannot
  // resolve the @axiom/core exports map.
  // fallow-ignore-next-line unused-class-member
  hasActiveTurnInSession(user: number | string, sessionId: string): boolean {
    const turns = this.liveTurns.get(String(user))
    if (!turns) return false
    for (const turn of turns) {
      if (!turn.ended && turn.sessionId === sessionId) return true
    }
    return false
  }

  /**
   * True while a turn is streaming into this strand AND that turn will write
   * its transcript (it has a database and a numeric user). `send_file_to_user`
   * asks this before staying passive: only a persisting turn puts the file
   * into `chat_messages` when it ends, and a file handed to a turn that
   * persists nothing is silently lost. Matched by strand id alone — strand ids
   * are unique, while the runner's turn key differs per channel (numeric user
   * for web, a channel key for Telegram).
   */
  // Consumed cross-workspace (web-backend send-file wiring); Fallow cannot
  // resolve the @axiom/core exports map.
  // fallow-ignore-next-line unused-class-member
  hasPersistingTurnInSession(sessionId: string): boolean {
    if (!this.db) return false
    for (const turns of this.liveTurns.values()) {
      for (const turn of turns) {
        if (!turn.ended && turn.sessionId === sessionId && turn.userId !== null) return true
      }
    }
    return false
  }

  /** The oldest live turn in this strand owns its effective model until it ends.
   * Completed overrides must never become a persistent strand preference.
   */
  getTurnModelOverride(user: number | string, sessionId: string): ModelSelection | null {
    for (const turn of this.liveTurns.get(String(user)) ?? []) {
      if (!turn.ended && turn.sessionId === sessionId) {
        return turn.turnModelOverride ? { ...turn.turnModelOverride } : null
      }
    }
    return null
  }

  /**
   * The model the live turn of this strand is actually talking to, frozen at
   * turn start (explicit per-turn pin, else whatever was effective then), or
   * null when no turn is running. The strand's model indicator reads this
   * first: a global model switch mid-turn must not claim the running answer
   * comes from the new model (incident 2026-09-24).
   */
  // Consumed cross-workspace (web-backend strands service); Fallow cannot
  // resolve the @axiom/core exports map.
  // fallow-ignore-next-line unused-class-member
  getRunningTurnModel(user: number | string, sessionId: string): TurnStartModel | null {
    for (const turn of this.liveTurns.get(String(user)) ?? []) {
      if (!turn.ended && turn.sessionId === sessionId && turn.startModel) {
        return { ...turn.startModel }
      }
    }
    return null
  }

  /**
   * True while ANY user has a queued or streaming turn of this persona.
   * Archiving or deleting a persona refuses with `persona_busy` on this
   * signal (SPEC 13.5), mirroring the `strand_busy` guard one level up: the
   * unit that must not vanish mid-turn is the persona here, and a turn of a
   * DIFFERENT persona must not block it.
   */
  // Consumed cross-workspace (web-backend personas service); Fallow cannot
  // resolve the @axiom/core exports map.
  // fallow-ignore-next-line unused-class-member
  hasActiveTurnForAgent(agentId: string): boolean {
    for (const turns of this.liveTurns.values()) {
      for (const turn of turns) {
        if (!turn.ended && turn.agentId === agentId) return true
      }
    }
    return false
  }

  /**
   * Start a turn. Returns immediately — the turn runs in the background and
   * reports exclusively through subscribers. Concurrent starts for the same
   * user are queued so their streams stay ordered.
   */
  startTurn(input: StartTurnInput): TurnInfo {
    const key = input.agentUserId ?? String(input.userId)
    const agentId = input.agentId ?? 'main'
    const turnOverride = input.turnModelOverride ?? null
    // Frozen here, before the turn is queued: everything that follows (the
    // provider swap inside the agent, the UI asking who is answering) must
    // agree on one model even when the global selection changes meanwhile.
    let startModel: TurnStartModel | null = null
    try {
      startModel = this.resolveStartModel?.({
        userId: input.userId,
        sessionId: input.sessionId,
        agentId,
        turnOverride,
      }) ?? null
    } catch (err) {
      console.warn('[turn-runner] Could not resolve the start model:', err)
      startModel = turnOverride
    }
    const turn: TurnState = {
      id: randomUUID(),
      turnModelOverride: input.turnModelOverride,
      startModel: startModel ?? turnOverride,
      key,
      userId: input.userId,
      sessionId: input.sessionId,
      agentId: input.agentId ?? 'main',
      startedAt: Date.now(),
      buffer: [],
      abortController: new AbortController(),
      attemptController: new AbortController(),
      ended: false,
      endedAt: null,
    }

    let turns = this.liveTurns.get(key)
    if (!turns) {
      turns = new Set()
      this.liveTurns.set(key, turns)
    }
    turns.add(turn)

    // Subscriptions stay keyed per user (`key`); only the execution chain is
    // per user+persona, so two personas of one user run side by side.
    const queueKey = `${key}\u0000${turn.agentId}`
    const previous = this.queues.get(queueKey) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(() => this.runTurn(turn, input))
      .catch((err) => {
        console.error('[turn-runner] turn failed unexpectedly:', err)
      })
    this.queues.set(queueKey, run)
    // Drop the drained chain so the map does not keep one entry per user that
    // ever chatted. A start that already read this promise stays chained to it.
    void run.then(() => {
      if (this.queues.get(queueKey) === run) this.queues.delete(queueKey)
    })

    return toInfo(turn)
  }

  /**
   * Re-run a failed turn (manual retry). Behaves like {@link startTurn} except
   * that the agent continues the existing transcript: the failed assistant
   * tail is dropped and the user message is never re-sent, so a retry cannot
   * duplicate it.
   */
  // Called through the TurnRetryRunnerLike interface and cross-workspace; Fallow
  // attributes neither to this class.
  // fallow-ignore-next-line unused-class-member
  retryTurn(input: StartTurnInput): TurnInfo {
    return this.startTurn({ ...input, continueFromTranscript: true })
  }

  /**
   * Abort every queued/streaming turn of a user (the `/stop` command, `/new`,
   * or an explicit kill). Returns true when something was actually aborted.
   */
  // Consumed cross-workspace (web-backend, telegram); Fallow cannot resolve the
  // @axiom/core exports map, so it sees no caller outside this class.
  // fallow-ignore-next-line unused-class-member
  abortTurn(user: number | string): boolean {
    const turns = this.liveTurns.get(String(user))
    if (!turns) return false

    let aborted = false
    const agent = this.getAgent()
    for (const turn of turns) {
      if (turn.ended) continue
      aborted = true
      turn.abortController.abort()
      turn.attemptController.abort()
      // Scoped per turn: a user's /stop must not tear down runs of other
      // users/personas that happen to share this process.
      agent?.abort({ sessionId: turn.sessionId, agentId: turn.agentId })
    }

    return aborted
  }

  private getReplayableTurn(key: string): TurnState | null {
    const turns = this.liveTurns.get(key)
    if (turns) {
      for (const turn of turns) {
        if (!turn.ended && turn.buffer.length > 0) return turn
      }
    }

    const recent = this.recentTurns.get(key)
    if (!recent || recent.endedAt === null) return null
    if (Date.now() - recent.endedAt > this.completedTurnRetentionMs) {
      this.recentTurns.delete(key)
      return null
    }
    return recent.buffer.length > 0 ? recent : null
  }

  private emit(turn: TurnState, event: UnstampedTurnEvent): void {
    // Stamp the persona here rather than at every call site so no emitter
    // can forget it (buffered replays carry it too).
    const stamped: TurnEvent = { ...event, agentId: turn.agentId, sessionId: turn.sessionId }
    turn.buffer.push(stamped)
    const set = this.subscribers.get(turn.key)
    if (!set) return
    for (const subscriber of [...set]) {
      try {
        subscriber(stamped)
      } catch (err) {
        console.error('[turn-runner] subscriber failed:', err)
      }
    }
  }

  private finishTurn(turn: TurnState): void {
    if (turn.ended) return
    turn.ended = true
    turn.endedAt = Date.now()

    const turns = this.liveTurns.get(turn.key)
    if (turns) {
      turns.delete(turn)
      if (turns.size === 0) this.liveTurns.delete(turn.key)
    }
    this.recentTurns.set(turn.key, turn)
    this.scheduleRetentionSweep(turn)

    this.emit(turn, { type: 'turn_end', turnId: turn.id })
    this.onTurnEnd?.(toInfo(turn))
  }

  /**
   * Release the replay buffer once the turn is no longer replayable. Without
   * this the last turn of every user — including its tool results — would stay
   * resident for the lifetime of the process, since {@link getReplayableTurn}
   * only evicts on the next subscribe.
   */
  private scheduleRetentionSweep(turn: TurnState): void {
    const timer = setTimeout(() => {
      if (this.recentTurns.get(turn.key) === turn) this.recentTurns.delete(turn.key)
      turn.buffer = []
    }, this.completedTurnRetentionMs)
    timer.unref?.()
  }

  private async runTurn(turn: TurnState, input: StartTurnInput): Promise<void> {
    // Paired with `onTurnEnd` in `finishTurn` before any early exit: consumers
    // use the pair as a gauge (active requests), so an unmatched end would
    // decrement someone else's turn.
    this.onTurnStart?.(toInfo(turn))

    if (turn.abortController.signal.aborted) {
      this.finishTurn(turn)
      return
    }

    const agent = this.getAgent()
    if (!agent) {
      this.failTurn(turn, {
        cause: 'agent_unavailable',
        error: 'Agent core not available',
        attempts: 0,
        retryable: true,
      })
      this.emitChunk(turn, { type: 'done' })
      this.finishTurn(turn)
      return
    }

    this.emit(turn, { type: 'turn_start', turnId: turn.id })

    const thresholds = this.resolveStallThresholds()
    const policy = this.resolveRetryPolicy()
    let attempt = 0
    // The credential recovery fires at most once per turn: a second
    // authentication error after a fresh credential is a real verdict.
    let authRecoveryUsed = false

    for (;;) {
      const result = await this.runAttempt(turn, input, agent, thresholds, policy, attempt, !authRecoveryUsed)
      if (result.status !== 'failed') break

      if (result.authRetry) {
        authRecoveryUsed = true
        attempt++
        const retry: RetryInfo = { attempt, maxRetries: policy.maxRetries, delayMs: 0, error: result.error }
        console.warn(
          `[turn-runner] Provider rejected the credentials (user=${turn.userId}, session=${turn.sessionId}): `
          + `${result.error} \u2014 credentials re-resolved, retrying once.`,
        )
        turn.buffer = turn.buffer.filter(event => event.type === 'turn_start')
        this.emitChunk(turn, { type: 'retry_scheduled', text: formatAuthRetryContent(), retry })
        if (turn.abortController.signal.aborted) break
        continue
      }

      if (!result.willRetry) {
        this.failTurn(turn, {
          cause: result.retryable ? 'retry_exhausted' : 'non_retryable',
          error: result.error,
          attempts: attempt,
          retryable: result.retryable,
        })
        break
      }

      attempt++
      const retry: RetryInfo = {
        attempt,
        maxRetries: policy.maxRetries,
        delayMs: retryDelayMs(policy, attempt),
        error: result.error,
      }
      console.warn(
        `[turn-runner] Retryable provider error (user=${turn.userId}, session=${turn.sessionId}): `
        + `${result.error} — retry ${attempt}/${policy.maxRetries} in ${retry.delayMs}ms.`,
      )

      // The failed attempt is discarded, so drop its events from the replay
      // buffer too: a consumer attaching during the backoff must not rebuild
      // the partial answer that no longer exists in the transcript.
      turn.buffer = turn.buffer.filter(event => event.type === 'turn_start')
      this.emitChunk(turn, {
        type: 'retry_scheduled',
        text: formatRetryScheduledContent(retry),
        retry,
      })

      // A user abort during the backoff ends the turn like any other abort.
      if (!await sleepUnlessAborted(retry.delayMs, turn.abortController.signal)) break
    }

    // Exactly one `done` per turn, emitted after the last attempt, so consumers
    // never get stuck on a streaming indicator and never see a turn "end" twice.
    this.emitChunk(turn, { type: 'done' })
    this.finishTurn(turn)
  }

  /**
   * Stream one attempt of the turn. Returns how it ended; the caller decides
   * whether to restart. Nothing terminal (`error`, `done`) is emitted here —
   * a failed attempt that will be retried must leave no trace behind.
   */
  private async runAttempt(
    turn: TurnState,
    input: StartTurnInput,
    agent: TurnAgentLike,
    thresholds: StallThresholds,
    policy: RetryPolicy,
    attempt: number,
    allowAuthRecovery = false,
  ): Promise<AttemptResult> {
    turn.attemptController = new AbortController()
    const transcript = new TurnTranscript(this.db, turn.sessionId, turn.userId, turn.agentId)
    const agentUserId = turn.key
    const stall: { error: string | null } = { error: null }
    const watchdog = this.startStallWatchdog(turn, agent, thresholds, (error) => { stall.error = error })
    let failure: { error: string; retryable: boolean } | null = null

    try {
      const continueTurn = attempt > 0 || input.continueFromTranscript === true
      // Re-emitted per auto-retry attempt because a discarded attempt rolls
      // back its rows and the UI strips them; a manual retry continues from a
      // committed transcript that already holds them.
      if (input.continueFromTranscript !== true) {
        for (const chunk of preambleChunks(input.preambleToolCalls)) {
          transcript.record(chunk)
          this.emitChunk(turn, chunk)
        }
      }
      // Keep the legacy 5-arg call shape when no explicit thread was picked:
      // callers outside the threads feature (Telegram, companion) assert on the
      // exact argument list, and an appended `undefined` would break them.
      const extra: [string?, (ModelSelection | null)?, (TurnRuntimeOverrides | null)?] =
        hasTurnRuntimeOverrides(input.turnOverrides)
          ? [input.explicitSessionId, input.turnModelOverride ?? null, input.turnOverrides]
          : input.turnModelOverride !== undefined
            ? [input.explicitSessionId, input.turnModelOverride]
            : input.explicitSessionId !== undefined ? [input.explicitSessionId] : []
      const stream = continueTurn && agent.retryTurn
        ? agent.retryTurn(agentUserId, input.text, input.source ?? 'web', input.attachments, turn.agentId, ...extra)
        : agent.sendMessage(agentUserId, input.text, input.source ?? 'web', input.attachments, turn.agentId, ...extra)

      for await (const chunk of stream) {
        watchdog.recordActivity()
        if (this.isAttemptAborted(turn)) break

        // Queue signals are internal control flow: they bracket the wait for
        // the process-wide turn lock and are never persisted or forwarded.
        if (chunk.type === 'queue_waiting') {
          watchdog.suspend()
          continue
        }
        if (chunk.type === 'queue_started') {
          watchdog.resume()
          continue
        }

        // `done` is owned by the turn, not by an attempt.
        if (chunk.type === 'done') continue

        if (chunk.type === 'error') {
          const error = chunk.error ?? 'Unknown provider error'
          failure = { error, retryable: this.isRetryableFailure(turn, error) }
          break
        }

        // Attachments are emitted before their tool chunk so consumers render
        // the download card on the running assistant turn, matching the order
        // used before the runner existed.
        for (const upload of transcript.record(chunk)) {
          this.emit(turn, { type: 'attachment', turnId: turn.id, attachment: upload })
        }

        this.emitChunk(turn, chunk)
      }
    } catch (err) {
      if (!this.isAttemptAborted(turn)) {
        const message = (err as Error).message
        failure = { error: `Agent error: ${message}`, retryable: this.isRetryableFailure(turn, message) }
      }
    } finally {
      watchdog.stop()
    }

    // A watchdog kill outranks whatever the stream reported on its way out: it
    // is the reason the attempt died, and it is always retryable.
    if (stall.error) failure = { error: stall.error, retryable: true }

    // A user abort ends the turn even if the watchdog fired first: only the
    // watchdog's own kill counts as a retryable failure.
    if (turn.abortController.signal.aborted) {
      this.commitTranscript(transcript)
      return { status: 'aborted' }
    }

    if (!failure) {
      this.commitTranscript(transcript)
      return { status: 'completed' }
    }

    // An authentication error is not retryable by policy (a wrong static key
    // stays wrong), but an OAuth access token can be stale in this process or
    // spuriously rejected. Ask the owner of the credentials once; only if it
    // says the credential was re-resolved does the attempt get repeated.
    const authRetry = allowAuthRecovery
      && !failure.retryable
      && isAuthError(failure.error)
      && await this.tryRecoverAuth(turn, failure.error)

    const willRetry = authRetry || (policy.enabled && attempt < policy.maxRetries && failure.retryable)
    // Discarding keeps the transcript free of half-written answers from the
    // attempt that is about to be replaced; a terminal failure keeps whatever
    // the provider managed to produce.
    if (willRetry) transcript.discard()
    else this.commitTranscript(transcript)

    return { status: 'failed', error: failure.error, retryable: failure.retryable, willRetry, authRetry }
  }

  /**
   * End the turn with a durable error row plus the matching `error` chunk.
   * Persisting is what turns the old "nothing happens" failure modes (expired
   * key, failed OAuth refresh, exhausted retries) into a message that is still
   * there after a reload; the chunk carries the same text and the row id so
   * live rendering and history agree.
   */
  private failTurn(turn: TurnState, failure: Omit<TurnErrorInfo, 'messageId' | 'occurredAt' | 'retryActionId'>): void {
    const info: TurnErrorInfo = {
      ...failure,
      occurredAt: new Date().toISOString(),
      retryActionId: newTurnRetryActionId(),
    }
    const content = formatTurnErrorContent(info)

    let messageId: number | null = null
    try {
      messageId = saveChatMessage(
        this.db,
        turn.sessionId,
        turn.userId,
        'system',
        content,
        JSON.stringify(buildTurnErrorMetadata(info)),
        turn.agentId,
      )
    } catch (err) {
      console.error('[turn-runner] Failed to persist terminal error:', err)
      messageId = null
    }

    console.error(
      `[turn-runner] Turn failed (user=${turn.userId}, session=${turn.sessionId}, `
      + `cause=${info.cause}, attempts=${info.attempts}): ${info.error}`,
    )

    const errorInfo: TurnErrorInfo = { ...info, messageId: messageId ?? undefined }
    this.emitChunk(turn, {
      type: 'error',
      error: info.error,
      text: content,
      errorInfo,
    })

    // Only a persisted error can carry a retry button: the action is resolved
    // against the row id, and without it a reload would lose the button.
    if (messageId !== null) this.onTurnFailed?.({ turn: toInfo(turn), error: errorInfo })
  }

  /**
   * Flush any trailing thinking that wasn't closed by text/tool/done (e.g.
   * aborted/errored streams) and write the assistant row.
   */
  private commitTranscript(transcript: TurnTranscript): void {
    transcript.flushThinking()
    transcript.finalize()
  }

  private isAttemptAborted(turn: TurnState): boolean {
    return turn.abortController.signal.aborted || turn.attemptController.signal.aborted
  }

  /**
   * An AbortError that this turn never requested (neither its turn-level nor
   * its attempt-level controller fired) was triggered from outside — another
   * strand's watchdog, a provider swap, a blanket cancel. That is transient
   * infrastructure noise, not a verdict about this turn, so it must be
   * retried instead of ending as `non_retryable` with the work lost
   * (incident 2026-09-15). A user `/stop` always sets `abortController`, so it
   * never reaches this path.
   */
  /**
   * Hand an authentication failure to the credential owner. Never throws: a
   * refresh that itself fails leaves the turn exactly where it was (terminal
   * error), it must not replace the provider's verdict with a stack trace.
   */
  private async tryRecoverAuth(turn: TurnState, error: string): Promise<boolean> {
    if (!this.recoverAuth) return false
    try {
      return await this.recoverAuth({
        agentId: turn.agentId,
        sessionId: turn.sessionId,
        providerId: turn.startModel?.providerId ?? null,
        error,
      })
    } catch (err) {
      console.error('[turn-runner] Credential recovery failed:', err)
      return false
    }
  }

  private isRetryableFailure(turn: TurnState, error: string): boolean {
    if (isAbortError(error) && !this.isAttemptAborted(turn)) return true
    return isRetryableTurnError(error)
  }

  private emitChunk(turn: TurnState, chunk: ResponseChunk): void {
    this.emit(turn, { type: 'chunk', turnId: turn.id, chunk })
  }

  /**
   * Resolved per turn so a settings edit applies to the next turn without a
   * restart. Constructor overrides win over the config file.
   */
  private resolveRetryPolicy(): RetryPolicy {
    return { ...loadRetryPolicy(), ...this.retryPolicyOverrides }
  }

  /**
   * Thresholds are resolved per turn so a settings edit takes effect on the
   * next turn without a restart. Constructor options win over the config file.
   */
  private resolveStallThresholds(): StallThresholds {
    const fromSettings = loadStallThresholds()
    return {
      warnMs: this.stallWarnMs ?? fromSettings.warnMs,
      abortMs: this.stallAbortMs ?? fromSettings.abortMs,
    }
  }

  /**
   * Detects silently dead provider streams (e.g. zombie websocket-cached
   * sockets, halted SSE readers behind dropped HTTP/2 streams). Without this
   * the chunk loop blocks forever — pi-ai's parseSSE/parseWebSocket never throw
   * on idle, so no error reaches the runtime, no log line is written, and
   * consumers stay stuck on "streaming" without ever receiving a `done`.
   * Transport-agnostic: it sits one layer above SSE/WS so it covers both.
   *
   * Stalls surface as `stall_warning` / `stall_resolved` chunks (channel
   * agnostic) and as a single `provider_stall` chat row that is updated in
   * place on resolution — never deleted — so history keeps an honest record.
   *
   * A hard abort is reported through `onAbort` instead of erroring out
   * directly: unlike a user abort it counts as a retryable failure, so the
   * attempt loop decides whether the turn restarts or ends.
   */
  private startStallWatchdog(
    turn: TurnState,
    agent: TurnAgentLike,
    thresholds: StallThresholds,
    onAbort: (error: string) => void,
  ) {
    let lastActivityAt = Date.now()
    let active: { startedAt: number; messageId: number | null } | null = null
    /**
     * Off while the turn only waits for the process-wide queue lock: there is
     * no provider connection yet, so silence is not a stall. Armed by default
     * so agents that do not send queue signals keep the old coverage.
     */
    let counting = true

    const db = this.db

    const persistStall = (stall: StallInfo): number | null => {
      try {
        return saveChatMessage(
          this.db,
          turn.sessionId,
          turn.userId,
          'system',
          formatProviderStallContent(stall),
          JSON.stringify(buildProviderStallMetadata(stall)),
        )
      } catch (err) {
        console.error('[turn-runner] Failed to persist stall warning:', err)
        return null
      }
    }

    const openStall = (now: number): void => {
      if (active) return
      const startedAt = lastActivityAt
      const stall: StallInfo = {
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now - startedAt,
      }
      const messageId = persistStall(stall)
      active = { startedAt, messageId }
      console.warn(
        `[turn-runner] Provider slow: ${stall.durationMs}ms idle (user=${turn.userId}, `
        + `session=${turn.sessionId}).`,
      )
      this.emitChunk(turn, {
        type: 'stall_warning',
        // `text` mirrors the persisted row content so live rendering and a
        // history reload show the exact same wording.
        text: formatProviderStallContent(stall),
        stall: { ...stall, messageId: messageId ?? undefined },
      })
    }

    const closeStall = (now: number, outcome: StallOutcome): void => {
      if (!active) return
      const { startedAt, messageId } = active
      active = null

      const stall: StallInfo = {
        messageId: messageId ?? undefined,
        startedAt: new Date(startedAt).toISOString(),
        resolvedAt: new Date(now).toISOString(),
        durationMs: now - startedAt,
        outcome,
      }

      if (messageId !== null && db) {
        try {
          updateChatMessage(
            db,
            messageId,
            formatProviderStallContent(stall),
            JSON.stringify(buildProviderStallMetadata(stall)),
          )
        } catch (err) {
          console.error('[turn-runner] Failed to resolve stall warning:', err)
        }
      }

      this.emitChunk(turn, {
        type: 'stall_resolved',
        text: formatProviderStallContent(stall),
        stall,
      })
    }

    const timer = setInterval(() => {
      if (!counting) return
      if (this.isAttemptAborted(turn)) return
      const now = Date.now()
      const idleMs = now - lastActivityAt

      if (idleMs >= thresholds.abortMs) {
        console.error(
          `[turn-runner] Provider stalled ${idleMs}ms (user=${turn.userId}, `
          + `session=${turn.sessionId}). Aborting stream.`,
        )
        // A hard abort always leaves a stall row behind, even when the warn
        // threshold never fired (e.g. warn >= abort in a custom config).
        openStall(now)
        closeStall(now, 'aborted')
        onAbort(
          `Provider stopped responding after ${Math.round(idleMs / 1000)}s. `
          + `Connection aborted — please retry.`,
        )
        turn.attemptController.abort()
        // Propagate abort into pi-agent-core so the underlying SSE fetch /
        // WebSocket gets cancelled (mirrors the /stop command handler) — but
        // only for THIS session: unscoped it killed the live turn of another
        // strand that merely shared the process (incident 2026-09-15).
        agent.abort({ sessionId: turn.sessionId, agentId: turn.agentId })
        return
      }

      if (idleMs >= thresholds.warnMs) openStall(now)
      // Never tick coarser than the warn threshold, otherwise a low threshold
      // would only fire on the next (much later) tick.
    }, Math.max(1, Math.min(this.watchdogIntervalMs, thresholds.warnMs)))

    return {
      recordActivity: () => {
        const now = Date.now()
        closeStall(now, 'recovered')
        lastActivityAt = now
      },
      /** The turn is queued behind another one — stop counting idle time. */
      suspend: () => {
        counting = false
        closeStall(Date.now(), 'recovered')
      },
      /** The turn owns the queue lock: from here on, silence is provider silence. */
      resume: () => {
        lastActivityAt = Date.now()
        counting = true
      },
      /**
       * Called once the stream is over. A stall still open at that point never
       * recovered — the turn died while the provider was silent.
       */
      stop: () => {
        clearInterval(timer)
        closeStall(Date.now(), 'aborted')
      },
    }
  }
}

/**
 * Turns a chunk stream into `chat_messages` rows: thinking blocks, tool calls
 * and — once the stream ends — the assistant response with its attachments.
 * Rows are written as the turn progresses so a crashed process still leaves
 * the partial reasoning behind; the assistant row is deliberately written only
 * at the end, since its text is only complete then.
 */
class TurnTranscript {
  private fullResponse = ''
  private currentThinking = ''
  private readonly pendingToolCalls = new Map<string, { toolName: string; toolArgs: unknown }>()
  private readonly uploads: UploadDescriptor[] = []
  /** Rows written so far, so a discarded attempt can roll them back. */
  private readonly writtenRowIds: number[] = []

  constructor(
    private readonly db: Database | null,
    private readonly sessionId: string,
    private readonly userId: number | null,
    // Fork multi-persona: persona attribution for every persisted row.
    private readonly agentId: string = 'main',
  ) {}

  private get persists(): boolean {
    return this.db !== null && this.userId !== null
  }

  /** Consume one chunk; returns any uploads the chunk produced. */
  record(chunk: ResponseChunk): UploadDescriptor[] {
    if (chunk.type === 'thinking' && chunk.thinking) {
      this.currentThinking += chunk.thinking
      return []
    }

    // Text, tool calls and the stream end all close an in-progress thinking run.
    this.flushThinking()

    if (chunk.type === 'text' && chunk.text) {
      this.fullResponse += chunk.text
      return []
    }

    if (chunk.type === 'tool_call_start' && chunk.toolCallId) {
      this.pendingToolCalls.set(chunk.toolCallId, {
        toolName: chunk.toolName ?? 'unknown',
        toolArgs: chunk.toolArgs,
      })
      return []
    }

    if (chunk.type === 'tool_call_end' && chunk.toolCallId) {
      const pending = this.pendingToolCalls.get(chunk.toolCallId)
      const toolName = pending?.toolName ?? chunk.toolName ?? 'unknown'
      this.remember(saveChatMessage(this.db, this.sessionId, this.userId, 'tool', `Tool: ${toolName}`, JSON.stringify({
        toolName,
        toolCallId: chunk.toolCallId,
        toolArgs: pending?.toolArgs ?? null,
        toolResult: chunk.toolResult ?? null,
        toolIsError: chunk.toolIsError ?? false,
      }), this.agentId))
      this.pendingToolCalls.delete(chunk.toolCallId)

      const newUploads = extractUploadsFromToolResult(chunk.toolResult)
      this.uploads.push(...newUploads)
      return newUploads
    }

    return []
  }

  /**
   * Persist the buffered thinking run. The core runtime only surfaces
   * `thinking` deltas, so each contiguous run (uninterrupted by text/tool/done)
   * becomes its own row tagged `metadata.kind === 'thinking'`.
   */
  flushThinking(): void {
    if (!this.currentThinking) return
    const text = this.currentThinking
    this.currentThinking = ''
    try {
      this.remember(
        saveChatMessage(this.db, this.sessionId, this.userId, 'assistant', text, JSON.stringify({ kind: 'thinking' }), this.agentId),
      )
    } catch (err) {
      console.error('[turn-runner] Failed to persist thinking block:', err)
    }
  }

  private remember(rowId: number | null): void {
    if (rowId !== null) this.writtenRowIds.push(rowId)
  }

  /**
   * Roll back everything this attempt wrote. Used when a retryable error kills
   * the attempt: the restarted turn produces its own thinking and tool rows,
   * and leaving the failed ones behind would duplicate them in the history.
   * Stall notices are written by the watchdog, not here, so they survive —
   * they are an honest record of what happened.
   */
  discard(): void {
    this.fullResponse = ''
    this.currentThinking = ''
    this.pendingToolCalls.clear()
    this.uploads.length = 0
    if (!this.db || this.writtenRowIds.length === 0) return
    try {
      // Artifacts first: a row whose message is gone can never be reached
      // again, and its bytes would leak into the data directory forever.
      deleteArtifactsForMessages(this.db, this.writtenRowIds)
      const statement = this.db.prepare('DELETE FROM chat_messages WHERE id = ?')
      for (const id of this.writtenRowIds) statement.run(id)
    } catch (err) {
      console.error('[turn-runner] Failed to discard the failed attempt:', err)
    }
    this.writtenRowIds.length = 0
  }

  /**
   * Write the assistant row. A turn that produced only attachments still gets
   * a row (with empty content) so the download card survives a history reload.
   */
  finalize(): void {
    if (!this.persists) return
    if (!this.fullResponse && this.uploads.length === 0) return
    const metadata = this.uploads.length > 0 ? serializeUploadsMetadata(this.uploads) : undefined
    const messageId = saveChatMessage(
      this.db, this.sessionId, this.userId, 'assistant', this.fullResponse, metadata, this.agentId,
    )
    this.remember(messageId)
    if (messageId !== null) this.recordArtifacts(messageId)
  }

  /**
   * SPEC 7.4b (canvas R2): the ```html fence and the referenced uploads of the
   * finished answer become artifact rows. Server side on purpose — this is the
   * single place every channel writes its assistant row, so the app, the web
   * app and Telegram all see the same artifacts without each parsing markdown
   * on their own. The fence stays in `content`; the text fallbacks must not go
   * empty.
   */
  private recordArtifacts(messageId: number): void {
    if (!this.db || this.userId === null) return
    try {
      const result = recordMessageArtifacts(this.db, {
        messageId,
        strandId: this.sessionId,
        userId: this.userId,
        agentId: this.agentId,
        content: this.fullResponse,
        uploads: this.uploads,
      })
      for (const skip of result.skipped) {
        if (skip.reason === 'duplicate') continue
        console.warn(`[turn-runner] Skipped artifact "${skip.title}": ${skip.reason}`)
      }
    } catch (err) {
      console.error('[turn-runner] Failed to record artifacts:', err)
    }
  }
}

function toInfo(turn: TurnState): TurnInfo {
  return {
    turnId: turn.id,
    agentUserId: turn.key,
    userId: turn.userId,
    sessionId: turn.sessionId,
    agentId: turn.agentId,
    startedAt: turn.startedAt,
  }
}
