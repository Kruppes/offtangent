import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentMessage, Agent as PiAgent } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { completeSimple } from './pi-models.js'
import type { Database } from './database.js'
import { getApiKeyForProvider, buildModel } from './provider-config.js'
import { assertLlmResponseOk } from './llm-response.js'
import type { ProviderConfig } from './provider-config.js'
import type { ProviderManager } from './provider-manager.js'
import { loadConfig } from './config.js'
import { resolveRoleSpec } from './model-policy.js'
import { buildAttachmentContext } from './attachment-context.js'
import type { UploadDescriptor } from './uploads.js'
import { SessionManager } from './session-manager.js'
import type { SessionEndCallbackOptions, SessionInfo } from './session-manager.js'
import { MessageQueue, TurnSemaphore } from './message-queue.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { AgentRuntimeBoundary, AgentRuntimePiAgentAccess } from './agent-runtime.js'
import type { AbortScope, AgentRuntimeStateSnapshot, ResponseChunk, TurnStreamChunk } from './agent-runtime-types.js'
import { resolveBackgroundReasoning } from './thinking-level.js'
import { withTimeout } from './promise-utils.js'
import { logToolCall } from './token-logger.js'
import {
  EMPTY_SUMMARY_TEXT,
  buildSummaryDeltaSystemPrompt,
  isEmptySummary,
  mergeSummaryDelta,
  parseSummaryDelta,
  renderSummaryMarkdown,
} from './session-summary-schema.js'
import { getLatestSessionSummary, insertSessionSummary } from './session-summary-store.js'
import { loadHeuristics } from './heuristics.js'
import { consumePendingTaskNotices } from './task-agent-notice.js'
import { assembleStrandContextWithStats, trimMessagesToBudget, stripStrandContextFromLastUserMessage } from './strand-context.js'
import type { EffectiveModel, ModelSelection } from './model-resolution.js'

export type { ResponseChunk } from './agent-runtime-types.js'
export { createYoloTools, isRetryablePreStreamError } from './agent-runtime.js'

export interface AgentCoreOptions {
  model: Model<Api>
  apiKey: string
  db: Database
  systemPrompt?: string
  tools?: import('@earendil-works/pi-agent-core').AgentTool[]
  memoryDir?: string
  sessionTimeoutMinutes?: number
  baseInstructions?: string
  providerConfig?: ProviderConfig // For OAuth token refresh
  providerManager?: ProviderManager // For fallback retry support
  quotaService?: import('./quota-tool.js').QuotaServiceLike
  /** Resolve the effective provider/model after this turn owns the global queue. */
  resolveTurnModel?: (input: {
    sessionId: string
    agentId: string
    turnOverride?: ModelSelection | null
  }) => Promise<{ provider: ProviderConfig; apiKey: string; effective: EffectiveModel } | null>
  /** Runtime injection seam used by boundary/integration tests. */
  runtimeFactory?: (agentId: string) => AgentRuntimeBoundary
  /**
   * Called when a session ends (timeout, /new command, or provider change)
   * with the summary text. `options.background` is true when the session
   * was ended non-blockingly (`resetSessionAsync`) and the summary became
   * available asynchronously after the new session had already been
   * announced — listeners can use this to emit a follow-up update event
   * rather than a duplicate session_end divider.
   */
  onSessionEnd?: (
    userId: string,
    sessionId: string,
    summary: string | null,
    agentId: string,
    options?: SessionEndCallbackOptions,
  ) => void
}

// Re-export for backward compatibility
export { getWorkspaceDir } from './workspace.js'

/**
 * How many turns may run at the same time across all personas
 * (`AXIOM_TURN_CONCURRENCY`, default 3). Parsed exactly like
 * `AXIOM_QUEUE_TURN_MAX_MS`: anything that is not a finite number >= 1 falls
 * back to the default rather than uncapping the process.
 */
const DEFAULT_TURN_CONCURRENCY = (() => {
  const raw = Number(process.env.AXIOM_TURN_CONCURRENCY)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3
})()

/**
 * Make the wait in the persona's turn queue visible to the caller.
 *
 * `MessageQueue.enqueue()` reserves the queue slot synchronously and its
 * promise resolves exactly when the turn owns the lock — everything before
 * that is pure waiting with no provider connection behind it. The stall
 * watchdog cannot tell that apart from a dead provider stream, so it used to
 * abort turns that were merely queued (incident 2026-09-15). Bracketing the
 * wait with two control signals keeps that knowledge inside core: both are
 * consumed by the TurnRunner and never reach a transcript, a client or a
 * channel.
 */
async function* bracketQueueWait(
  pending: Promise<AsyncIterable<ResponseChunk>>,
): AsyncIterable<TurnStreamChunk> {
  // Keep a rejection from surfacing as "unhandled" while we yield below; the
  // `await` further down still rethrows it to the caller.
  void pending.catch(() => {})
  let acquired = false
  try {
    yield { type: 'queue_waiting' }
    const iterable = await pending
    acquired = true
    yield { type: 'queue_started' }
    yield* iterable
  } finally {
    // The consumer walked away while we were still queued: hand the slot back
    // once it is granted, otherwise the queue lock stays held and every later
    // turn in the process blocks behind a turn nobody waits for.
    if (!acquired) {
      void pending
        .then(iterable => iterable[Symbol.asyncIterator]().return?.(undefined as never))
        .catch(() => {})
    }
  }
}

/**
 * Agent Core - manages message queue/session lifecycle and delegates runtime internals
 * (tool wiring, prompt assembly, execution orchestration) to AgentRuntimeBoundary.
 */
export class AgentCore {
  private db: Database
  private sessionManager: SessionManager
  private onSessionEndCallback?: (
    userId: string,
    sessionId: string,
    summary: string | null,
    agentId: string,
    options?: SessionEndCallbackOptions,
  ) => void
  private onTaskInjectionChunkCallback?: (chunk: ResponseChunk) => void
  /**
   * One queue per persona (plan D1/2a). The state a queue protects is the
   * persona's AgentRuntime (one loaded transcript per runtime) — two personas
   * never share one, so serializing them against each other only ever made a
   * long turn of persona A block persona B (incident 2026-09-18, 20 min for a
   * capture answer). Created lazily on first turn of a persona.
   */
  private messageQueues: Map<string, MessageQueue> = new Map()
  /**
   * Global cap on turns running at the same time across all personas, taken
   * after the persona lock. Shared provider/CPU budget, see plan D2.
   */
  private readonly turnSemaphore: TurnSemaphore
  private readonly toolTurn = new AsyncLocalStorage<{
    sessionId: string
    userId?: number
    agentId: string
  }>()
  /**
   * One AgentRuntime per agentId. The 'main' runtime always exists; persona
   * runtimes are created lazily on first use. Each has its own PiAgent with an
   * independent systemPrompt and message history.
   */
  private runtimes: Map<string, AgentRuntimeBoundary> = new Map()
  private runtimeOptions: AgentCoreOptions
  /**
   * Personas whose runtime is pinned to its own provider/model via
   * swapProviderForAgent (C4, per-agent model selection). Pinned runtimes are
   * skipped by the global swapProvider() so a global model change (Settings,
   * Telegram /model, fallback machinery) no longer overrides a persona's own
   * model. Note the documented consequence: a pinned persona does not follow
   * the global fallback swap either — its pin stays authoritative.
   */
  private pinnedProviderAgents: Set<string> = new Set()
  /**
   * Per-persona thread transcripts (Offtangent Stufe 1). There is exactly ONE
   * runtime per persona, so the model context of a thread that is not running
   * is parked here and swapped back in before the next turn on that thread.
   * agentId -> (sessionId -> messages), insertion-ordered = LRU.
   */
  private transcripts: Map<string, Map<string, AgentMessage[]>> = new Map()
  /** agentId -> the session whose transcript is currently loaded in the runtime. */
  private activeTranscriptSessions: Map<string, string> = new Map()
  /** Parked transcripts kept per persona; older ones are dropped (see plan: RAM bound). */
  private static readonly MAX_PARKED_TRANSCRIPTS_PER_AGENT = 8
  /** Personas already warned about for a runtime without transcript access (once, not per turn). */
  private warnedNoTranscriptAccess: Set<string> = new Set()

  constructor(options: AgentCoreOptions) {
    this.db = options.db
    this.onSessionEndCallback = options.onSessionEnd
    this.runtimeOptions = options

    // Create the default 'main' runtime eagerly. Per-persona runtimes are
    // created lazily via getOrCreateRuntime(). (Fork multi-persona model — kept
    // over upstream's single `this.runtime`; upstream's per-runtime options
    // such as `quotaService` are threaded through createRuntimeForAgent.)
    this.runtimes.set('main', this.createRuntimeForAgent('main', options.systemPrompt))

    // Per-persona queues share one global concurrency limit.
    this.turnSemaphore = new TurnSemaphore(DEFAULT_TURN_CONCURRENCY)

    // Initialize session manager
    this.sessionManager = new SessionManager({
      db: this.db,
      timeoutMinutes: options.sessionTimeoutMinutes ?? 30,
      memoryDir: options.memoryDir,
      onSummarize: async (sessionId: string, userId: string, conversationHistory?: string) => {
        return this.generateSessionSummary(userId, conversationHistory, sessionId)
      },
      onSessionEnd: (session: SessionInfo, summary: string | null, opts) => {
        const sessionAgentId = session.agentId ?? 'main'
        // For background ends (resetSessionAsync), runtime state was already
        // cleared synchronously when the new session was created — skip here
        // to avoid wiping the new session's accumulated messages.
        //
        // A `parked` end comes from the parked-thread sweep: the session that
        // ended is NOT the one loaded in the runtime, so clearing the runtime
        // would wipe the context of the thread the user is actually in.
        // Dropping the ended thread's parked transcript (below) is enough.
        if (!opts?.background && !opts?.parked) {
          const runtime = this.runtimes.get(sessionAgentId)
          if (runtime) {
            runtime.clearMessages()
            this.refreshSystemPrompt(undefined, undefined, sessionAgentId)
          }
        }
        // An ended session keeps no transcript, whether it ended in the
        // foreground or in the background (/new): the next turn on that id
        // starts from an empty context, exactly like clearMessages() does.
        this.dropTranscript(sessionAgentId, session.id)
        if (this.onSessionEndCallback) {
          this.onSessionEndCallback(session.userId, session.id, summary, sessionAgentId, opts)
        }
      },
    })
  }

  /**
   * Create an AgentRuntime bound to a specific agentId (persona).
   */
  private createRuntimeForAgent(agentId: string, systemPrompt?: string): AgentRuntimeBoundary {
    if (this.runtimeOptions.runtimeFactory) return this.runtimeOptions.runtimeFactory(agentId)
    return createAgentRuntime({
      model: this.runtimeOptions.model,
      apiKey: this.runtimeOptions.apiKey,
      db: this.runtimeOptions.db,
      systemPrompt,
      tools: this.runtimeOptions.tools,
      memoryDir: this.runtimeOptions.memoryDir,
      baseInstructions: this.runtimeOptions.baseInstructions,
      providerConfig: this.runtimeOptions.providerConfig,
      providerManager: this.runtimeOptions.providerManager,
      getCurrentToolUserId: () => this.getCurrentToolUserId(),
      quotaService: this.runtimeOptions.quotaService,
      agentId,
    })
  }

  /**
   * Get or lazily create the AgentRuntime for a given agentId.
   */
  private getOrCreateRuntime(agentId: string): AgentRuntimeBoundary {
    let runtime = this.runtimes.get(agentId)
    if (!runtime) {
      runtime = this.createRuntimeForAgent(agentId)
      this.runtimes.set(agentId, runtime)
    }
    return runtime
  }

  /** The canonical 'main' runtime (always present). */
  private get mainRuntime(): AgentRuntimeBoundary {
    return this.runtimes.get('main')!
  }

  /**
   * Make `sessionId` the transcript loaded in the persona's runtime.
   *
   * THE single place where thread contexts are swapped — every turn path
   * (normal message, retry, task injection) calls this before prompting, so a
   * forgotten path cannot leak one thread's context into another. Turns are
   * serialized by the global MessageQueue, so the save/load pair is race-free.
   *
   * No-op for runtimes that do not expose transcript access (test doubles):
   * those keep the pre-threads single-transcript behaviour.
   */
  private useSessionTranscript(agentId: string, sessionId: string): void {
    const runtime = this.getOrCreateRuntime(agentId)
    if (typeof runtime.getMessages !== 'function' || typeof runtime.setMessages !== 'function') {
      if (!this.warnedNoTranscriptAccess.has(agentId)) {
        this.warnedNoTranscriptAccess.add(agentId)
        console.warn(`[agent] Runtime for '${agentId}' exposes no transcript access; all threads share one context`)
      }
      return
    }

    const activeSessionId = this.activeTranscriptSessions.get(agentId)
    if (activeSessionId === sessionId) return

    let store = this.transcripts.get(agentId)
    if (!store) {
      store = new Map()
      this.transcripts.set(agentId, store)
    }

    if (activeSessionId) {
      // Park the outgoing thread's context (read live — the runtime may have
      // replaced the array during the turn).
      store.delete(activeSessionId)
      store.set(activeSessionId, runtime.getMessages())
    }

    const incoming = store.get(sessionId) ?? []
    store.delete(sessionId)
    runtime.setMessages(incoming)
    this.activeTranscriptSessions.set(agentId, sessionId)

    // Bound the RAM: drop the least recently used parked transcripts. A
    // dropped thread behaves like one after a restart (empty context, facts
    // and the session tail compensate).
    while (store.size > AgentCore.MAX_PARKED_TRANSCRIPTS_PER_AGENT) {
      const oldest = store.keys().next().value
      if (oldest === undefined) break
      store.delete(oldest)
    }
  }

  /** True when the thread's model context is loaded in the runtime or parked here. */
  private hasTranscript(agentId: string, sessionId: string): boolean {
    if (this.activeTranscriptSessions.get(agentId) === sessionId) return true
    return this.transcripts.get(agentId)?.has(sessionId) ?? false
  }

  /** Forget a thread's parked transcript (session ended). */
  private dropTranscript(agentId: string, sessionId: string): void {
    this.transcripts.get(agentId)?.delete(sessionId)
    if (this.activeTranscriptSessions.get(agentId) === sessionId) {
      this.activeTranscriptSessions.delete(agentId)
    }
  }

  /**
   * Drop a thread's model context everywhere it can still live (SPEC 7.5b):
   * the parked transcript AND, when that thread is the one currently loaded
   * in the persona runtime, the runtime's own message array plus the (user,
   * agent) session slot.
   *
   * Delete-path safety: the rows of a deleted strand are gone, but a runtime
   * still holding its transcript would let the next turn persist that session
   * id again and resurrect the strand with a partial history.
   */
  evictSessionTranscript(userId: string, agentId: string, sessionId: string): void {
    const wasActive = this.activeTranscriptSessions.get(agentId) === sessionId
    this.dropTranscript(agentId, sessionId)
    if (wasActive) {
      const runtime = this.runtimes.get(agentId)
      runtime?.clearMessages()
    }
    this.sessionManager.releaseSessionSlot(userId, agentId, sessionId)
  }

  /**
   * Turns ahead of a message enqueued right now (waiting + the one holding the
   * lock). With `agentId` that is the persona's own queue — the number that
   * actually decides how long a new turn of that persona waits. Without it the
   * legacy sum over all personas is returned, which now only says how busy the
   * process is, not how long anyone waits.
   */
  getPendingMessageCount(agentId?: string): number {
    if (agentId !== undefined) return this.messageQueues.get(agentId)?.busy ?? 0
    let total = 0
    for (const queue of this.messageQueues.values()) total += queue.busy
    return total
  }

  /**
   * What a turn enqueued RIGHT NOW on `agentId` would face (plan D3/D4):
   * its 1-based position and the turn that blocks it. `position` 1 means it
   * starts immediately, so callers only tell the user from 2 upwards.
   *
   * The blocker is always a turn of the SAME persona: that is the only one
   * that provably has to finish first. A wait for the global concurrency slot
   * is not reported as a blocker — it is short-lived and naming a foreign
   * persona's strand would be a false promise about the order.
   */
  describeQueue(agentId: string): { position: number; blockedBy: { agentId: string; sessionId: string | null } | null } {
    const queue = this.messageQueues.get(agentId)
    if (!queue) return { position: 1, blockedBy: null }
    const snapshot = queue.describe()
    const active = snapshot.active
    return {
      position: snapshot.waiting + (active ? 1 : 0) + 1,
      blockedBy: active ? { agentId: active.agentId, sessionId: active.sessionId } : null,
    }
  }

  /**
   * The turn of `sessionId` that is enqueued but has not started yet, for
   * clients that reconnect and need the wait state they missed (plan D5).
   * Null when that strand has nothing waiting (including when its turn is the
   * one running — that is visible through the turn stream itself).
   */
  describePendingTurn(
    agentId: string,
    sessionId: string,
  ): { position: number; blockedBy: { agentId: string; sessionId: string | null } | null } | null {
    const queue = this.messageQueues.get(agentId)
    if (!queue) return null
    const position = queue.pendingPositionOf(sessionId)
    if (position === null) return null
    const active = queue.describe().active
    return {
      position,
      blockedBy: active ? { agentId: active.agentId, sessionId: active.sessionId } : null,
    }
  }

  /** Lazily created queue for a persona (plan D1). */
  private queueFor(agentId: string): MessageQueue {
    const existing = this.messageQueues.get(agentId)
    if (existing) return existing
    const queue = new MessageQueue({ semaphore: this.turnSemaphore })
    this.messageQueues.set(agentId, queue)
    return queue
  }

  /**
   * Get the agentId of the currently executing runtime (set during a turn).
   * Returns undefined when no runtime is actively processing.
   */
  // Used by tool factories that need to attribute side effects to the active persona.
  // fallow-ignore-next-line unused-class-member
  getCurrentToolAgentId(): string | undefined {
    return this.toolTurn.getStore()?.agentId
  }

  /**
   * Initialize async components (must be called after construction).
   * Handles orphaned sessions from previous server runs.
   */
  // Called by the web backend after construction to recover orphaned sessions.
  // fallow-ignore-next-line unused-class-member
  async init(): Promise<void> {
    await this.sessionManager.init()
  }

  /**
   * Get the session manager.
   */
  getSessionManager(): SessionManager {
    return this.sessionManager
  }

  /**
   * Hot-swap the provider at runtime while preserving conversation context.
   */
  swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string): void {
    // Update stored options so future lazily-created persona runtimes use the
    // new provider too.
    this.runtimeOptions = { ...this.runtimeOptions, providerConfig: provider }
    for (const [agentId, runtime] of this.runtimes) {
      // Personas pinned to their own model keep it across global swaps.
      if (this.pinnedProviderAgents.has(agentId)) continue
      runtime.swapProvider(provider, apiKey, modelId)
    }
  }

  /**
   * Pin ONE persona runtime to its own provider/model (C4, per-agent model
   * selection — `multiPersona.perAgentProvider`). Creates the runtime if it
   * does not exist yet. Pinned runtimes are excluded from global
   * swapProvider() calls until unpinAgentProvider() is called.
   */
  // Used by the composition layer to apply multiPersona.perAgentProvider.
  swapProviderForAgent(agentId: string, provider: ProviderConfig, apiKey: string, modelId?: string): void {
    const runtime = this.getOrCreateRuntime(agentId)
    runtime.swapProvider(provider, apiKey, modelId)
    this.pinnedProviderAgents.add(agentId)
  }

  /**
   * Remove a persona's provider pin. When the global provider/apiKey is
   * passed, the runtime is re-synced to it immediately; otherwise it keeps
   * its current model until the next global swapProvider() call.
   */
  // Used by the composition layer when a perAgentProvider entry is removed.
  // fallow-ignore-next-line unused-class-member
  unpinAgentProvider(agentId: string, provider?: ProviderConfig, apiKey?: string, modelId?: string): void {
    if (!this.pinnedProviderAgents.delete(agentId)) return
    if (provider && apiKey !== undefined) {
      this.runtimes.get(agentId)?.swapProvider(provider, apiKey, modelId)
    }
  }

  /**
   * Replace the ProviderManager on all runtimes (used by the hot provider
   * switch so the mid-stream fallback machinery tracks the NEW primary).
   */
  setProviderManager(manager: ProviderManager | undefined): void {
    this.runtimeOptions = { ...this.runtimeOptions, providerManager: manager }
    for (const runtime of this.runtimes.values()) {
      runtime.setProviderManager(manager)
    }
  }

  /**
   * Get the ProviderManager reference (if configured). Canonical source is the
   * 'main' runtime.
   */
  getProviderManager(): ProviderManager | undefined {
    return this.mainRuntime.getProviderManager()
  }

  /**
   * Send a message and get back an async iterable of response chunks.
   * All messages are queued and processed sequentially to prevent collisions.
   */
  async *sendMessage(userId: string, text: string, source: string = 'web', attachments?: UploadDescriptor[], agentId: string = 'main', sessionId?: string, turnModelOverride?: ModelSelection | null): AsyncIterable<TurnStreamChunk> {
    const uploads = attachments
    const pending = this.queueFor(agentId).enqueue<ResponseChunk>(
      'user_message',
      userId,
      text,
      source,
      (msg) => {
        return this.processUserMessage(msg.payload.userId, msg.payload.text, msg.payload.source, uploads, agentId, false, sessionId, turnModelOverride)
      },
      { agentId, sessionId: sessionId ?? null },
    )
    yield* bracketQueueWait(pending)
  }

  /**
   * Re-run the last assistant turn after it failed (auto-retry, manual retry).
   *
   * The user message is NOT re-sent: the runtime drops the failed assistant
   * tail and continues from the existing transcript, so a retried turn never
   * duplicates the user message in the model context. `text`/`attachments`
   * are only used for the fallback path where the transcript has nothing to
   * continue from (e.g. the session was cleared in between).
   */
  async *retryTurn(
    userId: string,
    text: string,
    source: string = 'web',
    attachments?: UploadDescriptor[],
    agentId: string = 'main',
    sessionId?: string,
    turnModelOverride?: ModelSelection | null,
  ): AsyncIterable<TurnStreamChunk> {
    const uploads = attachments
    const pending = this.queueFor(agentId).enqueue<ResponseChunk>(
      'user_message',
      userId,
      text,
      source,
      (msg) => {
        // Persona-aware retry: route to the same persona runtime and set retry=true.
        return this.processUserMessage(msg.payload.userId, msg.payload.text, msg.payload.source, uploads, agentId, true, sessionId, turnModelOverride)
      },
      { agentId, sessionId: sessionId ?? null },
    )
    yield* bracketQueueWait(pending)
  }

  /**
   * Inject a task result into the main agent via the message queue.
   * The injection is queued and processed sequentially like any other message.
   *
   * `targetUserId` identifies which user should see the task result.
   *
   * `forcedSessionId`, if provided, pins the injection to a specific session
   * ID regardless of SessionManager state. Callers use this to guarantee the
   * chunk stream's `sessionId` matches a pre-resolved id they can correlate
   * against — necessary because /new on another channel could otherwise
   * close the cached session between pre-resolution and the queued injection
   * actually running, producing a different sessionId in the chunk stream.
   * Missing lineage is rejected. Feed-only outcomes must never start a turn.
   *
   * `injectionId`, if provided, is propagated onto every streamed chunk
   * (`chunk.injectionId`) so the caller can correlate chunks against a
   * per-injection metadata map without colliding with other injections
   * that happen to share the same target session id. When omitted a fresh
   * UUID is generated so every call still has a unique token.
   */
  async injectTaskResult(
    injection: string,
    targetUserId: string,
    forcedSessionId?: string,
    injectionId?: string,
    agentId: string = 'main',
  ): Promise<void> {
    if (!forcedSessionId) throw new Error('Task injection requires an explicit lineage strand')
    const resolvedInjectionId = injectionId ?? randomUUID()
    const iterable = await this.queueFor(agentId).enqueue<ResponseChunk>(
      'task_injection',
      targetUserId,
      injection,
      'task',
      (msg) => {
        return this.processTaskInjection(
          msg.payload.userId,
          msg.payload.text,
          forcedSessionId,
          resolvedInjectionId,
          agentId,
        )
      },
      { agentId, sessionId: forcedSessionId },
    )
    // Stream response chunks via callback (if set), otherwise drain silently
    for await (const chunk of iterable) {
      this.onTaskInjectionChunkCallback?.(chunk)
    }
  }

  /**
   * Process a user message (called from the queue).
   */
  // Merge (upstream 0.27.0 + fork multi-persona): keep BOTH the persona
  // `agentId` (routes to the per-persona runtime + fact/session scope) AND the
  // `retry` flag (manual retry continues the transcript instead of re-sending).
  private async *processUserMessage(userId: string, text: string, source: string, attachments?: UploadDescriptor[], agentId: string = 'main', retry: boolean = false, explicitSessionId?: string, turnModelOverride?: ModelSelection | null): AsyncIterable<ResponseChunk> {
    // Explicit thread selection (Offtangent Stufe 1) beats every heuristic:
    // the caller named a session, so no topic-shift detection runs and the
    // named session becomes the active one. Without it, behaviour is exactly
    // the pre-threads one (Telegram, companion app, legacy web UI).
    //
    // Otherwise: resolveSession with the message text so topic-shift detection
    // and fact injection run on new sessions / topic shifts. On a manual retry
    // we must NOT run topic-shift detection (it could split the session
    // mid-retry); reuse the existing session for the same persona.
    const session = explicitSessionId
      ? this.sessionManager.activateSession(userId, explicitSessionId, agentId, {
        ...(retry ? {} : { messageText: text }),
        // Whether the model context of that thread is loaded or parked here;
        // when it is not (restart, eviction, reopen) the manager queues the
        // thread's own tail + facts so the turn does not start from nothing.
        hasTranscript: this.hasTranscript(agentId, explicitSessionId),
      })
      : retry
        ? this.sessionManager.getOrCreateSession(userId, source, agentId)
        : this.sessionManager.resolveSession(userId, source, text, agentId)
    const sessionId = session.id

    // Resolve username for user profile injection (skip for group chats)
    let currentUser: { username: string } | undefined
    if (source !== 'telegram-group') {
      try {
        const row = this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined
        if (row?.username) {
          currentUser = { username: row.username }
        }
      } catch {
        // userId might not be a numeric ID (e.g. telegram-12345), skip
      }
    }

    // Pass channel as 'telegram' for both DM and group sources
    const channel = source.startsWith('telegram') ? 'telegram' : source
    this.refreshSystemPrompt(channel, currentUser, agentId)
    this.sessionManager.recordMessage(userId, agentId)

    // The text as the transport persisted it, before any injection.
    const rawText = text

    // A strand that a plain chat turn opened has no title; give it one from
    // this message (no-op once it has one) so it never stays a blank row.
    this.sessionManager.ensureThreadTitle(sessionId, rawText)

    // Consume any pending fact injection (set during resolveSession on a new
    // session start or topic shift) and prepend it to the user message.
    const factInjection = this.sessionManager.consumeFactInjection(userId, agentId)
    if (factInjection) {
      text = `${factInjection}\n\n${text}`
    }

    // W5/P3: outcomes of feed-only tasks (cronjobs) never start a turn of
    // their own, so they would otherwise wait for a run that reads them.
    // The next run is this one — announce them BEFORE the user's message,
    // never persisted, exactly once (see task-agent-notice.ts).
    const taskNoticeMaxAgeHours = (() => {
      try { return loadHeuristics().taskDelivery.maxAgeHours } catch { return 24 }
    })()
    const taskNotices = consumePendingTaskNotices(this.db, {
      agentId,
      ...(taskNoticeMaxAgeHours > 0 ? { maxAgeMs: taskNoticeMaxAgeHours * 3600_000 } : {}),
    })
    if (taskNotices) {
      text = `${taskNotices}\n\n${text}`
    }

    // Build image content and file context from attachments
    const { images, hints: fileHints } = buildAttachmentContext(attachments)

    // Route to the correct runtime for this agentId. Resolution happens here,
    // after the persona's MessageQueue granted its lock; swapping before enqueue
    // would let another strand change the shared persona runtime in between.
    // (The lock is per persona, and so is the runtime it protects — plan D1.)
    const runtime = this.getOrCreateRuntime(agentId)
    const resolvedModel = await this.runtimeOptions.resolveTurnModel?.({
      sessionId,
      agentId,
      turnOverride: turnModelOverride,
    })
    if (resolvedModel) {
      const currentProviderId = runtime.getCurrentProvider()?.id
      const currentModelId = runtime.getCurrentModel().id
      // A foreign run still owning this runtime means the queue watchdog
      // released the slot early while the old provider call stayed alive.
      // Swapping now would rewrite `agent.state.model` underneath that run
      // and finish its tool loop on this strand's model. The runtime rejects
      // the second prompt as busy anyway, so skipping the swap loses nothing.
      const foreignRun = runtime.getRunningSessionId?.() ?? null
      const runtimeIsFree = foreignRun === null || foreignRun === sessionId
      if (!runtimeIsFree) {
        console.warn(`[agent] Skipping model swap for session ${sessionId}: runtime still runs session ${foreignRun}`)
      }
      if (runtimeIsFree && (currentProviderId !== resolvedModel.effective.providerId || currentModelId !== resolvedModel.effective.modelId)) {
        runtime.swapProvider(resolvedModel.provider, resolvedModel.apiKey, resolvedModel.effective.modelId)
        if (resolvedModel.effective.degradedReason) {
          this.db.prepare(
            `INSERT INTO chat_messages (session_id, role, content, metadata, agent_id)
             VALUES (?, 'system', ?, ?, ?)`,
          ).run(
            sessionId,
            `Modell (automatischer Fallback): ${currentModelId} → ${resolvedModel.effective.modelId}`,
            JSON.stringify({ type: 'model_change', automatic: true, reason: resolvedModel.effective.degradedReason }),
            agentId,
          )
        }
      }
    }
    this.useSessionTranscript(agentId, sessionId)

    // Strand context by token budget (SPEC 11.3): trim the verbatim window,
    // then prepend strand notes, an index of the older messages and capped
    // retrieval. Short strands get nothing prepended.
    const strandContext = this.prepareStrandContext(runtime, sessionId, rawText)
    if (strandContext) {
      text = `${strandContext}\n\n${text}`
    }

    const timeContext = runtime.getCurrentTimeContext()
    const baseText = fileHints.length > 0 ? `${text}\n\n${fileHints.join('\n')}` : text
    const enrichedText = `${baseText}\n\n${timeContext}`
    const parsedUserId = Number.parseInt(userId, 10)
    const turn = { sessionId, userId: Number.isFinite(parsedUserId) ? parsedUserId : undefined, agentId }

    try {
      // Merge: retry/stream run on the SAME per-persona runtime the turn was
      // routed to (NOT a singular this.runtime), so a manual retry replays under
      // the correct persona's transcript/session.
      const stream = retry
        ? runtime.retryLastTurn(enrichedText, sessionId, images.length > 0 ? images : undefined)
        : runtime.streamPrompt(enrichedText, sessionId, images.length > 0 ? images : undefined)
      yield* this.bindToolTurn(stream, turn)
    } finally {
      if (strandContext) this.dropStrandContextFromTranscript(runtime)
    }

    // Count the agent response as a message too
    this.sessionManager.recordMessage(userId, agentId)
  }

  /**
   * Trim the runtime transcript to the strand token budget and build the
   * `<strand_context>` block from the database (SPEC 11.3). Returns null when
   * the runtime exposes no transcript or there is nothing outside memory.
   */
  private prepareStrandContext(runtime: AgentRuntimeBoundary, sessionId: string, userText: string): string | null {
    if (typeof runtime.getMessages !== 'function' || typeof runtime.setMessages !== 'function') return null
    try {
      const budget = loadHeuristics().strand.windowTokens
      const trimmed = trimMessagesToBudget(runtime.getMessages(), budget)
      if (trimmed.droppedCount > 0) {
        runtime.setMessages(trimmed.messages)
        console.log(`[strand] Trimmed ${trimmed.droppedCount} messages from the window of session ${sessionId} (${trimmed.keptTokens} tokens kept, budget ${budget})`)
      }
      const { block, stats } = assembleStrandContextWithStats(this.db, sessionId, userText, trimmed.messages)
      if (block || trimmed.droppedCount > 0) {
        // SPEC 12.2: strand window and retrieval metric, one row per turn
        // that actually used the mechanism.
        logToolCall(this.db, {
          sessionId,
          toolName: 'strand_context',
          input: JSON.stringify({ budgetTokens: budget, keptTokens: trimmed.keptTokens, trimmed: trimmed.droppedCount }),
          output: JSON.stringify(stats),
          durationMs: 0,
          status: 'success',
        })
      }
      return block
    } catch (err) {
      console.error('[strand] Failed to build strand context:', err)
      return null
    }
  }

  /** Strip the per turn block from the stored user message so it never accumulates. */
  private dropStrandContextFromTranscript(runtime: AgentRuntimeBoundary): void {
    if (typeof runtime.getMessages !== 'function' || typeof runtime.setMessages !== 'function') return
    try {
      const cleaned = stripStrandContextFromLastUserMessage(runtime.getMessages())
      if (cleaned) runtime.setMessages(cleaned)
    } catch (err) {
      console.error('[strand] Failed to strip strand context from transcript:', err)
    }
  }

  /**
   * Returns the calling tool turn's session, never a process-wide active chat.
   * Used by create_task to persist deterministic parent session lineage.
   */
  // Used by backend task/tool wiring to associate background work with the active chat session.
  // fallow-ignore-next-line unused-class-member
  getCurrentInteractiveSessionId(): string | null {
    return this.toolTurn.getStore()?.sessionId ?? null
  }

  /**
   * Returns the numeric user id of the user currently being served (set
   * during `processUserMessage`/`processTaskInjection`). Tools that need to
   * attribute side-effects (uploads, notifications, ...) to a concrete user
   * consume this via the same indirection used by AgentRuntime.
   *
   * Returns `undefined` outside an active turn.
   */
  // Used by tool factories that need to attribute side effects to the active user.
  // fallow-ignore-next-line unused-class-member
  getCurrentToolUserId(): number | undefined {
    return this.toolTurn.getStore()?.userId
  }

  /**
   * Run only in the caller's lineage strand. The active SessionManager strand
   * is neither a delivery fallback nor a source of tool parent attribution.
   */
  private async *processTaskInjection(
    targetUserId: string,
    injection: string,
    forcedSessionId?: string,
    injectionId?: string,
    agentId: string = 'main',
  ): AsyncIterable<ResponseChunk> {
    // Fail closed even if an internal caller bypasses injectTaskResult.
    if (!forcedSessionId) throw new Error('Task injection requires an explicit lineage strand')
    const sessionId = forcedSessionId
    const cached = this.sessionManager.getSession(targetUserId, agentId)
    if (cached?.id === sessionId) this.sessionManager.recordMessage(targetUserId, agentId)

    const parsedUserId = Number.parseInt(targetUserId, 10)
    const turn = { sessionId, userId: Number.isFinite(parsedUserId) ? parsedUserId : undefined, agentId }

    // Route task injection to the originating persona's runtime, on the
    // transcript of the session the injection lands in.
    const runtime = this.getOrCreateRuntime(agentId)
    this.useSessionTranscript(agentId, sessionId)

    for await (const chunk of this.bindToolTurn(runtime.streamPrompt(injection, sessionId), turn)) {
      // Tag task-injection chunks with the actual session used AND the
      // per-injection correlation token. Downstream correlation MUST
      // key off `chunk.injectionId` (unique per call) and not
      // `chunk.sessionId` (shared across concurrent injections targeting
      // the same lineage strand).
      yield { ...chunk, sessionId, injectionId }
    }

    // Count the agent response as a message too (only when we're driving
    // the cached session — otherwise recordMessage is a no-op for users
    // without a cached session anyway).
    if (this.sessionManager.getSession(targetUserId, agentId)?.id === sessionId) {
      this.sessionManager.recordMessage(targetUserId, agentId)
    }
  }

  /**
   * Async generators execute on next(), not on construction. Bind each iterator
   * operation so tool calls keep their originating turn across awaits, even
   * if a stalled turn outlives the queue lock. Never use enterWith here: callers
   * consuming the stream must not inherit another turn's attribution.
   */
  private bindToolTurn<T>(
    stream: AsyncIterable<T>,
    turn: { sessionId: string; userId?: number; agentId: string },
  ): AsyncIterable<T> {
    const storage = this.toolTurn
    return {
      [Symbol.asyncIterator]() {
        const iterator = storage.run(turn, () => stream[Symbol.asyncIterator]())
        return {
          next: (...args: [] | [undefined]) => storage.run(turn, () => iterator.next(...args)),
          return: async () => storage.run(turn, () => iterator.return?.() ?? Promise.resolve({ done: true as const, value: undefined })),
          throw: async (error: unknown) => storage.run(turn, () => {
            if (iterator.throw) return iterator.throw(error)
            throw error
          }),
        }
      },
    }
  }

  /**
   * Handle /new command: summarize current session and start fresh.
   */
  // Used by Telegram command handling for /new.
  // fallow-ignore-next-line unused-class-member
  async handleNewCommand(userId: string): Promise<string | null> {
    const summary = await this.sessionManager.handleNewCommand(userId)
    return summary
  }

  /**
   * Generate the session summary as a schema delta (SPEC 11.2).
   *
   * The model receives the previous `SessionSummary` (if any) plus the
   * masked transcript and returns a JSON delta. The server merges, stores
   * the new version in `session_summaries` and returns the markdown
   * rendering (goal, decisions, artifacts, next, `### Open Threads`) that
   * goes to the daily file and the session end event. A delta that does not
   * parse is rejected and the previous version stays untouched.
   */
  private async generateSessionSummary(_userId: string, conversationHistory?: string, sessionId?: string): Promise<string> {
    // Always use DB conversation history (single source of truth).
    // In-memory agent messages can disappear on provider change or restart,
    // but chat_messages in the DB are always reliable.
    if (!conversationHistory) {
      console.warn('[session-summary] No conversation history available, returning Empty session.')
      return EMPTY_SUMMARY_TEXT
    }

    console.log(`[session-summary] Generating summary for ${conversationHistory.length} chars of history`)

    // Resolve model + apiKey: use dedicated summary provider if configured, else current model
    let summaryModel = this.mainRuntime.getCurrentModel()
    let summaryApiKey = this.mainRuntime.getCurrentApiKey()
    try {
      const summarySettings = loadConfig<{ sessionSummaryProviderId?: string }>('settings.json')
      // modelPolicy.roles.summary wins, the legacy field is read through.
      const summaryProviderId = resolveRoleSpec('summary', summarySettings.sessionSummaryProviderId)
      if (summaryProviderId) {
        const { parseProviderModelId, loadProvidersDecrypted, getProviderDefaultModel } = await import('./provider-config.js')
        const { providerId, modelId } = parseProviderModelId(summaryProviderId)
        if (providerId) {
          const file = loadProvidersDecrypted()
          const summaryProvider = file.providers.find(p => p.id === providerId)
          if (summaryProvider) {
            const resolvedModelId = modelId ?? getProviderDefaultModel(summaryProvider)
            summaryModel = buildModel(summaryProvider, resolvedModelId)
            summaryApiKey = await getApiKeyForProvider(summaryProvider)
            console.log(`[session-summary] Using dedicated provider: ${summaryProvider.name} (${resolvedModelId})`)
          } else {
            console.warn(`[session-summary] Configured summary provider '${providerId}' not found, using active provider`)
          }
        }
      }
    } catch {
      // Settings not available, use current model
    }

    const previous = sessionId ? getLatestSessionSummary(this.db, sessionId) : null
    const previousBlock = previous
      ? `<previous_summary version="${previous.version}">\n${JSON.stringify(previous.summary, null, 2)}\n</previous_summary>\n\n`
      : ''

    try {
      // Session summary is a background job — use the background thinking level.
      // HARD timeout: a summary call on a dead connection (e.g. local Ollama
      // restarted mid-request) never settles, and /new AWAITS the summary in
      // the sequential message queue — without this cap the whole chat hangs.
      const response = await withTimeout(completeSimple(summaryModel, {
        systemPrompt: buildSummaryDeltaSystemPrompt(),
        messages: [{
          role: 'user' as const,
          content: `${previousBlock}Read the session transcript and return the JSON delta:\n\n<transcript>\n${conversationHistory}\n</transcript>`,
          timestamp: Date.now(),
        }],
      }, {
        apiKey: summaryApiKey,
        reasoning: resolveBackgroundReasoning(),
      }), 180_000, 'Session summary')

      assertLlmResponseOk(response, '[session-summary] Provider rejected the summary request')

      const textContent = response.content.filter(c => c.type === 'text')

      if (textContent.length === 0) {
        console.warn('[session-summary] API response contained no text content. Full response.content:', JSON.stringify(response.content))
      }

      const raw = textContent
        .map(c => (c as { type: 'text'; text: string }).text)
        .join('')
        .trim()

      const parsed = parseSummaryDelta(raw)
      if (!parsed.ok) {
        // Safeguard: a bad delta never touches the stored version. Recorded
        // as a system tool call so 12.2 can count rejected deltas.
        console.warn(`[session-summary] Rejected delta (${parsed.error}); keeping previous version. Raw: ${raw.slice(0, 200)}`)
        logToolCall(this.db, {
          sessionId: sessionId ?? '',
          toolName: 'session_summary_delta',
          input: JSON.stringify({ previousVersion: previous?.version ?? 0, historyChars: conversationHistory.length }),
          output: JSON.stringify({ rejected: true, error: parsed.error }),
          durationMs: 0,
          status: 'error',
        })
        return previous ? renderSummaryMarkdown(previous.summary) : ''
      }

      if (parsed.delta.empty && !previous) {
        return EMPTY_SUMMARY_TEXT
      }

      const merged = mergeSummaryDelta(previous?.summary ?? null, parsed.delta)
      if (sessionId) {
        try {
          const row = insertSessionSummary(this.db, sessionId, merged, parsed.delta, summaryModel.id)
          logToolCall(this.db, {
            sessionId,
            toolName: 'session_summary_delta',
            input: JSON.stringify({ previousVersion: previous?.version ?? 0, historyChars: conversationHistory.length }),
            output: JSON.stringify({
              version: row.version,
              added: Object.fromEntries(Object.entries(parsed.delta.add ?? {}).map(([k, v]) => [k, v?.length ?? 0])),
              resolved: parsed.delta.resolve?.open?.length ?? 0,
            }),
            durationMs: 0,
            status: 'success',
          })
        } catch (err) {
          console.error('[session-summary] Failed to store summary version:', err)
        }
      }

      if (isEmptySummary(merged)) {
        console.warn('[session-summary] Merged summary is empty, falling back to "Empty session."')
        return EMPTY_SUMMARY_TEXT
      }
      return renderSummaryMarkdown(merged)
    } catch (err) {
      // Return no summary at all: a placeholder string would be written to
      // the daily memory file and shown as the session's summary card,
      // making a broken provider look like an uneventful conversation.
      console.error('Failed to generate session summary:', err)
      return ''
    }
  }

  /**
   * Set the callback for session end events.
   */
  // Used by backend runtime composition to stream session-end events to clients.
  // fallow-ignore-next-line unused-class-member
  setOnSessionEnd(callback: (
    userId: string,
    sessionId: string,
    summary: string | null,
    agentId: string,
    options?: SessionEndCallbackOptions,
  ) => void): void {
    this.onSessionEndCallback = callback
  }

  /**
   * Set a callback for response chunks generated when the agent processes a task injection.
   * This allows streaming the agent's natural-language response to connected clients.
   */
  setOnTaskInjectionChunk(callback: (chunk: ResponseChunk) => void): void {
    this.onTaskInjectionChunkCallback = callback
  }

  /**
   * Abort agent runs. Without a scope every runtime is aborted (historical
   * behaviour, used by blanket cancellations). With `scope.sessionId` only the
   * runtime actually running that session is hit: turns of all users/personas
   * share this process, so an unscoped abort from one strand's watchdog killed
   * the live turn of a different strand (incident 2026-09-15).
   */
  // Used by web/Telegram cancellation handlers.
  // fallow-ignore-next-line unused-class-member
  abort(scope?: AbortScope): void {
    for (const [agentId, runtime] of this.runtimes) {
      if (scope?.agentId !== undefined && agentId !== scope.agentId) continue
      runtime.abort(scope)
    }
  }

  /**
   * Reset a user's session (blocking — awaits summary generation before
   * returning). Prefer `resetSessionAsync` for interactive UIs where
   * users should not wait for the LLM summary call to finish.
   */
  // fallow-ignore-next-line unused-class-member
  async resetSession(userId: string): Promise<string | null> {
    const summary = await this.sessionManager.handleNewCommand(userId)
    return summary
  }

  /**
   * Non-blocking variant: detaches the current session synchronously and
   * returns the freshly minted session. Summary generation runs in the
   * background; when it completes, the configured `onSessionEnd`
   * callback fires with `options.background = true`.
   *
   * Also clears the runtime's in-memory message buffer synchronously so
   * the new session starts clean, without waiting for the (slow)
   * summary LLM call.
   */
  // Used by the websocket chat /new command handler for instant session switch.
  // fallow-ignore-next-line unused-class-member
  resetSessionAsync(userId: string, source: string = 'web', agentId: string = 'main'): SessionInfo {
    // Clear the in-memory agent messages immediately so the new session
    // is not contaminated by the previous session's context. The DB-side
    // summary still uses `buildConversationHistory()` (sourced from the
    // `chat_messages` table), so we don't lose anything by clearing the
    // in-memory copy here.
    const runtime = this.getOrCreateRuntime(agentId)
    runtime.clearMessages()
    this.refreshSystemPrompt(undefined, undefined, agentId)
    // The runtime now holds an empty transcript that belongs to no thread yet;
    // forget the marker so the next turn loads its thread's context instead of
    // parking this blank state under the previous thread's id.
    this.activeTranscriptSessions.delete(agentId)
    return this.sessionManager.handleNewCommandAsync(userId, source, agentId)
  }

  /**
   * End all active sessions and emit session_end events.
   */
  // Used before provider swaps so existing sessions are summarized with the old context.
  // fallow-ignore-next-line unused-class-member
  async endAllSessions(): Promise<void> {
    await this.sessionManager.endAllSessions('provider_change')
  }

  /**
   * Refresh the system prompt from current memory state.
   */
  refreshSystemPrompt(channel?: string, currentUser?: { username: string }, agentId?: string): void {
    if (agentId) {
      // Refresh only the specified persona's runtime.
      this.getOrCreateRuntime(agentId).refreshSystemPrompt(channel, currentUser, agentId)
    } else {
      // Refresh every existing runtime.
      for (const [id, runtime] of this.runtimes) {
        runtime.refreshSystemPrompt(channel, currentUser, id)
      }
    }
  }

  /**
   * Update the thinking/reasoning level used for future agent turns.
   * Accepts any string; invalid values are ignored by the runtime.
   */
  // Used by settings updates to apply reasoning changes without recreating the agent.
  // fallow-ignore-next-line unused-class-member
  setThinkingLevel(level: string): void {
    for (const runtime of this.runtimes.values()) {
      runtime.setThinkingLevel(level)
    }
  }

  /**
   * Refresh skills: rebuild system prompt with current active skills.
   */
  // Used by skill-management routes after install/update/remove operations.
  // fallow-ignore-next-line unused-class-member
  refreshSkills(): void {
    this.refreshSystemPrompt()
  }

  /**
   * Get a stable runtime snapshot for diagnostics/testing.
   */
  getRuntimeStateSnapshot(agentId: string = 'main'): AgentRuntimeStateSnapshot {
    const runtime = this.runtimes.get(agentId)
    if (!runtime) {
      return { modelId: '', toolNames: [], messageCount: 0 }
    }
    return runtime.getStateSnapshot()
  }

  /**
   * Get the underlying pi-mono agent (for advanced usage).
   * @deprecated Prefer boundary methods like sendMessage()/abort()/getRuntimeStateSnapshot().
   */
  // Public escape hatch kept for compatibility with advanced internal integrations.
  // fallow-ignore-next-line unused-class-member
  getAgent(agentId: string = 'main'): PiAgent {
    const runtime = this.getOrCreateRuntime(agentId)
    const runtimeWithAgent = runtime as Partial<AgentRuntimePiAgentAccess>
    if (typeof runtimeWithAgent.getAgent !== 'function') {
      throw new Error('Direct agent access is not available on this runtime implementation.')
    }

    return runtimeWithAgent.getAgent()
  }

  /**
   * Dispose all sessions and clean up.
   */
  async dispose(): Promise<void> {
    await this.sessionManager.dispose()
    // Queues are dropped with the runtimes they protect. In-flight turns keep
    // their own closures (lock + semaphore slot are released by `releaseOnce`),
    // so dropping the map cannot strand a semaphore slot.
    this.messageQueues.clear()
    this.runtimes.clear()
    this.transcripts.clear()
    this.activeTranscriptSessions.clear()
  }
}
