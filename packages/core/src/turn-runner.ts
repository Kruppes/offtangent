import { ingestInteractionMessage } from './interaction-store.js'
import { randomUUID } from 'node:crypto'
import { frozenEcoRowId } from './eco-tool-freeze.js'
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
import { errorClass, errorTextClass, formatProviderErrorDiagnostic, publicProviderError } from './log-safe-error.js'
import type { ProviderErrorDiagnostic } from './log-safe-error.js'
import { newTurnRetryActionId } from './turn-retry-action.js'
import { sealText } from './secret-boundary.js'
import { classifyInteractionFences, extractAnswerableInteractionBlocks } from './contracts/interaction-blocks.js'
import type { InteractionParseOutcome } from './contracts/interaction-blocks.js'
import { recordInteractionEvent } from './interaction-telemetry.js'
import type { UploadDescriptor } from './uploads.js'
import { serializeUploadsMetadata } from './uploads.js'
import { extractVoiceNoteFromToolResult } from './voice-note-tool.js'
import { mergeVoiceNoteMetadata, type VoiceNote } from './voice-note.js'
import { extractUploadsFromToolResult } from './send-file-tool.js'
import { deleteArtifactsForMessages, recordMessageArtifacts } from './artifact-store.js'
import {
  buildProviderStallMetadata,
  formatProviderStallContent,
  loadStallThresholds,
} from './provider-stall.js'
import type { StallThresholds } from './provider-stall.js'
import { nativeFirstTokenBudgetMs, subscribeProviderPhase } from './provider-phase.js'
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
import { isRateLimitError, retryAfterMsFromError } from './provider-concurrency.js'

/**
 * Upper bound for a provider-stated `Retry-After` on a rate limit. Beyond
 * this a turn would look hung to the user, so it fails and can be retried by
 * hand instead.
 */
const RATE_LIMIT_RETRY_CAP_MS = 60_000
import type { TurnRuntimeOverrides } from './turn-overrides.js'
import { hasTurnRuntimeOverrides } from './turn-overrides.js'
import { recordStrandTurnStart, recordStrandTurnFirstToken, recordStrandTurnEnd } from './strand-turns.js'
import type { StrandTurnTrigger, StrandTurnInputMode } from './strand-turns.js'
import { markUserMessageSteerState, type SteerOffer, type SteerOfferOptions, type SteerRejectReason } from './steer.js'
import { collectUnansweredImages, markImagesSettled, mergeUploads } from './unanswered-attachments.js'

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
  /**
   * S1-D: hand a user interjection to the live run of this strand (after the
   * current tool batch). Optional; agents without it never steer.
   */
  offerSteer?(agentId: string, sessionId: string, text: string, messageId?: number | null, opts?: SteerOfferOptions): SteerOffer
}

/**
 * S1-D: what became of a user message sent to a strand.
 * - `steered`: handed to the running turn `turnId` (next model request);
 * - `queued`: waits behind the live turn `waitingForTurnId` as its own turn;
 * - `started`: no turn was live, it runs now.
 */
export type SubmitUserMessageResult =
  | { mode: 'steered'; turnId: string; /** Resolves to the fallback turn when the run ended before taking it, else null. */ fallback: Promise<TurnInfo | null> }
  | { mode: 'queued'; turn: TurnInfo; waitingForTurnId: string; reason: SteerRejectReason }
  | { mode: 'started'; turn: TurnInfo }
  /**
   * A message with attachments but no text (photos sent on their own). It
   * waits up to `holdMs` for a follow-up in the same strand (typically the
   * voice note the photos belong to) and then starts its own turn; a
   * follow-up inside the window takes the attachments into ITS turn.
   */
  | { mode: 'held'; holdMs: number }

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
  | ({ type: 'turn_start'; sessionId: string; replyToInteractionId?: string } & TurnEventBase)
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
  /** Strand statistics: who started the turn. Defaults to `user`. */
  trigger?: StrandTurnTrigger
  /** Strand statistics: how the prompt was entered (typed, dictated, block answer). */
  inputMode?: StrandTurnInputMode | null
  /**
   * S1-B: the interaction (`ia_…`) this turn answers. The answer row in
   * `chat_messages` carries the same id in its metadata; the runner stamps it
   * on `turn_start` so a client links the turn to the closed card.
   */
  replyToInteractionId?: string | null
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
  /**
   * How long a user message with attachments but no text waits for a
   * follow-up before it starts a turn of its own (see `submitUserMessage`).
   * 0 disables the hold. Default {@link DEFAULT_ATTACHMENT_ONLY_HOLD_MS}.
   */
  attachmentOnlyHoldMs?: number
  onTurnStart?: (turn: TurnInfo) => void
  onTurnEnd?: (turn: TurnInfo) => void
  /**
   * Called once a turn ended terminally, after the `turn_error` row was
   * written. Channels use this to hang a manual-retry action off the error
   * (`error.retryActionId`).
   */
  onTurnFailed?: (failure: { turn: TurnInfo; error: TurnErrorInfo }) => void
  /**
   * Called right after the assistant row of a finished turn was written — the
   * one place every channel (web, app, Telegram, router turns) persists an
   * answer. Consumers do OPTIONAL work on the finished answer (today: the
   * automatic voice note). It must never throw and never block: the callback
   * is invoked inside a try/catch and is expected to detach its own work.
   */
  onAssistantMessage?: (message: PersistedAssistantMessage) => void
}

/** One persisted assistant answer, as {@link TurnRunnerOptions.onAssistantMessage} sees it. */
export interface PersistedAssistantMessage {
  /**
   * The voice note the turn already carries (written by a tool). Set means the
   * answer has been spoken — the automatic voice reply must not add a second
   * one, it only broadcasts the frame.
   */
  voiceNote?: VoiceNote | null
  messageId: number
  userId: number
  sessionId: string
  agentId: string
  /** The full answer text; empty when the turn only produced attachments. */
  content: string
  /**
   * Channel of the turn (`web`, `telegram`, `clock`, ...). Lets a consumer
   * skip channels that already speak the answer themselves (the clock plays
   * its own TTS, review K0-K2-5 #1).
   */
  source?: string
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
  /** S1-D: set when the turn left the queue and drives the agent. */
  running?: boolean
  /** S1-D: queue place reserved for an offered, not yet delivered steer. */
  steerPlaceholder?: boolean
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
  /** Channel of the turn (`web`, `android`, `telegram`, ...), for telemetry. */
  source: string
  startedAt: number
  buffer: TurnEvent[]
  /** Turn-level abort: user initiated, never retried. */
  abortController: AbortController
  /** Per-attempt abort (watchdog stall): kills one attempt, not the turn. */
  attemptController: AbortController
  /**
   * The assistant row the last committed attempt wrote, or null. Carried on
   * the one `done` chunk (S0-B/QW2) so a client can wire the card buttons to
   * the persisted message without waiting for a history reload.
   */
  finalMessage: { messageId: number; blockId: string | null } | null
  ended: boolean
  endedAt: number | null
  /** Strand statistics: the turn row was written (persisting turn). */
  statsRecorded?: boolean
  statsFirstToken?: boolean
  statsFailed?: boolean
}

/** The answerable block ids of a finished answer, in document order. */
function findAnswerableInteractionBlockIds(content: string): string[] {
  try {
    return extractAnswerableInteractionBlocks(content).map(block => block.id)
  } catch {
    return []
  }
}

/** The terminal chunk of a turn, naming the persisted answer when there is one. */
function doneChunk(finalMessage: TurnState['finalMessage']): ResponseChunk {
  if (!finalMessage) return { type: 'done' }
  return finalMessage.blockId
    ? { type: 'done', messageId: finalMessage.messageId, blockId: finalMessage.blockId }
    : { type: 'done', messageId: finalMessage.messageId }
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
    /** Raw error text, in-process only: retry and auth classifiers. */
    error: string
    /**
     * What may leave the process: the fixed text of a runner/runtime notice,
     * or `publicProviderError(error)` for provider text (review K0-K2-4 #2/#3).
     */
    publicError: string
    retryable: boolean
    willRetry: boolean
    /** The retry is the one-shot credential recovery, not a policy retry. */
    authRetry?: boolean
    /** Secret-free structure of a provider 4xx rejection, persisted with the error row. */
    diagnostic?: ProviderErrorDiagnostic
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
/**
 * Photos and the voice note that explains them reach the server seconds apart
 * and in either order (the recording still uploads and transcribes while the
 * photos are already stored). 8 s covers that gap without making a photo sent
 * on its own wait noticeably.
 */
export const DEFAULT_ATTACHMENT_ONLY_HOLD_MS = 8_000

interface HeldSubmission {
  input: StartTurnInput & { messageId?: number | null }
  /** Every user row whose attachments this hold carries (merged holds). */
  messageIds: number[]
  timer: ReturnType<typeof setTimeout>
}

export class TurnRunner {
  private readonly db: Database | null
  private readonly attachmentOnlyHoldMs: number
  /** Attachment-only messages waiting for a follow-up, per user+persona+strand. */
  private readonly heldSubmissions = new Map<string, HeldSubmission>()
  private readonly getAgent: () => TurnAgentLike | null
  private readonly stallWarnMs?: number
  private readonly stallAbortMs?: number
  private readonly watchdogIntervalMs: number
  private readonly retryPolicyOverrides?: Partial<RetryPolicy>
  private readonly completedTurnRetentionMs: number
  private readonly onTurnStart?: (turn: TurnInfo) => void
  private readonly onTurnEnd?: (turn: TurnInfo) => void
  private readonly onTurnFailed?: (failure: { turn: TurnInfo; error: TurnErrorInfo }) => void
  private readonly onAssistantMessage?: (message: PersistedAssistantMessage) => void
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
   * is per persona too, so a long turn of `coder` must not hold up `main`
   * (incident 2026-09-18: a capture answer waited 20 min). Turns of the SAME
   * persona still run strictly one after another; the global fan-out is capped
   * by AgentCore's TurnSemaphore.
   */
  private readonly queues = new Map<string, Promise<void>>()
  /** S1-D: messageIds already requeued by {@link recoverUndeliveredSteers} in this process (guards a failed `steerRecovered` write). */
  private readonly recoveredSteerIds = new Set<number>()

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
    this.onAssistantMessage = options.onAssistantMessage
    this.recoverAuth = options.recoverAuth
    this.resolveStartModel = options.resolveStartModel
    this.attachmentOnlyHoldMs = Math.max(0, options.attachmentOnlyHoldMs ?? DEFAULT_ATTACHMENT_ONLY_HOLD_MS)
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
          console.error(`[turn-runner] replay subscriber failed: ${errorClass(err)}`)
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
   * Id of the live turn of this user in that strand, or null when none runs.
   * `fork_strand` counts its per-turn budget on this id: a budget keyed by the
   * strand alone would leak across turns, and one keyed by nothing at all
   * would not stop a loop inside a single turn.
   */
  // Consumed cross-workspace (web-backend fork wiring); Fallow cannot resolve
  // the @axiom/core exports map.
  // fallow-ignore-next-line unused-class-member
  activeTurnIdInSession(user: number | string, sessionId: string): string | null {
    for (const turn of this.liveTurns.get(String(user)) ?? []) {
      if (!turn.ended && turn.sessionId === sessionId) return turn.id
    }
    return null
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
    return this.enqueueTurn(input, null)
  }

  /**
   * {@link startTurn} with an optional steer gate (REVIEW-S1-D, finding 1):
   * the turn takes its place in the strand queue NOW, as a placeholder for an
   * offered interjection. `gate` resolving `true` (the steer reached a model
   * request) removes the placeholder without a trace; `false` turns it into a
   * real queued turn in the place it reserved, so a message that arrived
   * later can never overtake it.
   */
  private enqueueTurn(input: StartTurnInput, gate: Promise<boolean> | null): TurnInfo {
    // Privacy (plan 2026-09-26, step 1) — belt and braces. Every channel
    // seals its own input at the edge (web REST, web socket, captures,
    // interactions, Telegram); this is the shared funnel every one of them
    // ends in, so a NEW caller that forgets the boundary still cannot hand a
    // plaintext credential to a model. Sealing an already sealed text is a
    // no-op (handles are not secrets), so the double pass costs a scan and
    // changes nothing.
    if (input.text) {
      const sealed = sealText(input.text, { tier: 'user', source: `turn:${input.source ?? 'unknown'}` })
      if (sealed.text !== input.text) input = { ...input, text: sealed.text }
    }
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
      console.warn(`[turn-runner] Could not resolve the start model: ${errorClass(err)}`)
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
      source: input.source ?? 'web',
      startedAt: Date.now(),
      buffer: [],
      abortController: new AbortController(),
      attemptController: new AbortController(),
      finalMessage: null,
      ended: false,
      endedAt: null,
      ...(gate ? { steerPlaceholder: true } : {}),
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
    if (gate) {
      void gate.then((delivered) => {
        if (delivered) this.dropPlaceholder(turn)
        else turn.steerPlaceholder = false
      }, () => { turn.steerPlaceholder = false })
    }
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        if (gate && await gate.catch(() => false)) return
        return this.runTurn(turn, input)
      })
      .catch((err) => {
        console.error(`[turn-runner] turn failed unexpectedly: ${errorClass(err)}`)
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
   * S1-D: a user message for a strand. While a turn of the same strand and
   * persona is running its tool batch, the message is handed to that turn as
   * an interjection (steer) and reaches the model in the next request of the
   * SAME turn; `messageId` (the persisted user row) is stamped
   * `{steer:true, turnId}`. Otherwise it is queued as its own turn (stamped
   * `{queued:true}`) or, with no live turn, started. A steer the run did not
   * take (the batch ended the turn) falls back to a queued turn, so the
   * message is never lost and never delivered twice.
   */
  submitUserMessage(input: StartTurnInput & { messageId?: number | null }): SubmitUserMessageResult {
    const key = input.agentUserId ?? String(input.userId)
    const agentId = input.agentId ?? 'main'
    const holdKey = `${key}\u0000${agentId}\u0000${input.sessionId}`

    // A follow-up in the same strand takes the attachments of a held
    // attachment-only message into its own turn (one turn, all photos).
    const held = this.heldSubmissions.get(holdKey)
    let heldMessageIds: number[] = []
    if (held) {
      clearTimeout(held.timer)
      this.heldSubmissions.delete(holdKey)
      heldMessageIds = held.messageIds
      input = { ...input, attachments: mergeUploads(held.input.attachments, input.attachments) }
    }

    const live = [...(this.liveTurns.get(key) ?? [])].filter(t => !t.ended && t.agentId === agentId)
    if (live.length === 0 && this.shouldHold(input)) {
      const holdInput = input
      const messageIds = [...heldMessageIds, ...(input.messageId != null ? [input.messageId] : [])]
      const timer = setTimeout(() => {
        if (this.heldSubmissions.get(holdKey)?.timer !== timer) return
        this.heldSubmissions.delete(holdKey)
        this.submitNow(holdInput, messageIds)
      }, this.attachmentOnlyHoldMs)
      timer.unref?.()
      this.heldSubmissions.set(holdKey, { input: holdInput, messageIds, timer })
      return { mode: 'held', holdMs: this.attachmentOnlyHoldMs }
    }
    return this.submitNow(input, heldMessageIds)
  }

  /**
   * Photos without text wait for the words that belong to them. Only pure
   * image messages: a document or a recording without text is complete on
   * its own and starts its turn at once.
   */
  private shouldHold(input: StartTurnInput & { messageId?: number | null }): boolean {
    return this.attachmentOnlyHoldMs > 0
      && input.messageId != null
      && (input.attachments?.length ?? 0) > 0
      && (input.attachments ?? []).every(upload => upload.kind === 'image')
      && input.text.trim() === ''
      && !input.continueFromTranscript
      && !input.turnOverrides
      && !(input.preambleToolCalls?.length)
  }

  /**
   * Images of earlier user messages of this strand that no turn answered
   * (a held photo row, or one whose turn never started) join the turn of
   * `messageId`. Only for a turn that starts now: a queued or steered message
   * waits behind turns that answer those rows themselves.
   */
  private withUnansweredImages(input: StartTurnInput, messageId: number | null): { input: StartTurnInput; carriedMessageIds: number[] } {
    if (!this.db || messageId == null || input.continueFromTranscript) return { input, carriedMessageIds: [] }
    let carried: { uploads: UploadDescriptor[]; messageIds: number[] }
    try {
      carried = collectUnansweredImages(this.db, { sessionId: input.sessionId, userId: input.userId, beforeMessageId: messageId })
    } catch (err) {
      console.error('[turn-runner] Could not collect unanswered attachments:', errorClass(err))
      return { input, carriedMessageIds: [] }
    }
    if (carried.uploads.length === 0) return { input, carriedMessageIds: [] }
    return { input: { ...input, attachments: mergeUploads(carried.uploads, input.attachments) }, carriedMessageIds: carried.messageIds }
  }

  /**
   * F1 boundary: the images of a user row get at most ONE turn. As soon as a
   * turn exists for them (started or queued), their rows are stamped
   * `imagesTakenBy`; a later stop, kill or failure of that turn does not hand
   * them to the next turn of the strand. A stop during the hold stamps
   * `imagesDiscarded` instead (see {@link dropHeldSubmissions}).
   */
  private markTaken(turn: TurnInfo, messageIds: Array<number | null | undefined>): void {
    markImagesSettled(this.db, messageIds, { takenByTurnId: turn.turnId })
  }

  private submitNow(input: StartTurnInput & { messageId?: number | null }, heldMessageIds: number[] = []): SubmitUserMessageResult {
    const { messageId = null, ...rawStartInput } = input
    const key = rawStartInput.agentUserId ?? String(rawStartInput.userId)
    const agentId = rawStartInput.agentId ?? 'main'
    const live = [...(this.liveTurns.get(key) ?? [])].filter(t => !t.ended && t.agentId === agentId)
    if (live.length === 0) {
      const { input: withCarried, carriedMessageIds } = this.withUnansweredImages(rawStartInput, messageId)
      const turn = this.startTurn(withCarried)
      this.markTaken(turn, [...carriedMessageIds, ...heldMessageIds, messageId])
      return { mode: 'started', turn }
    }
    const startInput = rawStartInput
    // Only plain text steers: attachments, a one-shot model, turn overrides
    // or preamble tool calls need a turn of their own.
    const plainText = !startInput.continueFromTranscript
      && !(startInput.attachments?.length) && !startInput.turnModelOverride
      && !startInput.turnOverrides && !(startInput.preambleToolCalls?.length)
    const offer = this.offerSteerToLiveTurn({
      agentUserId: key,
      agentId,
      sessionId: startInput.sessionId,
      text: plainText ? startInput.text : '',
      source: startInput.source,
      messageId,
    })
    if (offer.accepted) {
      // The queue place is reserved synchronously, before any later message
      // can be queued (REVIEW-S1-D, finding 1).
      const placeholder = this.enqueueTurn(startInput, offer.settled)
      const fallback = offer.settled.then((delivered) => {
        if (delivered) return null
        markUserMessageSteerState(this.db, messageId, { queued: true })
        return placeholder
      })
      return { mode: 'steered', turnId: offer.turnId, fallback }
    }
    const running = live.find(t => t.running) ?? null
    const waitingFor = running ?? live[0]!
    markUserMessageSteerState(this.db, messageId, { queued: true, waitingForTurnId: waitingFor.id })
    const queuedTurn = this.startTurn(startInput)
    this.markTaken(queuedTurn, [...heldMessageIds, messageId])
    return { mode: 'queued', turn: queuedTurn, waitingForTurnId: waitingFor.id, reason: offer.reason }
  }

  /**
   * S1-D (REVIEW-S1-D, finding 2): after a restart, every persisted user
   * message stamped `steer:true` without `steerDelivered:true` was accepted as
   * an interjection but never reached a model request (the process died in
   * between). Each comes back as a queued turn of its own, oldest first
   * (`ORDER BY timestamp, id`). At-least-once: a crash between the real send
   * start and the `steerDelivered` write yields a duplicate, never a loss.
   * Idempotent per messageId: the row is restamped `{queued:true,
   * steerRecovered:true}` before its turn is queued, so a second call (or a
   * second start) finds nothing. Returns the number of requeued messages.
   */
  recoverUndeliveredSteers(): number {
    if (!this.db) return 0
    let rows: Array<{ id: number; session_id: string; user_id: number | null; content: string; agent_id: string | null; source: string | null }>
    try {
      rows = this.db.prepare(
        `SELECT m.id, m.session_id, m.user_id, m.content, m.agent_id, s.source
           FROM chat_messages m LEFT JOIN sessions s ON s.id = m.session_id
          WHERE m.role = 'user'
            AND json_valid(m.metadata)
            AND json_extract(m.metadata, '$.steer') = 1
            AND COALESCE(json_extract(m.metadata, '$.steerDelivered'), 0) != 1
          ORDER BY m.timestamp, m.id`,
      ).all() as typeof rows
    } catch (err) {
      console.warn(`[turn-runner] Could not read undelivered steers: ${errorClass(err)}`)
      return 0
    }
    let count = 0
    for (const row of rows) {
      if (row.user_id === null) continue
      // At-least-once within the process boundary: a row whose
      // `steerRecovered` write failed is still `steer:true` in the db, but
      // this process already requeued it and never does so again.
      if (this.recoveredSteerIds.has(row.id)) continue
      this.recoveredSteerIds.add(row.id)
      if (!markUserMessageSteerState(this.db, row.id, { queued: true, steerRecovered: true })) {
        console.warn(`[turn-runner] steerRecovered marker for message ${row.id} not written; requeued once in this process, a restart may requeue it again (at-least-once)`)
      }
      this.startTurn({
        userId: row.user_id,
        sessionId: row.session_id,
        text: row.content,
        source: row.source ?? 'web',
        agentId: row.agent_id ?? 'main',
      })
      count++
    }
    return count
  }

  /**
   * S1-D: offer `text` as an interjection to the RUNNING turn of this strand
   * and persona. Refused when no such turn runs, another turn of the persona
   * is already queued (a steer would overtake it), the run is not in a tool
   * batch, or the batch already carries a steer. Accepted: the user row
   * `messageId` is stamped `{steer:true, turnId}`; `settled` resolves `false`
   * when the run ended without taking it (the caller decides the fallback).
   * `preformatted`: `text` is an already escaped data block (ask_user answer).
   */
  offerSteerToLiveTurn(input: {
    agentUserId: string
    agentId?: string
    sessionId: string
    text: string
    source?: string
    messageId?: number | null
    preformatted?: boolean
  }): { accepted: true; turnId: string; settled: Promise<boolean> } | { accepted: false; reason: SteerRejectReason } {
    const agentId = input.agentId ?? 'main'
    const live = [...(this.liveTurns.get(input.agentUserId) ?? [])].filter(t => !t.ended && t.agentId === agentId)
    const running = live.find(t => t.running) ?? null
    if (!running || running.sessionId !== input.sessionId) return { accepted: false, reason: 'no_run' }
    // Another message already waits: a steer would overtake it. A steer
    // placeholder is no such message: the agent's one-per-batch slot keeps
    // the order against it (slot taken / not in a tool phase → queued behind).
    if (live.some(t => t !== running && !t.steerPlaceholder)) return { accepted: false, reason: 'turn_queued' }
    if (!input.text) return { accepted: false, reason: 'unsupported' }
    const agent = this.getAgent()
    if (!agent?.offerSteer) return { accepted: false, reason: 'unsupported' }
    const text = input.preformatted
      ? input.text
      : sealText(input.text, { tier: 'user', source: `steer:${input.source ?? 'unknown'}` }).text
    const offer = agent.offerSteer(agentId, input.sessionId, text, input.messageId ?? null, { preformatted: input.preformatted === true })
    if (!offer.accepted) return offer
    markUserMessageSteerState(this.db, input.messageId, { steer: true, turnId: running.id })
    // `settled` is true only once the block is part of an assembled model
    // request; the marker lets the restart recovery skip it.
    const db = this.db
    const settled = offer.settled.then((delivered) => {
      if (delivered) markUserMessageSteerState(db, input.messageId, { steerDelivered: true })
      return delivered
    }, () => false)
    return { accepted: true, turnId: running.id, settled }
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
   * Abort every queued/streaming turn of a user in EVERY session: the global
   * emergency stop (`/kill`, Telegram `/stop`). Returns true when something
   * was actually aborted. The visible stop button of a strand must use
   * {@link abortTurnInSession} instead — this one also ends turns running in
   * the user's other strands.
   */
  // Consumed cross-workspace (web-backend, telegram); Fallow cannot resolve the
  // @axiom/core exports map, so it sees no caller outside this class.
  // fallow-ignore-next-line unused-class-member
  abortTurn(user: number | string): boolean {
    const dropped = this.dropHeldSubmissions(String(user), null)
    return this.abortMatching(String(user), () => true) || dropped
  }

  /**
   * Abort the queued/streaming turns of a user IN ONE SESSION only (the
   * strand-local `/stop`). Turns of the same user in other sessions keep
   * running. The caller must have verified that the user owns `sessionId`;
   * the runner only matches it against the user's own live turns, so a
   * foreign session id can never reach another user's turns. Returns true
   * when something was actually aborted.
   */
  // Consumed cross-workspace (web-backend); Fallow cannot resolve the
  // @axiom/core exports map.
  // fallow-ignore-next-line unused-class-member
  abortTurnInSession(user: number | string, sessionId: string): boolean {
    if (!sessionId) return false
    const dropped = this.dropHeldSubmissions(String(user), sessionId)
    return this.abortMatching(String(user), turn => turn.sessionId === sessionId) || dropped
  }

  /** A stop also cancels attachment-only messages still waiting for a follow-up. */
  private dropHeldSubmissions(key: string, sessionId: string | null): boolean {
    let dropped = false
    for (const [holdKey, held] of this.heldSubmissions) {
      const [heldUser, , heldSession] = holdKey.split('\u0000')
      if (heldUser !== key || (sessionId !== null && heldSession !== sessionId)) continue
      clearTimeout(held.timer)
      this.heldSubmissions.delete(holdKey)
      // The user cancelled these photos: no later turn may bring them back.
      markImagesSettled(this.db, held.messageIds, { discarded: true })
      dropped = true
    }
    return dropped
  }

  private abortMatching(key: string, match: (turn: TurnState) => boolean): boolean {
    const turns = this.liveTurns.get(key)
    if (!turns) return false

    let aborted = false
    const agent = this.getAgent()
    for (const turn of turns) {
      if (turn.ended || !match(turn)) continue
      aborted = true
      turn.abortController.abort()
      turn.attemptController.abort()
      // Scoped per turn: a user's /stop must not tear down runs of other
      // users/personas/strands that happen to share this process.
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
        console.error(`[turn-runner] subscriber failed: ${errorClass(err)}`)
      }
    }
  }

  /** A steer placeholder whose interjection was delivered: gone, no events, no stats. */
  private dropPlaceholder(turn: TurnState): void {
    if (turn.ended) return
    turn.ended = true
    turn.endedAt = Date.now()
    const turns = this.liveTurns.get(turn.key)
    if (turns) {
      turns.delete(turn)
      if (turns.size === 0) this.liveTurns.delete(turn.key)
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

    if (turn.statsRecorded) {
      recordStrandTurnEnd(
        this.db, turn.id, turn.sessionId,
        turn.statsFailed ? 'failed' : turn.abortController.signal.aborted ? 'aborted' : 'completed',
        new Date(turn.endedAt).toISOString(),
      )
    }

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
    turn.running = true

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

    this.emit(turn, {
      type: 'turn_start',
      turnId: turn.id,
      ...(input.replyToInteractionId ? { replyToInteractionId: input.replyToInteractionId } : {}),
    })

    // Strand statistics: one `strand_turns` row per persisted turn (a retry
    // of a failed turn is a turn of its own). Channels without a web user
    // persist nothing, so they record no turn either.
    if (this.db && turn.userId !== null) {
      recordStrandTurnStart(this.db, {
        id: turn.id,
        sessionId: turn.sessionId,
        agentId: turn.agentId,
        trigger: input.trigger ?? 'user',
        inputMode: input.inputMode ?? (input.continueFromTranscript ? null : 'typed'),
        startedAt: new Date(turn.startedAt).toISOString(),
      })
      turn.statsRecorded = true
    }

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
        const retry: RetryInfo = { attempt, maxRetries: policy.maxRetries, delayMs: 0, error: result.publicError }
        console.warn(
          `[turn-runner] Provider rejected the credentials (user=${turn.userId}, session=${turn.sessionId}): `
          + `${errorTextClass(result.error)} \u2014 credentials re-resolved, retrying once.`,
        )
        turn.buffer = turn.buffer.filter(event => event.type === 'turn_start')
        this.emitChunk(turn, { type: 'retry_scheduled', text: formatAuthRetryContent(), retry })
        if (turn.abortController.signal.aborted) break
        continue
      }

      if (!result.willRetry) {
        this.failTurn(turn, {
          cause: result.retryable ? 'retry_exhausted' : 'non_retryable',
          error: result.publicError,
          attempts: attempt,
          retryable: result.retryable,
          ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
        }, errorTextClass(result.error))
        break
      }

      attempt++
      // A rate limit is not generic provider noise: the provider usually says
      // HOW long to wait. When it does, honour `Retry-After` (goal 4) instead
      // of the exponential curve, which can retry far too early and burn
      // another slot of the same credential. Without a stated delay the
      // documented 2s/4s/8s curve stays exactly as it was. Capped so an
      // extreme value cannot park a turn for minutes.
      const statedDelayMs = isRateLimitError(result.error) ? retryAfterMsFromError(result.error) : null
      const retry: RetryInfo = {
        attempt,
        maxRetries: policy.maxRetries,
        delayMs: statedDelayMs !== null
          ? Math.min(Math.max(statedDelayMs, retryDelayMs(policy, attempt)), RATE_LIMIT_RETRY_CAP_MS)
          : retryDelayMs(policy, attempt),
        error: result.publicError,
      }
      console.warn(
        `[turn-runner] Retryable provider error (user=${turn.userId}, session=${turn.sessionId}): `
        + `${errorTextClass(result.error)} — retry ${attempt}/${policy.maxRetries} in ${retry.delayMs}ms.`,
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
    // It names the persisted assistant row (S0-B/QW2): without it a card's
    // buttons stay dead until the client reloads the history.
    this.emitChunk(turn, doneChunk(turn.finalMessage))
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
    const transcript = new TurnTranscript(
      this.db, turn.sessionId, turn.userId, turn.agentId, this.onAssistantMessage, turn.source,
    )
    const agentUserId = turn.key
    const stall: { error: string | null; retryable: boolean } = { error: null, retryable: true }
    const watchdog = this.startStallWatchdog(turn, agent, thresholds, (error, retryable = true) => {
      stall.error = error
      stall.retryable = retryable
    })
    let failure: { error: string; publicError: string; retryable: boolean; diagnostic?: ProviderErrorDiagnostic } | null = null

    try {
      const continueTurn = attempt > 0 || input.continueFromTranscript === true
      // Re-emitted per auto-retry attempt because a discarded attempt rolls
      // back its rows and the UI strips them; a manual retry continues from a
      // committed transcript that already holds them.
      if (input.continueFromTranscript !== true) {
        for (const chunk of preambleChunks(input.preambleToolCalls)) {
          transcript.record(chunk)
          this.emitChunk(turn, chunk, { preamble: true })
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
        if (chunk.type === 'tool_call_start') watchdog.toolStarted(chunk.toolCallId ?? '')
        if (chunk.type === 'tool_call_end') watchdog.toolEnded(chunk.toolCallId ?? '')

        // `done` is owned by the turn, not by an attempt.
        if (chunk.type === 'done') continue

        if (chunk.type === 'error') {
          // `rawError` (provider text) feeds the classifiers only; `error` is
          // the public form. A chunk without `rawError` is a fixed notice of
          // the runtime, or comes from an older producer: then the public
          // form is derived here so raw text can never pass through.
          const error = chunk.rawError ?? chunk.error ?? 'Unknown provider error'
          failure = {
            error,
            publicError: chunk.rawError !== undefined ? (chunk.error ?? publicProviderError(chunk.rawError)) : publicProviderError(chunk.error),
            retryable: this.isRetryableFailure(turn, error),
            ...(chunk.diagnostic ? { diagnostic: chunk.diagnostic } : {}),
          }
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
        failure = {
          error: `Agent error: ${message}`,
          publicError: `Agent error: ${errorClass(err)}`,
          retryable: this.isRetryableFailure(turn, message),
        }
      }
    } finally {
      watchdog.stop()
    }

    // A watchdog kill outranks whatever the stream reported on its way out: it
    // is the reason the attempt died. A mid-stream stall is retryable; an
    // exceeded native first-token budget is not (an automatic retry would put
    // the same long prefill straight back into the same local runner queue).
    // The watchdog texts are the runner's own, so they are public as they are.
    if (stall.error) failure = { error: stall.error, publicError: stall.error, retryable: stall.retryable }

    // A user abort ends the turn even if the watchdog fired first: only the
    // watchdog's own kill counts as a retryable failure.
    if (turn.abortController.signal.aborted) {
      this.commitTranscript(turn, transcript)
      return { status: 'aborted' }
    }

    if (!failure) {
      this.commitTranscript(turn, transcript)
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
    else this.commitTranscript(turn, transcript)

    return { status: 'failed', error: failure.error, publicError: failure.publicError, retryable: failure.retryable, willRetry, authRetry, ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}) }
  }

  /**
   * End the turn with a durable error row plus the matching `error` chunk.
   * Persisting is what turns the old "nothing happens" failure modes (expired
   * key, failed OAuth refresh, exhausted retries) into a message that is still
   * there after a reload; the chunk carries the same text and the row id so
   * live rendering and history agree.
   */
  /**
   * `failure.error` must already be public (fixed text or
   * `publicProviderError`); `logClass` is the class of the raw text, so the
   * log keeps the diagnosis without the text (review K0-K2-4 #3).
   */
  private failTurn(
    turn: TurnState,
    failure: Omit<TurnErrorInfo, 'messageId' | 'occurredAt' | 'retryActionId'>,
    logClass: string = errorTextClass(failure.error),
  ): void {
    turn.statsFailed = true
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
      console.error(`[turn-runner] Failed to persist terminal error: ${errorClass(err)}`)
      messageId = null
    }

    console.error(
      `[turn-runner] Turn failed (user=${turn.userId}, session=${turn.sessionId}, `
      + `cause=${info.cause}, attempts=${info.attempts}): ${logClass}`
      + (info.diagnostic ? ` | ${formatProviderErrorDiagnostic(info.diagnostic)}` : ''),
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
  private commitTranscript(turn: TurnState, transcript: TurnTranscript): void {
    transcript.flushThinking()
    const written = transcript.finalize()
    if (!written) return
    turn.finalMessage = { messageId: written.messageId, blockId: written.blockId }
    // S0-B/B1+QW3: one counter per card fence of the persisted answer, by
    // parse outcome and channel. Outcomes only, never content.
    for (const outcome of written.parseOutcomes) recordInteractionEvent(turn.source, `parse_${outcome}`)
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
      console.error(`[turn-runner] Credential recovery failed: ${errorClass(err)}`)
      return false
    }
  }

  private isRetryableFailure(turn: TurnState, error: string): boolean {
    if (isAbortError(error) && !this.isAttemptAborted(turn)) return true
    return isRetryableTurnError(error)
  }

  private emitChunk(turn: TurnState, chunk: ResponseChunk, opts?: { preamble?: boolean }): void {
    // Preamble tool calls are synthetic (no model output): they must not
    // count as the first token of the answer.
    if (turn.statsRecorded && !turn.statsFirstToken && !opts?.preamble
      && (chunk.type === 'text' || chunk.type === 'thinking' || chunk.type === 'tool_call_start')) {
      turn.statsFirstToken = true
      recordStrandTurnFirstToken(this.db, turn.id)
    }
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
    onAbort: (error: string, retryable?: boolean) => void,
  ) {
    let lastActivityAt = Date.now()
    let active: { startedAt: number; messageId: number | null; firstToken: FirstTokenWait | null } | null = null
    /**
     * Set while a native local Ollama request of this session waits for its
     * first output (prompt prefill / runner queue). Only the native stream
     * wrapper emits it, so for every other provider this stays null and the
     * watchdog behaves exactly as before.
     */
    let firstToken: FirstTokenWait | null = null
    const unsubscribePhase = subscribeProviderPhase(turn.sessionId, (event) => {
      const now = Date.now()
      if (event.phase === 'stream_activity') {
        // Provider output without a text/thinking chunk (e.g. a long tool
        // call being streamed): the provider is alive. Ignored during a
        // native first-token wait, whose own phases own that budget.
        if (firstToken) return
        closeStall(now, 'recovered')
        lastActivityAt = now
        return
      }
      if (event.phase === 'awaiting_first_token') {
        // Dispatching the request is activity; from here the budget applies.
        closeStall(now, 'recovered')
        lastActivityAt = now
        firstToken = {
          requestId: event.requestId,
          estimatedInputTokens: event.estimatedInputTokens,
          budgetMs: nativeFirstTokenBudgetMs(event.estimatedInputTokens, thresholds.abortMs),
        }
        console.log(
          `[turn-runner] native first-token wait req=${event.requestId} session=${turn.sessionId} `
          + `est_input_tokens=${event.estimatedInputTokens} budget_ms=${firstToken.budgetMs} `
          + `(regular abort ${thresholds.abortMs}ms)`,
        )
        return
      }
      if (firstToken?.requestId !== event.requestId) return
      if (event.phase === 'first_token') {
        console.log(`[turn-runner] native first token req=${event.requestId} session=${turn.sessionId} after_ms=${event.elapsedMs}`)
      }
      // Only real output is a recovery. A request that ended without its
      // first token (error, cancel, empty end) is closed as exactly that, so
      // the row never claims the model "started answering" (review F2).
      const outcome: StallOutcome = event.phase === 'first_token'
        ? 'recovered'
        : event.end === 'done' ? 'ended' : event.end === 'canceled' ? 'canceled' : 'error'
      // First output or end of request: back to the regular stall budget,
      // which keeps a hang AFTER the first token bounded as before.
      closeStall(now, outcome)
      lastActivityAt = now
      firstToken = null
    })
    /**
     * Off while the turn only waits for the process-wide queue lock: there is
     * no provider connection yet, so silence is not a stall. Armed by default
     * so agents that do not send queue signals keep the old coverage.
     */
    let counting = true
    /**
     * Tool calls currently executing. While one runs, no provider request is
     * in flight, so silence is tool runtime, not provider silence: counting
     * pauses (plan 2026-10-09-provider-silence). A hung tool stays bounded by
     * the tool's own timeout and the runtime's turn inactivity guard.
     */
    const toolsInFlight = new Set<string>()

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
        console.error(`[turn-runner] Failed to persist stall warning: ${errorClass(err)}`)
        return null
      }
    }

    const firstTokenFields = (wait: FirstTokenWait | null): Partial<StallInfo> => wait
      ? { phase: 'first_token', budgetMs: wait.budgetMs, estimatedInputTokens: wait.estimatedInputTokens }
      : {}

    const openStall = (now: number): void => {
      if (active) return
      const startedAt = lastActivityAt
      const stall: StallInfo = {
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now - startedAt,
        ...firstTokenFields(firstToken),
      }
      const messageId = persistStall(stall)
      active = { startedAt, messageId, firstToken }
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
      const { startedAt, messageId, firstToken: wait } = active
      active = null

      const stall: StallInfo = {
        messageId: messageId ?? undefined,
        startedAt: new Date(startedAt).toISOString(),
        resolvedAt: new Date(now).toISOString(),
        durationMs: now - startedAt,
        outcome,
        ...firstTokenFields(wait),
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
          console.error(`[turn-runner] Failed to resolve stall warning: ${errorClass(err)}`)
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
      if (toolsInFlight.size > 0) return
      if (this.isAttemptAborted(turn)) return
      const now = Date.now()
      const idleMs = now - lastActivityAt
      const wait = firstToken

      if (wait && idleMs >= wait.budgetMs) {
        console.error(
          `[turn-runner] Native first-token budget exceeded req=${wait.requestId} idle_ms=${idleMs} `
          + `budget_ms=${wait.budgetMs} est_input_tokens=${wait.estimatedInputTokens} `
          + `(user=${turn.userId}, session=${turn.sessionId}). Aborting request, no auto-retry.`,
        )
        openStall(now)
        closeStall(now, 'aborted')
        onAbort(
          `Local model produced no output within its first-token budget of ${Math.round(wait.budgetMs / 1000)}s `
          + `(~${wait.estimatedInputTokens} input tokens estimated; the prompt may still be processing or the local runner is busy). `
          + `Request aborted and not retried automatically — retry manually, shorten the conversation or start a new strand.`,
          false,
        )
        turn.attemptController.abort()
        agent.abort({ sessionId: turn.sessionId, agentId: turn.agentId })
        return
      }

      if (!wait && idleMs >= thresholds.abortMs) {
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
      /** A tool started executing: its runtime is not provider silence. */
      toolStarted: (toolCallId: string) => {
        closeStall(Date.now(), 'recovered')
        toolsInFlight.add(toolCallId)
      },
      /** A tool finished: the next provider request starts a fresh budget. */
      toolEnded: (toolCallId: string) => {
        toolsInFlight.delete(toolCallId)
        lastActivityAt = Date.now()
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
        unsubscribePhase()
        closeStall(Date.now(), 'aborted')
      },
    }
  }
}

/** A native local request waiting for its first output (see provider-phase.ts). */
interface FirstTokenWait {
  requestId: string
  estimatedInputTokens: number
  budgetMs: number
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
  /**
   * The voice note a tool produced in this turn (`send_voice_message`). It is
   * written onto the assistant row in {@link finalize} and handed to the
   * assistant-message hook, which then skips the automatic note for this
   * message — one turn never speaks twice.
   */
  private voiceNote: VoiceNote | null = null
  /** Rows written so far, so a discarded attempt can roll them back. */
  private readonly writtenRowIds: number[] = []

  constructor(
    private readonly db: Database | null,
    private readonly sessionId: string,
    private readonly userId: number | null,
    // Fork multi-persona: persona attribution for every persisted row.
    private readonly agentId: string = 'main',
    private readonly onAssistantMessage?: (message: PersistedAssistantMessage) => void,
    /** Channel of the turn, handed to {@link onAssistantMessage}. */
    private readonly source?: string,
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
      // Real Eco: a result frozen at creation already owns its row (written
      // before the model could see it) — reuse it, never insert a duplicate.
      const frozenRowId = (this.db && frozenEcoRowId(this.db, this.sessionId, chunk.toolCallId, chunk.toolResult)) || undefined
      // A frozen row is NOT rolled back by discard(): the tool really ran, its
      // projection stays in the live agent state that the retried attempt
      // continues from, and that projection names this row id. Deleting it
      // would destroy the original while the transcript still points at it.
      if (frozenRowId === undefined) this.remember(saveChatMessage(this.db, this.sessionId, this.userId, 'tool', `Tool: ${toolName}`, JSON.stringify({
        toolName,
        toolCallId: chunk.toolCallId,
        toolArgs: pending?.toolArgs ?? null,
        toolResult: chunk.toolResult ?? null,
        toolIsError: chunk.toolIsError ?? false,
      }), this.agentId))
      this.pendingToolCalls.delete(chunk.toolCallId)

      const spoken = extractVoiceNoteFromToolResult(chunk.toolResult)
      if (spoken) this.voiceNote = spoken

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
      console.error(`[turn-runner] Failed to persist thinking block: ${errorClass(err)}`)
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
    this.voiceNote = null
    if (!this.db || this.writtenRowIds.length === 0) return
    try {
      // Artifacts first: a row whose message is gone can never be reached
      // again, and its bytes would leak into the data directory forever.
      deleteArtifactsForMessages(this.db, this.writtenRowIds)
      const statement = this.db.prepare('DELETE FROM chat_messages WHERE id = ?')
      for (const id of this.writtenRowIds) statement.run(id)
    } catch (err) {
      console.error(`[turn-runner] Failed to discard the failed attempt: ${errorClass(err)}`)
    }
    this.writtenRowIds.length = 0
  }

  /**
   * Write the assistant row. A turn that produced only attachments still gets
   * a row (with empty content) so the download card survives a history reload.
   */
  finalize(): { messageId: number; blockId: string | null; parseOutcomes: InteractionParseOutcome[] } | null {
    if (!this.persists) return null
    if (!this.fullResponse && this.uploads.length === 0 && !this.voiceNote) return null
    let metadata = this.uploads.length > 0 ? serializeUploadsMetadata(this.uploads) : undefined
    // A voice note produced by a tool belongs to THIS answer: it goes into the
    // same metadata blob the app already reads, next to `files`.
    if (this.voiceNote) metadata = mergeVoiceNoteMetadata(metadata ?? null, this.voiceNote)
    const messageId = saveChatMessage(
      this.db, this.sessionId, this.userId, 'assistant', this.fullResponse, metadata, this.agentId,
    )
    this.remember(messageId)
    if (messageId === null) return null
    this.recordArtifacts(messageId)
    this.recordInteractions(messageId)
    this.notifyAssistantMessage(messageId)
    return {
      messageId,
      blockId: findAnswerableInteractionBlockIds(this.fullResponse)[0] ?? null,
      parseOutcomes: classifyInteractionFences(this.fullResponse),
    }
  }

  /**
   * Stufe 1 (S1-A): every answerable fence card of the finished answer gets
   * its row in the `interactions` table, the one source of its state. Same
   * single place as `recordArtifacts`, so every channel is covered. Wrapped:
   * a broken card must never lose the turn that already succeeded.
   */
  private recordInteractions(messageId: number): void {
    if (!this.db) return
    try {
      const cards = ingestInteractionMessage(this.db, {
        messageId,
        strandId: this.sessionId,
        userId: this.userId,
        agent: this.agentId ?? 'main',
        content: this.fullResponse,
      })
      // S1-B telemetry: cards by source (fence here, `card_tool` in ask_user).
      if (cards.length > 0) recordInteractionEvent('other', 'card_fence', cards.length)
    } catch (err) {
      console.error(`[turn-runner] Failed to record interaction cards: ${errorClass(err)}`)
    }
  }

  /**
   * Hand the finished answer to the optional consumer. Wrapped: an exception
   * in an add-on (voice note) must never lose the turn that already succeeded.
   */
  private notifyAssistantMessage(messageId: number): void {
    if (!this.onAssistantMessage || this.userId === null) return
    try {
      this.onAssistantMessage({
        messageId,
        userId: this.userId,
        sessionId: this.sessionId,
        agentId: this.agentId,
        content: this.fullResponse,
        voiceNote: this.voiceNote,
        ...(this.source ? { source: this.source } : {}),
      })
    } catch (err) {
      console.error(`[turn-runner] onAssistantMessage hook failed: ${errorClass(err)}`)
    }
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
        console.warn(`[turn-runner] Skipped artifact (title length ${skip.title.length}): ${skip.reason}`)
      }
    } catch (err) {
      console.error(`[turn-runner] Failed to record artifacts: ${errorClass(err)}`)
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
