/**
 * The `interactions` repository (S1-A): every allowed transition, every
 * forbidden one, payload validation through the Core contract, the stale
 * rules (newer question, user continued) and the legacy backfill.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase, type Database } from './database.js'
import {
  INTERACTION_CLOSE_SOURCES,
  INTERACTION_STATUSES,
  InteractionPayloadError,
  InteractionTransitionError,
  backfillInteractions,
  createInteraction,
  getInteraction,
  findInteractionByBlock,
  ingestInteractionMessage,
  interactionEvents,
  isAllowedInteractionTransition,
  listOpenInteractionsForStrands,
  listStrandInteractions,
  supersedeOpenOnUserMessage,
  runInteractionTransaction,
  resetInteractionOutboxWarning,
  bindInteractionRequest,
  interactionValueHash,
  newInteractionId,
  saveInteractionDraft,
  transitionInteraction,
  type InteractionCloseSource,
  type InteractionEvent,
  type InteractionStatus,
} from './interaction-store.js'

const USER = 1
const STRAND = 'strand-a'

function choice(id: string, extra: Record<string, unknown> = {}) {
  return { kind: 'choice', id, question: `Question ${id}?`, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], ...extra }
}

function fence(payload: Record<string, unknown>): string {
  return '```offtangent\n' + JSON.stringify(payload) + '\n```'
}

let db: Database

function addSession(id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id) VALUES (?, NULL)`,
  ).run(id)
}

function addMessage(sessionId: string, role: 'user' | 'assistant', content: string, metadata: string | null = null): number {
  return Number(db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, 'main')`,
  ).run(sessionId, USER, role, content, metadata).lastInsertRowid)
}

function openCard(messageId: number, blockId = 'q1', strandId = STRAND) {
  return createInteraction(db, { strandId, userId: USER, messageId, agent: 'main', payload: choice(blockId) }).record
}

const ANSWER = { value: 'yes', label: 'Yes', answeredAt: '2026-10-24T10:00:00.000Z', clientRequestId: 'req-1', resumed: true }

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'u1', 'x'), (2, 'u2', 'x')").run()
})
afterEach(() => {
  db.close()
})

describe('interactions schema', () => {
  it('creates the table, the partial index on open cards per strand and the migration marker table', () => {
    const cols = (db.prepare('PRAGMA table_info(interactions)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'strand_id', 'message_id', 'tool_call_id', 'block_id', 'agent', 'payload', 'blocking', 'status',
      'answer', 'draft', 'created_at', 'expires_at', 'closed_at', 'closed_surface', 'close_source',
    ]))
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'interactions_open'").get() as { sql: string }
    expect(index.sql).toContain("WHERE status = 'open'")
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'interaction_migrations'").get()).toBeTruthy()
  })

  it('rejects an unknown status at the database level', () => {
    const card = openCard(10)
    expect(() => db.prepare("UPDATE interactions SET status = 'pending' WHERE id = ?").run(card.id)).toThrow()
  })

  it('mints sortable ia_<ulid> ids', () => {
    const a = newInteractionId(1_000)
    const b = newInteractionId(2_000)
    expect(a).toMatch(/^ia_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true)
  })
})

describe('createInteraction', () => {
  it('validates the payload with the Core contract and stores the normalized block', () => {
    const card = openCard(10)
    expect(card.status).toBe('open')
    expect(card.payload).toMatchObject({ kind: 'choice', id: 'q1', options: [{ id: 'yes' }, { id: 'no' }] })
    expect(card.blockId).toBe('q1')
    expect(card.blocking).toBe(true)
  })

  it('throws InteractionPayloadError for a payload outside the contract and for a draft block', () => {
    expect(() => createInteraction(db, { strandId: STRAND, userId: USER, messageId: 1, agent: 'main', payload: { kind: 'choice', id: 'x' } }))
      .toThrow(InteractionPayloadError)
    expect(() => createInteraction(db, { strandId: STRAND, userId: USER, messageId: 1, agent: 'main', payload: { kind: 'draft', id: 'd', text: 'hello' } }))
      .toThrow(InteractionPayloadError)
  })

  it('is idempotent per (message, block)', () => {
    const first = createInteraction(db, { strandId: STRAND, userId: USER, messageId: 10, agent: 'main', payload: choice('q1') })
    const second = createInteraction(db, { strandId: STRAND, userId: USER, messageId: 10, agent: 'main', payload: choice('q1') })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.record.id).toBe(first.record.id)
    expect(listStrandInteractions(db, STRAND)).toHaveLength(1)
  })

  it('supersedes older open cards of the strand as newer_question', () => {
    const older = openCard(10, 'q1')
    const newer = openCard(12, 'q2')
    expect(getInteraction(db, older.id)).toMatchObject({ status: 'superseded', closeSource: 'newer_question', closedSurface: 'system' })
    expect(getInteraction(db, newer.id)!.status).toBe('open')
    expect(listStrandInteractions(db, STRAND, { status: 'open' }).map(r => r.id)).toEqual([newer.id])
  })

  it('emits interaction.open and interaction.updated', () => {
    const events: InteractionEvent[] = []
    const off = interactionEvents.on(e => events.push(e))
    try {
      openCard(10, 'q1')
      openCard(12, 'q2')
    } finally { off() }
    expect(events.map(e => `${e.type}:${e.interaction.blockId}:${e.interaction.status}`))
      .toEqual(['open:q1:open', 'updated:q1:superseded', 'open:q2:open'])
  })
})

describe('transitions', () => {
  const allowed: Array<[InteractionStatus, InteractionStatus, InteractionCloseSource]> = [
    ['open', 'answered', 'answer'],
    ['open', 'dismissed', 'dismiss'],
    ['open', 'superseded', 'user_continued'],
    ['open', 'superseded', 'newer_question'],
    ['open', 'superseded', 'backfill'],
    ['open', 'expired', 'timeout'],
    ['open', 'expired', 'backfill'],
    // Strict contract (review 1, finding 4): nothing leaves a closed state,
    // superseded included. The loop below asserts every other pair throws.
  ]

  function cardIn(status: InteractionStatus) {
    const card = openCard(10)
    if (status === 'open') return card
    if (status === 'superseded') return transitionInteraction(db, card.id, 'superseded', { closeSource: 'user_continued' })
    if (status === 'answered') return transitionInteraction(db, card.id, 'answered', { closeSource: 'answer', answer: ANSWER })
    if (status === 'dismissed') return transitionInteraction(db, card.id, 'dismissed', { closeSource: 'dismiss' })
    return transitionInteraction(db, card.id, 'expired', { closeSource: 'timeout' })
  }

  for (const [from, to, source] of allowed) {
    it(`allows ${from} -> ${to} (${source})`, () => {
      const card = cardIn(from)
      const next = transitionInteraction(db, card.id, to, {
        closeSource: source,
        closedSurface: 'web',
        ...(to === 'answered' ? { answer: ANSWER } : {}),
      })
      expect(next.status).toBe(to)
      expect(next.closeSource).toBe(source)
      expect(next.closedSurface).toBe('web')
      expect(next.closedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
      if (to === 'answered') expect(next.answer).toEqual(ANSWER)
    })
  }

  const allowedKeys = new Set(allowed.map(([f, t, s]) => `${f}>${t}>${s}`))
  for (const from of INTERACTION_STATUSES) {
    for (const to of INTERACTION_STATUSES) {
      const sources = INTERACTION_CLOSE_SOURCES.filter(s => !allowedKeys.has(`${from}>${to}>${s}`))
      if (sources.length === 0) continue
      it(`forbids ${from} -> ${to} for ${sources.join(', ')}`, () => {
        for (const source of sources) {
          expect(isAllowedInteractionTransition(from, to, source)).toBe(false)
          const card = cardIn(from)
          expect(() => transitionInteraction(db, card.id, to, { closeSource: source, answer: ANSWER }))
            .toThrow(InteractionTransitionError)
          // The row is untouched by a rejected transition.
          expect(getInteraction(db, card.id)!.status).toBe(from)
          db.prepare('DELETE FROM interactions').run()
        }
      })
    }
  }

  it('forbids answered -> open explicitly (the example of the plan)', () => {
    const card = cardIn('answered')
    expect(() => transitionInteraction(db, card.id, 'open', { closeSource: 'answer' })).toThrow(/answered -> open/)
  })

  it('refuses an answered transition without an answer', () => {
    const card = openCard(10)
    expect(() => transitionInteraction(db, card.id, 'answered', { closeSource: 'answer' })).toThrow(/needs an answer/)
  })

  it('throws for an unknown id', () => {
    expect(() => transitionInteraction(db, 'ia_missing', 'dismissed', { closeSource: 'dismiss' })).toThrow(/does not exist/)
  })
})

describe('drafts', () => {
  it('stores partial answers on an open card and emits interaction.draft', () => {
    const card = openCard(10)
    const events: InteractionEvent[] = []
    const off = interactionEvents.on(e => events.push(e))
    try {
      expect(saveInteractionDraft(db, card.id, { answers: { q1: 'yes' } }).draft).toEqual({ answers: { q1: 'yes' } })
    } finally { off() }
    expect(events.map(e => e.type)).toEqual(['draft'])
  })

  it('refuses a draft on a closed card and clears the draft when answered', () => {
    const card = openCard(10)
    saveInteractionDraft(db, card.id, { answers: { q1: 'yes' } })
    const answered = transitionInteraction(db, card.id, 'answered', { closeSource: 'answer', answer: ANSWER })
    expect(answered.draft).toBeNull()
    expect(() => saveInteractionDraft(db, card.id, { answers: {} })).toThrow(InteractionTransitionError)
  })
})

describe('stale rule 1 at the persist point (supersedeOpenOnUserMessage, review 1 finding 6)', () => {
  it('there is no SQL trigger any more: a raw user row changes nothing', () => {
    addSession(STRAND)
    const card = openCard(addMessage(STRAND, 'assistant', fence(choice('q1'))))
    addMessage(STRAND, 'user', 'raw insert without the persist hook')
    expect(getInteraction(db, card.id)!.status).toBe('open')
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'interactions%'").all()
    expect(triggers).toEqual([])
  })

  it('a user message supersedes the open cards above it in the DB AND emits interaction.updated', () => {
    addSession(STRAND)
    const msg = addMessage(STRAND, 'assistant', fence(choice('q1')))
    const card = openCard(msg)
    const events: InteractionEvent[] = []
    const off = interactionEvents.on(e => events.push(e))
    try {
      const userRow = addMessage(STRAND, 'user', 'I would rather talk about something else')
      supersedeOpenOnUserMessage(db, STRAND, USER, userRow)
    } finally { off() }
    expect(getInteraction(db, card.id)).toMatchObject({ status: 'superseded', closeSource: 'user_continued' })
    expect(events.map(e => `${e.type}:${e.interaction.id}:${e.interaction.status}`)).toEqual([`updated:${card.id}:superseded`])

    const later = addMessage(STRAND, 'assistant', fence(choice('q2')))
    const second = openCard(later, 'q2')
    expect(getInteraction(db, second.id)!.status).toBe('open')
  })

  it('works across agents and for cards without owner, never for another user or strand', () => {
    addSession(STRAND)
    addSession('strand-b')
    const mine = createInteraction(db, { strandId: STRAND, userId: USER, messageId: 10, agent: 'coder', payload: choice('q1') }).record
    const ownerless = createInteraction(db, { strandId: STRAND, userId: null, messageId: 10, agent: 'main', payload: choice('q2') }).record
    const foreign = createInteraction(db, { strandId: STRAND, userId: 2, messageId: 10, agent: 'main', payload: choice('q3') }).record
    const elsewhere = createInteraction(db, { strandId: 'strand-b', userId: USER, messageId: 13, agent: 'main', payload: choice('q4') }).record
    const closed = supersedeOpenOnUserMessage(db, STRAND, USER, 100)
    expect(closed.map(r => r.id).sort()).toEqual([mine.id, ownerless.id].sort())
    expect(getInteraction(db, foreign.id)!.status).toBe('open')
    expect(getInteraction(db, elsewhere.id)!.status).toBe('open')
  })
})

describe('event outbox (review 1, finding 7)', () => {
  it('a transaction that fails after the transition emits nothing and leaves the card open', () => {
    const card = openCard(10)
    const events: InteractionEvent[] = []
    const off = interactionEvents.on(e => events.push(e))
    try {
      expect(() => runInteractionTransaction(db, () => {
        transitionInteraction(db, card.id, 'dismissed', { closeSource: 'dismiss' })
        throw new Error('boom after the transition')
      })).toThrow('boom after the transition')
    } finally { off() }
    expect(events).toEqual([])
    expect(getInteraction(db, card.id)!.status).toBe('open')
  })

  it('a committed transaction emits its events after the commit, in order', () => {
    const card = openCard(10)
    const seen: string[] = []
    const off = interactionEvents.on(e => {
      // At emit time the change is already committed and visible.
      seen.push(`${e.type}:${getInteraction(db, e.interaction.id)!.status}`)
    })
    try {
      runInteractionTransaction(db, () => {
        saveInteractionDraft(db, card.id, { answers: { q1: 'x' } })
        transitionInteraction(db, card.id, 'dismissed', { closeSource: 'dismiss' })
        expect(seen).toEqual([])
      })
    } finally { off() }
    expect(seen).toEqual(['draft:dismissed', 'updated:dismissed'])
  })
})

describe('expiry before supersede on the live paths (review 2, finding B)', () => {
  const PAST = '2026-10-20T00:00:00.000Z'
  function dueCard(messageId: number, blockId: string) {
    return createInteraction(db, {
      strandId: STRAND, userId: USER, messageId, agent: 'main', payload: choice(blockId, { expiresAt: PAST }),
      now: Date.parse('2026-10-19T00:00:00.000Z'),
    }).record
  }

  it('createInteraction: an older card already past expiresAt becomes expired/timeout, a live one superseded', () => {
    // Same message: cards of one message never supersede each other, and the
    // due card is written with a clock before its expiresAt.
    const live = openCard(10, 'q-live')
    const due = dueCard(10, 'q-due')
    expect(getInteraction(db, due.id)!.status).toBe('open')
    const events: InteractionEvent[] = []
    const off = interactionEvents.on(e => events.push(e))
    try { openCard(20, 'q-new') } finally { off() }
    expect(getInteraction(db, due.id)).toMatchObject({ status: 'expired', closeSource: 'timeout', closedAt: PAST })
    expect(getInteraction(db, live.id)).toMatchObject({ status: 'superseded', closeSource: 'newer_question' })
    expect(events.filter(e => e.type === 'updated').map(e => `${e.interaction.id}:${e.interaction.status}`))
      .toEqual([`${due.id}:expired`, `${live.id}:superseded`])
  })

  it('supersedeOpenOnUserMessage: a card already past expiresAt becomes expired/timeout, a live one superseded', () => {
    const due = dueCard(10, 'q-due')
    const live = openCard(10, 'q-live')
    const closed = supersedeOpenOnUserMessage(db, STRAND, USER, 100)
    expect(closed.map(r => r.id)).toEqual([live.id])
    expect(getInteraction(db, due.id)).toMatchObject({ status: 'expired', closeSource: 'timeout', closedAt: PAST })
    expect(getInteraction(db, live.id)).toMatchObject({ status: 'superseded', closeSource: 'user_continued' })
  })
})

describe('outbox under a foreign transaction (review 2, finding C)', () => {
  it('an outer raw db.transaction that throws after the inner success: card stays open, no event is emitted', () => {
    const card = openCard(10)
    resetInteractionOutboxWarning()
    const events: InteractionEvent[] = []
    const off = interactionEvents.on(e => events.push(e))
    try {
      expect(() => db.transaction(() => {
        runInteractionTransaction(db, () => transitionInteraction(db, card.id, 'dismissed', { closeSource: 'dismiss' }))
        throw new Error('outer boom after the inner commit point')
      })()).toThrow('outer boom')
    } finally { off() }
    expect(getInteraction(db, card.id)!.status).toBe('open')
    expect(events).toEqual([])
  })

  it('a bare transition inside a raw db.transaction emits nothing before (or after) that foreign commit', () => {
    const card = openCard(10)
    const events: InteractionEvent[] = []
    const off = interactionEvents.on(e => events.push(e))
    try {
      expect(() => db.transaction(() => {
        transitionInteraction(db, card.id, 'dismissed', { closeSource: 'dismiss' })
        throw new Error('outer boom')
      })()).toThrow('outer boom')
    } finally { off() }
    expect(getInteraction(db, card.id)!.status).toBe('open')
    expect(events).toEqual([])
  })
})

describe('idempotency keys (review 1, finding 3)', () => {
  it('binds (user, clientRequestId) to one card and one value hash', () => {
    const a = bindInteractionRequest(db, { userId: USER, clientRequestId: 'k1', interactionId: 'ia_a', valueHash: interactionValueHash('yes') })
    expect(a.bound).toBe(true)
    const b = bindInteractionRequest(db, { userId: USER, clientRequestId: 'k1', interactionId: 'ia_b', valueHash: interactionValueHash('no') })
    expect(b).toEqual({ bound: false, binding: { interactionId: 'ia_a', valueHash: interactionValueHash('yes') } })
    // The key space is per user.
    expect(bindInteractionRequest(db, { userId: 2, clientRequestId: 'k1', interactionId: 'ia_b', valueHash: 'h' }).bound).toBe(true)
    expect(interactionValueHash(['a', 'b'])).not.toBe(interactionValueHash('a,b'))
  })
})

describe('ingestInteractionMessage (live path)', () => {
  it('creates one open row per answerable fence card and skips drafts and broken fences', () => {
    addSession(STRAND)
    const content = [
      'Some text', fence(choice('q1')), fence({ kind: 'draft', id: 'd1', text: 'copy me' }), '```offtangent\n{"kind":"choice"\n```',
    ].join('\n\n')
    const msg = addMessage(STRAND, 'assistant', content)
    const records = ingestInteractionMessage(db, { messageId: msg, strandId: STRAND, userId: USER, agent: 'main', content })
    expect(records.map(r => r.blockId)).toEqual(['q1'])
    expect(ingestInteractionMessage(db, { messageId: msg, strandId: STRAND, userId: USER, agent: 'main', content })).toHaveLength(1)
    expect(listStrandInteractions(db, STRAND)).toHaveLength(1)
  })
})

describe('listOpenInteractionsForStrands', () => {
  it('returns only open, unexpired cards of the user', () => {
    const live = openCard(10, 'q1', 'a')
    createInteraction(db, { strandId: 'b', userId: USER, messageId: 11, agent: 'main', payload: choice('q2', { expiresAt: '2000-01-01T00:00:00.000Z' }) })
    createInteraction(db, { strandId: 'c', userId: 2, messageId: 12, agent: 'main', payload: choice('q3') })
    expect(listOpenInteractionsForStrands(db, ['a', 'b', 'c'], USER).map(r => r.id)).toEqual([live.id])
  })
})

describe('lazy expiry while the server runs (S1-A)', () => {
  it('a card whose expiresAt passes is stored as expired/timeout on the next attention read, with an updated event', () => {
    const expiresAt = '2026-10-24T12:00:00.000Z'
    const before = Date.parse(expiresAt) - 60_000
    const after = Date.parse(expiresAt) + 60_000
    const card = createInteraction(db, { strandId: 'b', userId: USER, messageId: 11, agent: 'main', payload: choice('q2', { expiresAt }) }).record
    expect(listOpenInteractionsForStrands(db, ['b'], USER, before).map(r => r.id)).toEqual([card.id])
    expect(getInteraction(db, card.id)!.status).toBe('open')

    const events: InteractionEvent[] = []
    const off = interactionEvents.on(event => { events.push(event) })
    try {
      expect(listOpenInteractionsForStrands(db, ['b'], USER, after)).toEqual([])
    } finally {
      off()
    }
    const stored = getInteraction(db, card.id)!
    expect(stored).toMatchObject({ status: 'expired', closeSource: 'timeout', closedSurface: 'system', closedAt: expiresAt })
    expect(events).toEqual([{ type: 'updated', interaction: stored }])
    // A second read changes nothing and emits nothing.
    const again: InteractionEvent[] = []
    const off2 = interactionEvents.on(event => { again.push(event) })
    try { listOpenInteractionsForStrands(db, ['b'], USER, after + 1000) } finally { off2() }
    expect(again).toEqual([])
  })

  it('the strand list (GET /api/strands/:id/interactions) expires due rows too', () => {
    const expiresAt = '2026-10-24T12:00:00.000Z'
    const due = createInteraction(db, { strandId: STRAND, userId: USER, messageId: 20, agent: 'main', payload: choice('q1', { expiresAt }) }).record
    const live = openCard(20, 'q2') // same message: both stay open side by side
    const now = Date.parse(expiresAt) + 1
    expect(listStrandInteractions(db, STRAND, { status: 'open', now }).map(r => r.id)).toEqual([live.id])
    expect(listStrandInteractions(db, STRAND, { status: 'expired', now }).map(r => r.id)).toEqual([due.id])
  })
})

describe('backfillInteractions', () => {
  const NOW = Date.parse('2026-10-24T12:00:00.000Z')

  // `initDatabase` already ran the one-time backfill over the empty test DB
  // and wrote its marker. A database from before S1-A has no marker: start
  // every test from that state.
  beforeEach(() => {
    db.prepare('DELETE FROM interaction_migrations').run()
  })

  it('takes the owner from sessions.user_id when the message row has none (review 1, finding 1)', () => {
    db.prepare(`INSERT INTO sessions (id, user_id) VALUES ('s-owned', 2)`).run()
    addSession('s-ownerless')
    const owned = Number(db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES ('s-owned', NULL, 'assistant', ?, 'main')`,
    ).run(fence(choice('O'))).lastInsertRowid)
    const ownerless = Number(db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES ('s-ownerless', NULL, 'assistant', ?, 'main')`,
    ).run(fence(choice('N'))).lastInsertRowid)
    backfillInteractions(db, { now: NOW })
    expect(findInteractionByBlock(db, owned, 'O')!.userId).toBe(2)
    expect(findInteractionByBlock(db, ownerless, 'N')!.userId).toBeNull()
  })

  it('expired AND passed over by the user: expired/timeout wins (review 1, finding 5, S0-B client order)', () => {
    addSession('s-both')
    const m = addMessage('s-both', 'assistant', fence(choice('X', { expiresAt: '2026-10-01T00:00:00.000Z' })))
    addMessage('s-both', 'user', 'moved on')
    addMessage('s-both', 'assistant', fence(choice('Y')))
    backfillInteractions(db, { now: NOW })
    expect(findInteractionByBlock(db, m, 'X')).toMatchObject({ status: 'expired', closeSource: 'timeout' })
  })

  it('runs at startup: a fresh database carries the marker', () => {
    const fresh = initDatabase(':memory:')
    try {
      const marker = fresh.prepare('SELECT version FROM interaction_migrations').all()
      expect(marker).toHaveLength(1)
      expect(backfillInteractions(fresh).ran).toBe(false)
    } finally {
      fresh.close()
    }
  })

  /**
   * Fixture: six legacy cards, one per resulting state plus a duplicate.
   *  A answered (metadata answer map)          -> answered / answer
   *  B expired (expiresAt in the past)        -> expired / timeout
   *  C user wrote afterwards                  -> superseded / user_continued
   *  D passed over by a newer card (E)        -> superseded / newer_question
   *  E newest card, nothing after it          -> open
   *  E' same block id again in the same message (duplicate) -> skipped
   */
  function seedFixture() {
    addSession('s-answered')
    addSession('s-expired')
    addSession('s-continued')
    addSession('s-open')
    const a = addMessage('s-answered', 'assistant', fence(choice('A')), JSON.stringify({
      interactionAnswers: { A: { blockId: 'A', value: 'yes', label: 'Yes', answeredAt: '2026-10-20T10:00:00.000Z', clientMessageId: 'cm-a', resumed: true } },
    }))
    const b = addMessage('s-expired', 'assistant', fence(choice('B', { expiresAt: '2026-10-01T00:00:00.000Z' })))
    const c = addMessage('s-continued', 'assistant', fence(choice('C')))
    addMessage('s-continued', 'user', 'never mind')
    const d = addMessage('s-open', 'assistant', fence(choice('D')))
    const e = addMessage('s-open', 'assistant', `${fence(choice('E'))}\n\n${fence(choice('E'))}`)
    return { a, b, c, d, e }
  }

  it('maps every legacy card to its state per stale rule B4 and skips the duplicate', () => {
    const ids = seedFixture()
    const { ran, stats } = backfillInteractions(db, { now: NOW })
    expect(ran).toBe(true)
    const byBlock = Object.fromEntries(
      (db.prepare('SELECT block_id, status, close_source, message_id, answer FROM interactions').all() as Array<Record<string, unknown>>)
        .map(r => [r.block_id, r]),
    )
    expect(Object.keys(byBlock).sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(byBlock.A).toMatchObject({ status: 'answered', close_source: 'answer', message_id: ids.a })
    expect(JSON.parse(byBlock.A!.answer as string)).toMatchObject({ value: 'yes', clientRequestId: 'cm-a' })
    expect(byBlock.B).toMatchObject({ status: 'expired', close_source: 'timeout' })
    expect(byBlock.C).toMatchObject({ status: 'superseded', close_source: 'user_continued' })
    expect(byBlock.D).toMatchObject({ status: 'superseded', close_source: 'newer_question' })
    expect(byBlock.E).toMatchObject({ status: 'open', close_source: null, message_id: ids.e })
    expect(stats).toMatchObject({ inserted: 5, answered: 1, expired: 1, superseded: 2, open: 1 })
  })

  it('marks cards of a deleted strand as superseded with close_source backfill', () => {
    const msg = addMessage('gone', 'assistant', fence(choice('G')))
    backfillInteractions(db, { now: NOW })
    expect(db.prepare('SELECT status, close_source FROM interactions WHERE message_id = ?').get(msg))
      .toEqual({ status: 'superseded', close_source: 'backfill' })
  })

  it('runs once: the marker makes a second run a no-op, and a forced rerun inserts nothing twice', () => {
    seedFixture()
    expect(backfillInteractions(db, { now: NOW }).ran).toBe(true)
    expect(backfillInteractions(db, { now: NOW }).ran).toBe(false)
    const forced = backfillInteractions(db, { now: NOW, force: true })
    expect(forced.stats.inserted).toBe(0)
    expect(forced.stats.skippedExisting).toBe(5)
    expect((db.prepare('SELECT COUNT(*) AS n FROM interactions').get() as { n: number }).n).toBe(5)
  })
})
