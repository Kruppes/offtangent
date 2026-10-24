/**
 * S1-C (Telegram): question cards as inline keyboards, end to end against the
 * real interactions service (registered as the core InteractionAnswerPort)
 * and a mocked Telegram Bot API.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createInteraction,
  getInteraction,
  ingestInteractionMessage,
  initDatabase,
  invalidateKnownValues,
  invalidateSecretHandleCache,
  parseAskUserArgs,
  registerInteractionAnswerPort,
} from '@axiom/core'
import type { Database, InteractionRecord } from '@axiom/core'
import { TelegramInteractionCards, CALLBACK_DATA_MAX_BYTES, COMMENT_WINDOW_MS } from '@axiom/telegram'
import type { CardCallback } from '@axiom/telegram'
import { createInteractionsService } from './service.js'

const CHAT = 4242
const OTHER_CHAT = 9999

let tmpDir: string
let previous: Record<string, string | undefined> = {}
let db: Database
let unregister: () => void
let now = 1_800_000_000_000
let turns: Array<Record<string, unknown>> = []
let sent: Array<{ chatId: number | string; text: string; other?: Record<string, unknown> }> = []
let edits: Array<{ chatId: number | string; messageId: number; text: string; other?: Record<string, unknown> }> = []
let cards: TelegramInteractionCards
let unsubscribe: () => void
let cbSeq = 0

type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }

function makeCards() {
  let nextId = 100
  return new TelegramInteractionCards({
    api: {
      sendMessage: async (chatId, text, other) => { sent.push({ chatId, text, other }); return { message_id: nextId++ } },
      editMessageText: async (chatId, messageId, text, other) => { edits.push({ chatId, messageId, text, other }); return true },
    },
    db,
    getPort: () => createInteractionsService({ db }),
    startTurn: (chat, input) => { turns.push({ chatId: chat.chatId, ...input }) },
    now: () => now,
  })
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function insertFence(fence: Record<string, unknown>, strand = 'strand-a'): InteractionRecord {
  const content = `Your call.\n\n\`\`\`offtangent\n${JSON.stringify(fence)}\n\`\`\``
  const messageId = Number(db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'assistant', ?, 'main')`,
  ).run(strand, content).lastInsertRowid)
  const [record] = ingestInteractionMessage(db, { messageId, strandId: strand, userId: 1, agent: 'main', content })
  return record!
}

function insertAskUser(questions: unknown[], toolCallId = 'call_1'): InteractionRecord {
  const parsed = parseAskUserArgs({ blocking: true, questions }, { id: toolCallId })
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error}`)
  const messageId = Number(db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES ('strand-a', 1, 'user', 'frag mich', 'main')`,
  ).run().lastInsertRowid)
  return createInteraction(db, {
    strandId: 'strand-a', userId: 1, messageId, agent: 'main', payload: parsed.value,
    toolCallId, blockId: null, blocking: parsed.value.blocking,
  }).record
}

const FENCE = {
  block: 'choice', id: 'b1', question: 'Hand this to Bob?',
  options: [{ id: 'yes', label: 'Hand over to Bob' }, { id: 'stay', label: 'Keep it here' }],
}

function lastKeyboard(): Keyboard {
  const edit = [...edits].reverse().find(e => e.other?.reply_markup)
  const markup = (edit?.other?.reply_markup ?? sent.at(-1)?.other?.reply_markup) as Keyboard
  return markup
}

function button(label: string, keyboard: Keyboard = lastKeyboard()): string {
  const found = keyboard.inline_keyboard.flat().find(b => b.text.includes(label))
  if (!found) throw new Error(`no button "${label}" in ${JSON.stringify(keyboard)}`)
  return found.callback_data
}

function tap(data: string, opts: { chatId?: number; userId?: number | null; id?: string } = {}): Promise<boolean> & { answers: string[] } {
  const answers: string[] = []
  const cb: CardCallback = {
    data,
    callbackQueryId: opts.id ?? `cbq-${++cbSeq}`,
    chatId: opts.chatId ?? CHAT,
    messageId: 100,
    fromUserId: opts.userId === undefined ? 1 : opts.userId,
    answer: async (text?: string) => { answers.push(text ?? '') },
  }
  const promise = cards.handleCallback(cb) as Promise<boolean> & { answers: string[] }
  promise.answers = answers
  return promise
}

/** Open a card: the bot knows the chat of the strand, then the store emits interaction.open. */
async function open(create: () => InteractionRecord): Promise<InteractionRecord> {
  cards.rememberChat('strand-a', { chatId: CHAT, isGroup: false })
  const record = create()
  await flush()
  return record
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1c-tg-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-s1b-answer-tests'
  invalidateSecretHandleCache()
  invalidateKnownValues()
  turns = []
  sent = []
  edits = []
  now = 1_800_000_000_000
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'other', 'x', 'user')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('strand-a', 1, 'main', 'S', 'interactive')").run()
  unregister = registerInteractionAnswerPort(createInteractionsService({ db }))
  cards = makeCards()
  unsubscribe = cards.subscribe()
})

afterEach(() => {
  unsubscribe()
  unregister()
  db.close()
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

describe('S1-C Telegram cards', () => {
  it('fence card: sent with one button per option and Verwerfen; a tap answers, starts the turn in this chat and removes the keyboard', async () => {
    const record = await open(() => insertFence(FENCE))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.chatId).toBe(CHAT)
    expect(sent[0]!.text).toContain('Hand this to Bob?')
    const labels = (sent[0]!.other!.reply_markup as Keyboard).inline_keyboard.flat().map(b => b.text)
    expect(labels).toEqual(['Hand over to Bob', 'Keep it here', '✖️ Verwerfen'])

    await tap(button('Hand over to Bob'))
    const stored = getInteraction(db, record.id)!
    expect(stored.status).toBe('answered')
    expect(stored.closedSurface).toBe('telegram')
    expect(stored.answer!.value).toBe('yes')
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ chatId: CHAT, sessionId: 'strand-a', source: 'telegram', inputMode: 'answer' })
    const final = edits.at(-1)!
    expect(final.text).toContain('✅ Beantwortet: Hand over to Bob')
    expect((final.other!.reply_markup as Keyboard).inline_keyboard).toEqual([])
  })

  it('a card of a strand this bot does not serve is not sent', async () => {
    insertFence(FENCE)
    await flush()
    expect(sent).toHaveLength(0)
  })

  it('a card opened during a turn is sent after the turn reply', async () => {
    cards.rememberChat('strand-a', { chatId: CHAT, isGroup: false })
    cards.beginTurn('strand-a')
    insertFence(FENCE)
    await flush()
    expect(sent).toHaveLength(0)
    await cards.endTurn('strand-a')
    expect(sent).toHaveLength(1)
  })

  it('ask_user choice: tap answers through the S1-B path (replyToInteractionId on the turn)', async () => {
    const record = await open(() => insertAskUser([
      { id: 'q1', type: 'choice', question: 'Welcher Token?', options: [{ id: 'old', label: 'den alten' }, { id: 'new', label: 'neu' }] },
    ]))
    await tap(button('neu'))
    const stored = getInteraction(db, record.id)!
    expect(stored.status).toBe('answered')
    expect(stored.answer!.items![0]!.selected.map(s => s.id)).toEqual(['new'])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ replyToInteractionId: record.id, inputMode: 'answer', source: 'telegram' })
    expect((edits.at(-1)!.other!.reply_markup as Keyboard).inline_keyboard).toEqual([])
  })

  it('multi: toggles mark the options, Fertig submits the toggled set', async () => {
    const record = await open(() => insertAskUser([
      { id: 'q1', type: 'multi', question: 'Welche Umgebungen?', options: [{ id: 'dev', label: 'Dev' }, { id: 'stage', label: 'Stage' }, { id: 'prod', label: 'Prod' }] },
    ]))
    await tap(button('Dev'))
    await tap(button('Prod'))
    await tap(button('Dev'))
    await tap(button('Prod'))
    await tap(button('Stage'))
    expect(lastKeyboard().inline_keyboard.flat().map(b => b.text)).toContain('☑️ Stage')
    expect(lastKeyboard().inline_keyboard.flat().map(b => b.text)).toContain('⬜ Dev')
    expect(getInteraction(db, record.id)!.status).toBe('open')
    await tap(button('Fertig'))
    const stored = getInteraction(db, record.id)!
    expect(stored.status).toBe('answered')
    expect(stored.answer!.items![0]!.selected.map(s => s.id)).toEqual(['stage'])
    expect(turns).toHaveLength(1)
  })

  it('three questions one after another, the intermediate state saved as draft', async () => {
    const record = await open(() => insertAskUser([
      { id: 'q1', type: 'choice', question: 'Erste?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', type: 'confirm', question: 'Zweite?', options: [{ id: 'yes', label: 'Ja' }, { id: 'no', label: 'Nein' }] },
      { id: 'q3', type: 'multi', question: 'Dritte?', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
    ]))
    expect(sent[0]!.text).toContain('(1/3) Erste?')
    await tap(button('B'))
    expect(edits.at(-1)!.text).toContain('(2/3) Zweite?')
    expect(getInteraction(db, record.id)!.draft).toMatchObject({ answers: { q1: { selected: ['b'] } }, step: 1 })
    await tap(button('Nein'))
    expect(edits.at(-1)!.text).toContain('(3/3) Dritte?')
    expect(getInteraction(db, record.id)!.status).toBe('open')
    expect(turns).toHaveLength(0)
    await tap(button('Y'))
    await tap(button('Fertig'))
    const stored = getInteraction(db, record.id)!
    expect(stored.status).toBe('answered')
    expect(stored.answer!.items!.map(i => i.selected.map(s => s.id))).toEqual([['b'], ['no'], ['y']])
    expect(turns).toHaveLength(1)
  })

  it('a tap on an earlier question of a wizard has no effect', async () => {
    const record = await open(() => insertAskUser([
      { id: 'q1', type: 'choice', question: 'Erste?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', type: 'choice', question: 'Zweite?', options: [{ id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
    ]))
    const firstA = button('A', sent[0]!.other!.reply_markup as Keyboard)
    await tap(button('B'))
    await tap(firstA)
    expect(getInteraction(db, record.id)!.draft).toMatchObject({ answers: { q1: { selected: ['b'] } } })
  })

  it('comment within the 10-minute window is assigned to the open question', async () => {
    const record = await open(() => insertAskUser([
      { id: 'q1', type: 'choice', question: 'Welcher Token?', allowComment: true, options: [{ id: 'old', label: 'den alten' }, { id: 'new', label: 'neu' }] },
    ]))
    await tap(button('Kommentar hinzufügen'))
    now += COMMENT_WINDOW_MS - 1000
    expect(await cards.claimComment(CHAT, 1, 'bitte rotieren')).toBe(true)
    expect(edits.at(-1)!.text).toContain('💬 bitte rotieren')
    await tap(button('den alten'))
    const stored = getInteraction(db, record.id)!
    expect(stored.status).toBe('answered')
    expect(stored.answer!.items![0]!.comment).toBe('bitte rotieren')
  })

  it('comment after the 10-minute window stays a normal message', async () => {
    const record = await open(() => insertAskUser([
      { id: 'q1', type: 'choice', question: 'Welcher Token?', allowComment: true, options: [{ id: 'old', label: 'den alten' }, { id: 'new', label: 'neu' }] },
    ]))
    await tap(button('Kommentar hinzufügen'))
    now += COMMENT_WINDOW_MS + 1000
    expect(await cards.claimComment(CHAT, 1, 'zu spät')).toBe(false)
    await tap(button('neu'))
    const stored = getInteraction(db, record.id)!
    expect(stored.answer!.items![0]!.comment).toBeUndefined()
  })

  it('comment of another user or in another chat is not claimed', async () => {
    await open(() => insertAskUser([
      { id: 'q1', type: 'choice', question: 'Welcher Token?', allowComment: true, options: [{ id: 'old', label: 'den alten' }, { id: 'new', label: 'neu' }] },
    ]))
    await tap(button('Kommentar hinzufügen'))
    expect(await cards.claimComment(CHAT, 2, 'fremd')).toBe(false)
    expect(await cards.claimComment(OTHER_CHAT, 1, 'anderer chat')).toBe(false)
    expect(await cards.claimComment(CHAT, 1, 'meins')).toBe(true)
  })

  it('"Other" waits for its text, then answers with it as comment', async () => {
    const record = await open(() => insertAskUser([
      { id: 'q1', type: 'choice', question: 'Welcher Token?', allowComment: true, options: [{ id: 'old', label: 'den alten' }, { id: 'new', label: 'neu' }] },
    ]))
    await tap(button('Other'))
    expect(getInteraction(db, record.id)!.status).toBe('open')
    expect(await cards.claimComment(CHAT, 1, 'ein ganz neuer')).toBe(true)
    const stored = getInteraction(db, record.id)!
    expect(stored.status).toBe('answered')
    expect(stored.answer!.items![0]).toMatchObject({ comment: 'ein ganz neuer' })
    expect(stored.answer!.items![0]!.selected.map(s => s.id)).toEqual(['other'])
  })

  it('Verwerfen dismisses without a turn and removes the keyboard', async () => {
    const record = await open(() => insertFence(FENCE))
    await tap(button('Verwerfen'))
    const stored = getInteraction(db, record.id)!
    expect(stored.status).toBe('dismissed')
    expect(stored.closedSurface).toBe('telegram')
    expect(turns).toHaveLength(0)
    expect(edits.at(-1)!.text).toContain('✖️ Verworfen')
    expect((edits.at(-1)!.other!.reply_markup as Keyboard).inline_keyboard).toEqual([])
  })

  it('an answer on another surface edits the Telegram card to its final state', async () => {
    const record = await open(() => insertFence(FENCE))
    createInteractionsService({ db }).answerById(1, record.id, { value: 'stay', clientRequestId: 'web-1', surface: 'web' })
    await flush()
    expect(sent).toHaveLength(1)
    const final = edits.at(-1)!
    expect(final.messageId).toBe(100)
    expect(final.text).toContain('✅ Beantwortet: Keep it here')
    expect((final.other!.reply_markup as Keyboard).inline_keyboard).toEqual([])
  })

  it('a superseded or expired card loses its keyboard and shows the status', async () => {
    const record = await open(() => insertFence(FENCE))
    db.prepare("UPDATE interactions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), record.id)
    const result = tap(button('Keep it here'))
    await result
    expect(getInteraction(db, record.id)!.status).toBe('expired')
    expect(edits.at(-1)!.text).toContain('⌛ Abgelaufen')
    expect((edits.at(-1)!.other!.reply_markup as Keyboard).inline_keyboard).toEqual([])
    expect(turns).toHaveLength(0)

    const second = await open(() => insertFence({ ...FENCE, id: 'b2' }))
    db.prepare("UPDATE interactions SET status = 'superseded' WHERE id = ?").run(second.id)
    const { interactionEvents } = await import('@axiom/core')
    interactionEvents.emit({ type: 'updated', interaction: getInteraction(db, second.id)! } as never)
    await flush()
    expect(edits.at(-1)!.text).toContain('↪️ Übergangen')
  })

  it('callback_data stays within 64 bytes for long interaction ids', () => {
    const longId = `int_${'x'.repeat(80)}`
    const data = cards.callbackData('o', longId, 3, 11)
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES)
    expect(cards.callbackData('o', longId, 0, 0).split(':')[2]).toBe(data.split(':')[2])
    for (const op of ['o', 'f', 'c', 'x'] as const) {
      expect(Buffer.byteLength(cards.callbackData(op, longId, 99, 99), 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES)
    }
  })

  it('every button of a real card carries callback_data within 64 bytes and labels cut at 40 chars', async () => {
    await open(() => insertAskUser([
      { id: 'q1', type: 'multi', question: 'Lang?', allowComment: true, options: [{ id: 'a', label: 'L'.repeat(90) }, { id: 'b', label: 'kurz' }] },
    ]))
    for (const b of (sent[0]!.other!.reply_markup as Keyboard).inline_keyboard.flat()) {
      expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES)
      expect([...b.text].length).toBeLessThanOrEqual(40)
    }
  })

  it('a second tap on the same option is idempotent (one answer, one turn)', async () => {
    const record = await open(() => insertFence(FENCE))
    const data = button('Hand over to Bob')
    await tap(data, { id: 'same-cbq' })
    const second = tap(data, { id: 'same-cbq' })
    await second
    const third = tap(data)
    await third
    expect(getInteraction(db, record.id)!.status).toBe('answered')
    expect(turns).toHaveLength(1)
    const answerRows = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user' AND session_id = 'strand-a'").get() as { n: number }
    expect(answerRows.n).toBe(1)
    expect(third.answers.at(-1)).toBe('Schon erledigt.')
  })

  it('a tap from another user or another chat has no effect', async () => {
    const record = await open(() => insertFence(FENCE))
    const data = button('Hand over to Bob')
    const foreignUser = tap(data, { userId: 2 })
    await foreignUser
    const foreignChat = tap(data, { chatId: OTHER_CHAT })
    await foreignChat
    const unlinked = tap(button('Verwerfen'), { userId: null })
    await unlinked
    expect(getInteraction(db, record.id)!.status).toBe('open')
    expect(turns).toHaveLength(0)
    expect(edits).toHaveLength(0)
    expect(foreignUser.answers.at(-1)).toBe('Diese Frage gehört jemand anderem.')
  })
})
