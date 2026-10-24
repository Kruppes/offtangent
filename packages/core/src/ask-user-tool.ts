/**
 * ask-user-tool.ts — the `ask_user` tool (Stufe 1, S1-B).
 *
 * The model asks 1 to 4 structured questions through a tool call instead of
 * a markdown fence. The server validates the arguments
 * (`contracts/ask-user.ts`), files ONE row in the `interactions` table and
 * the client draws it from `interaction.open`. The arguments never reach the
 * chat stream as text: the runtime replaces them by
 * `{ pending: true, questionCount }` on `tool_call_start` (see
 * `redactAskUserArgs`), which the websocket bridge turns into an
 * `interaction.pending` skeleton card.
 *
 * Blocking question (default): the tool result carries `terminate: true`,
 * pi-agent-core stops after this tool batch, the assistant turn closes with a
 * complete toolCall/toolResult pair and the strand shows "waiting for input"
 * through the open interaction (S1-A attention). The answer starts a NEW
 * turn (`replyToInteractionId`, structured block, see the interactions
 * service).
 *
 * Non-blocking question: the turn goes on; the answer, and a dismissal of
 * any question, reach the model at the start of the next turn through
 * {@link claimInteractionContextNotes} (two-phase: reserve, confirm on turn end).
 *
 * Switch, read at every turn start: `settings.json` → `askUser.agents`
 * (persona ids). Missing key → default `['main', 'bob']`; malformed → off
 * for everyone (fail-closed). Offered only to turns from a card-capable
 * surface (web, android); Telegram and unknown sources keep the fence path.

 */
import { randomUUID } from 'node:crypto'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { loadConfig, warnConfigReadFailed } from './config.js'
import {
  ASK_USER_MAX_QUESTIONS,
  ASK_USER_TOOL_NAME,
  formatAskUserAnswerBlock,
  formatInteractionAnswerNote,
  formatInteractionDismissNote,
  isAskUserPayload,
  parseAskUserArgs,
  type AskUserAnswerItem,
} from './contracts/ask-user.js'
import { createInteraction, ensureInteractionsTable, getInteraction } from './interaction-store.js'
import { recordInteractionEvent } from './interaction-telemetry.js'

export const ASK_USER_DEFAULT_AGENTS: readonly string[] = ['main', 'bob']

/**
 * Surfaces that can draw and answer an ask_user card (review B1). Telegram
 * (DM and group) draws it as an inline keyboard since S1-C. Every unknown
 * source (task, cron, empty) does not get the tool and keeps the fence path.
 * The value is the turn source (`StartTurnInput.source` → runtime channel),
 * never anything the model says.
 */
export const ASK_USER_SURFACES: readonly string[] = ['web', 'android', 'telegram', 'telegram-group']

export interface AskUserSettings {
  /** Persona ids that get the tool. */
  agents: string[]
  /** The `askUser` key was present but malformed: the tool is off for everyone (fail-closed). */
  invalid?: boolean
}

/**
 * Resolve the raw `askUser` settings value. Missing key → pilot default
 * (`main`, `bob`); present but malformed → off for every persona (fail-closed).
 */
export function resolveAskUserSettings(raw: unknown): AskUserSettings {
  if (raw === undefined) return { agents: [...ASK_USER_DEFAULT_AGENTS] }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const agents = (raw as { agents?: unknown }).agents
    if (Array.isArray(agents) && agents.every(a => typeof a === 'string')) return { agents: [...agents] }
  }
  return { agents: [], invalid: true }
}

let warnedInvalidSettings = false

/** Test hook: allow the one-time warning about an invalid `askUser` value again. */
export function resetAskUserSettingsWarning(): void {
  warnedInvalidSettings = false
}

function warnInvalidOnce(reason: string): void {
  if (warnedInvalidSettings) return
  warnedInvalidSettings = true
  console.warn(`[ask_user] settings.json askUser ${reason}; ask_user is off for every persona until it is fixed.`)
}

/** Read per turn start (no restart needed after a settings change). */
export function loadAskUserSettings(): AskUserSettings {
  let settings: AskUserSettings
  try {
    settings = resolveAskUserSettings(loadConfig<{ askUser?: unknown }>('settings.json').askUser)
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    settings = { agents: [], invalid: true }
  }
  if (settings.invalid) warnInvalidOnce('is invalid or unreadable')
  return settings
}

export function isAskUserEnabledFor(agentId: string, settings: AskUserSettings = loadAskUserSettings()): boolean {
  return !settings.invalid && settings.agents.includes(agentId)
}

/** Whether the turn source can serve ask_user cards. Unknown/absent → no. */
export function isAskUserSurface(source: string | undefined | null): boolean {
  return typeof source === 'string' && ASK_USER_SURFACES.includes(source)
}

/** The per-turn switch: persona released AND the turn comes from a card-capable surface. */
export function isAskUserOfferedFor(agentId: string, source: string | undefined | null, settings?: AskUserSettings): boolean {
  if (!isAskUserSurface(source)) return false
  return isAskUserEnabledFor(agentId, settings ?? loadAskUserSettings())
}

/** System prompt addendum when the switch is on: the tool replaces the fence. */
export const ASK_USER_SYSTEM_HINT = [
  '## Rückfragen an den Nutzer',
  'Für Rückfragen mit festen Antwortmöglichkeiten nutzt du das Tool `ask_user` (1 bis 4 Fragen, je Frage type choice|multi|confirm).',
  'Nutze dafür NICHT mehr den Markdown-Block ```offtangent```. Schreibe die Optionen nicht zusätzlich als Text.',
  'Nach einer blockierenden Frage endet dein Turn; die Antwort kommt als neue Nutzernachricht mit einem <interaction_answer>-Block.',
].join('\n')

const optionSchema = Type.Object({
  id: Type.String({ description: 'Stable option id, [A-Za-z0-9_-]{1,64}; "other" is reserved' }),
  label: Type.String({ description: 'Button label' }),
  description: Type.Optional(Type.String({ description: 'Optional one-line explanation' })),
})

const questionSchema = Type.Object({
  id: Type.Optional(Type.String({ description: 'Optional question id; defaults to q1..q4' })),
  type: Type.String({ description: 'choice (exactly one) | multi (one or more) | confirm (yes/no)' }),
  question: Type.String({ description: 'The question text' }),
  options: Type.Optional(Type.Array(optionSchema, { description: 'Answer options; confirm defaults to Ja/Nein' })),
  allowComment: Type.Optional(Type.Boolean({ description: 'Allow a free-text comment; adds an automatic "Other" row' })),
  recommended: Type.Optional(Type.String({ description: 'Id of the recommended option' })),
})

const askUserParameters = Type.Object({
  questions: Type.Array(questionSchema, { description: `1 to ${ASK_USER_MAX_QUESTIONS} questions` }),
  blocking: Type.Optional(Type.Boolean({ description: 'Default true: end the turn and wait for the answer' })),
  expiresInMinutes: Type.Optional(Type.Number({ description: 'Optional lifetime of the question in minutes' })),
})

export interface AskUserToolDeps {
  db: Database
  getSessionId: () => string | undefined
  getUserId: () => number | undefined
  getAgentId: () => string
  now?: () => number
  /**
   * B2 turn-end rule: claims the one blocking slot of the current turn.
   * Returns false when a blocking question was already asked in this turn;
   * the call then fails with {@link ASK_USER_ONE_BLOCKING_ERROR} and no card
   * is filed. Synchronous on purpose: parallel calls of one batch race here.
   */
  claimBlockingSlot?: () => boolean
}

/** Error of a second blocking ask_user call in the same turn (B2). */
export const ASK_USER_ONE_BLOCKING_ERROR = 'nur eine blockierende Frage je Turn'

/**
 * B2 turn-end rule: whether a completed tool batch holds a successful
 * blocking ask_user call. The runtime ends the turn after such a batch
 * (`finishTurn` → `end`), after the other calls of the batch ran normally,
 * without a further model request.
 */
export function batchHasBlockingAskUser(
  toolResults: ReadonlyArray<{ toolName: string; isError: boolean; details?: unknown }>,
): boolean {
  return toolResults.some(result => result.toolName === ASK_USER_TOOL_NAME
    && !result.isError
    && (result.details as { blocking?: unknown } | undefined)?.blocking === true)
}

/** Text of the tool result after a blocking question; the turn ends with it. */
export const ASK_USER_WAITING_RESULT = 'Frage gestellt, warte auf Antwort.'

export function createAskUserTool(deps: AskUserToolDeps): AgentTool {
  // The notes table exists before the first card closes: created lazily on
  // the first read, its baseline would swallow a dismissal made earlier.
  try {
    ensureNotesTable(deps.db)
  } catch (err) {
    console.warn('[ask_user] Could not prepare the context notes table:', (err as Error).message)
  }
  return {
    name: ASK_USER_TOOL_NAME,
    label: 'Ask user',
    description: 'Ask the user 1 to 4 structured questions with fixed options (choice, multi, confirm). '
      + 'A blocking question (default) ends your turn; the answer arrives as the next user message.',
    parameters: askUserParameters,
    execute: async (toolCallId: string, params: unknown) => {
      const parsed = parseAskUserArgs(params, { id: toolCallId, now: deps.now?.() })
      // The error text names the rule only, never a value from the arguments.
      if (!parsed.ok) throw new Error(`ask_user rejected (${parsed.code}): ${parsed.error}. Fix the arguments and call ask_user again.`)
      const strandId = deps.getSessionId()
      if (!strandId) throw new Error('ask_user needs a strand; ask in plain text instead.')
      const payload = parsed.value
      if (payload.blocking && deps.claimBlockingSlot && !deps.claimBlockingSlot()) {
        throw new Error(`ask_user rejected: ${ASK_USER_ONE_BLOCKING_ERROR}. Your first blocking question is already open; end the turn.`)
      }
      const { record } = createInteraction(deps.db, {
        strandId,
        userId: deps.getUserId() ?? null,
        messageId: latestMessageId(deps.db, strandId),
        agent: deps.getAgentId(),
        payload,
        toolCallId,
        blockId: null,
        blocking: payload.blocking,
        now: deps.now?.(),
      })
      recordInteractionEvent('other', 'card_tool')
      const text = payload.blocking
        ? `${ASK_USER_WAITING_RESULT} (interaction ${record.id}) Beende den Turn ohne weitere Ausgabe.`
        : `Frage gestellt (interaction ${record.id}, nicht blockierend). Arbeite weiter; die Antwort kommt im nächsten Turn.`
      return {
        content: [{ type: 'text' as const, text }],
        details: { interactionId: record.id, blocking: payload.blocking, questionCount: payload.questions.length },
        // B2: a blocking question ends the turn after this tool batch.
        terminate: payload.blocking,
      }
    },
  } as AgentTool
}

/**
 * The newest message of the strand: the anchor of the card. The assistant row
 * of the asking turn does not exist yet while the tool runs; the card hangs
 * on the message that triggered the turn (or 0 for an empty strand), which
 * keeps the S1-A stale rule (strictly older messages are superseded) intact.
 */
function latestMessageId(db: Database, strandId: string): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE session_id = ?').get(strandId) as { id: number | null } | undefined
  return row?.id ?? 0
}

// ---------------------------------------------------------------------------
// Next-turn context (non-blocking answers, dismissals)
// ---------------------------------------------------------------------------

/** Lease of a reserved context note: redelivered after this when no turn confirmed it. */
export const INTERACTION_NOTE_LEASE_MS = 10 * 60 * 1000

function ensureNotesTable(db: Database): void {
  ensureInteractionsTable(db)
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'interaction_context_notes'").get()
  if (exists) {
    // Upgrade of the first S1-B shape (read = delivered): add the two-phase
    // columns; rows marked before count as delivered.
    const cols = (db.prepare('PRAGMA table_info(interaction_context_notes)').all() as Array<{ name: string }>).map(c => c.name)
    if (!cols.includes('delivered_at')) {
      db.exec(`ALTER TABLE interaction_context_notes ADD COLUMN turn_id TEXT;
        ALTER TABLE interaction_context_notes ADD COLUMN lease_until TEXT;
        ALTER TABLE interaction_context_notes ADD COLUMN delivered_at TEXT;
        UPDATE interaction_context_notes SET delivered_at = injected_at WHERE delivered_at IS NULL;`)
    }
    return
  }
  db.exec(`CREATE TABLE IF NOT EXISTS interaction_context_notes (
    interaction_id TEXT PRIMARY KEY,
    injected_at    TEXT NOT NULL,
    turn_id        TEXT,
    lease_until    TEXT,
    delivered_at   TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_interaction_context_notes_turn ON interaction_context_notes(turn_id)')
  // Baseline: cards closed before this table existed (S1-A history,
  // backfilled fence cards) are marked as delivered, so the first turn after
  // the upgrade does not get a flood of old "verworfen" notes.
  const at = new Date().toISOString()
  db.prepare(
    `INSERT OR IGNORE INTO interaction_context_notes (interaction_id, injected_at, delivered_at)
     SELECT id, ?, ? FROM interactions WHERE status <> 'open'`,
  ).run(at, at)
}

export interface InteractionContextNotesClaim {
  /** Reservation key of this turn; pass it to deliver/release. */
  turnId: string
  /** The notes text to prepend to the user text of the turn. */
  text: string
}

/**
 * Phase 1 (review B3): reserve the notes the model has not seen yet — the
 * answer of a non-blocking ask_user question as a structured block, and a
 * note for every dismissed question (ask_user or fence card). Reserved with
 * `turn_id` and `lease_until = now + 10 min`; NOT delivered yet. A note whose
 * lease ran out without {@link markInteractionContextNotesDelivered} is
 * claimed again by the next turn (a duplicate is acceptable, a loss is not).
 * Blocking answers are not listed: their own turn carries the block.
 */
export function claimInteractionContextNotes(
  db: Database,
  strandId: string,
  opts: { turnId?: string; now?: number } = {},
): InteractionContextNotesClaim | null {
  try {
    ensureNotesTable(db)
    const now = opts.now ?? Date.now()
    const nowIso = new Date(now).toISOString()
    const rows = db.prepare(
      `SELECT i.id FROM interactions i
        WHERE i.strand_id = ?
          AND ((i.status = 'answered' AND i.blocking = 0) OR i.status = 'dismissed')
          AND NOT EXISTS (
            SELECT 1 FROM interaction_context_notes n
             WHERE n.interaction_id = i.id
               AND (n.delivered_at IS NOT NULL OR (n.lease_until IS NOT NULL AND n.lease_until > ?)))
        ORDER BY i.created_at, i.id`,
    ).all(strandId, nowIso) as Array<{ id: string }>
    if (rows.length === 0) return null
    const turnId = opts.turnId ?? randomUUID()
    const leaseUntil = new Date(now + INTERACTION_NOTE_LEASE_MS).toISOString()
    const reserve = db.prepare(
      `INSERT INTO interaction_context_notes (interaction_id, injected_at, turn_id, lease_until, delivered_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(interaction_id) DO UPDATE SET turn_id = excluded.turn_id, lease_until = excluded.lease_until`,
    )
    const delivered = db.prepare(
      `INSERT INTO interaction_context_notes (interaction_id, injected_at, delivered_at) VALUES (?, ?, ?)
       ON CONFLICT(interaction_id) DO UPDATE SET delivered_at = excluded.delivered_at`,
    )
    const notes: string[] = []
    for (const { id } of rows) {
      const record = getInteraction(db, id)
      if (!record) continue
      // An answer that already started its own turn (resumed) is in the
      // transcript; only a silent one is owed to the model.
      if (record.status === 'answered' && record.answer?.resumed) {
        delivered.run(id, nowIso, nowIso)
        continue
      }
      if (record.status === 'dismissed') {
        notes.push(formatInteractionDismissNote(record.id))
      } else if (isAskUserPayload(record.payload) && Array.isArray((record.answer as { items?: unknown } | null)?.items)) {
        notes.push(formatAskUserAnswerBlock(record.id, (record.answer as unknown as { items: AskUserAnswerItem[] }).items))
      } else if (record.answer) {
        notes.push(formatInteractionAnswerNote(record.id, record.answer.label))
      } else {
        continue
      }
      reserve.run(id, nowIso, turnId, leaseUntil)
    }
    return notes.length > 0 ? { turnId, text: notes.join('\n\n') } : null
  } catch (err) {
    console.warn('[ask_user] Could not read interaction context notes:', (err as Error).message)
    return null
  }
}

/** Phase 2: the turn that carried the notes ended without error → delivered. */
export function markInteractionContextNotesDelivered(db: Database, turnId: string, now = Date.now()): void {
  try {
    db.prepare('UPDATE interaction_context_notes SET delivered_at = ? WHERE turn_id = ? AND delivered_at IS NULL')
      .run(new Date(now).toISOString(), turnId)
  } catch (err) {
    console.warn('[ask_user] Could not confirm interaction context notes:', (err as Error).message)
  }
}

/** The turn failed: drop the lease so the next turn gets the notes right away. */
export function releaseInteractionContextNotes(db: Database, turnId: string): void {
  try {
    db.prepare('UPDATE interaction_context_notes SET lease_until = NULL WHERE turn_id = ? AND delivered_at IS NULL').run(turnId)
  } catch (err) {
    console.warn('[ask_user] Could not release interaction context notes:', (err as Error).message)
  }
}
