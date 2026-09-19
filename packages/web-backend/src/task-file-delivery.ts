import { serializeUploadsMetadata } from '@axiom/core'
import type { Database, UploadDescriptor } from '@axiom/core'
import type { ChatEventBus } from './chat-event-bus.js'

export interface TaskFileDeliveryDeps {
  db: Database
  chatEventBus?: ChatEventBus | null
}

export interface TaskFileDeliveryInput {
  userId: number
  /** Lineage strand, or the task's own transcript for a feed-only artifact. */
  sessionId: string | null
  agentId: string
  upload: UploadDescriptor
  caption?: string
}

export interface TaskFileDeliveryResult {
  /** Row id of the assistant message carrying the file, for diagnostics. */
  messageId: number
  /** Whether a live `attachment` frame was broadcast (false without a bus). */
  broadcast: boolean
}

/**
 * Deliver a file a background task produced into the strand that triggered
 * the task.
 *
 * A background task has no channel streaming its `tool_call_end` chunks, so
 * nothing does for it what `TurnRunner` + `ws-chat` do for an interactive
 * turn. This is that missing half, and it writes the same two things clients
 * already understand:
 *   1. an assistant row whose `metadata.files` holds the descriptor, so the
 *      file survives a history reload / app sync, and
 *   2. an `attachment` frame on the chat event bus (with `sessionId`,
 *      `agentId` and the row's `messageId`), so a live client renders the card
 *      immediately, as that row rather than glued to the last answer.
 *
 * Persist first, broadcast second: a client that reacts to the frame by
 * fetching history must not race a row that does not exist yet.
 */
export function deliverTaskFile(
  deps: TaskFileDeliveryDeps,
  input: TaskFileDeliveryInput,
): TaskFileDeliveryResult {
  if (!input.sessionId) {
    throw new Error('no strand to deliver the file to (task has no session lineage)')
  }

  const upload: UploadDescriptor = input.caption && !input.upload.caption
    ? { ...input.upload, caption: input.caption }
    : input.upload

  const result = deps.db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(input.sessionId, input.userId, 'assistant', '', serializeUploadsMetadata([upload]), input.agentId)

  const messageId = Number(result.lastInsertRowid)
  // A delivery without a row is not a delivery. Callers (send_file_to_user)
  // report this as a failure instead of claiming the file arrived.
  if (!Number.isInteger(messageId) || messageId <= 0) {
    throw new Error('the attachment message was not persisted (insert returned no row id)')
  }

  if (!deps.chatEventBus) {
    return { messageId, broadcast: false }
  }

  deps.chatEventBus.broadcast({
    type: 'attachment',
    userId: input.userId,
    source: 'task',
    sessionId: input.sessionId,
    agentId: input.agentId,
    attachment: upload,
    messageId,
  })

  return { messageId, broadcast: true }
}
