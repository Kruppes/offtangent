/**
 * The reduced state the LED clock renders (SCHNITTSTELLE.md §1–3).
 *
 * Principle: the backend shortens and filters, the clock only draws. Nothing
 * here ever carries message content: only persona ids, counts, a task name or
 * strand title of at most 24 characters, and the question of a clock-eligible
 * card (at most 40) with its option labels. In privacy mode even those texts
 * are blank; the option short labels stay, because without them the question
 * cannot be answered on the device. The model-chosen block and option ids
 * (often speaking, up to 64 characters) are replaced by opaque positional ids
 * (`~1`, `~2`, ...) in privacy mode; `/answer` maps them back
 * ({@link resolveClockBlock}, {@link resolveClockOptionValue}).
 */
import crypto from 'node:crypto'
import {
  extractAnswerableInteractionBlocks,
  getStrandAttentions,
  listStrandIdsForAttention,
  resolveInteractionBlockState,
  resolveTaskOwnerUserIdForTask,
  type Database,
  type InteractionBlock,
} from '@axiom/core'
import { panelText, personaId, shortLabel } from './text.js'

export const CLOCK_TITLE_MAX = 24
export const CLOCK_QUESTION_MAX = 40
export const CLOCK_LABEL_MAX = 20
export const CLOCK_SHORT_MAX = 9
export const CLOCK_RUNNING_MAX = 5
export const CLOCK_EVENTS_MAX = 5
export const CLOCK_EVENT_WINDOW_MINUTES = 10
const COUNT_MAX = 99
/** Upper bound of task rows looked at per poll; a clock never needs more. */
const TASK_SCAN_LIMIT = 200

export type ClockEventType = 'task_done' | 'task_failed' | 'question'

export interface ClockEvent {
  id: string
  type: ClockEventType
  persona: string
  title: string
  sound: 'chime' | 'alert' | 'none'
  at: string
}

export interface ClockQuestionOption {
  id: string
  label: string
  short: string
}

export interface ClockQuestion {
  id: string
  message_id: number
  block_id: string
  persona: string
  kind: 'choice' | 'confirm'
  text: string
  options: ClockQuestionOption[]
  expires_at: string | null
}

export interface ClockState {
  rev: number
  privacy: boolean
  status: {
    running: Array<{ persona: string; count: number }>
    questions_waiting: number
    thinking: boolean
  }
  events: ClockEvent[]
  question: ClockQuestion | null
}

/**
 * May this card be answered on the clock? Only single-choice and yes/no, and
 * never anything the model marked as destructive — those stay on the phone,
 * where the full context is visible.
 */
/** Opaque positional id of the privacy mode: `~<1-based index>`. */
const OPAQUE_ID = /^~([1-9]\d{0,3})$/

function opaqueIndex(id: string): number | null {
  const match = OPAQUE_ID.exec(id)
  return match ? Number(match[1]) - 1 : null
}

/**
 * The block a clock answer addresses. A real id and an opaque one (`~n` =
 * n-th answerable block of the message) are both accepted, so toggling the
 * privacy mode between the clock's poll and its answer never breaks it; the
 * form the device's current mode emits wins if both would match.
 */
export function resolveClockBlock(
  blocks: InteractionBlock[],
  blockId: string,
  privacy: boolean,
): InteractionBlock | undefined {
  const exact = blocks.find(candidate => candidate.id === blockId)
  const index = opaqueIndex(blockId)
  const positional = index === null ? undefined : blocks[index]
  return privacy ? (positional ?? exact) : (exact ?? positional)
}

/** The real option id behind a clock answer value (same rule as above). */
export function resolveClockOptionValue(block: InteractionBlock, value: string, privacy: boolean): string {
  const exact = block.options.find(option => option.id === value)?.id
  const index = opaqueIndex(value)
  const positional = index === null ? undefined : block.options[index]?.id
  return (privacy ? (positional ?? exact) : (exact ?? positional)) ?? value
}

export function isClockEligibleBlock(block: InteractionBlock): boolean {
  if (block.kind !== 'choice' && block.kind !== 'confirm') return false
  if (block.destructive) return false
  if (block.options.some(option => option.style === 'danger')) return false
  return block.options.length >= 2
}

/** SQLite `datetime('now')` text (UTC, no zone) to ISO-8601 UTC. */
function sqliteToIso(value: string | null): string | null {
  if (!value) return null
  const iso = /Z$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

function shortId(prefix: string, ...parts: string[]): string {
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)
  return `${prefix}${digest}`
}

interface TaskRow {
  id: string
  name: string
  status: string
  trigger_type: string
  trigger_source_id: string | null
  session_id: string | null
  agent_id: string | null
  result_status: string | null
  completed_at: string | null
}

interface MessageRow {
  id: number
  content: string
  metadata: string | null
  agent_id: string | null
  timestamp: string
}

function ownedBy(db: Database, row: TaskRow, userId: number): boolean {
  const owner = resolveTaskOwnerUserIdForTask(db, {
    id: row.id,
    triggerType: row.trigger_type,
    triggerSourceId: row.trigger_source_id,
    sessionId: row.session_id,
  })
  return owner === userId
}

function toQuestion(row: MessageRow, block: InteractionBlock, blockIndex: number, privacy: boolean): ClockQuestion {
  // A confirm card with the default yes/no pair is drawn as the fixed
  // Ja/Nein frames. One with custom option ids goes out as a plain choice, so
  // the clock never guesses which side means "yes".
  const yesNo = block.kind === 'confirm'
    && block.options.length === 2
    && block.options.some(option => option.id === 'yes')
    && block.options.some(option => option.id === 'no')
  const options: ClockQuestionOption[] = block.options.map((option, index) => {
    if (yesNo) {
      // The clock draws yes/no as two fixed frames; the ids are what the
      // interactions endpoint expects for a confirm block.
      const yes = option.id === 'yes'
      return { id: option.id, label: yes ? 'Ja' : 'Nein', short: yes ? 'Ja' : 'Nein' }
    }
    const label = panelText(option.label, CLOCK_LABEL_MAX)
    // Privacy mode: the model-chosen id may speak ("delete_customer_acme").
    const id = privacy ? `~${index + 1}` : option.id
    return { id, label: privacy ? '' : label, short: shortLabel(label, CLOCK_SHORT_MAX) }
  })
  // Two options must never look the same on the panel ("Lange Fassung" and
  // "Lange Version" both shorten to "Lange"): colliding ones fall back to the
  // label cut hard at nine characters, and if even that collides, a number.
  const seen = new Map<string, number>()
  for (const option of options) seen.set(option.short, (seen.get(option.short) ?? 0) + 1)
  options.forEach((option, index) => {
    if ((seen.get(option.short) ?? 0) < 2) return
    const full = panelText(block.options[index]!.label, CLOCK_LABEL_MAX)
    option.short = [...full].slice(0, CLOCK_SHORT_MAX).join('').trimEnd()
  })
  const recount = new Map<string, number>()
  for (const option of options) recount.set(option.short, (recount.get(option.short) ?? 0) + 1)
  options.forEach((option, index) => {
    if ((recount.get(option.short) ?? 0) > 1) option.short = `${index + 1} ${[...option.short].slice(0, CLOCK_SHORT_MAX - 2).join('')}`.trimEnd()
  })
  const blockId = privacy ? `~${blockIndex + 1}` : block.id
  return {
    id: `m${row.id}:${blockId}`,
    message_id: row.id,
    block_id: blockId,
    persona: personaId(row.agent_id),
    kind: yesNo ? 'confirm' : 'choice',
    text: privacy ? '' : panelText(block.question, CLOCK_QUESTION_MAX),
    options,
    expires_at: block.expiresAt ?? null,
  }
}

/**
 * Clock-eligible open questions of the user, oldest first. One per strand at
 * most: the strand attention rule ("only the newest open card of a strand is
 * waiting") is reused instead of re-implemented, and a strand whose waiting
 * card is NOT eligible (destructive, multi, ...) shows nothing on the clock.
 */
function openClockQuestions(
  db: Database,
  userId: number,
  privacy: boolean,
  now: number,
): Array<{ question: ClockQuestion; since: string }> {
  const strandIds = listStrandIdsForAttention(db, userId)
  const attentions = getStrandAttentions(db, strandIds, { userId, now })
  const found: Array<{ question: ClockQuestion; since: string }> = []
  for (const attention of attentions.values()) {
    if (attention.kind !== 'interaction' || attention.messageId == null) continue
    const row = db.prepare(
      'SELECT id, content, metadata, agent_id, timestamp FROM chat_messages WHERE id = ? AND user_id = ?',
    ).get(attention.messageId, userId) as MessageRow | undefined
    if (!row) continue
    const blocks = extractAnswerableInteractionBlocks(row.content)
    const openIndex = blocks.findIndex(block => resolveInteractionBlockState(block, row.metadata, { now }).closedReason === null)
    const open = openIndex < 0 ? undefined : blocks[openIndex]
    if (!open || !isClockEligibleBlock(open)) continue
    found.push({ question: toQuestion(row, open, openIndex, privacy), since: attention.since })
  }
  found.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.question.message_id - b.question.message_id)
  return found
}

/** A stable number for "did anything the clock shows change". */
function revisionOf(state: Omit<ClockState, 'rev'>): number {
  const digest = crypto.createHash('sha256').update(JSON.stringify(state)).digest()
  // 31 bits: Berry integers are 32-bit signed on the ESP32 build.
  return digest.readUInt32BE(0) & 0x7fffffff
}

export function buildClockState(
  db: Database,
  input: { userId: number; privacy: boolean; now?: number },
): ClockState {
  const now = input.now ?? Date.now()
  const { userId, privacy } = input

  const running = db.prepare(
    `SELECT id, name, status, trigger_type, trigger_source_id, session_id, agent_id, result_status, completed_at
       FROM tasks WHERE status = 'running' ORDER BY created_at ASC LIMIT ?`,
  ).all(TASK_SCAN_LIMIT) as TaskRow[]
  const perPersona = new Map<string, number>()
  for (const row of running) {
    if (!ownedBy(db, row, userId)) continue
    const persona = personaId(row.agent_id)
    perPersona.set(persona, (perPersona.get(persona) ?? 0) + 1)
  }
  const runningList = [...perPersona.entries()]
    .map(([persona, count]) => ({ persona, count: Math.min(count, COUNT_MAX) }))
    .sort((a, b) => b.count - a.count || a.persona.localeCompare(b.persona))
    .slice(0, CLOCK_RUNNING_MAX)

  const windowStart = new Date(now - CLOCK_EVENT_WINDOW_MINUTES * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const finished = db.prepare(
    `SELECT id, name, status, trigger_type, trigger_source_id, session_id, agent_id, result_status, completed_at
       FROM tasks
      WHERE status IN ('completed', 'failed')
        AND completed_at IS NOT NULL AND completed_at >= ?
        AND (result_status IS NULL OR result_status != 'silent')
      ORDER BY completed_at DESC LIMIT ?`,
  ).all(windowStart, TASK_SCAN_LIMIT) as TaskRow[]

  const events: ClockEvent[] = []
  for (const row of finished) {
    if (!ownedBy(db, row, userId)) continue
    const at = sqliteToIso(row.completed_at)
    if (!at) continue
    const failed = row.status === 'failed' || row.result_status === 'failed'
    events.push({
      id: shortId('t', row.id, row.status),
      type: failed ? 'task_failed' : 'task_done',
      persona: personaId(row.agent_id),
      title: privacy ? '' : panelText(row.name, CLOCK_TITLE_MAX),
      sound: failed ? 'alert' : 'chime',
      at,
    })
  }

  const questions = openClockQuestions(db, userId, privacy, now)
  const windowStartMs = now - CLOCK_EVENT_WINDOW_MINUTES * 60_000
  for (const { question, since } of questions) {
    if (Date.parse(since) < windowStartMs) continue
    events.push({
      id: shortId('q', question.id),
      type: 'question',
      persona: question.persona,
      title: privacy ? '' : panelText(question.text, CLOCK_TITLE_MAX),
      sound: 'chime',
      at: new Date(Date.parse(since)).toISOString(),
    })
  }
  // Newest last, at most five: the clock plays them in order and remembers
  // the last id it showed.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
  const recentEvents = events.slice(-CLOCK_EVENTS_MAX)

  const body: Omit<ClockState, 'rev'> = {
    privacy,
    status: {
      running: runningList,
      questions_waiting: Math.min(questions.length, COUNT_MAX),
      thinking: false,
    },
    events: recentEvents,
    question: questions[0]?.question ?? null,
  }
  return { rev: revisionOf(body), ...body }
}
