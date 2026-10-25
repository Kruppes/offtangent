/**
 * The general status of one user, for every screen that polls it: the Pi
 * dashboard first, any later device after it (`GET /api/status`).
 *
 * Same sources as the strand list of the app, nothing re-implemented:
 * `listStrandIdsForAttention` + `getStrandAttentions` (what waits on the
 * user), `getStrandReadStates` (unread), the interaction blocks of the
 * waiting message (open questions) and the `tasks` table (running tasks,
 * owner resolved like the clock does).
 *
 * Data economy: strand titles, task names and question/option texts only,
 * each cut to a fixed length; never prompts, summaries, results or message
 * bodies. In privacy mode every text is empty and question/option ids are
 * opaque positions (`~n`), exactly like the clock.
 *
 * `rev` is a hash of everything except `generated_at`, so a poller can send
 * `If-None-Match` and get a body-less 304 while nothing changed.
 */
import crypto from 'node:crypto'
import {
  extractAnswerableInteractionBlocks,
  getStrandAttentions,
  getStrandReadStates,
  isAskUserPayload,
  listInteractionsForMessage,
  listStrandIdsForAttention,
  sealInteractionValue,
  resolveInteractionBlockState,
  resolveTaskOwnerUserIdForTask,
  type AskUserPayload,
  type Database,
  type InteractionBlock,
  type InteractionRecord,
} from '@axiom/core'
import { personaId } from '../clock-device/text.js'
import { deviceAnswerableAskUserQuestion, deviceAskUserOptions, isDeviceAnswerableBlock } from './answer.js'
import type { StatusNote } from './note.js'

export const STATUS_VERSION = 2
export const STATUS_TITLE_MAX = 60
export const STATUS_QUESTION_MAX = 160
export const STATUS_LABEL_MAX = 40
export const STATUS_WAITING_MAX = 12
export const STATUS_QUESTIONS_MAX = 6
export const STATUS_RUNNING_MAX = 10
/** Unread counts only strands with activity in this window (old clutter does not count). */
export const STATUS_UNREAD_WINDOW_DAYS = 7

export interface StatusWaiting {
  strand_id: string
  title: string
  persona: string
  /** `interaction` = a card in the strand, `task_question` = a paused task asks. */
  kind: 'interaction' | 'task_question'
  since: string
  /** Id of the matching entry in `questions` when the device may answer it, else null. */
  question_id: string | null
}

export interface StatusQuestionOption {
  id: string
  label: string
}

export interface StatusQuestion {
  /** `m<message_id>:<block_id>`, stable while the card is open. */
  id: string
  message_id: number
  block_id: string
  strand_id: string
  persona: string
  /**
   * `confirm` / `choice`: one tappable question. `multi` (several picks) and
   * `set` (an ask_user card with several questions) are phone-only.
   */
  kind: 'confirm' | 'choice' | 'multi' | 'set'
  text: string
  /** Empty for a phone-only entry. */
  options: StatusQuestionOption[]
  since: string
  expires_at: string | null
  /**
   * True when a device may answer it with one tap on an option. False: the
   * text is shown (empty in privacy mode), no buttons, `hint` says where to
   * answer. Only ask_user cards produce false entries; fence cards that a
   * device may not answer (destructive, danger, multi) stay out of
   * `questions` entirely, as before.
   */
  answerable: boolean
  /** "am Handy beantworten" for a phone-only entry, else null. */
  hint: string | null
}

export const STATUS_PHONE_HINT = 'am Handy beantworten'

export interface StatusRunning {
  id: string
  name: string
  persona: string
  started_at: string | null
}

export interface StatusPayload {
  v: number
  rev: string
  generated_at: string
  privacy: boolean
  note: string
  note_expires_at: string | null
  waiting: StatusWaiting[]
  questions: StatusQuestion[]
  running: StatusRunning[]
  unread: number
  unread_all: number
  strands_total: number
}

interface TaskRow {
  id: string
  name: string
  trigger_type: string
  trigger_source_id: string | null
  session_id: string | null
  agent_id: string | null
  started_at: string | null
  created_at: string | null
}

interface MessageRow {
  id: number
  content: string
  metadata: string | null
  agent_id: string | null
}

/**
 * One line of screen text: Markdown emphasis dropped, whitespace collapsed,
 * cut at `max` code points with "…". Unlike the clock's `panelText` it keeps
 * every Unicode letter; the dashboard is a browser, not a 12-pixel font.
 */
export function lineText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  const line = raw.replace(/[*_`#>]+/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

function sqliteToIso(value: string | null): string | null {
  if (!value) return null
  const ms = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function toStatusQuestion(
  row: MessageRow,
  strandId: string,
  since: string,
  block: InteractionBlock,
  blockIndex: number,
  privacy: boolean,
): StatusQuestion {
  const yesNo = block.kind === 'confirm'
    && block.options.length === 2
    && block.options.some(option => option.id === 'yes')
    && block.options.some(option => option.id === 'no')
  const options = block.options.map((option, index) => {
    if (yesNo) return { id: option.id, label: option.id === 'yes' ? 'Ja' : 'Nein' }
    return {
      id: privacy ? `~${index + 1}` : option.id,
      label: privacy ? '' : lineText(option.label, STATUS_LABEL_MAX),
    }
  })
  const blockId = privacy ? `~${blockIndex + 1}` : block.id
  return {
    id: `m${row.id}:${blockId}`,
    message_id: row.id,
    block_id: blockId,
    strand_id: strandId,
    persona: personaId(row.agent_id),
    kind: yesNo ? 'confirm' : 'choice',
    text: privacy ? '' : lineText(block.question, STATUS_QUESTION_MAX),
    options,
    since,
    expires_at: block.expiresAt ?? null,
    answerable: true,
    hint: null,
  }
}

/**
 * The newest open ask_user interaction of a message, or undefined. Read
 * through the interactions store, the same rows the attention came from.
 */
function openAskUserRecord(db: Database, messageId: number, userId: number, now: number): InteractionRecord | undefined {
  const open = listInteractionsForMessage(db, messageId).filter(record =>
    record.status === 'open'
    && record.userId === userId
    && isAskUserPayload(record.payload)
    && (!record.expiresAt || Date.parse(record.expiresAt) > now))
  return open[open.length - 1]
}

/**
 * An ask_user card as a status entry. `block_id` is the interaction id: it is
 * opaque (ULID), so privacy mode keeps it; option ids become `~n` there.
 * Question and labels are model text and pass the interaction seal first,
 * like every other way an interaction row leaves the server.
 */
function askUserStatusQuestion(
  record: InteractionRecord,
  strandId: string,
  since: string,
  privacy: boolean,
): StatusQuestion {
  const payload = sealInteractionValue(record.payload as AskUserPayload)
  const single = deviceAnswerableAskUserQuestion(payload)
  const base = {
    id: `m${record.messageId}:${record.id}`,
    message_id: record.messageId,
    block_id: record.id,
    strand_id: strandId,
    persona: personaId(record.agent),
    since,
    expires_at: record.expiresAt ?? payload.expiresAt ?? null,
  }
  if (!single) {
    const first = payload.questions[0]
    const more = payload.questions.length - 1
    const text = lineText(first?.question ?? payload.question, STATUS_QUESTION_MAX - (more > 0 ? 12 : 0))
    return {
      ...base,
      kind: payload.questions.length > 1 ? 'set' : 'multi',
      text: privacy ? '' : more > 0 ? `${text} (+${more} weitere)` : text,
      options: [],
      answerable: false,
      hint: STATUS_PHONE_HINT,
    }
  }
  const shown = deviceAskUserOptions(single)
  const yesNo = single.type === 'confirm'
    && shown.length === 2
    && shown.some(option => option.id === 'yes')
    && shown.some(option => option.id === 'no')
  return {
    ...base,
    kind: yesNo ? 'confirm' : 'choice',
    text: privacy ? '' : lineText(single.question, STATUS_QUESTION_MAX),
    options: shown.map((option, index) => {
      if (yesNo) return { id: option.id, label: option.id === 'yes' ? 'Ja' : 'Nein' }
      return {
        id: privacy ? `~${index + 1}` : option.id,
        label: privacy ? '' : lineText(option.label, STATUS_LABEL_MAX),
      }
    }),
    answerable: true,
    hint: null,
  }
}

function revisionOf(body: Omit<StatusPayload, 'rev' | 'generated_at'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)
}

export function buildStatus(
  db: Database,
  input: { userId: number; privacy: boolean; note?: StatusNote | null; now?: number },
): StatusPayload {
  const now = input.now ?? Date.now()
  const { userId, privacy } = input

  const strandIds = listStrandIdsForAttention(db, userId)
  const attentions = getStrandAttentions(db, strandIds, { userId, now })
  const reads = getStrandReadStates(db, strandIds)
  const sessionStmt = db.prepare('SELECT title, agent_id FROM sessions WHERE id = ?')
  const messageStmt = db.prepare(
    'SELECT id, content, metadata, agent_id FROM chat_messages WHERE id = ? AND user_id = ?',
  )

  const waiting: StatusWaiting[] = []
  const questions: StatusQuestion[] = []
  for (const [strandId, attention] of attentions) {
    const session = sessionStmt.get(strandId) as { title: string | null; agent_id: string | null } | undefined
    let questionId: string | null = null
    const askUser = attention.kind === 'interaction' && attention.messageId != null
      ? openAskUserRecord(db, attention.messageId, userId, now)
      : undefined
    if (askUser) {
      // ask_user (S1-B): the question lives only in the interactions table,
      // the message text carries no fence block.
      const question = askUserStatusQuestion(askUser, strandId, attention.since, privacy)
      questions.push(question)
      // A phone-only entry leaves question_id null, so the waiting row still
      // says "am Handy" on a device that does not know `answerable` yet.
      if (question.answerable) questionId = question.id
    } else if (attention.kind === 'interaction' && attention.messageId != null) {
      const row = messageStmt.get(attention.messageId, userId) as MessageRow | undefined
      if (row) {
        const blocks = extractAnswerableInteractionBlocks(row.content)
        const openIndex = blocks.findIndex(block => resolveInteractionBlockState(block, row.metadata, { now }).closedReason === null)
        const open = openIndex < 0 ? undefined : blocks[openIndex]
        // Only cards a device may answer go out with options: choice/confirm,
        // not destructive, not multi (devices/answer.ts). Everything else
        // stays a plain "waiting" row; it must be answered on the phone.
        if (open && isDeviceAnswerableBlock(open)) {
          const question = toStatusQuestion(row, strandId, attention.since, open, openIndex, privacy)
          questions.push(question)
          questionId = question.id
        }
      }
    }
    waiting.push({
      strand_id: strandId,
      title: privacy ? '' : lineText(session?.title || 'Ohne Titel', STATUS_TITLE_MAX),
      persona: personaId(session?.agent_id),
      kind: attention.kind,
      since: attention.since,
      question_id: questionId,
    })
  }
  const bySince = (a: { since: string }, b: { since: string }) => Date.parse(a.since) - Date.parse(b.since)
  waiting.sort((a, b) => bySince(a, b) || a.strand_id.localeCompare(b.strand_id))
  // Tappable entries first: a phone-only entry must never push one out of the cap.
  questions.sort((a, b) => Number(b.answerable) - Number(a.answerable) || bySince(a, b) || a.message_id - b.message_id)

  // Every running task is scanned, the owner filter runs BEFORE any limit:
  // a cap on the scan would let older tasks of other users push the own ones
  // out. Running tasks are few; only the matches are kept, newest last.
  const runningRows = db.prepare(
    `SELECT id, name, trigger_type, trigger_source_id, session_id, agent_id, started_at, created_at
       FROM tasks WHERE status = 'running' ORDER BY COALESCE(started_at, created_at) ASC, id ASC`,
  ).iterate() as IterableIterator<TaskRow>
  const running: StatusRunning[] = []
  for (const row of runningRows) {
    const owner = resolveTaskOwnerUserIdForTask(db, {
      id: row.id,
      triggerType: row.trigger_type,
      triggerSourceId: row.trigger_source_id,
      sessionId: row.session_id,
    })
    if (owner !== userId) continue
    running.push({
      id: row.id,
      name: privacy ? '' : lineText(row.name, STATUS_TITLE_MAX),
      persona: personaId(row.agent_id),
      started_at: sqliteToIso(row.started_at ?? row.created_at),
    })
    if (running.length > STATUS_RUNNING_MAX) running.shift()
  }

  const windowStart = now - STATUS_UNREAD_WINDOW_DAYS * 86_400_000
  let unread = 0
  let unreadAll = 0
  for (const state of reads.values()) {
    if (!state.unread) continue
    unreadAll += 1
    if (state.lastActivityAt && Date.parse(state.lastActivityAt) > windowStart) unread += 1
  }

  const note = input.note ?? null
  const body: Omit<StatusPayload, 'rev' | 'generated_at'> = {
    v: STATUS_VERSION,
    privacy,
    note: privacy || !note ? '' : note.text,
    note_expires_at: privacy || !note ? null : note.expiresAt,
    waiting: waiting.slice(0, STATUS_WAITING_MAX),
    questions: questions.slice(0, STATUS_QUESTIONS_MAX),
    running: running.reverse(),
    unread,
    unread_all: unreadAll,
    strands_total: strandIds.length,
  }
  const { v, ...rest } = body
  return { v, rev: revisionOf(body), generated_at: new Date(now).toISOString(), ...rest }
}
