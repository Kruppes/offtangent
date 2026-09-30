/**
 * The "awaiting you" state of a strand (plan 2026-09-26).
 *
 * The rule these tests defend: `attention` and `POST /api/interactions` must
 * answer the SAME question. A card the endpoint refuses (answered, expired)
 * must not leave a badge behind, and a card it would still take must produce
 * one. The route level counterpart lives in
 * `packages/web-backend/src/api/modules/strands/attention.route.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  ATTENTION_MAX_AGE_MS,
  ATTENTION_PROMPT_MAX,
  loadAttentionMaxAgeMs,
  resolveAttentionMaxAgeMs,
  firstAwaitingStrandId,
  formatAttentionPrompt,
  getStrandAttention,
  getStrandAttentions,
  listStrandIdsForAttention,
} from './strand-attention.js'
import { withInteractionAnswer } from './contracts/interaction-blocks.js'

let db: Database

/**
 * Fixed clock for every fixture below. The age limit (rule 3) makes attention
 * time-dependent, so the fixtures date themselves relative to this instant
 * instead of relying on the real one — otherwise the suite would start failing
 * two days after the fixture dates.
 */
const NOW = Date.parse('2026-09-26T12:00:00.000Z')
/** A SQLite-shaped UTC timestamp `hours` before {@link NOW}. */
function hoursBeforeNow(hours: number): string {
  return new Date(NOW - hours * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * The age limit is read from `settings.json` (`offtangent.attentionMaxAgeHours`),
 * so every test in this file runs against an EMPTY temp config dir. Without it
 * the suite would read the live `/data/config/settings.json` and a value set on
 * the machine running the tests would change the expected defaults.
 */
let tempDataDir: string
let previousDataDir: string | undefined

function writeSettings(settings: unknown): void {
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(tempDataDir, 'config', 'settings.json'), JSON.stringify(settings), 'utf-8')
}

function removeSettings(): void {
  fs.rmSync(path.join(tempDataDir, 'config', 'settings.json'), { force: true })
}

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-attention-settings-'))
  process.env.DATA_DIR = tempDataDir
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  removeSettings()
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'alice', 'x')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'bob', 'x')
})

afterEach(() => {
  db.close()
})

function createStrand(id: string, userId = 1, options: { archived?: boolean; parent?: string; type?: string } = {}): string {
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, agent_id, title, archived, parent_session_id)
     VALUES (?, ?, ?, 'web', ?, 'main', ?, ?, ?)`,
  ).run(
    id,
    userId,
    String(userId),
    options.type ?? 'interactive',
    `Strand ${id}`,
    options.archived ? 1 : 0,
    options.parent ?? null,
  )
  return id
}

function blockFence(payload: Record<string, unknown>, fence = '```'): string {
  return [`${fence}offtangent`, JSON.stringify(payload), fence].join('\n')
}

function choiceBlock(id: string, question: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    block: 'choice',
    id,
    question,
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    ...extra,
  }
}

function insertMessage(
  sessionId: string,
  content: string,
  options: { userId?: number; role?: string; timestamp?: string; metadata?: string | null } = {},
): number {
  const info = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp, metadata)
     VALUES (?, ?, ?, ?, 'main', ?, ?)`,
  ).run(
    sessionId,
    options.userId ?? 1,
    options.role ?? 'assistant',
    content,
    options.timestamp ?? '2026-09-26 10:00:00',
    options.metadata ?? null,
  )
  return Number(info.lastInsertRowid)
}

/**
 * A task as the runner leaves it: its own session, whose parent is the strand
 * it was started from (`ensureTaskSession`), and `paused` + `question` as
 * `POST /api/tasks/:id/reply` finds it.
 */
function insertPausedTask(
  taskId: string,
  strandId: string,
  options: { summary?: string | null; startedAt?: string; status?: string; resultStatus?: string | null; userId?: number } = {},
): string {
  const taskSession = `sess-${taskId}`
  createStrand(taskSession, options.userId ?? 1, { parent: strandId, type: 'task' })
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, status, trigger_type, result_status, result_summary, session_id, started_at, created_at)
     VALUES (?, ?, 'do the thing', ?, 'user', ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    `Task ${taskId}`,
    options.status ?? 'paused',
    options.resultStatus === undefined ? 'question' : options.resultStatus,
    options.summary === undefined ? 'Should I book the early train?' : options.summary,
    taskSession,
    options.startedAt ?? '2026-09-26 09:00:00',
    options.startedAt ?? '2026-09-26 09:00:00',
  )
  return taskId
}

describe('formatAttentionPrompt', () => {
  it('collapses whitespace to a single line', () => {
    expect(formatAttentionPrompt('Which\n option   do\tyou want?')).toBe('Which option do you want?')
  })

  it('truncates with an ellipsis at the contract limit', () => {
    const prompt = formatAttentionPrompt('a'.repeat(400))
    expect(prompt.length).toBe(ATTENTION_PROMPT_MAX)
    expect(prompt.endsWith('…')).toBe(true)
    expect(ATTENTION_PROMPT_MAX).toBe(120)
  })

  it('leaves a prompt at the limit untouched', () => {
    const exact = 'b'.repeat(ATTENTION_PROMPT_MAX)
    expect(formatAttentionPrompt(exact)).toBe(exact)
  })

  it('renders an empty string for a missing question', () => {
    expect(formatAttentionPrompt(null)).toBe('')
  })
})

describe('getStrandAttentions — interaction blocks', () => {
  it('reports an unanswered choice block', () => {
    const strand = createStrand('s-choice')
    const messageId = insertMessage(strand, blockFence(choiceBlock('b1', 'Hand this to Bob?')), {
      timestamp: '2026-09-26 10:15:00',
    })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toEqual({
      kind: 'interaction',
      since: '2026-09-26T10:15:00.000Z',
      prompt: 'Hand this to Bob?',
      messageId,
      taskId: null,
    })
  })

  it('reports confirm and multi blocks, and ignores a draft block', () => {
    const confirm = createStrand('s-confirm')
    insertMessage(confirm, blockFence({ block: 'confirm', id: 'c1', question: 'Delete the note?' }))
    const multi = createStrand('s-multi')
    insertMessage(multi, blockFence({
      block: 'multi',
      id: 'm1',
      question: 'Which days work?',
      options: [{ id: 'mon', label: 'Monday' }, { id: 'tue', label: 'Tuesday' }],
    }))
    const draft = createStrand('s-draft')
    insertMessage(draft, blockFence({ block: 'draft', text: 'a draft, not a question' }))

    expect(getStrandAttention(db, confirm, { userId: 1, now: NOW })?.prompt).toBe('Delete the note?')
    expect(getStrandAttention(db, multi, { userId: 1, now: NOW })?.prompt).toBe('Which days work?')
    expect(getStrandAttention(db, draft, { userId: 1, now: NOW })).toBeNull()
  })

  it('drops the attention once the block carries an answer', () => {
    const strand = createStrand('s-answered')
    const content = blockFence(choiceBlock('b1', 'Hand this to Bob?'))
    const messageId = insertMessage(strand, content)
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.messageId).toBe(messageId)

    // Exactly what the interactions service writes (`withInteractionAnswer`).
    const metadata = withInteractionAnswer(null, {
      blockId: 'b1',
      value: 'yes',
      label: 'Yes',
      answeredAt: '2026-09-26T10:20:00.000Z',
      clientMessageId: 'cm-1',
      resumed: true,
    })
    db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), messageId)

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toBeNull()
  })

  it('drops the attention for an expired block — the 410 stale of the endpoint', () => {
    const strand = createStrand('s-expired')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Still relevant?', { expiresAt: '2026-09-26T11:00:00.000Z' })))

    const before = Date.parse('2026-09-26T10:59:59.000Z')
    const after = Date.parse('2026-09-26T11:00:01.000Z')
    expect(getStrandAttention(db, strand, { userId: 1, now: before })?.prompt).toBe('Still relevant?')
    expect(getStrandAttention(db, strand, { userId: 1, now: after })).toBeNull()
  })

  it('accepts a four-backtick fence, which the parser accepts too', () => {
    const strand = createStrand('s-wide-fence')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Wide fence?'), '````'))
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Wide fence?')
  })

  it('never reports a block of another user', () => {
    const foreign = createStrand('s-foreign', 2)
    insertMessage(foreign, blockFence(choiceBlock('b1', 'Bob question?')), { userId: 2 })

    expect(getStrandAttention(db, foreign, { userId: 1, now: NOW })).toBeNull()
    expect(getStrandAttention(db, foreign, { userId: 2, now: NOW })?.prompt).toBe('Bob question?')
  })

  it('truncates a long question to one line', () => {
    const strand = createStrand('s-long')
    insertMessage(strand, blockFence(choiceBlock('b1', `Should we\n  ${'x'.repeat(300)}`)))

    const prompt = getStrandAttention(db, strand, { userId: 1, now: NOW })!.prompt
    expect(prompt.length).toBe(ATTENTION_PROMPT_MAX)
    expect(prompt).not.toContain('\n')
    expect(prompt.endsWith('…')).toBe(true)
  })
})

/**
 * The staleness rules (attention only). They do NOT change what
 * `POST /api/interactions` accepts: a card that loses its badge here stays
 * answerable in the chat, which is the harmless direction. The reverse — a
 * badge over a card the endpoint refuses — is what the tests above defend.
 */
describe('getStrandAttentions — staleness (rule 1: superseded by the user)', () => {
  it('clears the card once the user wrote again in the strand', () => {
    const strand = createStrand('s-later-user-message')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Hand this to Bob?')), { timestamp: hoursBeforeNow(3) })
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.kind).toBe('interaction')

    insertMessage(strand, 'no, keep it here — I will do it myself', {
      role: 'user',
      timestamp: hoursBeforeNow(2),
    })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toBeNull()
  })

  it('clears the card for a later user turn written in the SAME second (id ordering)', () => {
    const sameSecond = hoursBeforeNow(1)
    const strand = createStrand('s-same-second')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Which one?')), { timestamp: sameSecond })
    insertMessage(strand, 'the second one', { role: 'user', timestamp: sameSecond })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toBeNull()
  })

  it('keeps the card when the user turn is OLDER than it', () => {
    const strand = createStrand('s-earlier-user-message')
    insertMessage(strand, 'what should we do about the rim?', { role: 'user', timestamp: hoursBeforeNow(5) })
    insertMessage(strand, blockFence(choiceBlock('b1', 'Drill the rim?')), { timestamp: hoursBeforeNow(4) })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Drill the rim?')
  })

  it('does not count assistant, tool or injected system rows as user activity', () => {
    // The shapes the system writes after a card (module header): a task result
    // and a task question land as `role = 'system'` (task-notification.ts), a
    // task injection answer / file delivery as `'assistant'`, a tool row as
    // `'tool'`. None of them is the user acting, so none of them clears a card.
    const strand = createStrand('s-system-rows')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Hand this to Bob?')), { timestamp: hoursBeforeNow(6) })
    insertMessage(strand, 'Task "Check the shop" finished', {
      role: 'system',
      timestamp: hoursBeforeNow(5),
      metadata: JSON.stringify({ type: 'task_result' }),
    })
    insertMessage(strand, 'Here is the report', {
      role: 'assistant',
      timestamp: hoursBeforeNow(4),
      metadata: JSON.stringify({ type: 'task_injection_response' }),
    })
    insertMessage(strand, 'Tool: shell', { role: 'tool', timestamp: hoursBeforeNow(3) })
    insertMessage(strand, 'Modell: a → b', {
      role: 'system',
      timestamp: hoursBeforeNow(2),
      metadata: JSON.stringify({ type: 'model_change', automatic: true }),
    })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Hand this to Bob?')
  })

  it('ignores a later user row of ANOTHER user in the same strand', () => {
    const strand = createStrand('s-foreign-user-row')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Hand this to Bob?')), { timestamp: hoursBeforeNow(3) })
    insertMessage(strand, 'not my strand', { role: 'user', userId: 2, timestamp: hoursBeforeNow(1) })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Hand this to Bob?')
  })

  it('does not let a user turn in a DIFFERENT strand clear the card', () => {
    const withCard = createStrand('s-card-only')
    const elsewhere = createStrand('s-elsewhere')
    insertMessage(withCard, blockFence(choiceBlock('b1', 'Hand this to Bob?')), { timestamp: hoursBeforeNow(3) })
    insertMessage(elsewhere, 'talking about something else', { role: 'user', timestamp: hoursBeforeNow(1) })

    expect(getStrandAttention(db, withCard, { userId: 1, now: NOW })?.prompt).toBe('Hand this to Bob?')
  })
})

describe('getStrandAttentions — staleness (rule 2: superseded by a newer card)', () => {
  it('reports the NEWEST open card of the strand, not the oldest', () => {
    const strand = createStrand('s-two-open-cards')
    insertMessage(strand, blockFence(choiceBlock('b1', 'First question?')), { timestamp: hoursBeforeNow(6) })
    const newest = insertMessage(strand, blockFence(choiceBlock('b2', 'Second question?')), {
      timestamp: hoursBeforeNow(2),
    })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toMatchObject({
      messageId: newest,
      prompt: 'Second question?',
      since: new Date(NOW - 2 * 3_600_000).toISOString(),
    })
  })

  it('falls back to the older open card when the newer one was answered', () => {
    const strand = createStrand('s-newer-answered')
    const older = insertMessage(strand, blockFence(choiceBlock('b1', 'First question?')), {
      timestamp: hoursBeforeNow(6),
    })
    const newer = insertMessage(strand, blockFence(choiceBlock('b2', 'Second question?')), {
      timestamp: hoursBeforeNow(5),
    })
    const metadata = withInteractionAnswer(null, {
      blockId: 'b2',
      value: 'yes',
      label: 'Yes',
      answeredAt: new Date(NOW - 4 * 3_600_000).toISOString(),
      clientMessageId: 'cm-newer',
      resumed: false,
    })
    db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), newer)

    // Only OPEN cards supersede: the answered one is no candidate at all.
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toMatchObject({
      messageId: older,
      prompt: 'First question?',
    })
  })

  it('does not resurrect an older card when the newest one is superseded by a user turn', () => {
    const strand = createStrand('s-newest-superseded')
    insertMessage(strand, blockFence(choiceBlock('b1', 'First question?')), { timestamp: hoursBeforeNow(6) })
    insertMessage(strand, blockFence(choiceBlock('b2', 'Second question?')), { timestamp: hoursBeforeNow(5) })
    insertMessage(strand, 'forget both, I did it', { role: 'user', timestamp: hoursBeforeNow(4) })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toBeNull()
  })
})

describe('getStrandAttentions — staleness (rule 3: age limit)', () => {
  it('keeps a card at 47 h and drops it at 49 h', () => {
    const fresh = createStrand('s-age-47h')
    insertMessage(fresh, blockFence(choiceBlock('b1', 'Still open?')), { timestamp: hoursBeforeNow(47) })
    const stale = createStrand('s-age-49h')
    insertMessage(stale, blockFence(choiceBlock('b2', 'Long forgotten?')), { timestamp: hoursBeforeNow(49) })

    expect(getStrandAttention(db, fresh, { userId: 1, now: NOW })?.prompt).toBe('Still open?')
    expect(getStrandAttention(db, stale, { userId: 1, now: NOW })).toBeNull()
    expect(ATTENTION_MAX_AGE_MS).toBe(48 * 60 * 60 * 1000)
  })

  it('keeps a card exactly at the limit and drops it one second later', () => {
    const strand = createStrand('s-age-edge')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Edge?')), { timestamp: hoursBeforeNow(48) })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Edge?')
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW + 1_000 })).toBeNull()
  })

  it('honours the maxAgeMs option', () => {
    const strand = createStrand('s-age-option')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Three hours old?')), { timestamp: hoursBeforeNow(3) })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW, maxAgeMs: 2 * 3_600_000 })).toBeNull()
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW, maxAgeMs: 4 * 3_600_000 })?.prompt)
      .toBe('Three hours old?')
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW, maxAgeMs: Number.POSITIVE_INFINITY })?.prompt)
      .toBe('Three hours old?')
  })

  it('honours AXIOM_ATTENTION_MAX_AGE_MS and ignores a garbage value', () => {
    const strand = createStrand('s-age-env')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Six hours old?')), { timestamp: hoursBeforeNow(6) })
    const previous = process.env.AXIOM_ATTENTION_MAX_AGE_MS
    try {
      process.env.AXIOM_ATTENTION_MAX_AGE_MS = String(4 * 3_600_000)
      expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toBeNull()
      process.env.AXIOM_ATTENTION_MAX_AGE_MS = 'soon'
      expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Six hours old?')
    } finally {
      if (previous === undefined) delete process.env.AXIOM_ATTENTION_MAX_AGE_MS
      else process.env.AXIOM_ATTENTION_MAX_AGE_MS = previous
    }
  })

  it('honours the setting offtangent.attentionMaxAgeHours', () => {
    const strand = createStrand('s-age-setting')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Sixty hours old?')), { timestamp: hoursBeforeNow(60) })

    writeSettings({ offtangent: { attentionMaxAgeHours: 72 } })
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Sixty hours old?')

    writeSettings({ offtangent: { attentionMaxAgeHours: 24 } })
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toBeNull()
  })

  it('picks up a changed setting on the next call, without a restart', () => {
    const strand = createStrand('s-age-setting-reload')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Ten hours old?')), { timestamp: hoursBeforeNow(10) })

    writeSettings({ offtangent: { attentionMaxAgeHours: 6 } })
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toBeNull()
    // Same process, same module instance: only the file changed.
    writeSettings({ offtangent: { attentionMaxAgeHours: 12 } })
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Ten hours old?')
  })

  it('lets an explicit maxAgeMs win over the setting', () => {
    const strand = createStrand('s-age-setting-override')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Thirty hours old?')), { timestamp: hoursBeforeNow(30) })

    writeSettings({ offtangent: { attentionMaxAgeHours: 1 } })
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW, maxAgeMs: 36 * 3_600_000 })?.prompt)
      .toBe('Thirty hours old?')
  })

  it('falls back to the default for a garbage or out-of-range setting', () => {
    const strand = createStrand('s-age-setting-garbage')
    insertMessage(strand, blockFence(choiceBlock('b1', 'Still inside 48 h?')), { timestamp: hoursBeforeNow(47) })

    for (const value of ['soon', 0, -5, 721, 4.5, null] as unknown[]) {
      writeSettings({ offtangent: { attentionMaxAgeHours: value } })
      expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Still inside 48 h?')
      expect(getStrandAttention(db, strand, { userId: 1, now: NOW + 2 * 3_600_000 })).toBeNull()
    }
  })

  it('drops a paused task question past the age limit but keeps a fresh one', () => {
    const fresh = createStrand('s-task-fresh')
    insertPausedTask('t-fresh', fresh, { startedAt: hoursBeforeNow(10) })
    const stale = createStrand('s-task-stale')
    insertPausedTask('t-stale', stale, { startedAt: hoursBeforeNow(72) })

    expect(getStrandAttention(db, fresh, { userId: 1, now: NOW })?.taskId).toBe('t-fresh')
    expect(getStrandAttention(db, stale, { userId: 1, now: NOW })).toBeNull()
  })

  it('does NOT clear a paused task question because the user wrote again', () => {
    // A paused task is blocked until `POST /api/tasks/:id/reply` answers it;
    // chatting in the strand does not unblock it, so rule 1 must not apply.
    const strand = createStrand('s-task-later-user-message')
    insertPausedTask('t-blocked', strand, { startedAt: hoursBeforeNow(5) })
    insertMessage(strand, 'meanwhile, something else', { role: 'user', timestamp: hoursBeforeNow(1) })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.taskId).toBe('t-blocked')
  })
})

describe('getStrandAttentions — paused tasks', () => {
  it('reports a paused task with a question for its originating strand', () => {
    const strand = createStrand('s-task')
    insertPausedTask('t-1', strand, { startedAt: '2026-09-26 09:30:00' })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toEqual({
      kind: 'task_question',
      since: '2026-09-26T09:30:00.000Z',
      prompt: 'Should I book the early train?',
      messageId: null,
      taskId: 't-1',
    })
  })

  it('also accepts a task whose session IS the strand', () => {
    const strand = createStrand('s-task-direct')
    db.prepare(
      `INSERT INTO tasks (id, name, prompt, status, trigger_type, result_status, result_summary, session_id, started_at)
       VALUES ('t-direct', 'Direct', 'p', 'paused', 'user', 'question', 'Which option?', ?, '2026-09-26 09:00:00')`,
    ).run(strand)

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.taskId).toBe('t-direct')
  })

  it('drops the attention once the task was resumed (status running again)', () => {
    const strand = createStrand('s-task-resumed')
    insertPausedTask('t-2', strand)
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.kind).toBe('task_question')

    // `TaskRunner.resume` sets the status back to running.
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = 't-2'").run()
    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toBeNull()
  })

  it('ignores a paused task without a question and a completed one', () => {
    const paused = createStrand('s-task-nonquestion')
    insertPausedTask('t-3', paused, { resultStatus: null })
    const done = createStrand('s-task-done')
    insertPausedTask('t-4', done, { status: 'completed' })

    expect(getStrandAttention(db, paused, { userId: 1, now: NOW })).toBeNull()
    expect(getStrandAttention(db, done, { userId: 1, now: NOW })).toBeNull()
  })

  it('never counts the task of another strand', () => {
    const owner = createStrand('s-task-owner')
    const other = createStrand('s-task-other')
    insertPausedTask('t-5', owner)

    expect(getStrandAttention(db, owner, { userId: 1, now: NOW })?.taskId).toBe('t-5')
    expect(getStrandAttention(db, other, { userId: 1, now: NOW })).toBeNull()
  })

  it('does not count a sub-task: its question goes to the parent task, not to the user', () => {
    const strand = createStrand('s-subtask')
    insertPausedTask('t-parent', strand, { status: 'running', resultStatus: null })
    // The sub-task hangs off the TASK session, one hop deeper.
    insertPausedTask('t-child', 'sess-t-parent')

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })).toBeNull()
  })

  it('falls back to the task name when the pause left no summary', () => {
    const strand = createStrand('s-task-noname')
    insertPausedTask('t-6', strand, { summary: null })

    expect(getStrandAttention(db, strand, { userId: 1, now: NOW })?.prompt).toBe('Task t-6')
  })
})

describe('getStrandAttentions — several sources', () => {
  it('lets the oldest open question win across kinds', () => {
    const taskFirst = createStrand('s-task-first')
    insertPausedTask('t-old', taskFirst, { startedAt: '2026-09-26 08:00:00' })
    insertMessage(taskFirst, blockFence(choiceBlock('b1', 'Later card?')), { timestamp: '2026-09-26 09:00:00' })

    const blockFirst = createStrand('s-block-first')
    insertMessage(blockFirst, blockFence(choiceBlock('b2', 'Earlier card?')), { timestamp: '2026-09-26 08:00:00' })
    insertPausedTask('t-new', blockFirst, { startedAt: '2026-09-26 09:00:00' })

    expect(getStrandAttention(db, taskFirst, { userId: 1, now: NOW })).toMatchObject({
      kind: 'task_question',
      taskId: 't-old',
      since: '2026-09-26T08:00:00.000Z',
    })
    expect(getStrandAttention(db, blockFirst, { userId: 1, now: NOW })).toMatchObject({
      kind: 'interaction',
      prompt: 'Earlier card?',
      since: '2026-09-26T08:00:00.000Z',
    })
  })

  it('answers many strands without a query per strand', () => {
    const ids: string[] = []
    for (let i = 0; i < 450; i++) {
      const id = createStrand(`s-bulk-${String(i).padStart(3, '0')}`)
      ids.push(id)
      if (i % 3 === 0) insertMessage(id, blockFence(choiceBlock(`b${i}`, `Question ${i}?`)))
    }

    const attentions = getStrandAttentions(db, ids, { userId: 1, now: NOW })
    expect(attentions.size).toBe(150)
    expect(attentions.get('s-bulk-000')?.prompt).toBe('Question 0?')
    expect(attentions.get('s-bulk-001')).toBeUndefined()
    // Beyond the 400-id chunk boundary the answer is the same.
    expect(attentions.get('s-bulk-402')?.prompt).toBe('Question 402?')
  })

  it('returns an empty map for no ids', () => {
    expect(getStrandAttentions(db, [], { userId: 1, now: NOW }).size).toBe(0)
  })
})

describe('firstAwaitingStrandId', () => {
  it('picks the oldest since and breaks ties by id', () => {
    const early = createStrand('s-early')
    insertMessage(early, blockFence(choiceBlock('b1', 'Early?')), { timestamp: '2026-09-26 07:00:00' })
    const lateA = createStrand('s-late-a')
    insertMessage(lateA, blockFence(choiceBlock('b2', 'Late A?')), { timestamp: '2026-09-26 12:00:00' })
    const lateB = createStrand('s-late-b')
    insertMessage(lateB, blockFence(choiceBlock('b3', 'Late B?')), { timestamp: '2026-09-26 12:00:00' })

    expect(firstAwaitingStrandId(getStrandAttentions(db, [early, lateA, lateB], { userId: 1, now: NOW }))).toBe(early)
    expect(firstAwaitingStrandId(getStrandAttentions(db, [lateB, lateA], { userId: 1, now: NOW }))).toBe(lateA)
    expect(firstAwaitingStrandId(new Map())).toBeNull()
  })
})

describe('listStrandIdsForAttention', () => {
  it('lists the non-archived interactive strands of one user only', () => {
    const own = createStrand('s-own')
    createStrand('s-archived', 1, { archived: true })
    createStrand('s-foreign-user', 2)
    createStrand('s-task-session', 1, { type: 'task' })

    expect(listStrandIdsForAttention(db, 1)).toEqual([own])
    expect(listStrandIdsForAttention(db, 1, { includeArchived: true }).sort()).toEqual(['s-archived', own])
    expect(listStrandIdsForAttention(db, 2)).toEqual(['s-foreign-user'])
  })
})

describe('resolveAttentionMaxAgeMs / loadAttentionMaxAgeMs', () => {
  const hours = (n: number) => n * 3_600_000

  it('returns the default when settings.json is absent', () => {
    expect(loadAttentionMaxAgeMs()).toBeNull()
    expect(resolveAttentionMaxAgeMs()).toBe(ATTENTION_MAX_AGE_MS)
  })

  it('returns the default when the key is absent', () => {
    writeSettings({ offtangent: { nowSetMax: 4 } })
    expect(loadAttentionMaxAgeMs()).toBeNull()
    expect(resolveAttentionMaxAgeMs()).toBe(hours(48))
  })

  it('uses a valid value, at both ends of the range', () => {
    writeSettings({ offtangent: { attentionMaxAgeHours: 1 } })
    expect(resolveAttentionMaxAgeMs()).toBe(hours(1))
    writeSettings({ offtangent: { attentionMaxAgeHours: 720 } })
    expect(resolveAttentionMaxAgeMs()).toBe(hours(720))
    writeSettings({ offtangent: { attentionMaxAgeHours: 72 } })
    expect(resolveAttentionMaxAgeMs()).toBe(hours(72))
  })

  it.each([
    ['a string', 'soon'],
    ['zero', 0],
    ['negative', -1],
    ['above the range', 721],
    ['fractional', 47.5],
    ['null', null],
    ['an object', { hours: 12 }],
  ])('falls back to the default for %s', (_label, value) => {
    writeSettings({ offtangent: { attentionMaxAgeHours: value } })
    expect(loadAttentionMaxAgeMs()).toBeNull()
    expect(resolveAttentionMaxAgeMs()).toBe(ATTENTION_MAX_AGE_MS)
  })

  it('falls back to the default for a corrupt settings.json', () => {
    fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(tempDataDir, 'config', 'settings.json'), '{ not json', 'utf-8')
    expect(loadAttentionMaxAgeMs()).toBeNull()
    expect(resolveAttentionMaxAgeMs()).toBe(ATTENTION_MAX_AGE_MS)
  })

  it('reads the file again on every call (a change needs no restart)', () => {
    writeSettings({ offtangent: { attentionMaxAgeHours: 10 } })
    expect(resolveAttentionMaxAgeMs()).toBe(hours(10))
    writeSettings({ offtangent: { attentionMaxAgeHours: 11 } })
    expect(resolveAttentionMaxAgeMs()).toBe(hours(11))
  })

  it('prefers the setting over the env override', () => {
    const previous = process.env.AXIOM_ATTENTION_MAX_AGE_MS
    try {
      process.env.AXIOM_ATTENTION_MAX_AGE_MS = String(hours(4))
      writeSettings({ offtangent: { attentionMaxAgeHours: 9 } })
      expect(resolveAttentionMaxAgeMs()).toBe(hours(9))
      // Env stays the documented deployment fallback when the setting is absent
      // or unusable.
      removeSettings()
      expect(resolveAttentionMaxAgeMs()).toBe(hours(4))
      writeSettings({ offtangent: { attentionMaxAgeHours: 0 } })
      expect(resolveAttentionMaxAgeMs()).toBe(hours(4))
    } finally {
      if (previous === undefined) delete process.env.AXIOM_ATTENTION_MAX_AGE_MS
      else process.env.AXIOM_ATTENTION_MAX_AGE_MS = previous
    }
  })

  it('prefers an explicit override over everything else', () => {
    const previous = process.env.AXIOM_ATTENTION_MAX_AGE_MS
    try {
      process.env.AXIOM_ATTENTION_MAX_AGE_MS = String(hours(4))
      writeSettings({ offtangent: { attentionMaxAgeHours: 9 } })
      expect(resolveAttentionMaxAgeMs(hours(2))).toBe(hours(2))
      expect(resolveAttentionMaxAgeMs(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
      // <= 0 is ignored, exactly like the option on getStrandAttentions.
      expect(resolveAttentionMaxAgeMs(0)).toBe(hours(9))
    } finally {
      if (previous === undefined) delete process.env.AXIOM_ATTENTION_MAX_AGE_MS
      else process.env.AXIOM_ATTENTION_MAX_AGE_MS = previous
    }
  })

  it('takes a settings object in hand instead of reading the file', () => {
    writeSettings({ offtangent: { attentionMaxAgeHours: 9 } })
    expect(resolveAttentionMaxAgeMs(undefined, { offtangent: { attentionMaxAgeHours: 3 } })).toBe(hours(3))
    expect(loadAttentionMaxAgeMs({ offtangent: { attentionMaxAgeHours: 'soon' } })).toBeNull()
  })
})
