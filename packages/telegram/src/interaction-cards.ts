/**
 * S1-C (Telegram): question cards as inline keyboards.
 *
 * A card opened in a strand this bot serves (a fence block or an ask_user
 * question set) is sent as one message with one button per option. The
 * answer and the dismiss go through the server's interactions service (the
 * core {@link InteractionAnswerPort}), so state machine, idempotency, the
 * answer row and the turn are exactly the ones of `POST /answer` and
 * `POST /dismiss`. This module only translates taps into that call and keeps
 * the Telegram message in step with the card's state.
 *
 * callback_data (Telegram limit: 64 bytes) carries only the interaction id,
 * the question index and the option index: `ia:<op>:<id>:<q>:<o>`. An id that
 * would push it over the limit is replaced by a short token (`~xxxxxxxx`).
 *
 * S1-C review 1: every card this bot sends is recorded in the table
 * `telegram_interaction_cards` (interaction id, chat, message id, chat kind,
 * short id). A tap is only accepted for a card found there, tapped in that
 * chat on that message; the owner is checked before anything is edited; and
 * every text and button label leaves through the interaction seal boundary
 * (`sealInteractionValue`, the same one the web backend uses).
 */
import crypto from 'node:crypto'
import {
  getInteraction,
  sealInteractionValue,
  interactionEvents,
  interactionPortErrorOf,
  ASK_USER_PAYLOAD_KIND,
  ASK_USER_OTHER_OPTION_ID,
} from '@axiom/core'
import type {
  AskUserAnswerInput,
  AskUserPayload,
  Database,
  InteractionAnswerPort,
  InteractionAnswerTurnInput,
  InteractionBlock,
  InteractionEvent,
  InteractionRecord,
  InteractionStatus,
} from '@axiom/core'

export const INTERACTION_CALLBACK_PREFIX = 'ia:'
export const CALLBACK_DATA_MAX_BYTES = 64
export const BUTTON_LABEL_MAX = 40
/** How long a "Kommentar hinzufügen" waits for the next text message. */
export const COMMENT_WINDOW_MS = 10 * 60 * 1000

export interface CardChat {
  chatId: number | string
  isGroup: boolean
}

/** The slice of the Telegram Bot API this module uses (mocked in tests). */
export interface CardsTelegramApi {
  sendMessage: (chatId: number | string, text: string, other?: Record<string, unknown>) => Promise<{ message_id: number }>
  editMessageText: (chatId: number | string, messageId: number, text: string, other?: Record<string, unknown>) => Promise<unknown>
}

export interface CardCallback {
  data: string
  callbackQueryId: string
  chatId: number | string | null
  messageId: number | null
  /** The approved web user behind the tapping Telegram account, or null. */
  fromUserId: number | null
  answer: (text?: string) => Promise<unknown>
}

export interface TelegramInteractionCardsOptions {
  api: CardsTelegramApi
  db: Database | null
  getPort: () => InteractionAnswerPort | null
  /** Run the answer turn and deliver its reply into `chat`. */
  startTurn: (chat: CardChat, input: InteractionAnswerTurnInput) => unknown
  now?: () => number
}

interface CardQuestion {
  id: string
  type: 'choice' | 'multi' | 'confirm'
  question: string
  options: Array<{ id: string; label: string; other?: boolean }>
  allowComment: boolean
}

interface CardState {
  id: string
  kind: 'fence' | 'ask'
  chat: CardChat
  messageId: number | null
  ownerUserId: number | null
  questions: CardQuestion[]
  step: number
  answers: Record<string, AskUserAnswerInput>
  toggles: string[]
  /**
   * open: taps accepted; busy: an answer/dismiss is in flight; closed: final;
   * moved: another surface changed the draft, the wizard here was stopped;
   * retry: the answer is filed but its turn did not start (retry button).
   */
  phase: 'open' | 'busy' | 'closed' | 'moved' | 'retry'
  awaitingComment: boolean
}

interface PendingComment {
  interactionId: string
  chatId: number | string
  questionIndex: number
  userId: number
  expiresAt: number
  /** Picking the "Other" row waits for its comment, then selects it. */
  selectOptionId?: string
}

const STATUS_TEXT: Record<Exclude<InteractionStatus, 'open'>, string> = {
  answered: '✅ Beantwortet',
  dismissed: '✖️ Verworfen',
  expired: '⌛ Abgelaufen',
  superseded: '↪️ Übergangen',
}

function truncate(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

function isAskUser(payload: InteractionRecord['payload']): payload is AskUserPayload {
  return (payload as { kind?: string }).kind === ASK_USER_PAYLOAD_KIND
}

/** Normalize a fence block or an ask_user payload into the questions of a card. Null = no card. */
export function cardQuestionsOf(record: InteractionRecord): CardQuestion[] | null {
  const payload = record.payload
  if (isAskUser(payload)) {
    if (!Array.isArray(payload.questions) || payload.questions.length === 0) return null
    return payload.questions.map(q => ({
      id: q.id,
      type: q.type,
      question: q.question,
      options: q.options.map(o => ({ id: o.id, label: o.label, ...(o.other || o.id === ASK_USER_OTHER_OPTION_ID ? { other: true } : {}) })),
      allowComment: q.allowComment,
    }))
  }
  const block = payload as InteractionBlock
  if (!block.supported || block.kind === 'draft' || !Array.isArray(block.options) || block.options.length === 0) return null
  return [{
    id: block.id || 'q',
    type: block.kind === 'multi' ? 'multi' : 'choice',
    question: block.question,
    options: block.options.map(o => ({ id: o.id, label: o.label })),
    allowComment: false,
  }]
}

/** A row of `telegram_interaction_cards`: the card message this bot sent. */
interface CardRow {
  interaction_id: string
  chat_id: string | null
  message_id: number | null
  is_group: number
  short_id: string | null
}

/** An answer request through the port (value/answers are left out on a resume retry). */
type AnswerRequest = Record<string, unknown> & { clientRequestId: string }

/**
 * S1-C review 2 (blocker): the retry state is not kept in this process but
 * derived from the interaction row, like web and app do: the card is
 * `answered`, its answer did not start its turn (`answer.resumed === false`)
 * and the answer carries the key it was filed with. That survives a bot
 * restart; the retry sends exactly that key.
 */
export function retryKeyOf(record: InteractionRecord | null): string | null {
  if (!record || record.status !== 'answered' || !record.answer) return null
  if (record.answer.resumed !== false) return null
  const key = record.answer.clientRequestId
  return typeof key === 'string' && key.length > 0 ? key : null
}

const INVALID_CARD = 'Diese Karte ist nicht mehr gültig.'
const FOREIGN_CARD = 'Diese Karte ist hier nicht gültig.'
const NOT_YOURS = 'Diese Frage gehört jemand anderem.'
const TURN_NOT_STARTED = 'Antwort gespeichert, Agent nicht gestartet – erneut tippen.'
const ALREADY_ANSWERED = 'Diese Frage ist bereits beantwortet.'
/** Strict callback_data shape: op, id or short id, question index, option index. */
const CALLBACK_RE = /^ia:([ofcxr]):([A-Za-z0-9_~-]{1,60}):(\d{1,3}):(\d{1,3})$/

/**
 * The one exit of every text and button label to Telegram (review 1,
 * finding 1): the interaction seal boundary of the web backend, so a
 * credential in a question, option label, answer label or comment becomes a
 * handle before it reaches a chat (in groups readable by every member).
 */
export function sealCardText(text: string): string {
  return sealInteractionValue(text)
}

/** Additive migration: the cards this bot sent (origin of every accepted tap). */
export function ensureTelegramInteractionCardsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_interaction_cards (
      interaction_id TEXT PRIMARY KEY,
      chat_id        TEXT,
      message_id     INTEGER,
      is_group       INTEGER NOT NULL DEFAULT 0,
      short_id       TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_interaction_cards_short
      ON telegram_interaction_cards(short_id) WHERE short_id IS NOT NULL;
  `)
}

function chatIdOf(stored: string): number | string {
  return /^-?\d+$/.test(stored) ? Number(stored) : stored
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')
}

export class TelegramInteractionCards {
  /** Live wizard state; a cache over `telegram_interaction_cards`, rebuilt from the rows. */
  private readonly cards = new Map<string, CardState>()
  private readonly sessionChats = new Map<string, CardChat>()
  private readonly busySessions = new Map<string, number>()
  private readonly queued = new Map<string, InteractionRecord[]>()
  /** Keyed by chat AND user: one open comment prompt per person per chat. */
  private readonly pendingComments = new Map<string, PendingComment>()
  private readonly sending = new Set<string>()
  /** Drafts this bot is writing itself (their `draft` event is not a foreign change). */
  private readonly ownDraftWrites = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: TelegramInteractionCardsOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  private tableReady = false

  /** The database with `telegram_interaction_cards` ensured (lazily: the first card needs it). */
  private cardsDb(): Database | null {
    const db = this.options.db
    if (!db) return null
    if (!this.tableReady) {
      ensureTelegramInteractionCardsTable(db)
      this.tableReady = true
    }
    return db
  }

  /** Listen to the process-wide interaction events. Returns the unsubscribe function. */
  subscribe(): () => void {
    return interactionEvents.on((event) => { void this.handleEvent(event) })
  }

  /** The chat a strand (session) of this bot talks in. Set on every inbound turn. */
  rememberChat(sessionId: string, chat: CardChat): void {
    this.sessionChats.set(sessionId, chat)
  }

  /** A turn of `sessionId` runs: cards it opens wait until its reply was sent. */
  beginTurn(sessionId: string): void {
    this.busySessions.set(sessionId, (this.busySessions.get(sessionId) ?? 0) + 1)
  }

  /** The turn's reply is out: send the cards it opened (and the ones whose send failed), in order. */
  async endTurn(sessionId: string): Promise<void> {
    const left = (this.busySessions.get(sessionId) ?? 1) - 1
    if (left > 0) {
      this.busySessions.set(sessionId, left)
      return
    }
    this.busySessions.delete(sessionId)
    const records = this.queued.get(sessionId) ?? []
    this.queued.delete(sessionId)
    for (const record of records) {
      // Re-read: the card may have been closed on another surface meanwhile.
      const fresh = this.options.db ? getInteraction(this.options.db, record.id) ?? record : record
      if (fresh.status !== 'open') continue
      await this.sendCard(fresh)
    }
  }

  async handleEvent(event: InteractionEvent): Promise<void> {
    try {
      const record = event.interaction
      if (event.type === 'open') {
        if (!this.options.db || record.status !== 'open') return
        if (this.cards.has(record.id) || this.sentRow(record.id)) return
        if (!this.sessionChats.has(record.strandId) || !this.options.getPort()) return
        if (!cardQuestionsOf(record)) return
        if (this.busySessions.has(record.strandId)) {
          this.enqueue(record)
          return
        }
        await this.sendCard(record)
        return
      }
      if (record.status === 'open') {
        // A draft written on another surface while the wizard runs here: the
        // local answers would overwrite it, so the wizard here stops (review 1).
        if (this.ownDraftWrites.has(record.id)) return
        const card = this.cards.get(record.id)
        if (!card || card.phase !== 'open') return
        await this.moveAway(card)
        return
      }
      // Closed (answered, dismissed, expired, superseded) — on this or another surface.
      let card = this.cards.get(record.id) ?? null
      if (card && (card.phase === 'busy' || card.phase === 'closed')) return
      // Answer filed, turn not started (from the row): the retry button stays.
      if (card && card.phase === 'retry' && retryKeyOf(record)) return
      if (!card) {
        const row = this.sentRow(record.id)
        if (!row) return
        card = this.newCard(record, this.chatOfRow(row), row.message_id)
        if (!card) return
        this.cards.set(record.id, card)
        if (card.phase === 'retry') {
          await this.showRetry(card)
          return
        }
      }
      await this.closeCard(card, record)
    } catch (error) {
      console.warn('[telegram] interaction card event failed:', error instanceof Error ? error.message : String(error))
    }
  }

  private enqueue(record: InteractionRecord): void {
    const list = this.queued.get(record.strandId) ?? []
    if (!list.some(r => r.id === record.id)) list.push(record)
    this.queued.set(record.strandId, list)
  }

  /** callback_data for one button; short token when the id would break the 64-byte limit. */
  callbackData(op: 'o' | 'f' | 'c' | 'x' | 'r', interactionId: string, questionIndex = 0, optionIndex = 0): string {
    const build = (id: string) => `${INTERACTION_CALLBACK_PREFIX}${op}:${id}:${questionIndex}:${optionIndex}`
    let data = build(interactionId)
    if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) data = build(this.shortIdFor(interactionId))
    return data
  }

  /** The persistent short id of a card; a collision is caught by the unique index and redrawn. */
  private shortIdFor(interactionId: string): string {
    const db = this.cardsDb()
    if (!db) throw new Error('telegram interaction cards need a database')
    const existing = db.prepare('SELECT short_id FROM telegram_interaction_cards WHERE interaction_id = ?')
      .get(interactionId) as { short_id: string | null } | undefined
    if (existing?.short_id) return existing.short_id
    for (let attempt = 0; attempt < 8; attempt++) {
      const token = `~${crypto.randomBytes(6).toString('base64url').slice(0, 8)}`
      try {
        db.prepare(
          `INSERT INTO telegram_interaction_cards (interaction_id, short_id) VALUES (?, ?)
           ON CONFLICT(interaction_id) DO UPDATE SET short_id = excluded.short_id`,
        ).run(interactionId, token)
        return token
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
      }
    }
    throw new Error('no free short id for a telegram interaction card')
  }

  /** The row of a card this bot actually sent (message id known), by interaction id or short id. */
  private sentRow(idOrShort: string): CardRow | null {
    const db = this.cardsDb()
    if (!db) return null
    const row = db.prepare(
      `SELECT interaction_id, chat_id, message_id, is_group, short_id FROM telegram_interaction_cards
        WHERE ${idOrShort.startsWith('~') ? 'short_id' : 'interaction_id'} = ?`,
    ).get(idOrShort) as CardRow | undefined
    return row && row.chat_id !== null && row.message_id !== null ? row : null
  }

  private chatOfRow(row: CardRow): CardChat {
    return { chatId: chatIdOf(row.chat_id!), isGroup: row.is_group === 1 }
  }

  private questionHead(card: CardState, index = card.step): string {
    const q = card.questions[Math.min(index, card.questions.length - 1)]!
    return card.questions.length > 1 ? `❓ (${index + 1}/${card.questions.length}) ${q.question}` : `❓ ${q.question}`
  }

  private renderText(card: CardState, footer?: string): string {
    const q = card.questions[Math.min(card.step, card.questions.length - 1)]!
    const lines: string[] = [this.questionHead(card)]
    const answer = card.answers[q.id]
    if (q.type === 'multi' && card.toggles.length > 0) {
      lines.push(`Auswahl: ${card.toggles.map(id => q.options.find(o => o.id === id)?.label ?? id).join(', ')}`)
    }
    if (answer?.comment) lines.push(`💬 ${answer.comment}`)
    if (card.awaitingComment) lines.push('✍️ Schreib deinen Kommentar als nächste Nachricht (10 Minuten).')
    if (footer) lines.push('', footer)
    return lines.join('\n')
  }

  private button(text: string, callbackData: string): { text: string; callback_data: string } {
    // Sealed BEFORE the cut: a truncated secret would no longer be recognized.
    return { text: truncate(sealCardText(text), BUTTON_LABEL_MAX), callback_data: callbackData }
  }

  private keyboard(card: CardState): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
    if (card.phase === 'retry') {
      return { inline_keyboard: [[this.button('🔁 Erneut starten', this.callbackData('r', card.id, card.step))]] }
    }
    const q = card.questions[card.step]!
    const rows: Array<Array<{ text: string; callback_data: string }>> = []
    q.options.forEach((option, index) => {
      const prefix = q.type === 'multi' ? (card.toggles.includes(option.id) ? '☑️ ' : '⬜ ') : ''
      rows.push([this.button(`${prefix}${option.label}`, this.callbackData('o', card.id, card.step, index))])
    })
    if (q.type === 'multi') rows.push([this.button('✅ Fertig', this.callbackData('f', card.id, card.step))])
    if (q.allowComment) rows.push([this.button('💬 Kommentar hinzufügen', this.callbackData('c', card.id, card.step))])
    rows.push([this.button('✖️ Verwerfen', this.callbackData('x', card.id, card.step))])
    return { inline_keyboard: rows }
  }

  private newCard(record: InteractionRecord, chat: CardChat, messageId: number | null): CardState | null {
    const questions = cardQuestionsOf(record)
    if (!questions) return null
    const card: CardState = {
      id: record.id,
      kind: isAskUser(record.payload) ? 'ask' : 'fence',
      chat,
      messageId,
      ownerUserId: record.userId,
      questions,
      step: 0,
      answers: {},
      toggles: [],
      // After a restart a filed answer whose turn did not start is a retry card (from the row).
      phase: retryKeyOf(record) ? 'retry' : 'open',
      awaitingComment: false,
    }
    // A wizard started on another device continues where it stopped.
    const draft = record.draft as { answers?: Record<string, AskUserAnswerInput>; step?: number } | null
    if (card.kind === 'ask' && draft && typeof draft === 'object' && draft.answers && typeof draft.answers === 'object') {
      card.answers = { ...draft.answers }
      const step = questions.findIndex(q => !card.answers[q.id]?.selected?.length)
      card.step = step === -1 ? questions.length - 1 : step
    }
    return card
  }

  private async sendCard(record: InteractionRecord): Promise<void> {
    const db = this.cardsDb()
    const chat = this.sessionChats.get(record.strandId)
    if (!db || !chat || this.cards.has(record.id) || this.sending.has(record.id) || this.sentRow(record.id)) return
    const card = this.newCard(record, chat, null)
    if (!card) return
    this.sending.add(record.id)
    try {
      // Reserve the row first (the short id of the keyboard lives in it).
      db.prepare(
        `INSERT INTO telegram_interaction_cards (interaction_id, chat_id, is_group) VALUES (?, ?, ?)
         ON CONFLICT(interaction_id) DO UPDATE SET chat_id = excluded.chat_id, is_group = excluded.is_group, message_id = NULL`,
      ).run(record.id, String(chat.chatId), chat.isGroup ? 1 : 0)
      const sent = await this.options.api.sendMessage(chat.chatId, sealCardText(this.renderText(card)), { reply_markup: this.keyboard(card) })
      card.messageId = sent.message_id
      db.prepare('UPDATE telegram_interaction_cards SET message_id = ? WHERE interaction_id = ?').run(sent.message_id, record.id)
      this.cards.set(record.id, card)
    } catch (error) {
      // Not delivered: no row that could accept taps, and the next end of a
      // turn in this strand tries again (review 1, delivery).
      db.prepare('UPDATE telegram_interaction_cards SET message_id = NULL, chat_id = NULL WHERE interaction_id = ?').run(record.id)
      this.enqueue(record)
      console.warn('[telegram] interaction card not sent:', error instanceof Error ? error.message : String(error))
    } finally {
      this.sending.delete(record.id)
    }
  }

  private async edit(card: CardState, text: string, keyboard: boolean): Promise<void> {
    if (card.messageId === null) return
    try {
      await this.options.api.editMessageText(card.chat.chatId, card.messageId, sealCardText(text), {
        reply_markup: keyboard ? this.keyboard(card) : { inline_keyboard: [] },
      })
    } catch (error) {
      // "message is not modified" and friends: the card state is what counts.
      console.warn('[telegram] interaction card edit failed:', error instanceof Error ? error.message : String(error))
    }
  }

  private allQuestionsText(card: CardState): string {
    return card.questions.length > 1
      ? card.questions.map((_q, i) => this.questionHead(card, i)).join('\n')
      : this.questionHead(card, 0)
  }

  private finalText(card: CardState, record: InteractionRecord | null, status: Exclude<InteractionStatus, 'open'>): string {
    const label = status === 'answered' ? record?.answer?.label : undefined
    return `${this.allQuestionsText(card)}\n\n${STATUS_TEXT[status]}${label ? `: ${label}` : ''}`
  }

  private clearComments(cardId: string): void {
    for (const [key, pending] of this.pendingComments) {
      if (pending.interactionId === cardId) this.pendingComments.delete(key)
    }
  }

  private async closeCard(card: CardState, record: InteractionRecord | null, status?: Exclude<InteractionStatus, 'open'>): Promise<void> {
    const final = status ?? (record && record.status !== 'open' ? record.status : null)
    if (!final) return
    card.phase = 'closed'
    card.awaitingComment = false
    this.clearComments(card.id)
    await this.edit(card, this.finalText(card, record, final), false)
  }

  /** Another surface changed the draft: stop the wizard here, keyboard off. */
  private async moveAway(card: CardState): Promise<void> {
    card.phase = 'moved'
    card.awaitingComment = false
    this.clearComments(card.id)
    await this.edit(card, `${this.allQuestionsText(card)}\n\n✏️ Wird auf einer anderen Oberfläche beantwortet.`, false)
  }

  /**
   * Handle an `ia:` callback. Returns false when the data is not ours.
   * Order (review 1, findings 2 and 3): 1. the card must be one this bot sent
   * (persistent row, same chat, same message), 2. the tapper must be its
   * owner, 3. its state must allow the tap, 4. act. Nothing is edited before
   * step 2 passed.
   */
  async handleCallback(cb: CardCallback): Promise<boolean> {
    if (!cb.data.startsWith(INTERACTION_CALLBACK_PREFIX)) return false
    const parsed = CALLBACK_RE.exec(cb.data)
    if (!parsed) {
      await cb.answer(INVALID_CARD)
      return true
    }
    const [, op, rawId, qRaw, oRaw] = parsed as unknown as [string, string, string, string, string]
    const questionIndex = Number(qRaw)
    const optionIndex = Number(oRaw)
    // 1. Origin.
    const row = this.sentRow(rawId)
    if (!row || cb.chatId === null || cb.messageId === null
      || String(cb.chatId) !== row.chat_id || cb.messageId !== row.message_id) {
      await cb.answer(FOREIGN_CARD)
      return true
    }
    const record = this.options.db ? getInteraction(this.options.db, row.interaction_id) : null
    if (!record) {
      await cb.answer(INVALID_CARD)
      return true
    }
    // 2. Owner.
    if (cb.fromUserId === null || (record.userId !== null && cb.fromUserId !== record.userId)) {
      await cb.answer(NOT_YOURS)
      return true
    }
    // 3. State.
    let card = this.cards.get(record.id) ?? null
    if (!card) {
      // After a restart the card is rebuilt from its persistent row.
      card = this.newCard(record, this.chatOfRow(row), row.message_id)
      if (!card) {
        await cb.answer(INVALID_CARD)
        return true
      }
      this.cards.set(record.id, card)
    }
    if (op === 'r') {
      await this.retryTurn(card, cb, record)
      return true
    }
    if (card.phase === 'busy' || card.phase === 'closed' || card.phase === 'retry') {
      await cb.answer(card.phase === 'busy' ? 'Wird gerade gespeichert …' : card.phase === 'retry' ? TURN_NOT_STARTED : 'Schon erledigt.')
      return true
    }
    if (record.status !== 'open') {
      await this.closeCard(card, record)
      await cb.answer(STATUS_TEXT[record.status as Exclude<InteractionStatus, 'open'>])
      return true
    }
    if (card.phase === 'moved') {
      await cb.answer('Diese Frage wird gerade woanders beantwortet.')
      return true
    }
    if (op !== 'x' && questionIndex !== card.step) {
      await cb.answer('Diese Frage ist schon beantwortet.')
      return true
    }
    const question = card.questions[card.step]!
    // 4. Act.
    switch (op) {
      case 'x':
        await this.dismiss(card, cb)
        return true
      case 'c':
        if (!question.allowComment) { await cb.answer(); return true }
        await this.startComment(card, cb.fromUserId)
        await cb.answer('Schreib deinen Kommentar als nächste Nachricht.')
        await this.edit(card, this.renderText(card), true)
        return true
      case 'f':
        if (question.type !== 'multi') { await cb.answer(); return true }
        if (card.toggles.length === 0) { await cb.answer('Wähle mindestens eine Option.'); return true }
        if (card.toggles.includes(ASK_USER_OTHER_OPTION_ID) && !card.answers[question.id]?.comment) {
          await this.startComment(card, cb.fromUserId)
          await cb.answer('Für "Other" brauche ich deinen Text: schreib ihn als nächste Nachricht, dann Fertig.')
          await this.edit(card, this.renderText(card), true)
          return true
        }
        card.answers[question.id] = { ...card.answers[question.id], selected: [...card.toggles] }
        await this.advance(card, cb)
        return true
      case 'o': {
        const option = question.options[optionIndex]
        if (!option) { await cb.answer(INVALID_CARD); return true }
        if (question.type === 'multi') {
          card.toggles = card.toggles.includes(option.id) ? card.toggles.filter(t => t !== option.id) : [...card.toggles, option.id]
          await cb.answer()
          await this.edit(card, this.renderText(card), true)
          return true
        }
        if (option.other && !card.answers[question.id]?.comment) {
          await this.startComment(card, cb.fromUserId, option.id)
          await cb.answer('Schreib deine Antwort als nächste Nachricht.')
          await this.edit(card, this.renderText(card), true)
          return true
        }
        card.answers[question.id] = { ...card.answers[question.id], selected: [option.id] }
        await this.advance(card, cb)
        return true
      }
      default:
        await cb.answer()
        return true
    }
  }

  /**
   * One comment prompt per person and chat. A new prompt of the same person
   * replaces the old one visibly: the old card no longer says it waits
   * (review 1, comment assignment).
   */
  private async startComment(card: CardState, userId: number, selectOptionId?: string): Promise<void> {
    const key = `${String(card.chat.chatId)}:${userId}`
    const previous = this.pendingComments.get(key)
    card.awaitingComment = true
    this.pendingComments.set(key, {
      interactionId: card.id,
      chatId: card.chat.chatId,
      questionIndex: card.step,
      userId,
      expiresAt: this.now() + COMMENT_WINDOW_MS,
      ...(selectOptionId ? { selectOptionId } : {}),
    })
    if (previous && previous.interactionId !== card.id) {
      const old = this.cards.get(previous.interactionId)
      if (old && old.awaitingComment) {
        old.awaitingComment = false
        if (old.phase === 'open') await this.edit(old, this.renderText(old), true)
      }
    }
  }

  /**
   * The next text message of a person with an open "Kommentar hinzufügen" in
   * this chat: within the window it becomes the comment of that question (and
   * is not a chat message); after it, it is an ordinary message. True = consumed.
   */
  async claimComment(chatId: number | string, userId: number | null, text: string): Promise<boolean> {
    if (userId === null) return false
    const key = `${String(chatId)}:${userId}`
    const pending = this.pendingComments.get(key)
    if (!pending || pending.userId !== userId) return false
    const card = this.cards.get(pending.interactionId)
    if (this.now() > pending.expiresAt || !card || card.phase !== 'open' || card.step !== pending.questionIndex) {
      this.pendingComments.delete(key)
      if (card) {
        card.awaitingComment = false
        if (card.phase === 'open') await this.edit(card, this.renderText(card), true)
      }
      return false
    }
    this.pendingComments.delete(key)
    card.awaitingComment = false
    const question = card.questions[card.step]!
    const comment = text.trim()
    card.answers[question.id] = { selected: card.answers[question.id]?.selected ?? [], comment }
    if (pending.selectOptionId) {
      card.answers[question.id] = { selected: [pending.selectOptionId], comment }
      await this.advance(card, null)
      return true
    }
    await this.edit(card, this.renderText(card), true)
    return true
  }

  /** One question done: next question (draft saved) or submit the whole card. */
  private async advance(card: CardState, cb: CardCallback | null): Promise<void> {
    card.toggles = []
    if (card.step < card.questions.length - 1) {
      card.step += 1
      const port = this.options.getPort()
      this.ownDraftWrites.add(card.id)
      try {
        port?.saveDraft(card.ownerUserId ?? 0, card.id, { answers: card.answers, step: card.step })
      } catch (error) {
        console.warn('[telegram] interaction draft not saved:', error instanceof Error ? error.message : String(error))
      } finally {
        this.ownDraftWrites.delete(card.id)
      }
      const next = card.questions[card.step]!
      if (card.answers[next.id]?.selected?.length && next.type === 'multi') card.toggles = [...card.answers[next.id]!.selected]
      await cb?.answer()
      await this.edit(card, this.renderText(card), true)
      return
    }
    await this.submit(card, cb)
  }

  private async submit(card: CardState, cb: CardCallback | null): Promise<void> {
    if (!this.options.getPort() || card.ownerUserId === null) {
      await cb?.answer('Antworten ist gerade nicht möglich.')
      return
    }
    const clientRequestId = `tg:${cb ? cb.callbackQueryId : `comment-${card.id}-${this.now()}`}`
    const q = card.questions[0]!
    const input = card.kind === 'ask'
      ? { answers: card.answers }
      : { value: q.type === 'multi' ? card.answers[q.id]!.selected : card.answers[q.id]!.selected[0]! }
    await this.sendAnswer(card, cb, { ...input, clientRequestId })
  }

  /**
   * File the answer through the port; its turn runs in this chat. When the
   * turn does not start, the port answers 502 `turn_failed` with the answer
   * filed and `resumed=false`: the card says so and offers a retry that
   * repeats the same request (same key, so only the turn is started again).
   */
  private async sendAnswer(card: CardState, cb: CardCallback | null, request: AnswerRequest, isRetry = false): Promise<void> {
    const port = this.options.getPort()
    if (!port || card.ownerUserId === null) {
      await cb?.answer('Antworten ist gerade nicht möglich.')
      return
    }
    card.phase = 'busy'
    try {
      const result = port.answerById(card.ownerUserId, card.id, {
        ...request,
        surface: 'telegram',
        startTurn: (turn) => this.options.startTurn(card.chat, turn),
      } as Parameters<InteractionAnswerPort['answerById']>[2])
      const record = (this.options.db ? getInteraction(this.options.db, card.id) : null) ?? result.interaction ?? null
      await cb?.answer('Gespeichert.')
      await this.closeCard(card, record ?? null, 'answered')
    } catch (error) {
      const portError = interactionPortErrorOf(error)
      if (portError?.status === 502 && portError.code === 'turn_failed') {
        card.phase = 'retry'
        card.awaitingComment = false
        console.warn(`[telegram] answer of ${card.id} filed, turn did not start`)
        await cb?.answer(TURN_NOT_STARTED)
        await this.showRetry(card)
        return
      }
      if (isRetry) {
        // The answer is filed; only the retry itself failed: the button stays.
        card.phase = 'retry'
        await cb?.answer('Das hat nicht geklappt, bitte nochmal.')
        return
      }
      await this.afterFailure(card, cb, error)
    }
  }

  /** The retry card: the answer is filed, its turn did not start; one button. */
  private async showRetry(card: CardState): Promise<void> {
    card.phase = 'retry'
    card.awaitingComment = false
    this.clearComments(card.id)
    await this.edit(card, `${this.allQuestionsText(card)}\n\n⚠️ ${TURN_NOT_STARTED}`, true)
  }

  /**
   * The retry button. Its state comes from the row, not from this process
   * (review 2): `answered` + `answer.resumed === false`, key =
   * `answer.clientRequestId`. The port gets that key and no value: a resume
   * retry of the service ignores the value and only starts the turn.
   */
  private async retryTurn(card: CardState, cb: CardCallback, record: InteractionRecord): Promise<void> {
    if (card.phase === 'busy') {
      await cb.answer('Wird gerade gespeichert …')
      return
    }
    if (record.status === 'answered' && record.answer?.resumed) {
      await this.closeCard(card, record)
      await cb.answer('Schon erledigt.')
      return
    }
    const key = retryKeyOf(record)
    if (!key) {
      if (record.status !== 'open') await this.closeCard(card, record)
      await cb.answer(INVALID_CARD)
      return
    }
    await this.sendAnswer(card, cb, { clientRequestId: key }, true)
  }

  private async dismiss(card: CardState, cb: CardCallback): Promise<void> {
    const port = this.options.getPort()
    if (!port || card.ownerUserId === null) {
      await cb.answer('Verwerfen ist gerade nicht möglich.')
      return
    }
    card.phase = 'busy'
    try {
      const { interaction } = port.dismiss(card.ownerUserId, card.id, 'telegram')
      await cb.answer('Verworfen.')
      await this.closeCard(card, interaction, interaction.status === 'open' ? 'dismissed' : interaction.status)
    } catch (error) {
      await this.afterFailure(card, cb, error)
    }
  }

  private async afterFailure(card: CardState, cb: CardCallback | null, error: unknown): Promise<void> {
    const portError = interactionPortErrorOf(error)
    const record = this.options.db ? getInteraction(this.options.db, card.id) : null
    if (record && record.status !== 'open') {
      // Closed elsewhere (409), expired (410): show the real state, keyboard off.
      // A 409 on an answered card is a tap that came too late (review 2, double tap).
      await cb?.answer(portError?.status === 409 && record.status === 'answered' ? ALREADY_ANSWERED : STATUS_TEXT[record.status])
      await this.closeCard(card, record)
      return
    }
    if (portError?.status === 410) {
      await cb?.answer(STATUS_TEXT.expired)
      await this.closeCard(card, record, 'expired')
      return
    }
    card.phase = 'open'
    console.warn('[telegram] interaction answer failed:', portError ? `${portError.status} ${portError.code}` : error instanceof Error ? error.message : String(error))
    await cb?.answer('Das hat nicht geklappt, bitte nochmal.')
  }
}
