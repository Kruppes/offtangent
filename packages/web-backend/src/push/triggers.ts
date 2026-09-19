/**
 * Where a doorbell comes from (PROTOCOL chapter 7, slice 2).
 *
 * Four proactive paths, and only these four:
 *
 *  * a turn ended for a strand (`turn_done`, or `error` when the turn died),
 *  * a background task finished or failed (`task_done` / `error`),
 *  * a background task asked something (`question`),
 *  * the captures service asked something about a filed note (`question`,
 *    see {@link sendCaptureDoorbell}).
 *
 * Heartbeats, consolidations and loop detection runs never ring: they are the
 * machine talking to itself. The guard is the session's `type`, so anything
 * that is not an interactive strand is filtered here rather than at every
 * call site.
 *
 * The feed (SPEC 2.9) does not add a fourth path. A background result that
 * goes to the feed only has no strand for the app to open, so it does not
 * ring; a result that ALSO enters a strand rings exactly once, through the
 * same `sendTaskDoorbell` call as before (`task-outcome.ts` calls it on the
 * strand path only). One event, at most one doorbell, in both directions.
 *
 * The default doorbell carries no content. Only when `PUSH_PREVIEW_CHARS` is
 * positive does a finished turn additionally load the strand title and the
 * answer text for the payload.
 */
import type { Database } from '@axiom/core'
import type { PushKind, PushSender } from './sender.js'

export interface TurnDoorbellInput {
  userId: number | null
  sessionId: string
  agentId: string
  failed: boolean
}

export interface TaskDoorbellInput {
  userId: number
  sessionId: string | undefined
  agentId: string
  type: 'task_completed' | 'task_failed' | 'task_question'
}

export interface CaptureDoorbellInput {
  userId: number
  strandId: string
  agentId: string
  /** `chat_messages.id` of the question row, the app's deep link cursor. */
  messageId: number | null
}

/** Only a real strand gets a doorbell. */
export function isPushableSession(db: Database, sessionId: string): boolean {
  try {
    const row = db.prepare('SELECT type FROM sessions WHERE id = ?').get(sessionId) as { type?: string } | undefined
    if (!row) return false
    return (row.type ?? 'interactive') === 'interactive'
  } catch {
    return false
  }
}

/** Newest assistant row of the strand; the app uses it as a cursor, not as content. */
export function latestAssistantMessageId(db: Database, sessionId: string): number | null {
  return latestAssistantMessage(db, sessionId, false).id
}

/**
 * Newest assistant row, optionally with its text.
 *
 * `withContent` is false unless `PUSH_PREVIEW_CHARS` is positive, so the
 * content column is not even selected on the default path. A doorbell is built
 * inside a turn hook; a failed query returns nulls rather than throwing.
 */
export function latestAssistantMessage(
  db: Database,
  sessionId: string,
  withContent: boolean,
): { id: number | null; content: string | null } {
  try {
    const columns = withContent ? 'id, content' : 'id'
    const row = db
      .prepare(`SELECT ${columns} FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`)
      .get(sessionId) as { id?: number; content?: string } | undefined
    return { id: row?.id ?? null, content: row?.content ?? null }
  } catch {
    return { id: null, content: null }
  }
}

/** The strand's own title, when it has one. Only read when previews are on. */
export function strandTitle(db: Database, sessionId: string): string | null {
  try {
    const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title?: string } | undefined
    const title = row?.title?.trim()
    return title && title.length > 0 ? title : null
  } catch {
    return null
  }
}

export function sendTurnDoorbell(db: Database, sender: PushSender, input: TurnDoorbellInput): void {
  if (input.userId === null) return
  if (!isPushableSession(db, input.sessionId)) return
  // Content is only touched when the operator asked for it; a failed turn
  // never carries an excerpt, there is nothing useful to quote.
  const wantsPreview = sender.previewChars > 0 && !input.failed
  const message = latestAssistantMessage(db, input.sessionId, wantsPreview)
  sender.sendDetached({
    userId: input.userId,
    kind: input.failed ? 'error' : 'turn_done',
    strandId: input.sessionId,
    agentId: input.agentId,
    title: (wantsPreview ? strandTitle(db, input.sessionId) : null) ?? input.agentId,
    messageId: message.id,
    preview: wantsPreview ? message.content : null,
  })
}

/**
 * The captures service filed a capture as a note but is not sure the text was
 * meant for the persona, so it wrote one short question into the strand
 * (SPEC 4.1, the doubt band). That question needs a doorbell of its own: no
 * turn ran, so `sendTurnDoorbell` never fires, and a question the user only
 * discovers by opening the app is the same silent failure as the wrong `note`
 * this band exists to fix.
 *
 * `question` and not `turn_done`, for two reasons: it IS a question, and
 * `turn_done` is the one kind that `PUSH_SUPPRESS_WHEN_CLIENT_ONLINE=turn`
 * drops while a client is connected. A question must arrive with the app open
 * as well — an open socket is not a pair of eyes.
 *
 * The body is a label like every other doorbell's, no capture text on the
 * wire, and the default body for `question` names a background task, which
 * this is not.
 */
export function sendCaptureDoorbell(db: Database, sender: PushSender, input: CaptureDoorbellInput): void {
  if (!isPushableSession(db, input.strandId)) return
  sender.sendDetached({
    userId: input.userId,
    kind: 'question',
    strandId: input.strandId,
    agentId: input.agentId,
    title: input.agentId,
    body: 'A filed note is waiting for your answer',
    messageId: input.messageId,
  })
}

export function sendTaskDoorbell(db: Database, sender: PushSender, input: TaskDoorbellInput): void {
  if (!input.sessionId) return
  if (!isPushableSession(db, input.sessionId)) return
  const kind: PushKind = input.type === 'task_question'
    ? 'question'
    : input.type === 'task_failed'
      ? 'error'
      : 'task_done'
  sender.sendDetached({
    userId: input.userId,
    kind,
    strandId: input.sessionId,
    agentId: input.agentId,
    title: input.agentId,
  })
}
