/**
 * useInteractionTable — the web client's copy of the `interactions` table
 * (S1-A, S1-C). It is the ONLY source the chat uses to decide in which state
 * a card is: the server owns the state (stale rule B4 at write time, the
 * `user_continued` trigger, answers, dismissals, timeouts, the backfill of
 * old cards), the client mirrors it.
 *
 * Filled from two places:
 *  - `GET /api/strands/:id/interactions` when a strand is shown: the open
 *    cards and the history (answered, dismissed, superseded, expired rows with
 *    their answer). The payload of a closed ask_user card is not in the
 *    message metadata (the tool arguments are redacted), so the table is the
 *    history source; the messages only anchor the card (`toolCallId` of the
 *    tool message, `interactionId` in the metadata of the answer message).
 *  - the `interaction.open` / `interaction.updated` / `interaction.draft` /
 *    `interaction.pending` frames of the chat socket (see `useChat`).
 *
 * A fence card the table does not know yet (the frame is still on its way)
 * counts as open: the server decides on the answer anyway and replies 409/410
 * for a closed card. No text heuristic is applied on the client any more.
 */
import type { Ref } from 'vue'
import type { AskUserPayload } from '@axiom/core/contracts'

export type InteractionTableStatus = 'open' | 'answered' | 'dismissed' | 'superseded' | 'expired'

export interface InteractionTableAnswer {
  value?: string | string[]
  label?: string
  answeredAt?: string
  /** The key of the stored answer; a retry after a 502 sends it again. */
  clientRequestId?: string
  /** false: the answer is stored but its turn did not start (502). */
  resumed?: boolean
  items?: Array<{ questionId: string; question?: string; selected: Array<{ id: string; label: string }>; comment?: string }>
}

/** The subset of an `interactions` row the web client needs (wire shape). */
export interface InteractionTableRow {
  id: string
  strandId: string
  messageId: number
  /** Set on ask_user cards (S1-B): the tool call that asked. */
  toolCallId?: string | null
  /** Set on fence cards (S1-A): the block id inside the message. */
  blockId?: string | null
  status: InteractionTableStatus
  payload?: unknown
  blocking?: boolean
  answer?: InteractionTableAnswer | null
  draft?: unknown
  closeSource?: string | null
  closedAt?: string | null
  expiresAt?: string | null
}

export type InteractionTableState = Record<string, InteractionTableRow>

export function interactionTableKey(messageId: number, blockId: string): string {
  return `${messageId}:${blockId}`
}

function isRow(value: unknown): value is InteractionTableRow {
  const row = value as Partial<InteractionTableRow> | null
  return !!row && typeof row.id === 'string' && typeof row.strandId === 'string'
    && typeof row.messageId === 'number' && typeof row.status === 'string'
    && (typeof row.blockId === 'string' || typeof row.toolCallId === 'string')
}

/** Is this row an ask_user card (payload `kind: 'ask_user'`)? */
export function isAskUserRow(row: InteractionTableRow | null | undefined): row is InteractionTableRow & { payload: AskUserPayload } {
  const payload = row?.payload as Partial<AskUserPayload> | undefined
  return !!payload && payload.kind === 'ask_user' && Array.isArray(payload.questions)
}

/**
 * Position in the state machine (core `interaction-store.ts`): every edge
 * leaves `open`, a closed status never changes again. The rows carry no
 * revision, so this rank orders them (review 1, B2).
 */
export function interactionStatusRank(status: InteractionTableStatus | string | null | undefined): number {
  return status === 'open' ? 0 : 1
}

/**
 * Monotonic merge of one row (B2): a row that is further in the state
 * machine is never set back by an older copy (a delayed GET snapshot or a
 * late frame), and `answer.resumed` only goes false -> true. Among equal
 * ranks the incoming fields win, unless `preferPrevious` (a frame that came
 * in while the snapshot was on its way is newer than the snapshot).
 */
export function mergeInteractionRow(
  previous: InteractionTableRow | undefined,
  incoming: InteractionTableRow,
  preferPrevious = false,
): InteractionTableRow {
  if (!previous) return incoming
  const before = interactionStatusRank(previous.status)
  const after = interactionStatusRank(incoming.status)
  if (before > after) return previous
  if (before === after && before > 0 && previous.status !== incoming.status) return previous
  const merged = preferPrevious && before === after ? { ...incoming, ...previous } : { ...previous, ...incoming }
  if (previous.answer?.resumed === true && merged.answer && merged.answer.resumed !== true) {
    merged.answer = { ...merged.answer, resumed: true }
  }
  return merged
}

/**
 * Upsert, keyed by the interaction id: a frame or list entry updates the
 * stored state of its card (monotonic, see `mergeInteractionRow`).
 * `updated`/`draft` frames may carry fewer fields; the fields we already
 * know are kept.
 */
export function applyInteractionRow(state: InteractionTableState, value: unknown): InteractionTableState {
  if (!isRow(value)) return state
  return { ...state, [value.id]: mergeInteractionRow(state[value.id], value) }
}

/**
 * A fresh list of one strand's rows from the server, merged into the state
 * (B2). Rows the list does not name are dropped, unless their id is in
 * `touched` (a frame delivered them while the list was on its way) or in
 * `keepMissing` (review 2: an open card that came by frame shortly before the
 * GET, see `RECENT_FRAME_KEEP_MS`); each listed row is merged monotonically,
 * a touched row keeps its frame fields.
 */
export function replaceStrandRows(
  state: InteractionTableState,
  strandId: string,
  rows: unknown[],
  touched: ReadonlySet<string> = new Set(),
  keepMissing: ReadonlySet<string> = new Set(),
): InteractionTableState {
  const next: InteractionTableState = {}
  for (const [key, row] of Object.entries(state)) {
    if (row.strandId !== strandId || touched.has(row.id) || keepMissing.has(row.id)) next[key] = row
  }
  for (const row of rows) {
    if (!isRow(row)) continue
    const previous = next[row.id] ?? state[row.id]
    next[row.id] = mergeInteractionRow(previous, row, touched.has(row.id))
  }
  return next
}

/**
 * M1 (review 1): the answer chip of a fence card. The table row wins (it is
 * kept live by `interaction.updated`, also for an answer from another
 * device); the message metadata is the fallback for a card the table lacks.
 */
export function answerChipOfRow(
  row: InteractionTableRow | null | undefined,
  fallback?: { label: string } | null,
): { label: string } | null {
  if (row?.status === 'answered') {
    const value = row.answer?.value
    const fromValue = Array.isArray(value) ? value.join(', ') : value
    const label = row.answer?.label || fromValue || fallback?.label
    if (label) return { label }
  }
  return fallback ?? null
}

/** Loads in flight: the ids frames delivered since each snapshot started. */
/**
 * Review 2, B2: a card known before the GET that the snapshot does not name
 * is dropped, unless it is `open` and its last frame is younger than this
 * (the server list may lag behind the frame of a just-opened card).
 */
export const RECENT_FRAME_KEEP_MS = 60_000

/** Ids of open rows of a strand whose last frame is younger than RECENT_FRAME_KEEP_MS. */
export function recentOpenFrameIds(
  state: InteractionTableState,
  strandId: string,
  frameSeenAt: Readonly<Record<string, number>>,
  now: number,
): Set<string> {
  const out = new Set<string>()
  for (const row of Object.values(state)) {
    const seen = frameSeenAt[row.id]
    if (row.strandId === strandId && row.status === 'open' && typeof seen === 'number' && now - seen < RECENT_FRAME_KEEP_MS) out.add(row.id)
  }
  return out
}

/**
 * Review 3: rows kept by the young-frame rule although the snapshot lacked
 * them, with the time they were marked. The next successful snapshot that
 * still lacks them, or the expiry timer RECENT_FRAME_KEEP_MS later, drops
 * them; a snapshot that names them clears the mark.
 */
const keepTimers = new Map<string, { strandId: string; timer: ReturnType<typeof setTimeout> }>()

function clearKeepTimer(id: string): void {
  const entry = keepTimers.get(id)
  if (entry) clearTimeout(entry.timer)
  keepTimers.delete(id)
}

const activeLoads = new Set<{ strandId: string; touched: Set<string> }>()

/** The fence card row of a message block, or null. */
export function rowOfBlock(state: InteractionTableState, messageId: number, blockId: string): InteractionTableRow | null {
  for (const row of Object.values(state)) {
    if (row.messageId === messageId && row.blockId === blockId) return row
  }
  return null
}

/** The ask_user row of a tool call, or null. */
export function rowOfToolCall(state: InteractionTableState, toolCallId: string): InteractionTableRow | null {
  for (const row of Object.values(state)) if (row.toolCallId === toolCallId) return row
  return null
}

/**
 * The interaction id an ask_user tool result names: `details.interactionId`
 * or the "(interaction <id>" note in its text.
 */
export function interactionIdOfToolResult(result: unknown): string | null {
  if (!result) return null
  const details = (result as { details?: { interactionId?: unknown } }).details
  if (details && typeof details.interactionId === 'string') return details.interactionId
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  const match = /\(interaction ([A-Za-z0-9_-]+)/.exec(text)
  return match?.[1] ?? null
}

/**
 * Is the card drawn closed without an answer? Only the table says so:
 * superseded (user continued, newer question, backfill), expired and
 * dismissed cards are closed; answered cards show their answer; open or
 * unknown cards stay open.
 */
export function cardClosedByTable(status: InteractionTableStatus | null | undefined): boolean {
  return status === 'superseded' || status === 'expired' || status === 'dismissed'
}

export function useInteractionTable() {
  const state = useState<InteractionTableState>('interaction_table', () => ({})) as Ref<InteractionTableState>
  /** `interaction.pending` skeletons: tool call id -> announced question count. */
  const pending = useState<Record<string, number>>('interaction_pending', () => ({})) as Ref<Record<string, number>>

  /** Review 2, B2: when the last frame of each card arrived (ms). */
  const frameSeenAt = useState<Record<string, number>>('interaction_frame_seen', () => ({})) as Ref<Record<string, number>>

  function receive(row: unknown): void {
    state.value = applyInteractionRow(state.value, row)
    if (isRow(row)) frameSeenAt.value = { ...frameSeenAt.value, [row.id]: Date.now() }
    if (isRow(row)) for (const load of activeLoads) if (load.strandId === row.strandId) load.touched.add(row.id)
    const toolCallId = (row as { toolCallId?: unknown } | null)?.toolCallId
    if (typeof toolCallId === 'string' && toolCallId in pending.value) {
      const { [toolCallId]: _gone, ...rest } = pending.value
      pending.value = rest
    }
  }

  /** `interaction.pending`: a skeleton until `interaction.open` arrives for the same tool call. */
  function receivePending(toolCallId: unknown, questionCount: unknown): void {
    if (typeof toolCallId !== 'string' || !toolCallId) return
    if (rowOfToolCall(state.value, toolCallId)) return
    pending.value = { ...pending.value, [toolCallId]: typeof questionCount === 'number' ? questionCount : 0 }
  }

  /** Review 3: ids kept by the young-frame rule but not yet confirmed by a snapshot -> marked at (ms). */
  const keptPendingVerify = useState<Record<string, number>>('interaction_kept_pending_verify', () => ({})) as Ref<Record<string, number>>

  function unmark(id: string): void {
    clearKeepTimer(id)
    if (id in keptPendingVerify.value) {
      const { [id]: _gone, ...rest } = keptPendingVerify.value
      keptPendingVerify.value = rest
    }
  }

  function dropUnverified(id: string): void {
    if (!(id in keptPendingVerify.value)) return
    unmark(id)
    const { [id]: _gone, ...rest } = state.value
    state.value = rest
  }

  function replaceStrand(strandId: string, rows: unknown[], touched?: ReadonlySet<string>): void {
    const named = new Set(rows.filter(isRow).map(row => row.id))
    for (const id of Object.keys(keptPendingVerify.value)) if (named.has(id)) unmark(id)
    const keep = recentOpenFrameIds(state.value, strandId, frameSeenAt.value, Date.now())
    // A mark that a second snapshot still lacks is dropped (frames during this GET still win).
    for (const id of [...keep]) if (id in keptPendingVerify.value && !touched?.has(id)) { keep.delete(id); unmark(id) }
    state.value = replaceStrandRows(state.value, strandId, rows, touched, keep)
    const now = Date.now()
    for (const id of keep) {
      if (named.has(id) || id in keptPendingVerify.value || !state.value[id]) continue
      keptPendingVerify.value = { ...keptPendingVerify.value, [id]: now }
      keepTimers.set(id, { strandId, timer: setTimeout(() => dropUnverified(id), RECENT_FRAME_KEEP_MS) })
    }
  }

  /** Review 3: on unmount or strand change, cancel the expiry timers (all, or those of other strands). */
  function clearPendingVerify(exceptStrandId?: string | null): void {
    for (const [id, entry] of [...keepTimers]) if (entry.strandId !== exceptStrandId) unmark(id)
  }

  function statusOf(messageId: number | string | undefined, blockId: string): InteractionTableStatus | null {
    if (typeof messageId !== 'number') return null
    return rowOfBlock(state.value, messageId, blockId)?.status ?? null
  }

  function blockRow(messageId: number | string | undefined, blockId: string): InteractionTableRow | null {
    if (typeof messageId !== 'number') return null
    return rowOfBlock(state.value, messageId, blockId)
  }

  function toolCallRow(toolCallId: string | undefined): InteractionTableRow | null {
    return toolCallId ? rowOfToolCall(state.value, toolCallId) : null
  }

  function pendingCount(toolCallId: string | undefined): number | null {
    if (!toolCallId) return null
    const count = pending.value[toolCallId]
    return typeof count === 'number' ? count : null
  }

  /** Reads every card of the strand (open cards and history) from the server. */
  async function loadStrand(strandId: string | null | undefined): Promise<void> {
    if (!strandId) return
    // B2: frames that arrive while the GET is on its way are newer than its
    // snapshot; they are recorded and win over it.
    const load = { strandId, touched: new Set<string>() }
    activeLoads.add(load)
    try {
      const { apiFetch } = useApi()
      const res = await apiFetch<{ interactions?: unknown[] }>(`/api/strands/${encodeURIComponent(strandId)}/interactions`)
      if (Array.isArray(res?.interactions)) replaceStrand(strandId, res.interactions, load.touched)
    } catch {
      // Keep what the frames delivered; an unknown card stays open and the
      // server still guards the answer.
    } finally {
      activeLoads.delete(load)
    }
  }

  return { state, pending, receive, receivePending, replaceStrand, statusOf, blockRow, toolCallRow, pendingCount, loadStrand, keptPendingVerify, clearPendingVerify }
}
