import { recordMessageArtifacts, serializeUploadsMetadata } from '@axiom/core'
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
  /**
   * Ids of the canvas artifacts this delivery created (empty for a file the
   * canvas cannot render, e.g. an APK). Returned so a caller can prove the
   * canvas exists instead of assuming it.
   */
  artifactIds: string[]
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
 *
 * And it records the canvas artifacts of that row. `TurnRunner.finalize()`
 * does this for an interactive turn; this path wrote the row itself and did
 * not, so an html file sent from a background task appeared as a download
 * card and never as a canvas (`chat_messages` 135305 and 135482 on the live
 * database, both with an `.html` in `metadata.files` and no `artifacts` row).
 * A `view_key` on the descriptor also only becomes a revision here.
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

  // Artifacts before the broadcast: a client that reacts to the frame by
  // reloading history must find the canvas already attached to the row.
  // Never throws (see `recordMessageArtifacts`): a canvas that cannot be
  // stored must not turn a successful delivery into a failure.
  const artifactIds: string[] = []
  try {
    const recorded = recordMessageArtifacts(deps.db, {
      messageId,
      strandId: input.sessionId,
      userId: input.userId,
      agentId: input.agentId,
      content: '',
      uploads: [upload],
    })
    for (const artifact of recorded.artifacts) artifactIds.push(artifact.id)
    for (const skip of recorded.skipped) {
      if (skip.reason === 'duplicate') continue
      console.warn(`[task-file-delivery] Skipped artifact "${skip.title}": ${skip.reason}`)
    }
  } catch (err) {
    console.error('[task-file-delivery] Failed to record artifacts:', err)
  }

  if (!deps.chatEventBus) {
    return { messageId, broadcast: false, artifactIds }
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

  return { messageId, broadcast: true, artifactIds }
}
