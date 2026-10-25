/**
 * S1-B, B2: the answer path of an ask_user card (answerById with `answers`).
 *
 *  - body {clientRequestId, answers:{[qid]:{selected, comment?}}}
 *  - validation against the card (validateAskUserAnswer), error text without user values
 *  - user row with replyToInteractionId in its metadata; turn text = formatAskUserAnswerBlock
 *  - idempotency and state machine of S1-A unchanged (hash over canonical answers)
 *  - dismiss: no turn; blocking=false: stored, no turn
 *  - sealing: ask_user payload (question, labels, descriptions) and comment
 *  - interaction.pending frame: toolCallId and count only
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createInteraction,
  getInteraction,
  initDatabase,
  invalidateKnownValues,
  invalidateSecretHandleCache,
  parseAskUserArgs,
  redactAskUserArgs,
  resolveSecret,
  SECRET_HANDLE_RE,
} from '@axiom/core'
import type { Database, InteractionRecord } from '@axiom/core'
import { createInteractionsService, InteractionServiceError } from './service.js'
import { registerInteractionBroadcast } from '../../../interaction-broadcast.js'
import { sealedInteraction } from '../../../interaction-seal.js'
import { interactionPendingFrame } from '../../../ws-chat.js'
import { parseAnswerByIdBody } from './schema.js'

/** `ghp_` plus 36 alphanumerics — matched by the `github-token` rule. */
const STRONG_CANARY = ['ghp', '_', 'C4n4ry', 'Fake', 'Token', '0000', 'abcdefghij', 'klmnopqr'].join('')
const USER_VALUE = 'UserValue-7781'

let tmpDir: string
let previous: Record<string, string | undefined> = {}
let db: Database
let turns: Array<Record<string, unknown>> = []

const handles = (text: string) => [...text.matchAll(new RegExp(SECRET_HANDLE_RE.source, 'g'))].map(m => m[1]!)

function makeService() {
  return createInteractionsService({
    db,
    getTurnRunner: () => ({ startTurn: (input: Record<string, unknown>) => { turns.push(input); return {} } } as never),
  })
}

function insertAskUser(opts: { blocking?: boolean; secret?: boolean; toolCallId?: string; strand?: string } = {}): InteractionRecord {
  const secret = opts.secret ? ` ${STRONG_CANARY}` : ''
  const parsed = parseAskUserArgs({
    blocking: opts.blocking ?? true,
    questions: [
      {
        id: 'q1', type: 'choice', question: `Welcher Token?${secret}`, allowComment: true,
        options: [{ id: 'old', label: `den alten${secret}`, description: `seit 2024${secret}` }, { id: 'new', label: 'neu' }],
      },
      { id: 'q2', type: 'multi', question: 'Welche Umgebungen?', options: [{ id: 'dev', label: 'Dev' }, { id: 'prod', label: 'Prod' }] },
    ],
  }, { id: opts.toolCallId ?? 'call_1' })
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error}`)
  const messageId = Number(db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', 'frag mich', 'main')`,
  ).run(opts.strand ?? 'strand-a').lastInsertRowid)
  return createInteraction(db, {
    strandId: opts.strand ?? 'strand-a', userId: 1, messageId, agent: 'main', payload: parsed.value,
    toolCallId: opts.toolCallId ?? 'call_1', blockId: null, blocking: parsed.value.blocking,
  }).record
}

const goodAnswers = () => ({ q1: { selected: ['old'], comment: 'bitte rotieren' }, q2: { selected: ['prod', 'dev'] } })

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1b-answer-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-s1b-answer-tests'
  invalidateSecretHandleCache()
  invalidateKnownValues()
  turns = []
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('strand-a', 1, 'main', 'S', 'interactive')").run()
})

afterEach(() => {
  db.close()
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

describe('S1-B answer body (schema)', () => {
  it('accepts {clientRequestId, answers} and rejects value+answers together or a bad shape', () => {
    expect(parseAnswerByIdBody({ clientRequestId: 'c1', answers: { q1: { selected: ['a'] } } }).ok).toBe(true)
    expect(parseAnswerByIdBody({ clientRequestId: 'c1', value: 'a', answers: { q1: { selected: ['a'] } } }).ok).toBe(false)
    expect(parseAnswerByIdBody({ clientRequestId: 'c1', answers: { q1: { selected: 'a' } } }).ok).toBe(false)
    expect(parseAnswerByIdBody({ clientRequestId: 'c1', answers: { q1: { selected: ['a'], comment: 'x'.repeat(2001) } } }).ok).toBe(false)
    expect(parseAnswerByIdBody({ answers: { q1: { selected: ['a'] } } }).ok).toBe(false)
  })
})

describe('S1-B answerById with answers', () => {
  it('blocking: answers, files the user row with replyToInteractionId and starts one turn with the block', () => {
    const card = insertAskUser()
    const service = makeService()
    const result = service.answerById(1, card.id, { clientRequestId: 'cr-1', answers: goodAnswers(), surface: 'web' })
    expect(result).toMatchObject({ applied: true, resumed: true, idempotent: false })
    expect(getInteraction(db, card.id)).toMatchObject({ status: 'answered', closeSource: 'answer' })
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ sessionId: 'strand-a', replyToInteractionId: card.id, inputMode: 'answer' })
    const text = String(turns[0]!.text)
    expect(text).toContain(`<interaction_answer id="${card.id}" source="ask_user">`)
    expect(text).toContain('Gewählt: den alten [old]')
    expect(text).toContain('Kommentar: bitte rotieren')
    // selected keeps the order the user picked
    expect(text).toContain('Gewählt: Prod [prod], Dev [dev]')
    const rows = db.prepare("SELECT content, metadata FROM chat_messages WHERE role = 'user' AND client_message_id = 'cr-1'").all() as Array<{ content: string; metadata: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe(text)
    expect(JSON.parse(rows[0]!.metadata)).toMatchObject({ type: 'interaction_answer', replyToInteractionId: card.id })
  })

  it('S1-C telegram review 1: a custom starter (Telegram) that throws leaves resumed=false (502 turn_failed); the same key retried with a working starter resumes once', () => {
    const card = insertAskUser()
    const service = makeService()
    let caught: unknown = null
    try {
      service.answerById(1, card.id, {
        clientRequestId: 'tg:cbq-1', answers: goodAnswers(), surface: 'telegram',
        startTurn: () => { throw new Error('runner refused') },
      })
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(InteractionServiceError)
    expect(caught).toMatchObject({ status: 502, code: 'turn_failed' })
    expect(getInteraction(db, card.id)).toMatchObject({ status: 'answered' })
    expect(getInteraction(db, card.id)!.answer!.resumed).toBe(false)
    expect(turns).toHaveLength(0)
    const started: Array<Record<string, unknown>> = []
    const retry = service.answerById(1, card.id, {
      clientRequestId: 'tg:cbq-1', answers: goodAnswers(), surface: 'telegram',
      startTurn: (input) => { started.push(input as unknown as Record<string, unknown>) },
    })
    expect(retry).toMatchObject({ resumed: true })
    expect(started).toHaveLength(1)
    expect(getInteraction(db, card.id)!.answer!.resumed).toBe(true)
    expect(turns).toHaveLength(0)
  })

  it('review K0-K2-4 #4: a starter that throws with private text logs the class only', () => {
    const MARKER = 'PRIVATE_CLOCK_DICTATION_MARKER_INTERACTION'
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    try {
      const card = insertAskUser()
      expect(() => makeService().answerById(1, card.id, {
        clientRequestId: 'tg:cbq-echo', answers: goodAnswers(), surface: 'telegram',
        startTurn: () => { throw new Error(`runner refused: ${MARKER}`) },
      })).toThrow(expect.objectContaining({ status: 502, code: 'turn_failed' }))
      const logged = spies.flatMap(spy => spy.mock.calls.flat())
        .map(arg => arg instanceof Error ? `${arg.message}\n${arg.stack ?? ''}` : String(arg)).join('\n')
      expect(logged).toContain('did not start: error')
      expect(logged).not.toContain(MARKER)
    } finally { spies.forEach(spy => spy.mockRestore()) }
  })

  it('S1-C telegram review 2: resume retry from the row — the Telegram starter, no default runner, the key from answer.clientRequestId and no answers', () => {
    const card = insertAskUser()
    // No getTurnRunner: only the starter Telegram passes with the call.
    const service = createInteractionsService({ db })
    expect(() => service.answerById(1, card.id, {
      clientRequestId: 'tg:cbq-r2', answers: goodAnswers(), surface: 'telegram',
      startTurn: () => { throw new Error('runner refused') },
    })).toThrow(expect.objectContaining({ status: 502, code: 'turn_failed' }))
    const row = getInteraction(db, card.id)!
    expect(row.answer).toMatchObject({ resumed: false, clientRequestId: 'tg:cbq-r2' })
    const started: unknown[] = []
    const retry = service.answerById(1, card.id, {
      clientRequestId: row.answer!.clientRequestId!, surface: 'telegram',
      startTurn: (input: unknown) => { started.push(input) },
    } as never)
    expect(retry).toMatchObject({ resumed: true, idempotent: true })
    expect(started).toHaveLength(1)
    expect(getInteraction(db, card.id)!.answer!.resumed).toBe(true)
    // Done: the same key with its answers again is idempotent and starts nothing; another key is 409.
    // (Telegram itself does not call the port once the row says resumed=true.)
    expect(service.answerById(1, card.id, {
      clientRequestId: 'tg:cbq-r2', answers: goodAnswers(), surface: 'telegram', startTurn: (input: unknown) => { started.push(input) },
    })).toMatchObject({ resumed: true, idempotent: true })
    expect(started).toHaveLength(1)
    expect(() => service.answerById(1, card.id, {
      clientRequestId: 'tg:cbq-r3', answers: goodAnswers(), surface: 'telegram', startTurn: (input: unknown) => { started.push(input) },
    })).toThrow(expect.objectContaining({ status: 409 }))
  })

  it('idempotency: same key and same answers (other key order) is one answer, one turn', () => {
    const card = insertAskUser()
    const service = makeService()
    service.answerById(1, card.id, { clientRequestId: 'cr-1', answers: goodAnswers(), surface: 'web' })
    const reordered = { q2: { selected: ['prod', 'dev'] }, q1: { comment: 'bitte rotieren', selected: ['old'] } }
    const again = service.answerById(1, card.id, { clientRequestId: 'cr-1', answers: reordered, surface: 'web' })
    expect(again.idempotent).toBe(true)
    expect(turns).toHaveLength(1)
    const n = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user' AND client_message_id = 'cr-1'").get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('409: the same key with other answers, and a second key on an answered card', () => {
    const card = insertAskUser()
    const service = makeService()
    service.answerById(1, card.id, { clientRequestId: 'cr-1', answers: goodAnswers(), surface: 'web' })
    const other = { q1: { selected: ['new'] }, q2: { selected: ['dev'] } }
    expect(() => service.answerById(1, card.id, { clientRequestId: 'cr-1', answers: other, surface: 'web' })).toThrow(InteractionServiceError)
    try {
      service.answerById(1, card.id, { clientRequestId: 'cr-2', answers: other, surface: 'web' })
      throw new Error('expected 409')
    } catch (err) {
      expect((err as InteractionServiceError).status).toBe(409)
    }
    expect(turns).toHaveLength(1)
  })

  it('400 for invalid answers; the error never echoes a user value; the card stays open', () => {
    const card = insertAskUser()
    const service = makeService()
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unknown option', { q1: { selected: [USER_VALUE] }, q2: { selected: ['dev'] } }],
      ['unknown question', { q1: { selected: ['old'] }, q2: { selected: ['dev'] }, [USER_VALUE]: { selected: ['x'] } }],
      ['missing question', { q1: { selected: ['old'] } }],
      ['two picks on choice', { q1: { selected: ['old', 'new'] }, q2: { selected: ['dev'] } }],
      ['comment not allowed', { q1: { selected: ['old'] }, q2: { selected: ['dev'], comment: USER_VALUE } }],
      ['comment too long', { q1: { selected: ['old'], comment: USER_VALUE + 'x'.repeat(2001) }, q2: { selected: ['dev'] } }],
      ['other without comment', { q1: { selected: ['other'] }, q2: { selected: ['dev'] } }],
    ]
    for (const [name, answers] of cases) {
      let caught: unknown
      try { service.answerById(1, card.id, { clientRequestId: `cr-${name}`, answers: answers as never, surface: 'web' }) } catch (err) { caught = err }
      expect(caught, name).toBeInstanceOf(InteractionServiceError)
      expect((caught as InteractionServiceError).status, name).toBe(400)
      expect((caught as Error).message, name).not.toContain(USER_VALUE)
    }
    expect(getInteraction(db, card.id)?.status).toBe('open')
    expect(turns).toHaveLength(0)
  })

  it('"other" with a comment is accepted when the question allows comments', () => {
    const card = insertAskUser()
    const service = makeService()
    service.answerById(1, card.id, { clientRequestId: 'cr-o', answers: { q1: { selected: ['other'], comment: 'einen dritten' }, q2: { selected: ['dev'] } }, surface: 'web' })
    expect(String(turns[0]!.text)).toContain('Kommentar: einen dritten')
  })

  it('an ask_user card needs answers (value alone is 400)', () => {
    const card = insertAskUser()
    expect(() => makeService().answerById(1, card.id, { clientRequestId: 'cr-v', value: 'old', surface: 'web' })).toThrow(/answers is required/)
  })

  it('blocking=false: the answer is stored, no user row, no turn', () => {
    const card = insertAskUser({ blocking: false })
    const result = makeService().answerById(1, card.id, { clientRequestId: 'cr-nb', answers: goodAnswers(), surface: 'web' })
    expect(result).toMatchObject({ applied: true, resumed: false })
    expect(getInteraction(db, card.id)?.status).toBe('answered')
    expect(turns).toHaveLength(0)
    const n = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE client_message_id = 'cr-nb'").get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('S1-D: blocking=false answered during a running tool batch goes into that turn as a steer (no turn, resumed once delivered)', async () => {
    const card = insertAskUser({ blocking: false })
    const offers: Array<Record<string, unknown>> = []
    const service = createInteractionsService({
      db,
      getTurnRunner: () => ({
        startTurn: (input: Record<string, unknown>) => { turns.push(input); return {} },
        offerSteerToLiveTurn: (input: Record<string, unknown>) => { offers.push(input); return { accepted: true, turnId: 'turn-live', settled: Promise.resolve(true) } },
      } as never),
    })
    const result = service.answerById(1, card.id, { clientRequestId: 'cr-nb-steer', answers: goodAnswers(), surface: 'web' })
    expect(result).toMatchObject({ applied: true, resumed: false, steered: { turnId: 'turn-live' } })
    expect(turns).toHaveLength(0)
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({ sessionId: card.strandId, preformatted: true })
    // The steer text is the structured answer block of this card.
    expect(String(offers[0]!.text)).toContain(card.id)
    await new Promise(r => setTimeout(r, 0))
    // Delivered: marked resumed, so the next turn's context notes skip it.
    expect(getInteraction(db, card.id)?.answer?.resumed).toBe(true)
  })

  it('S1-D: a throwing steer offer is logged as class only, never with the error text (review K0-K2-5 merge sweep)', async () => {
    const card = insertAskUser({ blocking: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const service = createInteractionsService({
      db,
      getTurnRunner: () => ({
        startTurn: (input: Record<string, unknown>) => { turns.push(input); return {} },
        offerSteerToLiveTurn: () => { throw new Error('steer refused: PRIVATE_CLOCK_DICTATION_MARKER_007') },
      } as never),
    })
    try {
      const result = service.answerById(1, card.id, { clientRequestId: 'cr-nb-throw', answers: goodAnswers(), surface: 'web' })
      expect(result).not.toHaveProperty('steered')
      const logged = warn.mock.calls.map(c => c.map(String).join(' ')).join('\n')
      expect(logged).toContain('Steer of the answer to')
      expect(logged).not.toContain('PRIVATE_CLOCK_DICTATION_MARKER_007')
    } finally {
      warn.mockRestore()
    }
  })

  it('S1-D: blocking=false with no tool batch running (steer refused) stays a context note for the next turn', async () => {
    const card = insertAskUser({ blocking: false })
    const service = createInteractionsService({
      db,
      getTurnRunner: () => ({
        startTurn: (input: Record<string, unknown>) => { turns.push(input); return {} },
        offerSteerToLiveTurn: () => ({ accepted: false, reason: 'not_in_tool_phase' }),
      } as never),
    })
    const result = service.answerById(1, card.id, { clientRequestId: 'cr-nb-q', answers: goodAnswers(), surface: 'web' })
    expect(result).not.toHaveProperty('steered')
    expect(turns).toHaveLength(0)
    await new Promise(r => setTimeout(r, 0))
    expect(getInteraction(db, card.id)?.answer?.resumed).toBe(false)
  })

  it('dismiss: closes the card without a turn', () => {
    const card = insertAskUser()
    makeService().dismiss(1, card.id, 'web')
    expect(getInteraction(db, card.id)?.status).toBe('dismissed')
    expect(turns).toHaveLength(0)
  })
})

describe('S1-B sealing of the ask_user payload and comment (canary)', () => {
  it('payload strings are sealed recursively in sealedInteraction and frames; ids stay', () => {
    const frames: Array<Record<string, unknown>> = []
    const off = registerInteractionBroadcast({ chatEventBus: { broadcast: (e: Record<string, unknown>) => { frames.push(e) } } as never })
    let card: InteractionRecord
    try {
      card = insertAskUser({ secret: true })
      makeService().answerById(1, card.id, { clientRequestId: 'cr-s', answers: { q1: { selected: ['old'], comment: `nimm ${STRONG_CANARY}` }, q2: { selected: ['dev'] } }, surface: 'web' })
    } finally {
      off()
    }
    const sealed = sealedInteraction(getInteraction(db, card!.id)!)
    expect(JSON.stringify(sealed)).not.toContain(STRONG_CANARY)
    const payload = sealed.payload as unknown as { questions: Array<{ id: string; question: string; options: Array<{ id: string; label: string; description?: string }> }> }
    expect(handles(payload.questions[0]!.question)).toHaveLength(1)
    expect(handles(payload.questions[0]!.options[0]!.label)).toHaveLength(1)
    expect(handles(payload.questions[0]!.options[0]!.description!)).toHaveLength(1)
    expect(payload.questions.map(q => q.id)).toEqual(['q1', 'q2'])
    expect(frames.map(f => f.type)).toEqual(expect.arrayContaining(['interaction.open', 'interaction.updated']))
    for (const frame of frames) expect(JSON.stringify(frame)).not.toContain(STRONG_CANARY)
    // the typed comment passes the boundary before it becomes a user row / turn
    for (const turn of turns) expect(String(turn.text)).not.toContain(STRONG_CANARY)
    const userRows = db.prepare("SELECT content FROM chat_messages WHERE role = 'user'").all() as Array<{ content: string }>
    for (const row of userRows) expect(row.content).not.toContain(STRONG_CANARY)
    const commentRow = userRows.find(r => r.content.includes('Kommentar:'))!
    expect(handles(commentRow.content).map(h => resolveSecret(h))).toContain(STRONG_CANARY)
  })
})

describe('S1-B interaction.pending frame', () => {
  it('carries toolCallId and question count only, never the arguments', () => {
    const args = { questions: [{ type: 'choice', question: `Q ${STRONG_CANARY}`, options: [{ id: 'a', label: STRONG_CANARY }] }] }
    const frame = interactionPendingFrame({ type: 'tool_call_start', toolName: 'ask_user', toolCallId: 'call_p', toolArgs: redactAskUserArgs(args) }, 'strand-a', 'main')
    expect(frame).toEqual({ type: 'interaction.pending', sessionId: 'strand-a', agentId: 'main', toolCallId: 'call_p', questionCount: 1 })
    expect(JSON.stringify(frame)).not.toContain(STRONG_CANARY)
  })
})

describe('review 2 S1-C, B1: resume retry without a value hash', () => {
  let failTurns = 0
  beforeEach(() => {
    failTurns = 0
    db.prepare("INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('strand-b', 1, 'main', 'S2', 'interactive')").run()
  })
  const flakyService = () => createInteractionsService({
    db,
    getTurnRunner: () => ({
      startTurn: (input: Record<string, unknown>) => {
        if (failTurns > 0) { failTurns--; throw new Error('runner down') }
        turns.push(input)
        return {}
      },
    } as never),
  })
  const status = (fn: () => unknown): { status: number; code: string } => {
    try { fn() } catch (err) {
      const e = err as InteractionServiceError
      return { status: e.status, code: e.code }
    }
    return { status: 200, code: 'ok' }
  }
  const sealedComment = { q1: { selected: ['old'], comment: `rotieren ${STRONG_CANARY}` }, q2: { selected: ['dev'] } }
  /** What the client can rebuild after a reload: the sealed items of the row. */
  const rebuiltFromRow = (card: InteractionRecord) => {
    const items = (sealedInteraction(getInteraction(db, card.id)!).answer as unknown as { items: Array<{ questionId: string; selected: Array<{ id: string }>; comment?: string }> }).items
    const out: Record<string, { selected: string[]; comment?: string }> = {}
    for (const item of items) out[item.questionId] = { selected: item.selected.map(o => o.id), ...(item.comment ? { comment: item.comment } : {}) }
    return out
  }

  it('a retry with a sealed (other) comment after a 502 starts the turn again and answers 200', () => {
    const card = insertAskUser()
    const service = flakyService()
    failTurns = 1
    expect(status(() => service.answerById(1, card.id, { clientRequestId: 'rr-1', answers: sealedComment, surface: 'web' }))).toMatchObject({ status: 502, code: 'turn_failed' })
    expect(getInteraction(db, card.id)!.answer!.resumed).toBe(false)
    const rebuilt = rebuiltFromRow(card)
    // The sealing really changed the comment, so the old hash cannot match.
    expect(rebuilt.q1!.comment).not.toBe(sealedComment.q1.comment)
    expect(rebuilt.q1!.comment).not.toContain(STRONG_CANARY)
    // A second failure stays 502 retryable.
    failTurns = 1
    expect(status(() => service.answerById(1, card.id, { clientRequestId: 'rr-1', answers: rebuilt, surface: 'web' }))).toMatchObject({ status: 502 })
    const retry = service.answerById(1, card.id, { clientRequestId: 'rr-1', answers: rebuilt, surface: 'web' })
    expect(retry).toMatchObject({ applied: true, resumed: true, idempotent: true })
    expect(retry.interaction?.answer?.resumed).toBe(true)
    expect(turns).toHaveLength(1)
    const n = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user' AND client_message_id = 'rr-1'").get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('the body value may be missing or arbitrary on a resume retry; control: the unchanged value works too', () => {
    const a = insertAskUser({ toolCallId: 'call_a' })
    const b = insertAskUser({ toolCallId: 'call_b', strand: 'strand-b' })
    const service = flakyService()
    failTurns = 2
    expect(status(() => service.answerById(1, a.id, { clientRequestId: 'rr-a', answers: goodAnswers(), surface: 'web' })).status).toBe(502)
    expect(status(() => service.answerById(1, b.id, { clientRequestId: 'rr-b', answers: goodAnswers(), surface: 'web' })).status).toBe(502)
    expect(service.answerById(1, a.id, { clientRequestId: 'rr-a', surface: 'web' } as never)).toMatchObject({ resumed: true })
    expect(service.answerById(1, b.id, { clientRequestId: 'rr-b', answers: goodAnswers(), surface: 'web' })).toMatchObject({ resumed: true })
    expect(turns).toHaveLength(2)
  })

  it('the key of a resumed=false card sent to another card is still 409 idempotency_conflict', () => {
    const card = insertAskUser({ toolCallId: 'call_a' })
    const other = insertAskUser({ toolCallId: 'call_b', strand: 'strand-b' })
    const service = flakyService()
    failTurns = 1
    expect(status(() => service.answerById(1, card.id, { clientRequestId: 'rr-x', answers: goodAnswers(), surface: 'web' })).status).toBe(502)
    expect(status(() => service.answerById(1, other.id, { clientRequestId: 'rr-x', answers: goodAnswers(), surface: 'web' }))).toEqual({ status: 409, code: 'idempotency_conflict' })
    expect(getInteraction(db, other.id)!.status).toBe('open')
    expect(turns).toHaveLength(0)
  })

  it('on a resumed=true card the same key with another value stays 409', () => {
    const card = insertAskUser()
    const service = flakyService()
    service.answerById(1, card.id, { clientRequestId: 'rr-2', answers: goodAnswers(), surface: 'web' })
    expect(getInteraction(db, card.id)!.answer!.resumed).toBe(true)
    const other = { q1: { selected: ['new'] }, q2: { selected: ['dev'] } }
    expect(status(() => service.answerById(1, card.id, { clientRequestId: 'rr-2', answers: other, surface: 'web' }))).toEqual({ status: 409, code: 'idempotency_conflict' })
    expect(turns).toHaveLength(1)
  })

  it('review 3: a foreign owner retrying with the known key on an answered resumed=false card gets 404, no turn, no extra user row', () => {
    const card = insertAskUser()
    const service = flakyService()
    failTurns = 1
    expect(status(() => service.answerById(1, card.id, { clientRequestId: 'rr-own', answers: goodAnswers(), surface: 'web' })).status).toBe(502)
    expect(getInteraction(db, card.id)!.status).toBe('answered')
    expect(getInteraction(db, card.id)!.answer!.resumed).toBe(false)
    const userRows = () => (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'").get() as { n: number }).n
    const before = userRows()
    expect(status(() => service.answerById(2, card.id, { clientRequestId: 'rr-own', answers: goodAnswers(), surface: 'web' }))).toEqual({ status: 404, code: 'unknown_interaction' })
    expect(status(() => service.answerById(2, card.id, { clientRequestId: 'rr-own', surface: 'web' } as never))).toEqual({ status: 404, code: 'unknown_interaction' })
    expect(turns).toHaveLength(0)
    expect(userRows()).toBe(before)
    expect(getInteraction(db, card.id)!.answer!.resumed).toBe(false)
  })
})
