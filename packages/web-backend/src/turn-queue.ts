/**
 * Queue wait, made visible (plan 2026-09-19, Fix 1 / D3–D5).
 *
 * Turns of one persona are serialized, and a turn that waits looks exactly
 * like a turn that was silently dropped — that is what made a capture answer
 * arrive after 20 minutes with nothing on the card to explain it (incident
 * 2026-09-18). This module turns AgentCore's queue state into the one shape
 * every surface uses: the `turn_queued` event/frame, the `turn` field of
 * `POST /api/captures` and `pendingTurn` of `GET /api/strands/:id`.
 *
 * The blocker's strand title is resolved HERE, not in core: the queue knows
 * ids, the database knows titles. It is resolved per user so a foreign
 * strand's title can never leak — an unresolvable title stays null, which
 * every client has to handle anyway (a blocker without a session id, a strand
 * that was never titled).
 */
import type { Database } from '@axiom/core'
import type { ChatEvent, ChatEventBus } from './chat-event-bus.js'

/** The turn that has to finish before the announced one can start. */
export interface TurnBlocker {
  agentId: string
  sessionId: string | null
  title: string | null
}

/** Wait state of one turn, identical on the WS frame and in both REST bodies. */
export interface QueuedTurnInfo {
  /** True from position 2 upwards: the turn has to wait for another one. */
  queued: boolean
  /** 1-based place of the turn; `position - 1` turns run/wait before it. */
  position: number
  blockedBy: TurnBlocker | null
}

/**
 * The slice of AgentCore this module needs. Structural on purpose: the
 * methods are optional so an older/mocked core degrades to "nothing known
 * about the queue" instead of throwing inside a turn start.
 */
export interface TurnQueueView {
  describeQueue?: (agentId: string) => { position: number; blockedBy: { agentId: string; sessionId: string | null } | null }
  describePendingTurn?: (agentId: string, sessionId: string) => { position: number; blockedBy: { agentId: string; sessionId: string | null } | null } | null
  getPendingMessageCount?: (agentId?: string) => number
}

/**
 * Title of a strand the user owns, or null. Mirrors the ownership predicate
 * used by the capture router (`session_user` OR numeric `user_id`).
 */
export function resolveStrandTitle(db: Database, userId: number | string, sessionId: string | null): string | null {
  if (!sessionId) return null
  try {
    const row = db.prepare(
      'SELECT title FROM sessions WHERE id = ? AND (session_user = ? OR CAST(user_id AS TEXT) = ?)',
    ).get(sessionId, String(userId), String(userId)) as { title: string | null } | undefined
    return row?.title ?? null
  } catch (err) {
    // A wait notice is never worth failing a turn start for.
    console.warn(`[turn-queue] could not resolve strand title for ${sessionId}: ${(err as Error).message}`)
    return null
  }
}

function withTitle(
  db: Database,
  userId: number | string,
  blockedBy: { agentId: string; sessionId: string | null } | null,
): TurnBlocker | null {
  if (!blockedBy) return null
  return { ...blockedBy, title: resolveStrandTitle(db, userId, blockedBy.sessionId) }
}

/**
 * What a turn started RIGHT NOW on `agentId` faces. Call this BEFORE handing
 * the turn to the TurnRunner: the runner enqueues asynchronously, so a
 * snapshot taken first never counts the announced turn itself.
 */
export function describeQueuedTurn(
  db: Database,
  core: TurnQueueView | null | undefined,
  userId: number | string,
  agentId: string,
): QueuedTurnInfo {
  if (!core) return { queued: false, position: 1, blockedBy: null }
  const described = core.describeQueue?.(agentId)
  if (described) {
    return {
      queued: described.position >= 2,
      position: described.position,
      blockedBy: withTitle(db, userId, described.blockedBy),
    }
  }
  // Legacy core without describeQueue: the count is all we know.
  const pending = core.getPendingMessageCount?.(agentId) ?? 0
  return { queued: pending > 0, position: pending + 1, blockedBy: null }
}

/**
 * The turn of `sessionId` that is enqueued but has not started yet, or null.
 * Used by `GET /api/strands/:id` so a client that reconnects mid-wait can
 * render the same notice it would have received live.
 */
export function describePendingTurn(
  db: Database,
  core: TurnQueueView | null | undefined,
  userId: number | string,
  agentId: string,
  sessionId: string,
): QueuedTurnInfo | null {
  const pending = core?.describePendingTurn?.(agentId, sessionId)
  if (!pending) return null
  return {
    queued: true,
    position: pending.position,
    blockedBy: withTitle(db, userId, pending.blockedBy),
  }
}

/**
 * Broadcast the wait to every client of the user (plan D4). Only from
 * position 2 upwards — announcing position 1 would put a "please wait" on a
 * turn that is already running.
 */
export function emitTurnQueued(
  bus: ChatEventBus | null | undefined,
  input: {
    userId: number
    sessionId: string
    agentId: string
    info: QueuedTurnInfo
    source?: ChatEvent['source']
    sourceConnectionId?: string
  },
): void {
  if (!bus || !input.info.queued) return
  bus.broadcast({
    type: 'turn_queued',
    userId: input.userId,
    source: input.source ?? 'web',
    ...(input.sourceConnectionId ? { sourceConnectionId: input.sourceConnectionId } : {}),
    sessionId: input.sessionId,
    agentId: input.agentId,
    position: input.info.position,
    blockedBy: input.info.blockedBy,
  })
}
