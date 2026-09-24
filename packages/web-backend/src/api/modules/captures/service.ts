/**
 * Captures service (SPEC 4, 6.1). Accepts a capture, runs the router for
 * captures without a strand, applies decisions by confidence band, and owns
 * the apply and undo semantics. Every state change is persisted before any
 * frame is sent, so a client that reconnects sees the same picture as one
 * that stayed online.
 */
import type { AgentCore, Capture, CaptureLanguage, CaptureSplit, Database, ModelSelection, Decision, DecisionAlternative, NowSetMode, RouterInput, RouterProposal, RouterAction, RouterIntent, ResolvedRouterModel, RouterCompletion, SplitCompletion, Thread, TurnRuntimeOverrides, UploadDescriptor } from '@axiom/core'
import {
  addStrandTags,
  formatInteractionBlockFence,
  addressStrength,
  addToNowSetIfRoom,
  buildRouterInput,
  captureLanguage,
  CLIENT_TARGET_MODEL,
  CLIENT_TARGET_RATIONALE,
  confidenceBand,
  createStrandLink,
  explicitTargetVerdict,
  findDeviceAffinity,
  FILLER_GUARD_MARKER,
  getCapture,
  getCaptureByClientKey,
  getCurrentDecision,
  getCurrentDecisionForPart,
  getDecision,
  capturePartCount,
  insertCapture,
  insertDecision,
  isSplitEligible,
  listCurrentDecisions,
  listAllCurrentDecisions,
  runCaptureSplit,
  segmentSentences,
  singlePartSplit,
  withCapturePartPrefix,
  isFillerCapture,
  rankStrandsByActivity,
  isSessionAccessError,
  isSilenceTranscript,
  listCaptures,
  listDecisionsForCaptures,
  listPersonaIds,
  loadMultiPersonaSettings,
  resolveAssignableProjectId,
  runRouter,
  serializeUploadsMetadata,
  SILENCE_GUARD_MARKER,
  updateCapture,
  updateDecision,
} from '@axiom/core'
import { parseTurnModelSelection } from '../../../model-selection.js'
import type { ChatEvent, ChatEventBus } from '../../../chat-event-bus.js'
import { describeQueuedTurn, emitTurnQueued } from '../../../turn-queue.js'
import type { QueuedTurnInfo } from '../../../turn-queue.js'
import { resolveNowSetMax, resolveNowSetMode } from '../../../now-set-limit.js'
import type { CaptureMode, CreateCaptureBody, ApplyCaptureBody, UndoCaptureBody, RouterPreviewBody } from './schema.js'
import { findQuickStrand, planAssistMode, planQuickMode, planSourceStyle, QUICK_MODE_MODEL, QUICK_MODE_RATIONALE } from './quick-mode.js'

/**
 * Marker written into the rationale of a decision whose `note` the guard below
 * turned into an `ask`. It keeps the `router_decisions` row honest — the stored
 * intent is what happened, this sentence says what the model proposed — and it
 * makes the guard countable (`WHERE rationale LIKE 'capture guard: note%'`).
 */
export const NOTE_IN_DIALOG_MARKER = 'capture guard: note into a live dialog'

/**
 * Marker of the text backstop below, deliberately a different sentence than
 * {@link NOTE_IN_DIALOG_MARKER}: the two mechanisms catch different shapes of
 * the same mistake, and counting them apart in `router_decisions` is the only
 * way to see which one is actually carrying the load
 * (`WHERE rationale LIKE 'capture guard: a note that addresses%'`).
 */
export const ADDRESSED_NOTE_MARKER = 'capture guard: a note that addresses you'

/**
 * Marker of the doubt band, again its own sentence so the three mechanisms can
 * be told apart in `router_decisions`
 * (`WHERE rationale LIKE 'capture guard: a note that may address%'`). Counting
 * this one answers the question the band was built for: how often does the
 * server have to ask, and is that often enough to annoy?
 *
 * It is only written when a question was really written into a strand, never
 * for a capture that stayed unsorted — the count is the number of questions,
 * not the number of doubts.
 */
export const DOUBTFUL_NOTE_MARKER = 'capture guard: a note that may address you'

/**
 * The sentence above the card. It states what happened, so every surface that
 * cannot render an interactive block — an older app, a plain text export —
 * still carries the fact in prose. Language follows the capture (see
 * `captureLanguage`), because a German note answered in English reads like a
 * bug.
 */
export const CAPTURE_NUDGE_TEXT: Record<CaptureLanguage, string> = {
  de: 'Als Notiz abgelegt.',
  en: 'Filed that as a note.',
}

/**
 * The question on the card. Deliberately NOT the same sentence as the prose
 * above it: the card renders the question itself, so repeating the prose would
 * show the user the same line twice.
 */
export const CAPTURE_CONFIRM_QUESTION: Record<CaptureLanguage, string> = {
  de: 'Oder soll ich darauf antworten?',
  en: 'Or should I answer it?',
}

/**
 * Block id of that card. One constant, not a per-capture id: the card lives in
 * a message that already carries `capture_id`, so the capture is resolved from
 * the row and the id only has to be stable enough to answer twice without
 * ambiguity. Stable across processes, which is what makes the answer
 * idempotent (SPEC 7.4c `409 already_answered`).
 */
export const CAPTURE_CONFIRM_BLOCK_ID = 'note-confirm'

/** Keep it filed and silent. */
export const CAPTURE_CONFIRM_KEEP = 'keep'
/** Run the ordinary answer path on the capture text. */
export const CAPTURE_CONFIRM_ANSWER = 'answer'

export const CAPTURE_CONFIRM_LABELS: Record<CaptureLanguage, Record<string, string>> = {
  de: { [CAPTURE_CONFIRM_KEEP]: 'Nur als Notiz behalten', [CAPTURE_CONFIRM_ANSWER]: 'Antworte darauf' },
  en: { [CAPTURE_CONFIRM_KEEP]: 'Just keep the note', [CAPTURE_CONFIRM_ANSWER]: 'Answer it' },
}

/**
 * Idempotency key of the card, written into `chat_messages.client_message_id`.
 * The partial unique index `idx_chat_messages_client_message_id (user_id,
 * client_message_id)` then makes "one card per capture" a database
 * guarantee instead of a check that a retry can race: a second routing, a
 * reconnect or a replayed request inserts nothing and the service notices
 * from `changes === 0`.
 */
export function captureConfirmKey(captureId: string): string {
  return `note-confirm:${captureId}`
}

/**
 * The card a filed note carries: prose, then one `choice` block with exactly
 * two options.
 *
 * `choice` and not `confirm`, although both render: a `confirm` is an
 * affirmative/cancel pair (and paints the affirmative red when destructive),
 * while these two options are equal outcomes — keeping the note is not
 * "cancel", it is a decision. The wire format is the one merged with the
 * interaction blocks, `formatInteractionBlockFence` writes it, and
 * `renderInteractionMessageAsText` degrades it to a numbered list for
 * Telegram and every other surface without a card renderer.
 */
export function captureConfirmContent(language: CaptureLanguage): string {
  const labels = CAPTURE_CONFIRM_LABELS[language]
  const fence = formatInteractionBlockFence({
    kind: 'choice',
    id: CAPTURE_CONFIRM_BLOCK_ID,
    question: CAPTURE_CONFIRM_QUESTION[language],
    options: [
      { id: CAPTURE_CONFIRM_KEEP, label: labels[CAPTURE_CONFIRM_KEEP]! },
      { id: CAPTURE_CONFIRM_ANSWER, label: labels[CAPTURE_CONFIRM_ANSWER]! },
    ],
  })
  return `${CAPTURE_NUDGE_TEXT[language]}\n\n${fence}`
}

/**
 * `chat_messages.metadata` of such a question. Two things hang off it: the row
 * is recognisable as the server's own question rather than a persona's answer,
 * and {@link NOT_A_NUDGE} keeps it out of every "has anybody answered here?"
 * query. Matched with LIKE and not with `json_extract`, because a malformed
 * metadata value must not throw inside a filing.
 */
const NUDGE_METADATA = JSON.stringify({ type: 'capture_nudge' })
const NUDGE_LIKE = '%"capture_nudge"%'
const NOT_A_NUDGE = `(metadata IS NULL OR metadata NOT LIKE '${NUDGE_LIKE}')`

/**
 * Insert the card, exactly once per capture.
 *
 * The idempotency is the database's, not this function's: `client_message_id`
 * carries {@link captureConfirmKey} and the partial unique index
 * `idx_chat_messages_client_message_id (user_id, client_message_id)` turns a
 * second insert into a no-op. A check-then-insert would lose that race — two
 * requests that both find no card both write one — and duplicate cards are
 * exactly the failure mode worth designing against here.
 *
 * Returns the new message id, or null when the card was already there.
 */
export function writeConfirmationCard(
  db: Database,
  input: { userId: number; strandId: string; agentId: string; captureId: string; content: string },
): number | null {
  const result = db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, capture_id, client_message_id)
     VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING`,
  ).run(
    input.strandId, input.userId, input.content, NUDGE_METADATA,
    input.agentId, input.captureId, captureConfirmKey(input.captureId),
  )
  return result.changes === 0 ? null : Number(result.lastInsertRowid)
}

export class CaptureServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'CaptureServiceError'
  }
}

/** Minimal turn starter so the service does not depend on the whole TurnRunner. */
export interface CaptureTurnStarter {
  hasActiveTurnInSession?: (userId: number | string, sessionId: string) => boolean
  startTurn: (input: {
    userId: number
    sessionId: string
    text: string
    source: string
    attachments?: UploadDescriptor[]
    agentId: string
    explicitSessionId: string
    turnModelOverride?: ModelSelection
    turnOverrides?: TurnRuntimeOverrides
  }) => unknown
}

export interface CapturesServiceOptions {
  db: Database
  getAgentCore: () => AgentCore | null
  chatEventBus?: ChatEventBus | null
  getTurnRunner?: () => CaptureTurnStarter | null
  /**
   * Rings the phone for a question the service wrote into a strand (the doubt
   * band below). Wired to the push sender in `app.ts`; absent means no
   * doorbell, which is what every test that does not care about push gets.
   */
  sendDoorbell?: (input: { userId: number; strandId: string; agentId: string; messageId: number | null }) => void
  /** Effective now-set size, read per call so a settings save applies at once. */
  getNowSetMax?: () => number
  /**
   * How the now set is filled (`offtangent.nowSetMode`). In `auto` a filing
   * never writes the `now_set` table; it only broadcasts when the computed
   * ranking changed because of the message it just wrote.
   */
  getNowSetMode?: () => NowSetMode
  /** Test hooks: pin the router chain or the completion function. */
  routerChain?: () => ResolvedRouterModel[] | undefined
  routerComplete?: RouterCompletion
  /** Test hook for the two split stages, same role as `routerComplete`. */
  splitComplete?: SplitCompletion
}

/** The decision shape `POST /api/router/preview` returns (nothing is stored). */
export type PreviewDecision =
  Omit<Decision, 'id' | 'captureId' | 'state' | 'createdAt' | 'appliedAt' | 'resolvedAt'>
  & { newStrand: RouterProposal['newStrand']; notes: string[] }

export interface RouterPreviewPart {
  index: number
  title: string | null
  text: string
  sentenceIds: number[]
  decision: PreviewDecision
}

export interface RouterPreviewResult {
  /** The decision of part 0, unchanged for every client that knows no parts. */
  decision: PreviewDecision
  parts: RouterPreviewPart[]
  partCount: number
  split: SplitInfo
}

/** One part of a capture as the API delivers it. */
export interface CapturePartView {
  index: number
  title: string | null
  text: string
  sentenceIds: number[]
  decision: Decision
}

/** What the split decided about a capture (`null` when it never ran). */
export interface SplitInfo {
  confidence: number | null
  rationale: string | null
  gated: boolean
}

/** Which topic part of a capture a write belongs to (split-on-intake). */
export interface PartRef {
  index: number
  count: number
}

export const SINGLE_PART: PartRef = { index: 0, count: 1 }

export interface CaptureResult {
  capture: Capture
  decision: Decision
  created: boolean
  /**
   * Every current part of the capture, in part order, the same shape as
   * `GET /api/captures/:id` and the routed frame. Set on every result that
   * leaves the service (create, apply, undo, dismiss, keep-as-one), so a client
   * that changed one part does not have to read the capture back to learn the
   * state of the others. One entry for a capture that was not split.
   */
  parts?: CapturePartView[]
  partCount?: number
  /**
   * Wait state of the turn this capture started (plan 2026-09-19, D5), or null
   * when no turn was started (filed as a silent note, low band, dismissed) or
   * when it started immediately. The client shows "waits behind <strand>"
   * instead of a card that sits there doing nothing for 20 minutes.
   */
  turn?: QueuedTurnInfo | null
}

interface StrandTargets {
  strand: Thread
  createdStrandId: string | null
}

function personaList(): string[] {
  return ['main', ...listPersonaIds()]
}

function defaultPersona(): string {
  const configured = loadMultiPersonaSettings().defaultAgentId
  return personaList().includes(configured) ? configured : 'main'
}

export function createCapturesService(options: CapturesServiceOptions) {
  const { db } = options

  function rememberSelection(capture: Capture, selection?: ModelSelection, mode: CaptureMode = 'work'): void {
    const metadata: Record<string, unknown> = {}
    if (selection) metadata.turnOverride = selection
    // Only a non-default mode is stored (`work` is the default). The column is read back by every turn
    // this capture starts (including one a later confirmation starts), so the
    // style and thinking level of a quick capture survive the request that
    // created it without a second table.
    if (mode !== 'work') metadata.mode = mode
    if (Object.keys(metadata).length === 0) return
    db.prepare('UPDATE captures SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), capture.id)
  }

  /** The mode a capture was created with, as stored in `captures.metadata`. */
  function modeOf(capture: Capture): CaptureMode {
    const row = db.prepare('SELECT metadata FROM captures WHERE id = ?').get(capture.id) as { metadata: string | null } | undefined
    if (!row?.metadata) return 'work'
    try {
      const parsed = JSON.parse(row.metadata) as { mode?: string }
      if (parsed.mode === 'quick') return 'quick'
      if (parsed.mode === 'assist') return 'assist'
      return 'work'
    } catch {
      return 'work'
    }
  }

  /**
   * Turn-local thinking level and style instruction of a capture, read from
   * the settings again at turn start. Recomputed instead of remembered on
   * purpose: the hint is prompt text, and the text the product owner has
   * configured NOW is the right one, also for a confirmation that starts the
   * turn minutes after the capture arrived.
   *
   * A quick capture gets both (mode hint plus device hint plus the mode's
   * thinking level), a working capture only what its SOURCE demands — the puck
   * reads every answer out loud, also the long one it asked for in work mode.
   * An assist capture gets the draft instruction plus the device hint, but
   * keeps the persona's model and thinking level.
   */
  function turnOverridesFor(capture: Capture): TurnRuntimeOverrides | undefined {
    const mode = modeOf(capture)
    if (mode === 'quick') return planQuickMode(capture.source).turnOverrides
    if (mode === 'assist') return planAssistMode(capture.source)
    return planSourceStyle(capture.source)
  }

  /**
   * Model for a turn this capture starts: an explicit client pin first, the
   * quick mode's configured model second, the persona's own model last.
   *
   * The second step matters for the puck's follow-up question, which names a
   * strand AND asks for the quick mode: the strand decides where the answer
   * goes, the mode still decides which model writes it.
   */
  function modelForTurn(capture: Capture): ModelSelection | undefined {
    const pinned = selectionFor(capture)
    if (pinned) return pinned
    if (modeOf(capture) !== 'quick') return undefined
    const plan = planQuickMode(capture.source)
    if (plan.modelNote) console.warn(`[captures] quick mode: ${plan.modelNote}`)
    return plan.turnOverride
  }

  function selectionFor(capture: Capture): ModelSelection | undefined {
    const row = db.prepare('SELECT metadata FROM captures WHERE id = ?').get(capture.id) as { metadata: string | null }
    const metadata = row.metadata ? JSON.parse(row.metadata) as { turnOverride?: ModelSelection } : {}
    const selection = metadata.turnOverride
    const parsed = parseTurnModelSelection({ modelProviderId: selection?.providerId, modelId: selection?.modelId })
    if (!parsed.ok) throw new CaptureServiceError(400, parsed.code, parsed.error)
    return parsed.value
  }

  function requireIdle(userId: number, strandId: string): void {
    if (options.getTurnRunner?.()?.hasActiveTurnInSession?.(userId, strandId)) {
      throw new CaptureServiceError(409, 'strand_busy', 'Strand has an active turn')
    }
  }
  const nowSetMax = options.getNowSetMax ?? (() => resolveNowSetMax())
  const nowSetMode = options.getNowSetMode ?? (() => resolveNowSetMode())

  /**
   * Captures whose answer is already on its way. {@link answerExists} cannot
   * see a turn that is still running — no assistant row exists yet — so
   * confirming a `needs_review` filing in those few seconds would start a
   * second turn and the same question would be answered twice.
   *
   * Deliberately in memory and not in a column: the set only has to outlive
   * the turn, and a turn does not survive a process restart. An empty set
   * after a restart is therefore the correct answer, because the turn it would
   * have remembered is gone and running it again is the right move.
   */
  const answering = new Set<string>()
  /** keep-as-one runs per capture; a second call while one runs joins it. */
  const keepingAsOne = new Map<string, Promise<CaptureResult>>()

  function manager() {
    const core = options.getAgentCore()
    if (!core) throw new CaptureServiceError(503, 'agent_unavailable', 'Agent core not available')
    return core.getSessionManager()
  }

  function requireCapture(userId: number, id: string): Capture {
    const capture = getCapture(db, String(userId), id)
    if (!capture) throw new CaptureServiceError(404, 'capture_not_found', 'Capture not found')
    return capture
  }

  function requireDecision(capture: Capture): Decision {
    const decision = getCurrentDecision(db, capture.id)
    if (!decision) throw new CaptureServiceError(500, 'decision_missing', 'Capture has no routing decision')
    return decision
  }

  function ownStrand(userId: number, strandId: string): Thread {
    const strand = manager().getThread(String(userId), strandId)
    if (!strand || strand.archived) throw new CaptureServiceError(404, 'invalid_strand', 'Strand not found')
    return strand
  }

  function broadcast(userId: number, event: Omit<ChatEvent, 'userId'>): void {
    options.chatEventBus?.broadcast({ ...event, userId })
  }

  function bumpStrandActivity(userId: number, strand: Thread, delta: 1 | -1): void {
    const active = manager().getSession(String(userId), strand.agentId)
    if (delta === 1 && active?.id === strand.id) {
      manager().recordMessage(String(userId), strand.agentId)
      return
    }
    db.prepare(
      `UPDATE sessions SET message_count = MAX(0, message_count + ?), last_activity = datetime('now') WHERE id = ?`,
    ).run(delta, strand.id)
  }

  /**
   * Has a persona ever answered in this strand? Then it is a live dialog.
   *
   * The server's own question (the doubt band) does not count. It is not an
   * answer, and counting it would make every strand that ever got one a live
   * dialog: the next note filed there would be upgraded to `ask` and answered
   * — exactly the unsolicited reply this band exists to avoid.
   */
  function isLiveDialog(strandId: string): boolean {
    const row = db.prepare(
      `SELECT 1 FROM chat_messages WHERE session_id = ? AND role = 'assistant' AND ${NOT_A_NUDGE} LIMIT 1`,
    ).get(strandId)
    return !!row
  }

  /**
   * A `note` that lands in a strand where a persona has already answered is
   * practically never what the user meant: they are talking to someone, and a
   * filed note runs no turn, so the chat stays silent and no doorbell rings.
   * A wrong `note` therefore costs the whole answer, a wrong `ask` one
   * superfluous reply — the cheap mistake wins and the intent is upgraded.
   *
   * The guard cannot cover `new_strand`: a strand that does not exist yet has
   * no history to judge. That case belongs to {@link guardAddressedNote},
   * which reads the capture's text instead of the strand's history.
   */
  function guardNoteIntoLiveDialog(proposal: RouterProposal): RouterProposal {
    if (proposal.intent !== 'note' || proposal.action === 'new_strand') return proposal
    if (!proposal.strandId || !isLiveDialog(proposal.strandId)) return proposal
    const marker = `${NOTE_IN_DIALOG_MARKER} (${proposal.strandId}), intent note became ask.`
    const rationale = proposal.rationale ? `${marker} Model: ${proposal.rationale}` : marker
    console.warn(`[captures] ${marker}`)
    return { ...proposal, intent: 'ask', rationale: rationale.slice(0, 400) }
  }

  /**
   * The backstop for the case the guard above cannot see: a capture that talks
   * to the persona while opening a brand new strand. That is exactly the shape
   * of the incident this whole mechanism exists for — no history to judge, so
   * the only evidence left is the text itself, and `addressStrength` reads it
   * server side instead of trusting the model's label.
   *
   * Three bands, because the evidence has three strengths (SPEC 4.1):
   *
   *  * `strong` (two marker classes or more) — the intent becomes `ask`, the
   *    turn runs, the user gets an answer. Same behaviour as before.
   *  * `weak` (exactly one class) — the intent STAYS `note`. One marker fires
   *    on ordinary self-notes ("Termin beim Zahnarzt am Montag?"), so guessing
   *    `ask` here answers a shopping list. Instead the caller writes one short
   *    question into the strand: no turn, no model call, and the user decides.
   *  * `none` — nothing happens, the note is filed in silence.
   *
   * It runs after {@link guardNoteIntoLiveDialog} and therefore only ever sees
   * a `note` that guard left alone: whichever guard fires first owns the
   * rationale, and the row never carries two markers. Independent of the
   * action on purpose — `new_strand` is the case it is here for.
   */
  function guardAddressedNote(proposal: RouterProposal, text: string): { proposal: RouterProposal; doubtful: boolean } {
    if (proposal.intent !== 'note') return { proposal, doubtful: false }
    const strength = addressStrength(text)
    if (strength === 'none') return { proposal, doubtful: false }
    if (strength === 'strong') {
      const marker = `${ADDRESSED_NOTE_MARKER}, intent note became ask.`
      const rationale = proposal.rationale ? `${marker} Model: ${proposal.rationale}` : marker
      console.warn(`[captures] ${marker}`)
      return { proposal: { ...proposal, intent: 'ask', rationale: rationale.slice(0, 400) }, doubtful: false }
    }
    return { proposal, doubtful: true }
  }

  /** Stamp the doubt band's marker onto a decision that stays a `note`. */
  function markDoubtful(proposal: RouterProposal): RouterProposal {
    const marker = `${DOUBTFUL_NOTE_MARKER}, filed as a note and asked back.`
    const rationale = proposal.rationale ? `${marker} Model: ${proposal.rationale}` : marker
    console.warn(`[captures] ${marker}`)
    return { ...proposal, rationale: rationale.slice(0, 400) }
  }

  /**
   * Write the confirmation card into the strand the capture was just filed
   * into: "Als Notiz abgelegt." plus a `choice` block with "keep" and
   * "answer".
   *
   * Written ONLY for the doubt band — a text with exactly one address marker,
   * where the server genuinely cannot tell a memo from a request. A note with
   * no marker at all is filed in silence, because a card on every note is the
   * failure this was measured to produce: of the twelve cards the blanket rule
   * wrote, eleven landed on automated test notes from a device and not one
   * carried textual evidence that anybody was being addressed (zero
   * `router_decisions` rows with {@link DOUBTFUL_NOTE_MARKER}). A question
   * nobody needs teaches the user to stop reading questions, and then the one
   * that matters is gone too.
   *
   * An ordinary `assistant` row, because that is what it is: the persona
   * saying something. It carries the capture id, so the row travels with the
   * capture through {@link move} and is removed with it, and the
   * `capture_nudge` metadata tag, which keeps it out of {@link isLiveDialog}
   * and {@link answerExists} — the card is not an answer, and a strand that
   * only ever got one is not a live dialog.
   *
   * Idempotent by database index, not by a check: `client_message_id` carries
   * {@link captureConfirmKey}, so a second routing of the same capture, a
   * retried request or a reconnect inserts nothing. Returns false in that
   * case, and then nothing is bumped and nothing rings either.
   *
   * The activity bump is the same one a filed capture gets, so the strand
   * sorts to the top and reads as "something is waiting".
   *
   * The doorbell rings for it: a card the user never sees is the silence this
   * mechanism exists against, and since only the doubt band gets a card at
   * all, ringing it is at most a handful of pushes a week rather than one per
   * note.
   */
  function askBack(userId: number, capture: Capture, strand: Thread, ring: boolean): boolean {
    const language = captureLanguage(capture.text)
    const messageId = writeConfirmationCard(db, {
      userId,
      strandId: strand.id,
      agentId: strand.agentId,
      captureId: capture.id,
      content: captureConfirmContent(language),
    })
    if (messageId === null) {
      // The card is already there. Bumping or ringing again would turn a
      // retry into noise, which is the failure this guard exists for.
      console.warn(`[captures] confirmation card for capture ${capture.id} already exists, nothing written`)
      return false
    }
    bumpStrandActivity(userId, strand, 1)
    if (!ring) return true
    try {
      options.sendDoorbell?.({ userId, strandId: strand.id, agentId: strand.agentId, messageId })
    } catch (err) {
      // A doorbell must never cost a filing.
      console.error(`[captures] Doorbell for capture ${capture.id} failed: ${(err as Error).message}`)
    }
    return true
  }

  /**
   * Does an assistant answer exist after the capture's message in its strand?
   * The server's own question is not one (see {@link isLiveDialog}): undoing a
   * capture that was only asked about is still a true move, not a re-filing.
   */
  function answerExists(capture: Capture): boolean {
    if (!capture.strandId || capture.messageId === null) return false
    const row = db.prepare(
      `SELECT 1 FROM chat_messages WHERE session_id = ? AND id > ? AND role = 'assistant' AND ${NOT_A_NUDGE} LIMIT 1`,
    ).get(capture.strandId, capture.messageId)
    return !!row
  }

  /**
   * The part of a capture a filing belongs to. `count` 1 is every capture that
   * was not split, and then nothing about the write changes: no `part_index`
   * other than 0, no `capturePart` metadata, no fragment line in the context.
   */
  function writeMessage(userId: number, capture: Capture, strand: Thread, text: string, part: PartRef = SINGLE_PART): number {
    const uploads = capture.attachments.length > 0 ? { files: capture.attachments } : null
    const partMeta = part.count > 1 ? { capturePart: { index: part.index, count: part.count, captureId: capture.id } } : null
    const merged = uploads && !partMeta
      ? serializeUploadsMetadata(capture.attachments)
      : uploads || partMeta ? JSON.stringify({ ...(uploads ?? {}), ...(partMeta ?? {}) }) : null
    const result = db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, capture_id, part_index)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`,
    ).run(strand.id, userId, text, merged, strand.agentId, capture.id, part.index)
    return Number(result.lastInsertRowid)
  }

  /** The `chat_messages` row one part of a capture was filed into, if any. */
  function partFiling(captureId: string, partIndex: number): { strandId: string; messageId: number } | null {
    const row = db.prepare(
      `SELECT id, session_id FROM chat_messages WHERE capture_id = ? AND part_index = ? AND role = 'user'
       ORDER BY id DESC LIMIT 1`,
    ).get(captureId, partIndex) as { id: number; session_id: string } | undefined
    return row ? { strandId: row.session_id, messageId: row.id } : null
  }

  /**
   * The capture as ONE of its parts: the part's consolidated text and the
   * strand and message row of that part's own filing. A capture that was not
   * split is returned unchanged, so every path below behaves exactly as it did
   * before parts existed.
   */
  function partView(capture: Capture, decision: Decision): Capture {
    if (decision.partCount < 2) return capture
    const filing = partFiling(capture.id, decision.partIndex)
    return {
      ...capture,
      text: decision.partText ?? capture.text,
      strandId: filing?.strandId ?? null,
      messageId: filing?.messageId ?? null,
    }
  }

  /**
   * The capture status a multi part capture has after its parts were filed:
   * `filed` when every part is applied and none is reviewable, `needs_review`
   * while any part still waits for the user, and the tray status when nothing
   * is filed at all.
   *
   * Deliberately NOT `pending`: `pending` is the status of a capture before it
   * was routed, and the tray reads `unsorted`/`failed`. A capture whose parts
   * were all undone has to be reachable again, which is the same status a
   * single part undo has always written.
   */
  function syncCaptureStatus(userId: number, captureId: string): Capture | null {
    const decisions = listCurrentDecisions(db, captureId)
    if (decisions.length === 0) return getCapture(db, String(userId), captureId)
    const capture = getCapture(db, String(userId), captureId)
    if (!capture || capture.status === 'dismissed' || capture.status === 'moved') return capture
    const applied = decisions.filter(d => d.state === 'applied' || d.state === 'confirmed')
    let status: Capture['status']
    if (applied.length === 0) {
      status = decisions.every(d => d.model === 'synthetic') ? 'failed' : 'unsorted'
    } else if (applied.length < decisions.length) {
      status = 'needs_review'
    } else {
      const reviewable = applied.some(d => confidenceBand(d.confidence) !== 'high' && d.state === 'applied')
      status = reviewable ? 'needs_review' : 'filed'
    }
    const first = partFiling(captureId, 0)
    updateCapture(db, captureId, {
      status,
      strandId: first?.strandId ?? null,
      messageId: first?.messageId ?? null,
      ...(applied.length === 0 ? { filedAt: null } : {}),
    })
    return getCapture(db, String(userId), captureId)
  }

  /**
   * Wait state of the turns started in the current request, keyed by capture.
   * Read (and dropped) by the public entry points that return a CaptureResult;
   * trimmed so a path that never reads its entry cannot grow the map.
   */
  const startedTurns = new Map<string, QueuedTurnInfo>()

  function rememberTurn(captureId: string, info: QueuedTurnInfo): void {
    startedTurns.set(captureId, info)
    while (startedTurns.size > 50) {
      const oldest = startedTurns.keys().next()
      if (oldest.done) break
      startedTurns.delete(oldest.value)
    }
  }

  function takeTurn(captureId: string): QueuedTurnInfo | null {
    const info = startedTurns.get(captureId) ?? null
    startedTurns.delete(captureId)
    return info
  }

  function startTurn(userId: number, capture: Capture, strand: Thread, text: string): void {
    const overrides = turnOverridesFor(capture)
    const runner = options.getTurnRunner?.()
    if (!runner) {
      console.warn(`[captures] No turn runner available, capture ${capture.id} was filed without an answer`)
      return
    }
    // Sampled BEFORE the runner enqueues, so the snapshot never counts this
    // turn itself (TurnRunner.startTurn enqueues asynchronously).
    const queuedTurn = describeQueuedTurn(db, options.getAgentCore(), userId, strand.agentId)
    rememberTurn(capture.id, queuedTurn)
    // The capture path had no queue feedback at all: the card just stayed
    // silent while the persona was busy elsewhere (incident 2026-09-18).
    emitTurnQueued(options.chatEventBus, {
      userId,
      sessionId: strand.id,
      agentId: strand.agentId,
      info: queuedTurn,
      source: 'web',
    })
    runner.startTurn({
      userId,
      sessionId: strand.id,
      text,
      source: capture.source,
      attachments: capture.attachments.length > 0 ? capture.attachments : undefined,
      agentId: strand.agentId,
      explicitSessionId: strand.id,
      turnModelOverride: modelForTurn(capture),
      ...(overrides ? { turnOverrides: overrides } : {}),
    })
  }

  /**
   * A project id the router proposed is only used when it is still assignable
   * (SPEC 4.2b). Between routing and filing the product owner can delete or
   * archive a project; that must cost the capture its project, never its
   * filing, so an unusable id degrades to "no project".
   */
  function usableProjectId(userId: number, projectId: string | null | undefined): string | null {
    if (!projectId) return null
    try {
      return resolveAssignableProjectId(db, String(userId), projectId)
    } catch {
      console.warn(`[captures] project ${projectId} is no longer assignable, filing without a project`)
      return null
    }
  }

  /** Resolve the strand a proposal points at, creating one for `new_strand`. */
  function resolveTargets(userId: number, capture: Capture, proposal: RouterProposal): StrandTargets {
    if (proposal.action === 'new_strand') {
      const ns = proposal.newStrand
        ?? { title: capture.text.slice(0, 60), personaId: capture.agentId ?? defaultPersona(), tags: [], projectId: null }
      const personaId = personaList().includes(ns.personaId) ? ns.personaId : defaultPersona()
      const selection = selectionFor(capture)
      const strand = manager().createThread(String(userId), personaId, ns.title, usableProjectId(userId, ns.projectId))
      if (selection) db.prepare('UPDATE sessions SET model_provider_id = ?, model_id = ? WHERE id = ?')
        .run(selection.providerId, selection.modelId, strand.id)
      if (ns.tags.length > 0) addStrandTags(db, String(userId), strand.id, ns.tags, 'router')
      return { strand, createdStrandId: strand.id }
    }
    const strand = ownStrand(userId, proposal.strandId!)
    return { strand, createdStrandId: null }
  }

  /**
   * Answer a capture after its filing: the confirmation of a `needs_review`
   * decision whose turn never ran. Idempotent on purpose — a capture that
   * already has an answer, or one whose turn is still running, is left alone,
   * because a question answered twice is the same failure as one answered
   * never, only louder.
   *
   * The activity bump is taken back because {@link file} only bumps when it
   * does NOT start a turn; the turn does its own bookkeeping.
   */
  function answerLater(userId: number, capture: Capture): boolean {
    if (!capture.strandId) return false
    if (answering.has(capture.id) || answerExists(capture)) return false
    const strand = ownStrand(userId, capture.strandId)
    requireIdle(userId, strand.id)
    selectionFor(capture)
    bumpStrandActivity(userId, strand, -1)
    answering.add(capture.id)
    startTurn(userId, capture, strand, capture.text)
    return true
  }

  /**
   * The other half of the confirmation card: the user tapped one of its two
   * options, `POST /api/interactions` validated the answer against the block
   * and hands the choice here.
   *
   * Both options end the same way as confirming a `needs_review` filing in
   * {@link apply} — decision `confirmed`, capture `filed` — because that is
   * what the tap means: the user has seen the filing and decided about it.
   * Only the second one also starts the turn, and it does so through
   * {@link answerLater}, the same idempotent path the `apply` confirmation
   * uses. No second answer mechanism, and none of the two can run twice: the
   * answer state of the block is stored in the card's metadata and
   * `answerLater` refuses a capture that is already being answered.
   *
   * `handled: false` means "not mine" (another block id, or a message whose
   * capture is gone); the interactions service then falls back to its ordinary
   * behaviour and files the label as a user message.
   */
  function confirmNoteFiling(
    userId: number,
    input: { captureId: string; blockId: string; choice: string },
  ): { handled: boolean; resumed: boolean } {
    if (input.blockId !== CAPTURE_CONFIRM_BLOCK_ID) return { handled: false, resumed: false }
    if (input.choice !== CAPTURE_CONFIRM_KEEP && input.choice !== CAPTURE_CONFIRM_ANSWER) {
      return { handled: false, resumed: false }
    }
    const capture = getCapture(db, String(userId), input.captureId)
    if (!capture) return { handled: false, resumed: false }
    const current = getCurrentDecision(db, capture.id)
    if (input.choice === CAPTURE_CONFIRM_ANSWER && capture.strandId) {
      ownStrand(userId, capture.strandId)
      requireIdle(userId, capture.strandId)
      selectionFor(capture)
    }
    if (current && current.state === 'applied') {
      updateDecision(db, current.id, { state: 'confirmed', resolvedAt: 'now' })
    }
    const resumed = input.choice === CAPTURE_CONFIRM_ANSWER ? answerLater(userId, capture) : false
    if (capture.status === 'needs_review') updateCapture(db, capture.id, { status: 'filed' })
    // Filed now: no confirmation can reach this capture again, so the
    // in-flight mark has nothing left to protect.
    if (!resumed) answering.delete(capture.id)
    const fresh = getCapture(db, String(userId), capture.id)
    const decision = current ? getDecision(db, current.id) : null
    if (fresh && decision) emitRouted(userId, fresh, decision)
    return { handled: true, resumed }
  }

  /**
   * File a capture according to a proposal: write the chat row, bind the
   * capture, tag and link, pull the strand into the now set, and start the
   * turn for `ask`. `runTurn` says whether the answer may run now; see the
   * call sites for when it does not (SPEC 4.4).
   */
  function file(
    userId: number,
    capture: Capture,
    proposal: RouterProposal,
    decisionId: string,
    status: 'filed' | 'needs_review' | 'moved',
    runTurn: boolean,
    text: string = capture.text,
    part: PartRef = SINGLE_PART,
  ): Capture {
    selectionFor(capture)
    // Auto mode: the ranking BEFORE this filing writes its user message, so
    // the broadcast below only fires when the filing actually moved the set.
    const rankedBefore = nowSetMode() === 'auto' ? rankedNowIds(userId) : null
    if (proposal.action !== 'new_strand') {
      ownStrand(userId, proposal.strandId!)
      requireIdle(userId, proposal.strandId!)
    }
    const { strand, createdStrandId } = resolveTargets(userId, capture, proposal)
    if (proposal.action === 'link' && proposal.secondaryStrandId) {
      const secondary = ownStrand(userId, proposal.secondaryStrandId)
      createStrandLink(db, { fromStrand: strand.id, toStrand: secondary.id, captureId: capture.id, kind: 'reference' })
    }
    if (proposal.tags.length > 0) addStrandTags(db, String(userId), strand.id, proposal.tags, 'router')

    const messageId = writeMessage(userId, capture, strand, text, part)
    // Only the first part binds the capture row: `captures.strand_id` and
    // `captures.message_id` are what the tray, the home screen and
    // `GET /api/captures` read, and they expect one strand per capture. The
    // other parts are reachable through their decision rows and their
    // `chat_messages.part_index`.
    if (part.index === 0) updateCapture(db, capture.id, { status, strandId: strand.id, messageId, filedAt: 'now' })
    else updateCapture(db, capture.id, { status, filedAt: 'now' })
    updateDecision(db, decisionId, { state: 'applied', createdStrandId, strandId: strand.id, appliedAt: 'now' })

    const turn = runTurn && proposal.intent === 'ask'
    if (turn) {
      // Only a filing that is still open for review can be confirmed into a
      // second turn, so that is the only one worth remembering.
      if (status === 'needs_review') answering.add(capture.id)
      startTurn(userId, capture, strand, withCapturePartPrefix(text, { ...part, captureId: capture.id }))
    } else {
      bumpStrandActivity(userId, strand, 1)
    }
    if (rankedBefore) {
      // Computed set: never write `now_set` (manual mode and the rollback keep
      // their table), only tell the clients when the order or content changed.
      const rankedAfter = rankedNowIds(userId)
      if (rankedAfter.join('\u0000') !== rankedBefore.join('\u0000')) {
        broadcast(userId, { type: 'now_set_changed', source: 'web', strandIds: rankedAfter })
      }
    } else if (addToNowSetIfRoom(db, String(userId), strand.id, nowSetMax())) {
      broadcast(userId, { type: 'now_set_changed', source: 'web', strandIds: nowSetIds(userId) })
    }
    broadcast(userId, {
      type: 'user_message', source: 'web', sessionId: strand.id, agentId: strand.agentId, text,
    })
    return getCapture(db, String(userId), capture.id)!
  }

  /** The computed now set (auto mode), same ranking the API returns. */
  function rankedNowIds(userId: number): string[] {
    return rankStrandsByActivity(db, String(userId), { max: nowSetMax() })
  }

  function nowSetIds(userId: number): string[] {
    // The set can exceed the current limit when the size setting was lowered
    // under it; the broadcast must still carry every id in it.
    return manager().listThreads(String(userId), { nowOnly: true, limit: Math.max(nowSetMax(), 10) }).map(t => t.id)
  }

  function proposalFromDecision(decision: Decision, override: Partial<RouterProposal> = {}): RouterProposal {
    return {
      action: decision.action,
      strandId: decision.strandId,
      secondaryStrandId: decision.secondaryStrandId,
      newStrand: decision.action === 'new_strand'
        ? {
          title: decision.title ?? 'New strand',
          personaId: decision.personaId ?? defaultPersona(),
          tags: decision.tags,
          projectId: decision.projectId,
        }
        : null,
      intent: decision.intent,
      confidence: decision.confidence,
      tags: decision.tags,
      rationale: decision.rationale,
      alternatives: decision.alternatives,
      projectSuggestion: decision.projectSuggestion,
      ...override,
    }
  }

  /** Insert a decision row from a proposal; `newStrand` lands in its own columns. */
  function persistProposal(
    captureId: string,
    proposal: RouterProposal,
    extra: { model: string; latencyMs: number | null; confidence?: number; rationale?: string },
    part?: { index: number; count: number; text: string | null; title: string | null; sentenceIds: number[] },
  ): Decision {
    return insertDecision(db, {
      partIndex: part?.index ?? 0,
      partCount: part?.count ?? 1,
      partText: part?.text ?? null,
      partTitle: part?.title ?? null,
      sentenceIds: part?.sentenceIds ?? [],
      captureId,
      action: proposal.action,
      strandId: proposal.strandId,
      secondaryStrandId: proposal.secondaryStrandId,
      intent: proposal.intent,
      confidence: extra.confidence ?? proposal.confidence,
      tags: proposal.action === 'new_strand' && proposal.newStrand
        ? Array.from(new Set([...proposal.newStrand.tags, ...proposal.tags]))
        : proposal.tags,
      rationale: extra.rationale ?? proposal.rationale,
      title: proposal.newStrand?.title ?? null,
      personaId: proposal.newStrand?.personaId ?? null,
      projectId: proposal.newStrand?.projectId ?? null,
      projectSuggestion: proposal.projectSuggestion,
      alternatives: proposal.alternatives,
      model: extra.model,
      latencyMs: extra.latencyMs,
      state: 'proposed',
    })
  }

  /**
   * The routed frame. `decision` stays the decision of part 0 and the
   * top-level fields keep their meaning, so the Android app 0.16.x and the web
   * client read a split capture exactly like a single one; `parts` and
   * `partCount` are additive and only interesting to a client that knows them.
   * One frame per capture, never one per part: a second frame with the same
   * capture id would show up as a second card in every older client.
   */
  function emitRouted(userId: number, capture: Capture, decision: Decision): void {
    const parts = currentParts(capture, decision)
    broadcast(userId, {
      type: capture.status === 'needs_review' ? 'capture_needs_review' : 'capture_routed',
      source: 'web',
      sessionId: capture.strandId ?? undefined,
      agentId: capture.agentId ?? undefined,
      capture,
      decision,
      parts,
      partCount: parts.length,
    })
  }

  async function createCapture(userId: number, body: CreateCaptureBody): Promise<CaptureResult> {
    const userKey = String(userId)
    const selection = parseTurnModelSelection({ modelProviderId: body.turnOverride?.providerId, modelId: body.turnOverride?.modelId })
    if (!selection.ok) throw new CaptureServiceError(400, selection.code, selection.error)
    if (body.clientMessageId) {
      const existing = getCaptureByClientKey(db, userKey, body.clientMessageId)
      if (existing) return { capture: existing, decision: requireDecision(existing), created: false }
    }

    // A recording that contained no speech is stored and then put down
    // immediately: no router call, no strand, no card in the tray. It runs
    // before the strand branch because the mistake is the same on both paths —
    // a `* Musik *` appended to a chosen strand would start a turn about
    // nothing.
    //
    // Deliberately NOT gated on `kind: 'voice'`: the Android client posts its
    // on-device transcripts as `kind: 'text'` (51 of 51 in the live database),
    // and two of the twelve `* Musik *` cards arrived that way. The response
    // still carries the discarded capture, so the client can say what happened
    // and offer the undo.
    if (isSilenceTranscript(body.text)) return dismissWithoutRouting(userId, body, SILENCE_GUARD_MARKER, 'silence-guard')

    // Explicit beats heuristic (SPEC 4.1): a named strand skips the router.
    if (body.strandId) {
      // ... but only for a caller that can HAVE an intent. A named strand is a
      // user gesture; a program that sends one is asserting a choice nobody
      // made (capture b008c981, `source: 'bench'`, filed into a strand the
      // product owner was using, with the rationale "Strand chosen by the
      // user"). A program keeps the shortcut only for a strand it opened
      // itself, and then the decision row says so.
      const verdict = explicitTargetVerdict(db, { userId: userKey, source: body.source, strandId: body.strandId })
      if (verdict.kind === 'forbidden') throw new CaptureServiceError(400, verdict.code, verdict.message)
      const sessionManager = manager()
      let strand: Thread
      const owned = ownStrand(userId, body.strandId)
      requireIdle(userId, owned.id)
      try {
        const row = sessionManager.assertSessionAccess(userKey, body.strandId, body.agentId ?? owned.agentId)
        strand = sessionManager.getThread(userKey, row.id)!
      } catch (err) {
        if (isSessionAccessError(err)) throw new CaptureServiceError(400, 'invalid_strand', err.message)
        throw err
      }
      const capture = insertCapture(db, {
        userId: userKey, agentId: strand.agentId, clientMessageId: body.clientMessageId, text: body.text,
        kind: body.kind, source: body.source, attachments: body.attachments, strandId: strand.id,
      })
      // The mode travels with the capture even on the explicit path: the strand
      // decides where the answer goes, the mode still decides how it sounds.
      rememberSelection(capture, selection.value, body.mode)
      // No router runs on this path, so the text backstop is the only thing
      // between a sentence that clearly addresses the persona and a silent
      // filing. Two marker classes or more get an `ask` and therefore a turn;
      // without this, "schau dir das bitte an" typed into a strand the user
      // picked himself would be filed and answered by nobody — the exact
      // incident the backstop was built for, one path over.
      const addressed = !body.intent && addressStrength(capture.text) === 'strong'
      const intent: RouterIntent = body.intent ?? (addressed ? 'ask' : 'note')
      // The rationale has to survive being read a month later, so it states
      // who actually chose: a person on a user surface, or the client itself.
      const chose = verdict.kind === 'user' ? 'Strand chosen by the user' : `${CLIENT_TARGET_RATIONALE} (${body.source})`
      const proposal: RouterProposal = {
        action: 'append', strandId: strand.id, secondaryStrandId: null, newStrand: null, intent,
        confidence: 1, tags: [],
        rationale: addressed ? `${chose}. ${ADDRESSED_NOTE_MARKER}, intent note became ask.` : chose,
        alternatives: [], projectSuggestion: null,
      }
      const decision = persistProposal(capture.id, proposal, {
        model: verdict.kind === 'user' ? 'explicit' : CLIENT_TARGET_MODEL, latencyMs: 0,
      })
      const filed = file(userId, capture, proposal, decision.id, 'filed', true)
      // The strand was the user's choice, the intent was not: without
      // `body.intent` the `note` above is this server's default, and a default
      // is a guess. The text decides how loud that guess may be — the same
      // three bands the router path uses (SPEC 4.1), because the mistake is
      // the same one on both paths and a capture typed into a chosen strand
      // must not go silent just because no router ran. `strong` already became
      // an `ask` above and answered; `weak` gets the card; `none` stays a
      // silent note. A client that STATED the intent has decided already and
      // is never asked (explicit beats heuristic).
      if (!body.intent && addressStrength(capture.text) === 'weak') askBack(userId, filed, strand, true)
      const current = getDecision(db, decision.id)!
      emitRouted(userId, filed, current)
      return { capture: filed, decision: current, created: true, turn: takeTurn(filed.id) }
    }

    // Pure courtesy never reaches the router. A model asked where a thank you
    // belongs answers with a strand and a confidence, and both are fiction:
    // capture ffd77c2b ("Vielen Dank.", voice) was appended to an unrelated
    // strand with 0.87. Not asking is cheaper than distrusting the answer.
    //
    // Deliberately AFTER the explicit branch above, unlike the silence guard:
    // a "Danke!" typed into a strand the user picked himself is a line in a
    // conversation he is having, and throwing that away would be the server
    // overruling a gesture. Without a strand there is no conversation it could
    // belong to, which is exactly the case this gate covers.
    if (isFillerCapture(body.text)) return dismissWithoutRouting(userId, body, FILLER_GUARD_MARKER, 'filler-guard')

    // Capture mode „Kurzfrage" (U10a): a question asked into a device without a
    // screen. No router call (its latency is the whole point), one strand per
    // user and source, `ask` intent, and the mode's own model, thinking level
    // and spoken-answer style.
    //
    // A quick capture that DOES name a strand is not handled here: the puck
    // sends `strandId` plus `intent: 'ask'` for a follow-up question, and an
    // explicit target outranks the mode's own strand (SPEC 4.1). Such a
    // capture takes the normal explicit path below and only keeps the mode's
    // delivery settings (see `rememberSelection(..., body.mode)` there).
    //
    // Deliberately AFTER both guards: a silent recording and a bare "Danke"
    // are not questions, and the mode buys no exemption from the two rules
    // that exist to keep pointless turns from running at all.
    if (body.mode === 'quick' && !body.strandId) return createQuick(userId, body)

    const capture = insertCapture(db, {
      userId: userKey, agentId: body.agentId, clientMessageId: body.clientMessageId, text: body.text,
      kind: body.kind, source: body.source, attachments: body.attachments,
    })
    // The mode travels with the capture on the router path too. Only `assist`
    // can arrive here (a quick capture is handled above, with or without a
    // strand), and it needs to survive the request: the turn that writes the
    // draft starts after the router answered, and a later turn in the same
    // capture must sound the same.
    rememberSelection(capture, selection.value, body.mode)
    // Where did the previous capture of this same client go? For a device that
    // sends one utterance per capture that is the conversation it is in the
    // middle of, and without it every sentence is routed stone cold (six
    // strands from six consecutive Puck captures in one night).
    const deviceHint = findDeviceAffinity(db, userKey, { source: capture.source, excludeCaptureId: capture.id })
    // Candidates are selected ONCE, from the whole capture, and reused for
    // every part: the parts of one dictation compete for the same strands, and
    // a second selection per part would only cost reads.
    const input = buildRouterInput(db, userKey, {
      id: capture.id, text: capture.text, kind: capture.kind, personaHint: capture.agentId, createdAt: capture.createdAt,
    }, { personas: personaList(), defaultPersona: capture.agentId ?? defaultPersona(), deviceHint })

    const split = await splitForIntake(capture, body)
    if (split.model !== 'none') rememberSplit(capture.id, split)
    return routeParts(userId, capture, body, input, split)
  }

  /**
   * Split a capture into topic parts before it is routed, or return the single
   * part that is the capture itself.
   *
   * Never for `assist`: an assist capture asks for ONE draft the user is about
   * to paste somewhere, and two parallel drafts out of one dictation is not a
   * thing the client can render (quick mode never reaches this point, it has
   * its own path above).
   */
  async function splitForIntake(capture: Capture, body: CreateCaptureBody): Promise<CaptureSplit> {
    if (body.mode === 'assist') return singlePartSplit(capture.text, 'assist mode files as one')
    if (!isSplitEligible({ kind: capture.kind, text: capture.text })) {
      return singlePartSplit(capture.text, 'not eligible for a split')
    }
    const chain = options.routerChain?.()
    const split = await runCaptureSplit(capture.text, {
      ...(chain ? { chain } : {}),
      ...(options.splitComplete ? { complete: options.splitComplete } : {}),
    })
    for (const note of split.notes) console.warn(`[split] capture ${capture.id}: ${note}`)
    if (split.parts.length > 1) {
      console.log(`[split] capture ${capture.id}: ${split.parts.length} parts (${split.splitConfidence.toFixed(2)}) ${split.parts.map(part => part.title).join(' | ')}`)
    }
    return split
  }

  /**
   * Route every part of a capture: one router call, one decision row and one
   * filing per part, then the aggregate status of the capture. With a single
   * part this is the path captures have always taken, step for step.
   */
  async function routeParts(
    userId: number,
    capture: Capture,
    body: CreateCaptureBody,
    input: RouterInput,
    split: CaptureSplit,
  ): Promise<CaptureResult> {
    const userKey = String(userId)
    const count = split.parts.length
    let firstDecisionId: string | null = null
    let filed: Capture = capture

    for (const part of split.parts) {
      const partInput: RouterInput = count > 1
        ? { ...input, capture: { ...input.capture, text: part.text } }
        : input
      const result = await runRouter(partInput, { chain: options.routerChain?.(), complete: options.routerComplete })
      for (const note of result.notes) console.warn(`[router] capture ${capture.id} part ${part.index}: ${note}`)
      // Explicit beats heuristic (SPEC 4.1): an intent the client states itself
      // is taken as it is, the guards only correct the router's own verdict.
      const guarded = body.intent
        ? { proposal: { ...result.proposal, intent: body.intent }, doubtful: false }
        : guardAddressedNote(guardNoteIntoLiveDialog(result.proposal), part.text)
      let proposal = guarded.proposal
      const band = confidenceBand(proposal.confidence)
      // The doubt band only exists where there is a strand to ask in. A low band
      // capture is not filed at all, it waits in the inbox with the user looking
      // at it, so neither the marker nor the question is written — that keeps the
      // marker count equal to the number of questions asked.
      const doubtful = guarded.doubtful && band !== 'low'
      if (doubtful) proposal = markDoubtful(proposal)

      const decision = persistProposal(capture.id, proposal, { model: result.model, latencyMs: result.latencyMs }, {
        index: part.index,
        count,
        text: count > 1 ? part.text : null,
        title: part.title || null,
        sentenceIds: part.sentenceIds,
      })
      if (part.index === 0) firstDecisionId = decision.id

      if (band === 'low') {
        if (count === 1) updateCapture(db, capture.id, { status: result.model === 'synthetic' ? 'failed' : 'unsorted' })
        filed = getCapture(db, userKey, capture.id)!
      } else {
        // Two independent questions, and only one of them belongs to the band:
        // WHERE the capture goes is uncertain below 0.70 and stays reviewable,
        // WHETHER an answer is owed is the intent's business alone. Coupling the
        // second to the first is what left the product owner's questions sitting
        // silently in `needs_review`.
        //
        // Safe because `guardLowConfidenceAppend` has already turned every
        // sub-0.70 `append`/`link` into a `new_strand`: a medium band filing
        // lands in a strand this very capture opened, never in a foreign
        // history. The `new_strand` test keeps that guarantee checkable from
        // here instead of trusting a guard two packages away.
        const answers = band === 'high' || proposal.action === 'new_strand'
        filed = file(
          userId, capture, proposal, decision.id, band === 'high' ? 'filed' : 'needs_review', answers,
          part.text, { index: part.index, count },
        )
        // Only the doubt band asks. `doubtful` already carries every condition
        // that may produce a card — intent `note`, no stated intent from the
        // client, exactly one address marker in the text, a band that files
        // somewhere — so this is the whole rule and not a second one next to it.
        //
        // A note WITHOUT any marker is filed in silence on purpose. It was
        // briefly the other way round ("every note the router decided ends in a
        // card"), and the measurement of that week is the reason it is not:
        // eleven of twelve cards fired on machine written test notes, none on a
        // sentence addressed to anyone.
        const cardStrandId = count > 1 ? decision.strandId ?? partFiling(capture.id, part.index)?.strandId ?? null : filed.strandId
        if (doubtful && cardStrandId) {
          const strand = manager().getThread(userKey, cardStrandId)
          if (strand) askBack(userId, filed, strand, true)
        }
      }
    }

    if (count > 1) filed = syncCaptureStatus(userId, capture.id) ?? filed
    const current = getDecision(db, firstDecisionId!)!
    emitRouted(userId, filed, current)
    return { capture: filed, decision: current, created: true, turn: takeTurn(filed.id) }

  }

  /**
   * The quick path: file into the mode's strand and answer at once.
   *
   * What it does NOT do is as important as what it does. No router runs, so
   * nothing can be filed into a strand the user is having a different
   * conversation in; the only strand it ever touches is one a previous quick
   * capture of this same source created (proved by
   * `router_decisions.created_strand_id`, the same evidence the explicit-target
   * guard trusts) or one it creates itself. The decision row says
   * `model: 'quick-mode'` so quick filings stay countable next to router ones
   * and never claim a confidence the server did not compute.
   */
  function createQuick(userId: number, body: CreateCaptureBody): CaptureResult {
    const userKey = String(userId)
    const plan = planQuickMode(body.source)
    if (plan.modelNote) console.warn(`[captures] quick mode: ${plan.modelNote}`)
    const agentId = body.agentId ?? defaultPersona()
    // An explicit pin from the client outranks the mode's configured model
    // (SPEC 4.1, explicit beats heuristic): the caller named a model, the
    // setting only says what to use when nobody did.
    const selection = body.turnOverride ?? plan.turnOverride

    const existing = findQuickStrand(db, userKey, body.source)
    const strandId = existing && strandStillThere(userId, existing) ? existing : null
    if (strandId) requireIdle(userId, strandId)

    const capture = insertCapture(db, {
      userId: userKey, agentId, clientMessageId: body.clientMessageId, text: body.text,
      kind: body.kind, source: body.source, attachments: body.attachments,
    })
    rememberSelection(capture, selection, 'quick')

    const proposal: RouterProposal = strandId
      ? {
        action: 'append', strandId, secondaryStrandId: null, newStrand: null, intent: 'ask',
        confidence: 1, tags: [], rationale: `${QUICK_MODE_RATIONALE} (${body.source})`,
        alternatives: [], projectSuggestion: null,
      }
      : {
        action: 'new_strand', strandId: null, secondaryStrandId: null, intent: 'ask',
        newStrand: { title: plan.strandTitle, personaId: agentId, tags: [], projectId: null },
        confidence: 1, tags: [], rationale: `${QUICK_MODE_RATIONALE} (${body.source})`,
        alternatives: [], projectSuggestion: null,
      }
    const decision = persistProposal(capture.id, proposal, { model: QUICK_MODE_MODEL, latencyMs: 0 })
    const filed = file(userId, capture, proposal, decision.id, 'filed', true)
    const current = getDecision(db, decision.id)!
    emitRouted(userId, filed, current)
    return { capture: filed, decision: current, created: true, turn: takeTurn(filed.id) }
  }

  /**
   * Is this strand still readable for the user? `findQuickStrand` already
   * filters archived rows in SQL, but the strand can also have been deleted or
   * handed to another persona between two utterances, and appending to a row
   * the session manager refuses would turn a question into a 400 instead of an
   * answer. A missing strand simply means the next quick capture opens one.
   */
  function strandStillThere(userId: number, strandId: string): boolean {
    try {
      return manager().getThread(String(userId), strandId) !== null
    } catch {
      return false
    }
  }

  /**
   * Store a capture that never reached the router as already discarded: a
   * silent recording, or a text that is pure courtesy. The capture row
   * survives so the transcript stays auditable (`?status=dismissed`) and a
   * retried `clientMessageId` still resolves; the decision records WHY through
   * its `model` and its rationale marker, which is what separates a guard from
   * a swallowed request and makes each gate countable on its own.
   */
  function dismissWithoutRouting(
    userId: number,
    body: CreateCaptureBody,
    marker: string,
    model: string,
  ): CaptureResult {
    const userKey = String(userId)
    const capture = insertCapture(db, {
      userId: userKey, agentId: body.agentId, clientMessageId: body.clientMessageId, text: body.text,
      kind: body.kind, source: body.source, attachments: body.attachments,
    })
    const decision = persistProposal(capture.id, {
      action: 'new_strand', strandId: null, secondaryStrandId: null, newStrand: null, intent: 'note',
      confidence: 0, tags: [], rationale: marker, alternatives: [], projectSuggestion: null,
    }, { model, latencyMs: 0 })
    updateDecision(db, decision.id, { state: 'superseded', resolvedAt: 'now' })
    updateCapture(db, capture.id, { status: 'dismissed' })
    const stored = getCapture(db, userKey, capture.id)!
    const current = getDecision(db, decision.id)!
    emitRouted(userId, stored, current)
    return { capture: stored, decision: current, created: true }
  }

  /**
   * Throw a tray card away (SPEC 4.3). The capture keeps its row and its
   * decision — "nothing is lost" — but leaves every list, so the inbox can
   * actually reach zero. Before this existed the app offered "keep unsorted",
   * which wrote nothing at all and left the card in place forever.
   */
  function dismiss(userId: number, captureId: string): CaptureResult {
    const capture = requireCapture(userId, captureId)
    const current = requireDecision(capture)
    // Idempotent: a double tap, or an undo raced by a second discard, is a 200
    // with the state the client already believes in.
    if (capture.status === 'dismissed') return { capture, decision: current, created: false }
    if (capture.status !== 'unsorted' && capture.status !== 'failed') {
      throw new CaptureServiceError(409, 'not_in_tray', 'Only an unsorted or failed capture can be discarded')
    }
    // A tray capture has no strand and no message by construction, so there is
    // no transcript to evict and no turn to lose a race against. The fields
    // are cleared anyway: a later restore must start from a clean row.
    answering.delete(capture.id)
    for (const part of listCurrentDecisions(db, capture.id)) {
      if (part.state === 'proposed') updateDecision(db, part.id, { state: 'superseded', resolvedAt: 'now' })
    }
    updateCapture(db, capture.id, { status: 'dismissed', strandId: null, messageId: null, filedAt: null })
    const stored = getCapture(db, String(userId), capture.id)!
    const decision = getDecision(db, current.id)!
    emitRouted(userId, stored, decision)
    return { capture: stored, decision, created: false }
  }

  /** Undo of a discard: the card comes back with its proposal intact. */
  function restore(userId: number, capture: Capture, current: Decision): CaptureResult {
    for (const part of listCurrentDecisions(db, capture.id)) {
      if (part.state === 'superseded') updateDecision(db, part.id, { state: 'proposed', resolvedAt: null })
    }
    updateCapture(db, capture.id, { status: 'unsorted', strandId: null, messageId: null, filedAt: null })
    const stored = getCapture(db, String(userId), capture.id)!
    const decision = getDecision(db, current.id)!
    emitRouted(userId, stored, decision)
    return { capture: stored, decision, created: false }
  }

  /**
   * The tray listing. `decisions` keeps exactly one entry per capture (the
   * decision of part 0), which is what every client built before parts reads;
   * `parts` carries every part of every capture in the same response.
   */
  function list(userId: number, query: { status: Capture['status'] | 'all'; limit: number; offset: number }) {
    const captures = listCaptures(db, String(userId), query)
    const ids = captures.map(c => c.id)
    const decisions = listDecisionsForCaptures(db, ids)
    const all = listAllCurrentDecisions(db, ids)
    const parts: Record<string, CapturePartView[]> = {}
    for (const capture of captures) {
      parts[capture.id] = describeParts(capture, all.filter(d => d.captureId === capture.id))
    }
    return { captures, decisions, parts }
  }

  /** One capture with its parts, the shape `GET /api/captures/:id` returns. */
  function get(userId: number, captureId: string) {
    const capture = requireCapture(userId, captureId)
    const decisions = listCurrentDecisions(db, capture.id)
    const decision = decisions.find(d => d.partIndex === 0) ?? decisions[0] ?? null
    if (!decision) throw new CaptureServiceError(500, 'decision_missing', 'Capture has no routing decision')
    return {
      capture,
      decision,
      parts: describeParts(capture, decisions),
      partCount: decision.partCount,
      split: splitInfo(capture.id),
      // The sentences exactly as the split numbered them (1-based in
      // `sentenceIds`), so a client can mark a part inside the original
      // without re-implementing the segmentation. Only worth sending when
      // there is more than one part to mark.
      sentences: decision.partCount > 1 ? segmentSentences(capture.text) : [],
    }
  }

  /**
   * The current parts of a capture, one shape for the frame, the detail view
   * and every write response. A single part capture is answered from the
   * decision in hand, a split one is read back so every part is current.
   */
  function currentParts(capture: Capture, decision: Decision): CapturePartView[] {
    const decisions = decision.partCount > 1 ? listCurrentDecisions(db, capture.id) : [decision]
    return describeParts(capture, decisions)
  }

  /** The result as it leaves the service: with the parts the write left behind. */
  function withParts(result: CaptureResult): CaptureResult {
    const parts = currentParts(result.capture, result.decision)
    return { ...result, parts, partCount: parts.length }
  }

  /**
   * The parts of a capture as the API delivers them: the consolidated text of
   * each part, the sentences it was built from and its own decision. A capture
   * that was not split has exactly one part whose text IS the capture text.
   */
  function describeParts(capture: Capture, decisions: Decision[]): CapturePartView[] {
    return decisions.map(decision => ({
      index: decision.partIndex,
      title: decision.partTitle,
      text: decision.partText ?? capture.text,
      sentenceIds: decision.sentenceIds,
      decision,
    }))
  }

  /**
   * What the split decided, read back from `captures.metadata`. Null for every
   * capture that was never looked at (too short, setting off, assist mode).
   */
  function splitInfo(captureId: string): SplitInfo {
    const row = db.prepare('SELECT metadata FROM captures WHERE id = ?').get(captureId) as { metadata: string | null } | undefined
    if (!row?.metadata) return { confidence: null, rationale: null, gated: false }
    try {
      const parsed = JSON.parse(row.metadata) as { split?: { confidence?: number; rationale?: string; gated?: boolean } }
      const split = parsed.split
      if (!split) return { confidence: null, rationale: null, gated: false }
      return {
        confidence: typeof split.confidence === 'number' ? split.confidence : null,
        rationale: typeof split.rationale === 'string' ? split.rationale : null,
        gated: split.gated === true,
      }
    } catch {
      return { confidence: null, rationale: null, gated: false }
    }
  }

  /** Keep what the split decided with the capture, next to mode and model pin. */
  function rememberSplit(captureId: string, split: CaptureSplit): void {
    const row = db.prepare('SELECT metadata FROM captures WHERE id = ?').get(captureId) as { metadata: string | null } | undefined
    let metadata: Record<string, unknown> = {}
    try { metadata = row?.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {} } catch { metadata = {} }
    metadata.split = { confidence: split.splitConfidence, rationale: split.rationale, gated: split.gated, parts: split.parts.length }
    db.prepare('UPDATE captures SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), captureId)
  }

  function manualProposal(capture: Capture, body: ApplyCaptureBody, base: Decision): RouterProposal {
    const action: RouterAction = body.action ?? base.action
    const title = body.title ?? base.title ?? 'New strand'
    const personaId = body.personaId ?? base.personaId ?? capture.agentId ?? defaultPersona()
    return {
      action,
      strandId: action === 'new_strand' ? null : (body.strandId ?? base.strandId),
      secondaryStrandId: action === 'link' ? base.secondaryStrandId : null,
      // No project: this is the product owner correcting the router, and a
      // project the router guessed must not ride along into a target the user
      // picked by hand (SPEC 4.2b).
      newStrand: action === 'new_strand' ? { title, personaId, tags: base.tags, projectId: null } : null,
      intent: base.intent,
      confidence: 1,
      tags: base.tags,
      rationale: 'Chosen by the user',
      alternatives: [],
      projectSuggestion: null,
    }
  }

  /**
   * Apply one part of a capture (part 0 by default, which is the whole capture
   * for everything that was not split).
   */
  function apply(userId: number, captureId: string, body: ApplyCaptureBody): CaptureResult {
    const stored = requireCapture(userId, captureId)
    const partIndex = body.partIndex ?? 0
    const current = getCurrentDecisionForPart(db, stored.id, partIndex)
    if (!current) throw new CaptureServiceError(404, 'part_not_found', `Capture has no part ${partIndex}`)
    const result = applyPart(userId, partView(stored, current), current, body)
    if (current.partCount < 2) return result
    const fresh = syncCaptureStatus(userId, stored.id) ?? result.capture
    const decision = getCurrentDecision(db, stored.id) ?? result.decision
    emitRouted(userId, fresh, decision)
    return { ...result, capture: fresh, decision }
  }

  function applyPart(userId: number, capture: Capture, current: Decision, body: ApplyCaptureBody): CaptureResult {
    const part: PartRef = { index: current.partIndex, count: current.partCount }
    if (body.decisionId && body.decisionId !== current.id) {
      throw new CaptureServiceError(409, 'decision_superseded', 'That decision is no longer current')
    }
    const alternative: DecisionAlternative | undefined = body.action || body.strandId
      ? current.alternatives.find(a => a.action === (body.action ?? a.action) && (body.strandId ? a.strandId === body.strandId : true))
      : undefined

    const applied = current.state === 'applied' || current.state === 'confirmed'
    const isConfirm = !body.action && !body.strandId && !body.title
    if (applied && isConfirm) {
      if (capture.status === 'needs_review' && current.intent === 'ask' && capture.strandId
        && !answering.has(capture.id) && !answerExists(capture)) {
        ownStrand(userId, capture.strandId)
        requireIdle(userId, capture.strandId)
        selectionFor(capture)
      }
      // Confirming a needs_review filing. The answer normally ran when the
      // capture was filed; this catches the two cases where it did not — a
      // row from before the intent and the band were decoupled, and a filing
      // whose turn runner was missing at the time.
      if (current.state === 'applied') updateDecision(db, current.id, { state: 'confirmed', resolvedAt: 'now' })
      if (capture.status === 'needs_review') {
        updateCapture(db, capture.id, { status: 'filed' })
        if (current.intent === 'ask') answerLater(userId, capture)
        // Filed now: no confirmation can reach this capture again, so the
        // in-flight mark has nothing left to protect.
        answering.delete(capture.id)
      }
      const fresh = getCapture(db, String(userId), capture.id)!
      const decision = getDecision(db, current.id)!
      emitRouted(userId, fresh, decision)
      return { capture: fresh, decision, created: false }
    }
    if (applied) {
      // A different target for an already filed capture is a move: same
      // mechanics as undo with a target (SPEC 4.5).
      return move(userId, capture, current, manualProposal(capture, body, current), alternative, part)
    }

    // Unsorted (or failed) capture: apply the proposal, an alternative, or a manual choice.
    const proposal = isConfirm ? proposalFromDecision(current) : manualProposal(capture, body, current)
    if (proposal.action !== 'new_strand' && !proposal.strandId) {
      throw new CaptureServiceError(400, 'invalid_strand', 'strandId is required for this action')
    }
    selectionFor(capture)
    if (proposal.action !== 'new_strand') {
      ownStrand(userId, proposal.strandId!)
      requireIdle(userId, proposal.strandId!)
    }
    let decisionId = current.id
    if (!isConfirm) {
      updateDecision(db, current.id, { state: 'superseded', resolvedAt: 'now' })
      decisionId = persistProposal(capture.id, proposal, { model: 'user', latencyMs: null, confidence: alternative?.confidence ?? 1 }, {
        index: part.index, count: part.count, text: current.partText, title: current.partTitle, sentenceIds: current.sentenceIds,
      }).id
    }
    const filed = file(userId, capture, proposal, decisionId, 'filed', true, capture.text, part)
    const decision = getDecision(db, decisionId)!
    if (decision.state === 'applied' && isConfirm) updateDecision(db, decisionId, { state: 'confirmed', resolvedAt: 'now' })
    const finalDecision = getDecision(db, decisionId)!
    emitRouted(userId, filed, finalDecision)
    return { capture: filed, decision: finalDecision, created: false, turn: takeTurn(filed.id) }
  }

  /**
   * Undo semantics (SPEC 4.5). Before an answer exists the filing is a true
   * move (or a return to unsorted); afterwards the exchange stays where it
   * happened, badged `misfiled`, and the text is re-filed as a fresh capture.
   */
  function undo(userId: number, captureId: string, body: UndoCaptureBody): CaptureResult {
    const stored = requireCapture(userId, captureId)
    const count = capturePartCount(db, stored.id)
    if (count > 1 && body.partIndex === null) return undoAllParts(userId, stored, body)
    const partIndex = body.partIndex ?? 0
    const current = getCurrentDecisionForPart(db, stored.id, partIndex)
    if (!current) throw new CaptureServiceError(404, 'part_not_found', `Capture has no part ${partIndex}`)
    const result = undoPart(userId, partView(stored, current), current, body)
    if (current.partCount < 2) return result
    const fresh = syncCaptureStatus(userId, stored.id) ?? result.capture
    const decision = getCurrentDecision(db, stored.id) ?? result.decision
    emitRouted(userId, fresh, decision)
    return { ...result, capture: fresh, decision }
  }

  /**
   * Undo of a whole split capture: every part goes back, the capture lands in
   * the tray. Highest part first so part 0 (the part the capture row is bound
   * to) is the last binding that is cleared.
   */
  function undoAllParts(userId: number, stored: Capture, body: UndoCaptureBody): CaptureResult {
    const decisions = listCurrentDecisions(db, stored.id)
    for (const decision of [...decisions].reverse()) {
      undoPart(userId, partView(stored, decision), decision, { strandId: null, partIndex: decision.partIndex }, false)
    }
    const fresh = syncCaptureStatus(userId, stored.id) ?? stored
    const decision = getCurrentDecision(db, stored.id)!
    emitRouted(userId, fresh, decision)
    return { capture: fresh, decision, created: false, turn: body.strandId ? takeTurn(stored.id) : null }
  }

  function undoPart(
    userId: number,
    capture: Capture,
    current: Decision,
    body: UndoCaptureBody,
    emit = true,
  ): CaptureResult {
    const part: PartRef = { index: current.partIndex, count: current.partCount }
    // A discard is undone through the same door as a filing: one undo path for
    // the client, whatever the last action was.
    if (capture.status === 'dismissed') return restore(userId, capture, current)
    const applied = current.state === 'applied' || current.state === 'confirmed'
    if (!applied || !capture.strandId) {
      // Nothing applied, or already undone: idempotent 200 with the current state.
      return { capture, decision: current, created: false }
    }
    const proposal: RouterProposal | null = body.strandId
      ? {
        action: 'append', strandId: body.strandId, secondaryStrandId: null, newStrand: null, intent: current.intent,
        confidence: 1, tags: [], rationale: 'Moved by the user', alternatives: [], projectSuggestion: null,
      }
      : null
    return move(userId, capture, current, proposal, undefined, part, emit)
  }

  function deleteEmptyCreatedStrand(userId: number, decision: Decision, exceptStrandId: string | null): void {
    if (!decision.createdStrandId || decision.createdStrandId === exceptStrandId) return
    const count = db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?')
      .get(decision.createdStrandId) as { count: number }
    if (count.count > 0) return
    db.prepare('UPDATE sessions SET message_count = 0 WHERE id = ?').run(decision.createdStrandId)
    db.prepare('DELETE FROM now_set WHERE user_id = ? AND strand_id = ?').run(String(userId), decision.createdStrandId)
    db.prepare('DELETE FROM strand_tags WHERE strand_id = ?').run(decision.createdStrandId)
    manager().deleteThread(String(userId), decision.createdStrandId)
  }

  function move(
    userId: number,
    capture: Capture,
    current: Decision,
    proposal: RouterProposal | null,
    alternative: DecisionAlternative | undefined,
    part: PartRef = SINGLE_PART,
    emit = true,
  ): CaptureResult {
    const oldStrand = manager().getThread(String(userId), capture.strandId!)
    if (proposal) selectionFor(capture)
    if (proposal && proposal.action !== 'new_strand') {
      ownStrand(userId, proposal.strandId!)
      requireIdle(userId, proposal.strandId!)
    }
    answering.delete(capture.id)

    if (!answerExists(capture)) {
      // True move: the chat row travels with the capture.
      updateDecision(db, current.id, { state: 'undone', resolvedAt: 'now' })
      if (capture.messageId !== null) {
        db.prepare('DELETE FROM chat_messages WHERE id = ? AND capture_id = ?').run(capture.messageId, capture.id)
      }
      if (oldStrand) bumpStrandActivity(userId, oldStrand, -1)
      // A question the server asked about THIS capture travels with it: left
      // behind it would ask about a note that is no longer there, and it would
      // keep an otherwise empty created strand alive.
      const removedNudges = db.prepare(
        `DELETE FROM chat_messages WHERE capture_id = ? AND role = 'assistant' AND metadata LIKE ?`,
      ).run(capture.id, NUDGE_LIKE).changes
      if (oldStrand) for (let i = 0; i < removedNudges; i += 1) bumpStrandActivity(userId, oldStrand, -1)
      if (!proposal) {
        // Only part 0 owns `captures.strand_id`/`message_id`; a later part
        // that goes back must not unbind the parts that are still filed.
        if (part.index === 0) updateCapture(db, capture.id, { status: 'unsorted', strandId: null, messageId: null, filedAt: null })
        else updateCapture(db, capture.id, { status: 'unsorted' })
        deleteEmptyCreatedStrand(userId, current, null)
        const fresh = getCapture(db, String(userId), capture.id)!
        const decision = getDecision(db, current.id)!
        if (emit) emitRouted(userId, fresh, decision)
        return { capture: fresh, decision, created: false }
      }
      const decision = persistProposal(capture.id, proposal, { model: 'user', latencyMs: null, confidence: alternative?.confidence ?? 1 }, {
        index: part.index, count: part.count, text: current.partText, title: current.partTitle, sentenceIds: current.sentenceIds,
      })
      const filed = file(userId, capture, proposal, decision.id, 'moved', true, capture.text, part)
      deleteEmptyCreatedStrand(userId, current, filed.strandId)
      const finalDecision = getDecision(db, decision.id)!
      if (emit) emitRouted(userId, filed, finalDecision)
      return { capture: filed, decision: finalDecision, created: false }
    }

    // After the answer: badge, link, re-file as a fresh capture.
    updateDecision(db, current.id, { state: 'undone', resolvedAt: 'now' })
    if (capture.messageId !== null) {
      const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(capture.messageId) as { metadata: string | null } | undefined
      let meta: Record<string, unknown> = {}
      try { meta = row?.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {} } catch { meta = {} }
      db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...meta, misfiled: true }), capture.messageId)
    }
    updateCapture(db, capture.id, { status: 'moved' })
    if (!proposal) {
      const fresh = getCapture(db, String(userId), capture.id)!
      const decision = getDecision(db, current.id)!
      if (emit) emitRouted(userId, fresh, decision)
      return { capture: fresh, decision, created: false }
    }
    const prefix = `moved from ${oldStrand?.title ?? 'another strand'}`
    const copy = insertCapture(db, {
      userId: String(userId), agentId: capture.agentId, clientMessageId: null, text: `${prefix}\n${capture.text}`,
      kind: capture.kind, source: capture.source, attachments: capture.attachments,
    })
    rememberSelection(copy, selectionFor(capture))
    const refiled: RouterProposal = {
      ...proposal, intent: 'note', secondaryStrandId: null, rationale: 'Moved by the user', projectSuggestion: null,
    }
    const decision = persistProposal(copy.id, refiled, { model: 'user', latencyMs: null, confidence: alternative?.confidence ?? 1 })
    const filed = file(userId, copy, refiled, decision.id, 'filed', false)
    if (oldStrand && filed.strandId) {
      createStrandLink(db, { fromStrand: oldStrand.id, toStrand: filed.strandId, captureId: capture.id, kind: 'moved_from' })
    }
    const finalDecision = getDecision(db, decision.id)!
    if (emit) emitRouted(userId, filed, finalDecision)
    return { capture: filed, decision: finalDecision, created: false, turn: takeTurn(filed.id) }
  }

  /**
   * The escape hatch of split-on-intake: the user says "this was one thought".
   * Every part goes back, the old decisions are superseded, and the ORIGINAL
   * capture text is routed once, with splitting switched off. Same capture row,
   * same id, so nothing the client holds becomes stale.
   */
  async function keepAsOne(userId: number, captureId: string): Promise<CaptureResult> {
    const stored = requireCapture(userId, captureId)
    if (stored.status === 'dismissed') throw new CaptureServiceError(409, 'capture_dismissed', 'A discarded capture cannot be re-routed')
    // Idempotent, like undo: a capture that already is one part (never split,
    // or kept as one a moment ago) is answered with its current state. Without
    // this a double tap routes the same text twice and opens a second strand.
    const current = getCurrentDecision(db, stored.id)
    if (current && current.partCount < 2) return { capture: stored, decision: current, created: false }
    const inflight = keepingAsOne.get(stored.id)
    if (inflight) return inflight
    const run = keepAsOneNow(userId, stored).finally(() => keepingAsOne.delete(stored.id))
    keepingAsOne.set(stored.id, run)
    return run
  }

  async function keepAsOneNow(userId: number, stored: Capture): Promise<CaptureResult> {
    const before = listCurrentDecisions(db, stored.id)
    for (const decision of [...before].reverse()) {
      const view = partView(stored, decision)
      if (decision.state === 'applied' || decision.state === 'confirmed') {
        undoPart(userId, view, decision, { strandId: null, partIndex: decision.partIndex }, false)
      }
    }
    for (const decision of listCurrentDecisions(db, stored.id)) {
      updateDecision(db, decision.id, { state: 'superseded', resolvedAt: 'now' })
    }
    updateCapture(db, stored.id, { status: 'pending', strandId: null, messageId: null, filedAt: null })
    const capture = getCapture(db, String(userId), stored.id)!
    const split = singlePartSplit(capture.text, 'kept as one by the user')
    rememberSplit(capture.id, { ...split, model: 'user' })
    const deviceHint = findDeviceAffinity(db, String(userId), { source: capture.source, excludeCaptureId: capture.id })
    const input = buildRouterInput(db, String(userId), {
      id: capture.id, text: capture.text, kind: capture.kind, personaHint: capture.agentId, createdAt: capture.createdAt,
    }, { personas: personaList(), defaultPersona: capture.agentId ?? defaultPersona(), deviceHint })
    const body: CreateCaptureBody = {
      text: capture.text, clientMessageId: null, agentId: capture.agentId, strandId: null,
      kind: capture.kind, source: capture.source, attachments: capture.attachments, intent: null, mode: modeOf(capture),
    }
    const result = await routeParts(userId, capture, body, input, split)
    return { ...result, created: false }
  }

  async function preview(userId: number, body: RouterPreviewBody): Promise<RouterPreviewResult> {
    const chain = options.routerChain?.()
    const split = isSplitEligible({ kind: 'text', text: body.text })
      ? await runCaptureSplit(body.text, {
        ...(chain ? { chain } : {}),
        ...(options.splitComplete ? { complete: options.splitComplete } : {}),
      })
      : singlePartSplit(body.text, 'not eligible for a split')
    const parts: RouterPreviewPart[] = []
    for (const part of split.parts) {
      const input = buildRouterInput(db, String(userId), {
        id: 'preview', text: part.text, kind: 'text', personaHint: body.agentId, createdAt: new Date().toISOString(),
      }, { personas: personaList(), defaultPersona: body.agentId ?? defaultPersona() })
      const result = await runRouter(input, { chain, complete: options.routerComplete })
      const p = result.proposal
      parts.push({
        index: part.index,
        title: part.title || null,
        text: part.text,
        sentenceIds: part.sentenceIds,
        decision: {
          action: p.action, strandId: p.strandId, secondaryStrandId: p.secondaryStrandId, createdStrandId: null,
          intent: p.intent, confidence: p.confidence, tags: p.tags, rationale: p.rationale, alternatives: p.alternatives,
          title: p.newStrand?.title ?? null, personaId: p.newStrand?.personaId ?? null,
          projectId: p.newStrand?.projectId ?? null, projectSuggestion: p.projectSuggestion,
          partIndex: part.index, partCount: split.parts.length,
          partText: split.parts.length > 1 ? part.text : null, partTitle: part.title || null,
          sentenceIds: part.sentenceIds,
          model: result.model, latencyMs: result.latencyMs, newStrand: p.newStrand, notes: result.notes,
        },
      })
    }
    return {
      decision: parts[0].decision,
      parts,
      partCount: parts.length,
      split: { confidence: split.splitConfidence, rationale: split.rationale, gated: split.gated },
    }
  }

  return {
    createCapture: async (userId: number, body: CreateCaptureBody) => withParts(await createCapture(userId, body)),
    list,
    get,
    apply: (userId: number, captureId: string, body: ApplyCaptureBody) => withParts(apply(userId, captureId, body)),
    undo: (userId: number, captureId: string, body: UndoCaptureBody) => withParts(undo(userId, captureId, body)),
    dismiss: (userId: number, captureId: string) => withParts(dismiss(userId, captureId)),
    keepAsOne: async (userId: number, captureId: string) => withParts(await keepAsOne(userId, captureId)),
    preview,
    confirmNoteFiling,
  }
}

export type CapturesService = ReturnType<typeof createCapturesService>
