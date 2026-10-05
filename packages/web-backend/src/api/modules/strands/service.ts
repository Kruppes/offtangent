/**
 * Strands, tags, now set and resurface (SPEC 6.2, 6.3). A strand is a thread
 * (interactive session) plus tags, now rank and link count; the session
 * manager already renders those fields, this service adds the writes.
 */
import type { AgentCore, EffectiveModel, ModelSelection, Database, NowSetMode, StrandAttention, StrandAttentionSummary, StrandDeletePreview, StrandDeleteResult, StrandReadState, StrandTaskTree, Tag, Thread, ResurfaceItem } from '@axiom/core'
import {
  EMPTY_STRAND_READ_STATE,
  InvalidInputError,
  firstAwaitingStrandId,
  getStrandAttentions,
  getStrandReadStates,
  listStrandIdsForAttention,
  markStrandRead,
  assignProjectIfUnset,
  buildStrandTaskTree,
  createTag,
  dismissStrandProject,
  dismissStrandTasks,
  listStrandTaskDismissals,
  undismissStrandTasks,
  getStrandProjectSuggestion,
  deleteStrand,
  getNowSet,
  hasLiveTaskForStrand,
  listChildStrandIds,
  getStrandForkLineage,
  listResurfaceItems,
  listTags,
  lastCompactionForStrand,
  lastEcoViewForStrand,
  observedEcoContextLimit,
  isStrandEcoEnabled,
  setStrandEcoEnabled,
  readStrandContextWindow,
  setStrandContextWindow,
  decideNumCtx,
  resolveBaseline,
  peekOllamaShowFacts,
  ECO_CONTEXT_PRESETS,
  OLLAMA_CHAT_API,
  PROVIDER_TYPE_PRESETS,
  resolveEcoBudget,
  lastRequestUsageForStrand,
  lastTranscriptWindowForStrand,
  previewStrandDelete,
  rankStrandsByActivity,
  removeFromNowSet,
  setNowSet,
  setStrandTags,
  snoozeStrand,
  updateTag,
  FORK_SEED_MAX,
  ForkStrandError,
  forkStrand,
  listRecalledMessages,
  toIsoUtc,
} from '@axiom/core'
import type { EcoViewMetric, RecalledMessage, StrandFork } from '@axiom/core'
import type { ChatEventBus } from '../../../chat-event-bus.js'
import { resolveNowSetMax, resolveNowSetMode } from '../../../now-set-limit.js'
import { describePendingTurn } from '../../../turn-queue.js'
import { searchStrands } from './search.js'
import type { DeleteStrandQuery, ListStrandsQuery, PatchStrandBody, PatchStrandModelBody, PatchStrandEcoBody, StrandActivityIdsBody, StrandTasksQuery } from './schema.js'
import { effectiveModelForStrand, getProvider, modelMetadataFor } from '../../../model-selection.js'

/**
 * `GET /api/strands/:id/context` (plan 2026-09-24, strand status bar).
 *
 * Everything here describes ONE strand and the LAST request it really sent to
 * a provider. No accumulated billing totals, no visible history length. Any
 * number that cannot be derived honestly is `null`, never 0 — the client
 * renders a dash for it.
 */
export interface StrandContextMeasurement {
  /** `measured` = a provider counted it; `unknown` = the strand never ran. */
  state: 'measured' | 'unknown'
  requestTokens: number | null
  inputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
  measuredAt: string | null
  measuredModelId: string | null
  measuredProviderId: string | null
  /**
   * True when the measurement was taken on a different model than the one the
   * next turn will use — the percentage then refers to a foreign window and
   * the client must mark it as outdated instead of silently rescaling it.
   */
  stale: boolean
  /**
   * False when the counts come from the provider, true for a locally
   * estimated row. Only `kind = 'request'` rows are selected today, and those
   * are always provider counted, so this is false in practice — it stays a
   * boolean so the field can never lie if another source is ever admitted.
   */
  estimated: boolean
}

export interface StrandContextBudget {
  /**
   * Context window of the CURRENT model, null when the catalog has none. This
   * is the ONE denominator of the percentage in the status bar: measured
   * request tokens / context window.
   */
  contextWindow: number | null
  /**
   * The catalog's max output tokens of the current model. This is a CAP on the
   * answer, not a reservation the runtime subtracts from the input budget —
   * nothing in the runtime deducts it (`maxTokens` is catalog metadata only).
   * It is reported as a cap and must never be turned into a "usable budget".
   */
  outputCapTokens: number | null
  /** Where the cap comes from, so the client can label it honestly. */
  outputCapSource: 'model_catalog' | null
}

/**
 * The transcript side of the context, and the ONLY basis on which a trim
 * warning may be raised.
 *
 * `AgentCore.prepareStrandContext` applies `heuristics.strand.windowTokens` to
 * `trimMessagesToBudget(runtime.getMessages())` — the transcript window alone,
 * estimated locally. The measured request total is a different quantity (it
 * also carries system prompt, memory, tool definitions and attachments, all
 * counted by the provider), so comparing it against this budget would light up
 * permanently on every strand with a large system prompt.
 *
 * `state: 'unknown'` means this strand never wrote a `strand_context` metric
 * row; the client then shows no trim warning instead of guessing one.
 */
export interface StrandTranscriptStatus {
  state: 'measured' | 'unknown'
  estimatedTokens: number | null
  budgetTokens: number | null
  at: string | null
  /**
   * Messages the last measured turn dropped. `estimatedTokens` is logged after
   * the trim, so a strand that was trimmed once sits just below the budget
   * forever; a threshold warning on top of that would never switch off again.
   * `> 0` means "already trimmed" (state a fact), `0` with a high ratio means
   * "trim is imminent" (the only case that warrants a warning).
   */
  trimmedMessages: number | null
  /** Local heuristic estimate, never a provider count. */
  estimated: true
}

export interface StrandContextReport {
  strandId: string
  measurement: StrandContextMeasurement
  budget: StrandContextBudget
  transcript: StrandTranscriptStatus
  lastCompaction: { at: string; droppedMessages: number; keptTokens: number | null; budgetTokens: number | null } | null
  model: (EffectiveModel & { displayName: string | null; providerName: string | null }) | null
  /**
   * W5b, additive: the older messages the agent actually pulled back into
   * this strand's prompt (recall_message calls and the strand-context
   * retrieval), newest first, excerpt only.
   */
  recalled: RecalledMessage[]
  /**
   * Eco mode (plan 2026-10-05-real-eco), additive. `inputBudgetTokens` is a
   * display estimate (declared window minus reserve and margin), never applied
   * to requests. `last` aggregates the tool results frozen smaller at creation
   * (chars/3 estimates of stored original vs stored projection); refusal
   * fields stay false/null because real Eco never refuses a request.
   */
  eco: StrandEcoStatus
  generatedAt: string
}

export interface StrandEcoStatus {
  enabled: boolean
  /** Runner limit observed in an overflow (lowers the budget below the declared window), null when none. */
  observedContextLimitTokens: number | null
  inputBudgetTokens: number | null
  outputReserveTokens: number | null
  /** True when the model declares no context window and a conservative fallback is used. */
  contextFallback: boolean
  last: EcoViewMetric | null
  /**
   * Per-strand context-window choice, re-evaluated against the CURRENT model
   * on every read (a model switch keeps the choice but never silently carries
   * it over). `state` says what a request would actually do.
   */
  contextWindow: StrandContextWindowStatus
}

export interface StrandContextWindowStatus {
  /** null = "Unverändert" (no num_ctx override). */
  choice: number | null
  presets: number[]
  /** Only the native Ollama /api/chat provider can carry num_ctx; the /v1 adapter cannot. */
  supported: boolean
  state: 'unchanged' | 'applied' | 'baseline_kept' | 'provider_unsupported' | 'baseline_unknown' | 'supported_unknown' | 'exceeds_supported' | 'invalid_choice' | 'no_model'
  /** num_ctx a request would send right now (null = none; the model keeps its own window). */
  effective?: number | null
  /** Native only: whether the /api/show facts behind `state` are cached ('known'), being fetched or failed. */
  facts?: 'known' | 'pending' | 'failed'
  /** Native only: the window a request keeps without override (null = unknown → a choice cannot take effect). */
  baseline?: number | null
  /** Native only: where `baseline` comes from (per-model setting, provider setting or modelfile). */
  baselineSource?: 'model_setting' | 'provider_setting' | 'modelfile' | null
}

/** One fact of the slim `GET /api/strands/:id/facts` list (W5b). */
export interface StrandFactItem {
  id: number
  text: string
  createdAt: string
  status: 'active' | 'superseded'
}

export interface StrandFactsList {
  strandId: string
  facts: StrandFactItem[]
  total: number
  truncated: boolean
  /** Session summaries of the strand (same count the delete preview shows). */
  summaries: number
  /** Tool calls logged under the strand (same count the delete preview shows). */
  toolCalls: number
}

/** Body of `POST /api/strands/:id/fork` after validation (W5b). */
export interface ForkAtMessageBody {
  messageId: number
  title?: string
}

/** What a web fork answers besides the new strand. */
export interface ForkAtMessageResult {
  strandId: string
  title: string
  parentStrandId: string
  parentTitle: string | null
  forkedAt: string
  forkedFromMessageId: number
  seedMessageId: number | null
  noticeMessageId: number
  depth: number
}

/** Upper bound of the slim facts list; the panel shows a handful anyway. */
export const STRAND_FACTS_MAX = 200
/** Characters of the forked message copied into the seed. */
const FORK_MESSAGE_CHARS = 4000
const FORK_DEFAULT_TITLE_CHARS = 60

export class StrandServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'StrandServiceError'
  }
}

/**
 * Minimal turn runner view: the strands service only asks whether a turn is
 * live in one session, it never starts one.
 */
export interface StrandTurnGuard {
  getTurnModelOverride?: (user: number | string, sessionId: string) => ModelSelection | null
  /**
   * The model a live turn of this strand was bound to at its start, or null
   * when no turn runs. Feeds `runningTurnModel` (incident 2026-09-24: the
   * header showed the globally effective model while an older model was still
   * answering).
   */
  getRunningTurnModel?: (user: number | string, sessionId: string) =>
  (ModelSelection & { source?: string; degradedReason?: string }) | null
  hasActiveTurnInSession?: (user: number | string, sessionId: string) => boolean
}

/**
 * What the strand endpoints actually return: the thread plus its server side
 * read state (`lastActivityAt`, `unread`). The read state is NOT built in
 * `SessionManager.toThread` — that runs per row, and the list endpoint would
 * turn into an N+1 over `chat_messages`. It is joined in one query here
 * instead (see `getStrandReadStates`).
 */
/**
 * What the list and detail reads add on top of a `Thread`: the read state
 * (`lastActivityAt` / `unread`) and the "awaiting you" state (`attention`).
 * Additive, exactly like the read state before it — `Thread` itself stays
 * untouched so every other consumer of the type is unaffected.
 */
export type StrandWithReadState = Thread & StrandReadState & {
  attention: StrandAttention | null
  /** `?q=` only: plain-text excerpt of the best matching message. */
  matchSnippet?: string
}

export interface StrandsServiceOptions {
  db: Database
  getAgentCore: () => AgentCore | null
  chatEventBus?: ChatEventBus | null
  getTurnRunner?: () => StrandTurnGuard | null
  /** Effective now-set size, read per request so a settings save applies at once. */
  getNowSetMax?: () => number
  /**
   * How the now set is filled (`offtangent.nowSetMode`), read per request for
   * the same reason. `auto` computes the set from the user's activity and
   * refuses writes, `manual` is the curated `now_set` table.
   */
  getNowSetMode?: () => NowSetMode
  getQuotaSnapshot?: () => unknown
}

export function createStrandsService(options: StrandsServiceOptions) {
  const { db } = options
  const nowSetMaxOf = options.getNowSetMax ?? (() => resolveNowSetMax())
  const nowSetModeOf = options.getNowSetMode ?? (() => resolveNowSetMode())

  function manager() {
    const core = options.getAgentCore()
    if (!core) throw new StrandServiceError(503, 'agent_unavailable', 'Agent core not available')
    return core.getSessionManager()
  }

  function requireStrand(userId: number, strandId: string): Thread {
    const strand = manager().getThread(String(userId), strandId)
    if (!strand) throw new StrandServiceError(404, 'strand_not_found', 'Strand not found')
    return strand
  }

  /**
   * Ownership of a strand id, told apart from a plain miss. Every other read
   * answers 404 for a foreign strand (no existence oracle), but SPEC 6.2 asks
   * DELETE for an explicit 403, so the delete path needs the distinction.
   */
  function ownershipOf(userId: number, strandId: string): 'unknown' | 'foreign' | 'own' {
    const row = db.prepare('SELECT type, user_id, session_user FROM sessions WHERE id = ?')
      .get(strandId) as { type: string; user_id: number | null; session_user: string | null } | undefined
    if (!row || row.type !== 'interactive') return 'unknown'
    const owned = row.session_user === String(userId) || (row.user_id != null && String(row.user_id) === String(userId))
    return owned ? 'own' : 'foreign'
  }

  /**
   * SPEC 7.5b runtime hazard: a strand that is being written to right now, or
   * that carries a delegated task, must not be archived or deleted — the next
   * turn would write the rows back.
   */
  function assertNotBusy(userId: number, strandId: string): void {
    const runner = options.getTurnRunner?.()
    if (runner?.hasActiveTurnInSession?.(userId, strandId)) {
      throw new StrandServiceError(409, 'strand_busy', 'A turn is running in this strand')
    }
    if (hasLiveTaskForStrand(db, strandId)) {
      throw new StrandServiceError(409, 'strand_busy', 'A delegated task is running in this strand')
    }
  }

  /**
   * Ids the clients should see right now: the computed ranking in auto mode,
   * the stored set in manual mode.
   */
  function currentNowSetIds(userId: number): string[] {
    return nowSetModeOf() === 'auto'
      ? rankStrandsByActivity(db, String(userId), { max: nowSetMax() })
      : getNowSet(db, String(userId))
  }

  function broadcastNowSet(userId: number): void {
    options.chatEventBus?.broadcast({
      type: 'now_set_changed',
      userId,
      source: 'web',
      strandIds: currentNowSetIds(userId),
    })
  }

  /**
   * Archive / un-archive, pin and rename (SPEC 6.2, 7.5b). Archiving clears
   * the now-set slot and the pin, un-archiving (the undo of the swipe) is
   * always allowed and never blocked by a running turn.
   */
  function patchStrand(userId: number, strandId: string, patch: PatchStrandBody): Thread {
    const existing = requireStrand(userId, strandId)
    if (patch.archived === true && !existing.archived) assertNotBusy(userId, strandId)

    const updated = manager().updateThread(String(userId), strandId, {
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.archived === true ? { pinned: false } : patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    })
    if (!updated) throw new StrandServiceError(404, 'strand_not_found', 'Strand not found')

    // Manual: the slot is freed and the broadcast carries the stored set.
    // Auto: the archived strand simply drops out of the ranking, so the
    // broadcast is driven by the computed list instead of the table write
    // (which may still run harmlessly on a set left over from manual mode).
    if (patch.archived === true) {
      const removed = removeFromNowSet(db, String(userId), strandId)
      if (removed || nowSetModeOf() === 'auto') broadcastNowSet(userId)
    }
    return requireStrand(userId, strandId)
  }

  /**
   * Attach `lastActivityAt` / `unread` / `attention` to a list of strands in a
   * bounded number of queries (read state: one per 400 ids, attention: three
   * per 400 ids). Never one query per strand.
   */
  function withReadState(userId: number, strands: Thread[]): StrandWithReadState[] {
    const ids = strands.map(strand => strand.id)
    const states = getStrandReadStates(db, ids)
    const attentions = getStrandAttentions(db, ids, { userId })
    return strands.map(strand => ({
      ...strand,
      ...(states.get(strand.id) ?? EMPTY_STRAND_READ_STATE),
      attention: attentions.get(strand.id) ?? null,
    }))
  }

  /**
   * Title of a lineage parent, read without an ownership check on purpose: the
   * caller already owns the CHILD, and a fork never crosses users (see
   * strand-fork.ts), so this cannot leak a foreign title.
   */
  function parentTitleOf(parentStrandId: string): string | null {
    const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get(parentStrandId) as
      { title: string | null } | undefined
    return row?.title ?? null
  }

  function countConversationMessages(strandId: string): number {
    return (db.prepare(
      `SELECT COUNT(*) AS count FROM chat_messages
       WHERE session_id = ? AND role IN ('user', 'assistant') AND TRIM(content) <> ''`,
    ).get(strandId) as { count: number }).count
  }

  function getStrand(userId: number, strandId: string) {
    const strand = withReadState(userId, [requireStrand(userId, strandId)])[0]
    const row = db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(strandId) as {
      model_provider_id: string | null
      model_id: string | null
    }
    return {
      ...strand,
      /**
       * Messages a reader sees in the transcript: user and assistant rows with
       * text, counted from chat_messages. `messageCount` is the session
       * counter (bumped per turn of the cached slot only, read by the memory
       * jobs and resurface) and keeps its meaning; on long-lived strands it
       * drifts far from what the transcript shows.
       */
      conversationMessageCount: countConversationMessages(strandId),
      pinnedModel: row.model_provider_id && row.model_id
        ? { providerId: row.model_provider_id, modelId: row.model_id }
        : null,
      effectiveModel: effectiveModelForStrand(db, strandId, options.getTurnRunner?.()?.getTurnModelOverride?.(userId, strandId)),
      /**
       * The model that is answering RIGHT NOW, frozen when the running turn
       * started, or null when the strand is idle. `effectiveModel` answers
       * "what will the next turn use" and changes the moment the global
       * selection changes; it must not be presented as the source of an answer
       * that is still streaming from another model (incident 2026-09-24).
       */
      runningTurnModel: runningTurnModelOf(userId, strandId),
      /**
       * A turn of this strand that is enqueued but has not started yet (plan
       * 2026-09-19, D5), else null. A client that missed the live
       * `turn_queued` event (reload, second device) reads the same wait state
       * here instead of showing an idle strand that is in fact waiting.
       */
      pendingTurn: describePendingTurn(db, options.getAgentCore(), userId, strand.agentId, strandId),
      /**
       * Lineage of a forked strand (`fork_strand`). `parentStrandId` and
       * `forkedAt` are already on the thread (and therefore in the list too);
       * the detail adds the parent's title so a back-link chip needs no second
       * request, and the direct children so the branch is navigable downwards.
       * A parent that was deleted resolves to a null title — the lineage id
       * stays, the fork still happened.
       */
      parentStrandTitle: strand.parentStrandId ? parentTitleOf(strand.parentStrandId) : null,
      childStrandIds: listChildStrandIds(db, strandId),
      /**
       * W5b, additive: the parent message this strand was forked at (null for
       * a root strand), so "forked from" can jump to the exact message.
       */
      forkedFromMessageId: strand.parentStrandId ? getStrandForkLineage(db, strandId).forkedFromMessageId : null,
      /**
       * W5b, additive: the direct children with their titles, oldest first
       * (same order as `childStrandIds`), so the parent can show
       * "Branch: <title>" links without one request per child. Same owner by
       * construction (a fork never crosses users).
       */
      childStrands: childStrandsOf(strandId),
    }
  }

  function childStrandsOf(strandId: string): Array<{ id: string; title: string | null; forkedAt: string | null; forkedFromMessageId: number | null }> {
    const ids = listChildStrandIds(db, strandId)
    if (ids.length === 0) return []
    const read = db.prepare('SELECT title, forked_at, forked_from_message_id FROM sessions WHERE id = ?')
    return ids.map((id) => {
      const row = read.get(id) as { title: string | null; forked_at: string | null; forked_from_message_id: number | null } | undefined
      return {
        id,
        title: row?.title ?? null,
        forkedAt: row?.forked_at ? toIsoUtc(row.forked_at) : null,
        forkedFromMessageId: row?.forked_from_message_id ?? null,
      }
    })
  }

  /**
   * Normalize the runner's frozen turn model into the same shape the clients
   * already parse for `effectiveModel`. `source` defaults to `turn` because a
   * running turn IS the strongest binding, whatever made it effective.
   */
  function runningTurnModelOf(userId: number, strandId: string): EffectiveModel | null {
    const running = options.getTurnRunner?.()?.getRunningTurnModel?.(userId, strandId)
    if (!running) return null
    return {
      providerId: running.providerId,
      modelId: running.modelId,
      source: (running.source as EffectiveModel['source'] | undefined) ?? 'turn',
      ...(running.degradedReason ? { degradedReason: running.degradedReason } : {}),
    }
  }

  function ecoStatusOf(strandId: string, model: { providerId?: string; modelId: string; contextWindow: number | null; maxTokens: number | null } | null): StrandEcoStatus {
    // Same inputs as the request budget (B1): a runner limit observed in an
    // overflow lowers the shown budget exactly like it lowers the request.
    // MAJOR-1: only evidence of the strand's CURRENT model counts.
    const observed = (model ? observedEcoContextLimit(strandId, { id: model.modelId }) : undefined) ?? null
    const budget = model ? resolveEcoBudget({ contextWindow: model.contextWindow, maxTokens: model.maxTokens, observedContextLimit: observed }) : null
    return {
      enabled: isStrandEcoEnabled(db, strandId),
      observedContextLimitTokens: observed,
      inputBudgetTokens: budget?.inputBudget ?? null,
      outputReserveTokens: budget?.outputReserve ?? null,
      contextFallback: budget?.contextFallback ?? false,
      last: lastEcoViewForStrand(db, strandId),
      contextWindow: contextWindowStatusOf(strandId, model?.providerId ?? null, model?.modelId ?? null),
    }
  }

  /**
   * Re-evaluated on every read. Baseline facts (/api/show) are not fetched
   * here yet, so a native provider reports baseline_unknown for a choice and
   * nothing is overridden (no guessed floor). Pure read: never mutates
   * server config, other strands or global state.
   */
  function contextWindowStatusOf(strandId: string, providerId: string | null, modelId: string | null, candidate?: number | null): StrandContextWindowStatus {
    const choice = candidate !== undefined ? candidate : readStrandContextWindow(db, strandId)
    const presets = [...ECO_CONTEXT_PRESETS]
    if (!providerId) return { choice, presets, supported: false, state: 'no_model' }
    const provider = getProvider(providerId)
    const providerType = provider?.providerType
    const apiType = providerType ? PROVIDER_TYPE_PRESETS[providerType]?.apiType : undefined
    const nativeProvider = apiType === OLLAMA_CHAT_API
    // Same facts the request path uses (cached read-only /api/show for the
    // strand's CURRENT model, re-read per status call). Not yet cached → the
    // baseline is honestly unknown; nothing is guessed.
    const peek = nativeProvider && modelId ? peekOllamaShowFacts(provider?.baseUrl, modelId) : { known: false, facts: {}, failed: false }
    // Same baseline precedence as the request path: per-model setting >
    // provider setting > modelfile (resolveBaseline).
    const modelNumCtx = nativeProvider && modelId ? provider?.models?.find(m => m.id === modelId)?.ollamaNumCtx : undefined
    const facts = {
      ...peek.facts,
      ...(provider?.ollamaNumCtx !== undefined ? { providerNumCtx: provider.ollamaNumCtx } : {}),
      ...(modelNumCtx !== undefined ? { modelNumCtx } : {}),
    }
    const decision = decideNumCtx({ nativeProvider, choice, facts })
    const baseline = nativeProvider ? resolveBaseline(facts) : { known: false as const }
    return {
      choice,
      presets,
      supported: nativeProvider,
      state: decision.state,
      effective: decision.numCtx ?? null,
      ...(nativeProvider ? { baseline: baseline.known ? baseline.value : null, baselineSource: baseline.known ? baseline.source : null } : {}),
      ...(nativeProvider ? { facts: peek.known ? 'known' as const : peek.failed ? 'failed' as const : 'pending' as const } : {}),
    }
  }

  /**
   * Eco switch of one strand. Owner-checked like every strand write (404 for
   * a foreign or missing strand). Takes effect on the next LLM request, also
   * inside a running tool loop, so it is deliberately not blocked by a busy
   * strand. Switching it off is the complete rollback.
   */
  function patchStrandEco(userId: number, strandId: string, patch: PatchStrandEcoBody): { strandId: string; eco: StrandEcoStatus } {
    requireStrand(userId, strandId)
    // Server-side range check BEFORE any write (the body parser already limits
    // the value to the presets + hard cap): a choice above the KNOWN supported
    // maximum of the strand's current native model is refused, nothing stored.
    if (typeof patch.contextWindow === 'number') {
      const current = effectiveModelForStrand(db, strandId)
      const status = contextWindowStatusOf(strandId, current?.providerId ?? null, current?.modelId ?? null, patch.contextWindow)
      if (status.state === 'exceeds_supported') {
        throw new StrandServiceError(400, 'context_window_exceeds_supported', 'Context window exceeds what the current model supports')
      }
    }
    // Owner-checked above; each write touches only this strand's row.
    if (patch.enabled !== undefined && !setStrandEcoEnabled(db, strandId, patch.enabled)) {
      throw new StrandServiceError(404, 'strand_not_found', 'Strand not found')
    }
    if (patch.contextWindow !== undefined && !setStrandContextWindow(db, strandId, patch.contextWindow)) {
      throw new StrandServiceError(404, 'strand_not_found', 'Strand not found')
    }
    const effective = effectiveModelForStrand(db, strandId)
    const meta = effective ? modelMetadataFor(effective.providerId, effective.modelId) : null
    return {
      strandId,
      eco: ecoStatusOf(strandId, effective && meta ? { providerId: effective.providerId, modelId: effective.modelId, contextWindow: meta.contextWindow ?? null, maxTokens: meta.maxTokens ?? null } : null),
    }
  }

  function patchStrandModel(userId: number, strandId: string, patch: PatchStrandModelBody) {
    const strand = requireStrand(userId, strandId)
    assertNotBusy(userId, strandId)
    const before = effectiveModelForStrand(db, strandId)
    if (patch.providerId !== null && patch.modelId !== null) {
      const provider = getProvider(patch.providerId)
      if (!provider || !(provider.enabledModels ?? []).includes(patch.modelId)
        || provider.modelStatuses?.[patch.modelId] === 'error') {
        throw new StrandServiceError(400, 'model_unavailable', 'Provider/model does not exist, is disabled, or is unavailable')
      }
    }
    db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?')
      .run(patch.providerId, patch.modelId, strandId)
    const effective = effectiveModelForStrand(db, strandId)
    const from = before?.modelId ?? 'kein Modell'
    const to = effective?.modelId ?? 'kein Modell'
    db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id)
       VALUES (?, ?, 'system', ?, ?, ?)`,
    ).run(
      strandId,
      userId,
      `Modell: ${from} → ${to}`,
      JSON.stringify({ type: 'model_change', automatic: false }),
      strand.agentId,
    )
    return {
      pinnedModel: patch.providerId && patch.modelId ? { providerId: patch.providerId, modelId: patch.modelId } : null,
      effectiveModel: effective,
    }
  }

  function deletePreview(userId: number, strandId: string): StrandDeletePreview {
    requireStrand(userId, strandId)
    return previewStrandDelete(db, String(userId), strandId)
  }

  /**
   * Hard delete (SPEC 7.5b). Order matters: ownership, confirmation and the
   * busy guards first, then the in-memory transcript is evicted, and only
   * then the rows are dropped in one transaction. Evicting before the commit
   * means a turn that somehow starts in between rebuilds its context from the
   * database instead of re-persisting a stale one.
   */
  function removeStrand(userId: number, strandId: string, query: DeleteStrandQuery): StrandDeleteResult {
    const ownership = ownershipOf(userId, strandId)
    if (ownership === 'unknown') throw new StrandServiceError(404, 'strand_not_found', 'Strand not found')
    if (ownership === 'foreign') throw new StrandServiceError(403, 'forbidden', 'Strand belongs to another user')
    if (!query.confirm) {
      throw new StrandServiceError(400, 'confirm_required', 'Deleting a strand requires confirm=1')
    }
    const strand = requireStrand(userId, strandId)
    assertNotBusy(userId, strandId)

    const core = options.getAgentCore()
    core?.evictSessionTranscript?.(String(userId), strand.agentId, strandId)

    const wasInNowSet = currentNowSetIds(userId).includes(strandId)
    const result = deleteStrand(db, String(userId), strandId, { deleteFacts: query.deleteFacts })
    if (wasInNowSet) broadcastNowSet(userId)
    return result
  }

  /**
   * `GET /api/strands`, with the two server side filter chips (plan
   * 2026-09-26).
   *
   * A filter is resolved to an ID SET first and handed to `listThreads` as
   * `ids`, so ordering, the other filters (tag, persona, project, now) and
   * LIMIT/OFFSET keep working exactly as before — filtering the page after the
   * fact would return short pages and a wrong offset. The candidate set is
   * bounded by the user's own strand count, and both filters combine as AND.
   */
  function listStrands(userId: number, query: ListStrandsQuery): StrandWithReadState[] {
    const { q, ...listQuery } = query
    if (!q && !query.attentionOnly && !query.unreadOnly) {
      return withReadState(userId, manager().listThreads(String(userId), listQuery))
    }

    // `?q=` resolves to an id set as well (title + message content), so it
    // combines with the chips and every other filter as AND.
    const hits = q ? searchStrands(db, userId, q, { includeArchived: query.includeArchived }) : null
    let ids = hits ? hits.ids : listStrandIdsForAttention(db, userId, { includeArchived: query.includeArchived })
    if (query.attentionOnly) {
      const attentions = getStrandAttentions(db, ids, { userId })
      ids = ids.filter(id => attentions.has(id))
    }
    if (query.unreadOnly) {
      const states = getStrandReadStates(db, ids)
      ids = ids.filter(id => states.get(id)?.unread)
    }
    if (ids.length === 0) return []
    const strands = withReadState(userId, manager().listThreads(String(userId), { ...listQuery, ids }))
    if (!hits) return strands
    return strands.map(strand => {
      const snippet = hits.snippets.get(strand.id)
      return snippet ? { ...strand, matchSnippet: snippet } : strand
    })
  }

  /**
   * `GET /api/strands/attention-summary`: the two counts a client shows before
   * it has any list, over ALL non-archived strands of the user — deliberately
   * independent of the 100-per-page cap of the list endpoint, which is exactly
   * why this endpoint exists.
   */
  function attentionSummary(userId: number): StrandAttentionSummary {
    const ids = listStrandIdsForAttention(db, userId)
    const attentions = getStrandAttentions(db, ids, { userId })
    const states = getStrandReadStates(db, ids)
    let unread = 0
    for (const id of ids) {
      if (states.get(id)?.unread) unread += 1
    }
    return {
      awaiting: attentions.size,
      unread,
      firstAwaitingStrandId: firstAwaitingStrandId(attentions),
    }
  }

  /**
   * Mark a strand as read (`POST /api/strands/:id/read`, 204). Idempotent:
   * the marker is moved to `now` every time, a second call just writes the
   * same state again. A foreign or unknown strand answers 404 via
   * `requireStrand` — same rule as every other strand read.
   */
  function markRead(userId: number, strandId: string): void {
    requireStrand(userId, strandId)
    markStrandRead(db, strandId)
  }

  /**
   * Everything that works for this strand right now: the tasks it delegated
   * and, recursively, their sub-tasks (SPEC 10.x, strand activity).
   *
   * Ownership is checked first (`requireStrand` — 404 for a foreign strand,
   * no existence oracle). This is also the catch-up read after a reconnect:
   * a client that missed a `task_started` frame still sees the full tree.
   */
  function strandTasks(userId: number, strandId: string, query: StrandTasksQuery): StrandTaskTree & { tasks: Array<StrandTaskTree['tasks'][number] & { dismissedAt: string | null }> } {
    requireStrand(userId, strandId)
    const tree = buildStrandTaskTree(db, strandId, { include: query.include })
    // W6c: additive field. A client that does not know it (the app before
    // its update) keeps showing everything, exactly as before.
    const dismissed = listStrandTaskDismissals(db, strandId)
    return { ...tree, tasks: tree.tasks.map(task => ({ ...task, dismissedAt: dismissed.get(task.id) ?? null })) }
  }

  /**
   * Acknowledge finished entries of the strand activity list (W6c). Only ids
   * that are part of THIS strand's tree are accepted (no writing marks for a
   * foreign task); live entries (running / paused) cannot be dismissed, they
   * always stay visible. Idempotent: a dismissed id keeps its first time.
   */
  function dismissStrandActivity(userId: number, strandId: string, body: StrandActivityIdsBody): { dismissed: string[]; dismissedAt: string } {
    requireStrand(userId, strandId)
    const tree = buildStrandTaskTree(db, strandId, { include: 'all' })
    const byId = new Map(tree.tasks.map(task => [task.id, task]))
    const unknown = body.ids.filter(id => !byId.has(id))
    if (unknown.length > 0) throw new StrandServiceError(404, 'task_not_found', 'Task is not part of this strand')
    const live = body.ids.filter(id => byId.get(id)!.status === 'running' || byId.get(id)!.status === 'paused')
    if (live.length > 0) throw new StrandServiceError(409, 'task_live', 'A running or paused task cannot be dismissed')
    const at = new Date().toISOString()
    dismissStrandTasks(db, strandId, body.ids, at)
    return { dismissed: body.ids, dismissedAt: at }
  }

  /** Bring dismissed entries back (undo / "show hidden" restore). */
  function undismissStrandActivity(userId: number, strandId: string, body: StrandActivityIdsBody): { restored: string[] } {
    requireStrand(userId, strandId)
    undismissStrandTasks(db, strandId, body.ids)
    return { restored: body.ids }
  }

  /**
   * Context telemetry of one strand (status bar). Ownership first, exactly
   * like `strandTasks` — a foreign or unknown strand gets 404, never a
   * measurement. There is one runtime per strand since the isolation merge,
   * and the reads below are keyed by `session_id` anyway, so no other
   * strand's numbers can appear here.
   */
  /**
   * `token_usage.provider` is the pi-ai provider SLUG of the request
   * (`assistantMsg.provider` -> 'ollama', 'anthropic', 'gemini'), while an
   * effective model carries the CONFIGURED provider id, which is a uuid for
   * every provider created through the UI. Comparing the two directly marked
   * every single measurement as stale (observed on the emulator: a request
   * booked as 'ollama' against provider id '4ac0eadd-…' rendered as "other
   * model"). So the measured slug is compared against the slug of the
   * effective provider, and the configured id is still accepted for old rows
   * and for providers whose id is their slug.
   *
   * Limitation, deliberately not invented around: two configured providers can
   * share one slug (two 'openai-compatible' endpoints). A switch between them
   * is then invisible here. An unknown provider (deleted from the config)
   * yields no slug at all — in that case the provider dimension is dropped and
   * only the model id decides, instead of claiming a change nobody can verify.
   */
  function providerChanged(measuredProvider: string, effectiveProviderId: string): boolean {
    if (measuredProvider === effectiveProviderId) return false
    const slug = getProvider(effectiveProviderId)?.provider ?? null
    if (slug === null) return false
    return measuredProvider !== slug
  }

  function strandContext(userId: number, strandId: string): StrandContextReport {
    requireStrand(userId, strandId)
    const effective = effectiveModelForStrand(db, strandId, options.getTurnRunner?.()?.getTurnModelOverride?.(userId, strandId))
    const usage = lastRequestUsageForStrand(db, strandId)
    const meta = effective ? modelMetadataFor(effective.providerId, effective.modelId) : null
    const contextWindow = meta?.contextWindow ?? null
    const outputCap = meta?.maxTokens ?? null
    const transcriptWindow = lastTranscriptWindowForStrand(db, strandId)
    const measurement: StrandContextMeasurement = usage
      ? {
          state: 'measured',
          requestTokens: usage.requestTokens,
          inputTokens: usage.inputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
          measuredAt: usage.measuredAt,
          measuredModelId: usage.measuredModelId,
          measuredProviderId: usage.measuredProviderId,
          stale: effective !== null
            && (usage.measuredModelId !== effective.modelId
              || providerChanged(usage.measuredProviderId, effective.providerId)),
          estimated: false,
        }
      : {
          state: 'unknown',
          requestTokens: null,
          inputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          outputTokens: null,
          measuredAt: null,
          measuredModelId: null,
          measuredProviderId: null,
          stale: false,
          estimated: false,
        }
    return {
      strandId,
      measurement,
      budget: {
        contextWindow,
        outputCapTokens: outputCap,
        outputCapSource: outputCap === null ? null : 'model_catalog',
      },
      transcript: transcriptWindow
        ? {
            state: 'measured',
            estimatedTokens: transcriptWindow.estimatedTokens,
            budgetTokens: transcriptWindow.budgetTokens,
            at: transcriptWindow.at,
            trimmedMessages: transcriptWindow.trimmedMessages,
            estimated: true,
          }
        : {
            state: 'unknown',
            estimatedTokens: null,
            budgetTokens: null,
            at: null,
            trimmedMessages: null,
            estimated: true,
          },
      lastCompaction: lastCompactionForStrand(db, strandId),
      model: effective
        ? { ...effective, displayName: meta?.displayName ?? null, providerName: meta?.providerName ?? null }
        : null,
      recalled: listRecalledMessages(db, userId, strandId),
      eco: ecoStatusOf(strandId, effective ? { providerId: effective.providerId, modelId: effective.modelId, contextWindow, maxTokens: outputCap } : null),
      generatedAt: new Date().toISOString(),
    }
  }

  /**
   * Slim fact list for the context panel (W5b): the facts that carry this
   * strand as their source, owner scoped exactly like the delete preview,
   * without counting the whole cascade on every panel open.
   */
  function strandFacts(userId: number, strandId: string): StrandFactsList {
    requireStrand(userId, strandId)
    const user = String(userId)
    const total = (db.prepare(
      'SELECT COUNT(*) AS c FROM memories WHERE session_id = ? AND CAST(user_id AS TEXT) = ?',
    ).get(strandId, user) as { c: number }).c
    const rows = db.prepare(
      `SELECT id, content, timestamp, status FROM memories
        WHERE session_id = ? AND CAST(user_id AS TEXT) = ?
        ORDER BY id ASC LIMIT ?`,
    ).all(strandId, user, STRAND_FACTS_MAX) as Array<{ id: number; content: string; timestamp: string; status: string | null }>
    return {
      strandId,
      facts: rows.map(row => ({
        id: row.id,
        text: row.content,
        createdAt: toIsoUtc(row.timestamp),
        status: row.status === 'superseded' ? 'superseded' : 'active',
      })),
      total,
      truncated: total > rows.length,
      summaries: (db.prepare('SELECT COUNT(*) AS c FROM session_summaries WHERE session_id = ?').get(strandId) as { c: number }).c,
      toolCalls: (db.prepare('SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = ?').get(strandId) as { c: number }).c,
    }
  }

  /**
   * "Fork at this message" from the web (W5b). Same mechanism as the agent's
   * `fork_strand` (core `forkStrand`): lineage columns, seed row, the
   * "forked into" row in the parent and the reference link. The seed is the
   * chosen message plus a `[msg:<id>]` pointer the agent can recall. No turn
   * is started; the user writes first.
   */
  function forkAtMessage(userId: number, strandId: string, body: ForkAtMessageBody): { strand: ReturnType<typeof getStrand>; fork: ForkAtMessageResult } {
    requireStrand(userId, strandId)
    const message = db.prepare(
      `SELECT id, role, content FROM chat_messages
        WHERE id = ? AND session_id = ? AND role IN ('user', 'assistant')`,
    ).get(body.messageId, strandId) as { id: number; role: string; content: string | null } | undefined
    if (!message) throw new StrandServiceError(404, 'message_not_found', 'Message not found in this strand')
    const flat = (message.content ?? '').trim()
    if (!flat) throw new StrandServiceError(400, 'message_empty', 'This message has no text to fork from')

    const body_ = flat.length > FORK_MESSAGE_CHARS ? `${flat.slice(0, FORK_MESSAGE_CHARS - 1)}…` : flat
    const seed = `${body_}\n\n[msg:${message.id}]`.slice(0, FORK_SEED_MAX)
    const title = body.title ?? defaultForkTitle(flat)

    let fork: StrandFork
    try {
      fork = forkStrand({
        db,
        sessions: manager(),
        userId,
        parentStrandId: strandId,
        title,
        seed,
        forkedFromMessageId: message.id,
        autoRun: false,
      })
    } catch (err) {
      if (err instanceof ForkStrandError) {
        if (err.code === 'parent_not_found') throw new StrandServiceError(404, 'strand_not_found', 'Strand not found')
        if (err.code === 'parent_archived') throw new StrandServiceError(409, 'strand_archived', 'An archived strand cannot be forked')
        if (err.code === 'fork_depth_exceeded' || err.code === 'fork_lineage_cycle') {
          throw new StrandServiceError(409, 'fork_depth_exceeded', 'This branch is already nested too deep')
        }
        throw new StrandServiceError(400, err.code, err.code === 'invalid_title' ? 'Invalid title' : 'Invalid fork request')
      }
      throw err
    }

    // Same live event the agent tool sends, so other tabs and the app show
    // the "forked into" row and the new strand without a reload.
    options.chatEventBus?.broadcast({
      type: 'strand_forked',
      userId,
      source: 'web',
      sessionId: fork.parentStrandId,
      agentId: fork.agentId,
      fork: {
        strandId: fork.strandId,
        title: fork.title,
        parentStrandId: fork.parentStrandId,
        forkedAt: fork.forkedAt,
        agentId: fork.agentId,
        projectId: fork.projectId,
        runStarted: false,
      },
    })

    return {
      strand: getStrand(userId, fork.strandId),
      fork: {
        strandId: fork.strandId,
        title: fork.title,
        parentStrandId: fork.parentStrandId,
        parentTitle: fork.parentTitle,
        forkedAt: fork.forkedAt,
        forkedFromMessageId: message.id,
        seedMessageId: fork.seedMessageId,
        noticeMessageId: fork.noticeMessageId,
        depth: fork.depth,
      },
    }
  }

  function setTags(userId: number, strandId: string, tags: string[]): Thread {
    requireStrand(userId, strandId)
    setStrandTags(db, String(userId), strandId, tags)
    return requireStrand(userId, strandId)
  }

  function tags(userId: number, includeArchived: boolean): Tag[] {
    return listTags(db, String(userId), { includeArchived })
  }

  function createTagFor(userId: number, body: { name?: unknown; color?: unknown }): { tag: Tag; created: boolean } {
    try {
      return createTag(db, String(userId), { name: body.name, color: body.color })
    } catch (err) {
      if (err instanceof InvalidInputError) throw new StrandServiceError(400, 'invalid_tag', err.message)
      throw err
    }
  }

  function patchTag(userId: number, id: string, body: { name?: unknown; color?: unknown; archived?: unknown }): Tag {
    let tag: Tag | null
    try {
      tag = updateTag(db, String(userId), id, body)
    } catch (err) {
      if (err instanceof InvalidInputError) throw new StrandServiceError(400, 'invalid_tag', err.message)
      throw err
    }
    if (!tag) throw new StrandServiceError(404, 'tag_not_found', 'Tag not found')
    return tag
  }

  function nowSetMax(): number {
    return nowSetMaxOf()
  }

  function nowSetMode(): NowSetMode {
    return nowSetModeOf()
  }

  /**
   * The set can be larger than the current limit when the size setting was
   * lowered under it, so the list limit is the larger of the two — lowering
   * the setting must never hide a strand that is in the set.
   *
   * In auto mode the list is computed from the user's activity instead
   * (`rankStrandsByActivity`), hydrated through the same `listThreads` path so
   * tags, links and read state are attached exactly as before. `nowRank` is
   * overwritten with the position in the computed list, because the `now_set`
   * table the session manager reads is not what is shown here.
   */
  function nowSet(userId: number): Thread[] {
    if (nowSetMode() === 'auto') {
      const ranked = rankStrandsByActivity(db, String(userId), { max: nowSetMax() })
      if (ranked.length === 0) return []
      const hydrated = manager().listThreads(String(userId), { ids: ranked, limit: ranked.length })
      const byId = new Map(hydrated.map(strand => [strand.id, strand]))
      return ranked.flatMap((id, index) => {
        const strand = byId.get(id)
        return strand ? [{ ...strand, nowRank: index + 1 }] : []
      })
    }
    const ids = getNowSet(db, String(userId))
    if (ids.length === 0) return []
    const limit = Math.max(nowSetMax(), ids.length)
    return manager().listThreads(String(userId), { nowOnly: true, includeArchived: true, limit })
  }

  function replaceNowSet(userId: number, strandIds: string[]): Thread[] {
    if (nowSetMode() === 'auto') {
      throw new StrandServiceError(
        409,
        'now_set_auto',
        'The now set is filled automatically; switch offtangent.nowSetMode to manual to edit it',
      )
    }
    const max = nowSetMax()
    if (strandIds.length > max) {
      throw new StrandServiceError(400, 'now_set_too_large', `The now set holds at most ${max} strands`)
    }
    for (const id of strandIds) {
      const strand = manager().getThread(String(userId), id)
      if (!strand || strand.archived) throw new StrandServiceError(400, 'strand_not_found', `Strand ${id} not found`)
    }
    const ids = setNowSet(db, String(userId), strandIds, max)
    options.chatEventBus?.broadcast({ type: 'now_set_changed', userId, source: 'web', strandIds: ids })
    return nowSet(userId)
  }

  function resurface(userId: number, limit: number): ResurfaceItem[] {
    return listResurfaceItems(db, String(userId), { limit })
  }

  function snooze(userId: number, strandId: string, days: number): void {
    requireStrand(userId, strandId)
    snoozeStrand(db, String(userId), strandId, days)
  }

  /**
   * Accept the open project proposal of a strand (Stufe 2). Writes the
   * project only while the strand has none: a strand that got a project in
   * the meantime (by hand or by a confident run) answers 409 instead of being
   * moved, because nothing in this feature ever moves a filed strand.
   */
  function acceptProjectSuggestion(userId: number, strandId: string): Thread {
    const strand = requireStrand(userId, strandId)
    if (strand.projectId) {
      throw new StrandServiceError(409, 'project_already_set', 'This strand already has a project')
    }
    const suggestion = getStrandProjectSuggestion(db, strandId)
    if (!suggestion) {
      throw new StrandServiceError(404, 'suggestion_not_found', 'This strand has no open project suggestion')
    }
    if (!assignProjectIfUnset(db, strandId, String(userId), suggestion.projectId)) {
      throw new StrandServiceError(409, 'project_not_assignable', 'The suggested project could not be assigned')
    }
    return requireStrand(userId, strandId)
  }

  /**
   * Throw the proposal away for good. The (strand, project) pair is recorded,
   * so no later run suggests it again and no later run assigns it silently
   * either, however confident it is.
   */
  function dismissProjectSuggestion(userId: number, strandId: string): Thread {
    requireStrand(userId, strandId)
    const suggestion = getStrandProjectSuggestion(db, strandId)
    if (!suggestion) {
      throw new StrandServiceError(404, 'suggestion_not_found', 'This strand has no open project suggestion')
    }
    dismissStrandProject(db, strandId, suggestion.projectId)
    return requireStrand(userId, strandId)
  }

  return {
    listStrands,
    attentionSummary,
    markRead,
    getStrand,
    patchStrandModel,
    patchStrandEco,
    patchStrand,
    deletePreview,
    removeStrand,
    strandTasks,
    strandContext,
    strandFacts,
    forkAtMessage,
    setTags,
    tags,
    createTag: createTagFor,
    patchTag,
    nowSet,
    nowSetMax,
    nowSetMode,
    replaceNowSet,
    resurface,
    snooze,
    acceptProjectSuggestion,
    dismissProjectSuggestion,
    dismissStrandActivity,
    undismissStrandActivity,
  }
}

export type StrandsService = ReturnType<typeof createStrandsService>

/** First line of the message, cut to a readable title. */
export function defaultForkTitle(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? ''
  const flat = line.replace(/\s+/g, ' ').replace(/^[#>*\-\s]+/, '').trim()
  if (!flat) return 'Fork'
  return flat.length > FORK_DEFAULT_TITLE_CHARS ? `${flat.slice(0, FORK_DEFAULT_TITLE_CHARS - 1)}…` : flat
}
