/**
 * Strands, tags, now set and resurface (SPEC 6.2, 6.3). A strand is a thread
 * (interactive session) plus tags, now rank and link count; the session
 * manager already renders those fields, this service adds the writes.
 */
import type { AgentCore, ModelSelection, Database, StrandDeletePreview, StrandDeleteResult, StrandReadState, StrandTaskTree, Tag, Thread, ResurfaceItem } from '@axiom/core'
import {
  EMPTY_STRAND_READ_STATE,
  InvalidInputError,
  getStrandReadStates,
  markStrandRead,
  assignProjectIfUnset,
  buildStrandTaskTree,
  createTag,
  dismissStrandProject,
  getStrandProjectSuggestion,
  deleteStrand,
  getNowSet,
  hasLiveTaskForStrand,
  listResurfaceItems,
  listTags,
  previewStrandDelete,
  removeFromNowSet,
  setNowSet,
  setStrandTags,
  snoozeStrand,
  updateTag,
} from '@axiom/core'
import type { ChatEventBus } from '../../../chat-event-bus.js'
import { resolveNowSetMax } from '../../../now-set-limit.js'
import { describePendingTurn } from '../../../turn-queue.js'
import type { DeleteStrandQuery, ListStrandsQuery, PatchStrandBody, PatchStrandModelBody, StrandTasksQuery } from './schema.js'
import { effectiveModelForStrand, getProvider } from '../../../model-selection.js'

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
  hasActiveTurnInSession?: (user: number | string, sessionId: string) => boolean
}

/**
 * What the strand endpoints actually return: the thread plus its server side
 * read state (`lastActivityAt`, `unread`). The read state is NOT built in
 * `SessionManager.toThread` — that runs per row, and the list endpoint would
 * turn into an N+1 over `chat_messages`. It is joined in one query here
 * instead (see `getStrandReadStates`).
 */
export type StrandWithReadState = Thread & StrandReadState

export interface StrandsServiceOptions {
  db: Database
  getAgentCore: () => AgentCore | null
  chatEventBus?: ChatEventBus | null
  getTurnRunner?: () => StrandTurnGuard | null
  /** Effective now-set size, read per request so a settings save applies at once. */
  getNowSetMax?: () => number
  getQuotaSnapshot?: () => unknown
}

export function createStrandsService(options: StrandsServiceOptions) {
  const { db } = options
  const nowSetMaxOf = options.getNowSetMax ?? (() => resolveNowSetMax())

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

  function broadcastNowSet(userId: number): void {
    options.chatEventBus?.broadcast({
      type: 'now_set_changed',
      userId,
      source: 'web',
      strandIds: getNowSet(db, String(userId)),
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

    if (patch.archived === true && removeFromNowSet(db, String(userId), strandId)) {
      broadcastNowSet(userId)
    }
    return requireStrand(userId, strandId)
  }

  /** Attach `lastActivityAt` / `unread` to a list of strands in one query. */
  function withReadState(strands: Thread[]): StrandWithReadState[] {
    const states = getStrandReadStates(db, strands.map(strand => strand.id))
    return strands.map(strand => ({
      ...strand,
      ...(states.get(strand.id) ?? EMPTY_STRAND_READ_STATE),
    }))
  }

  function getStrand(userId: number, strandId: string) {
    const strand = withReadState([requireStrand(userId, strandId)])[0]
    const row = db.prepare('SELECT model_provider_id, model_id FROM sessions WHERE id = ?').get(strandId) as {
      model_provider_id: string | null
      model_id: string | null
    }
    return {
      ...strand,
      pinnedModel: row.model_provider_id && row.model_id
        ? { providerId: row.model_provider_id, modelId: row.model_id }
        : null,
      effectiveModel: effectiveModelForStrand(db, strandId, options.getTurnRunner?.()?.getTurnModelOverride?.(userId, strandId)),
      /**
       * A turn of this strand that is enqueued but has not started yet (plan
       * 2026-09-19, D5), else null. A client that missed the live
       * `turn_queued` event (reload, second device) reads the same wait state
       * here instead of showing an idle strand that is in fact waiting.
       */
      pendingTurn: describePendingTurn(db, options.getAgentCore(), userId, strand.agentId, strandId),
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

    const wasInNowSet = getNowSet(db, String(userId)).includes(strandId)
    const result = deleteStrand(db, String(userId), strandId, { deleteFacts: query.deleteFacts })
    if (wasInNowSet) broadcastNowSet(userId)
    return result
  }

  function listStrands(userId: number, query: ListStrandsQuery): StrandWithReadState[] {
    return withReadState(manager().listThreads(String(userId), query))
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
  function strandTasks(userId: number, strandId: string, query: StrandTasksQuery): StrandTaskTree {
    requireStrand(userId, strandId)
    return buildStrandTaskTree(db, strandId, { include: query.include })
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

  /**
   * The set can be larger than the current limit when the size setting was
   * lowered under it, so the list limit is the larger of the two — lowering
   * the setting must never hide a strand that is in the set.
   */
  function nowSet(userId: number): Thread[] {
    const ids = getNowSet(db, String(userId))
    if (ids.length === 0) return []
    const limit = Math.max(nowSetMax(), ids.length)
    return manager().listThreads(String(userId), { nowOnly: true, includeArchived: true, limit })
  }

  function replaceNowSet(userId: number, strandIds: string[]): Thread[] {
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
    markRead,
    getStrand,
    patchStrandModel,
    patchStrand,
    deletePreview,
    removeStrand,
    strandTasks,
    setTags,
    tags,
    createTag: createTagFor,
    patchTag,
    nowSet,
    nowSetMax,
    replaceNowSet,
    resurface,
    snooze,
    acceptProjectSuggestion,
    dismissProjectSuggestion,
  }
}

export type StrandsService = ReturnType<typeof createStrandsService>
