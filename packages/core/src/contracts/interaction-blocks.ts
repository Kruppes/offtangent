/**
 * Interactive blocks — the wire format for "answers you tap instead of type"
 * (SPEC 7.4c).
 *
 * A block is a fenced markdown block with a JSON body that the persona writes
 * into the message text:
 *
 * ```offtangent
 * { "block": "choice", "id": "b1", "question": "Hand this to Bob?",
 *   "options": [ { "id": "yes", "label": "Hand over to Bob" },
 *                { "id": "stay", "label": "Keep it here" } ] }
 * ```
 *
 * There is NO schema change on `chat_messages`: the block travels inside the
 * message content, history and search keep working, and every surface that
 * cannot render a card degrades the block to a readable numbered list — never
 * to raw JSON.
 *
 * This module is intentionally dependency-free so all three consumers can use
 * the same parser: the web frontend (card renderer), the web backend
 * (`POST /api/interactions` validation) and the Telegram bot (degradation).
 *
 * Hard rules encoded here, from the "Restraint" paragraph of 7.4c:
 *   - at most five options for `choice`/`confirm`/`handover` (eight for `multi`)
 *   - at most ONE interactive card per message; further blocks degrade to text
 *   - anything that does not parse stays text, it never throws
 */

/**
 * Every block kind the SPEC reserves.
 *
 * `draft` (W1 of the puck assist waves) is the odd one out: it carries no
 * question and no options, only the plain text the user wants to TYPE
 * somewhere (a mail, a message). It exists so a screenless device can send
 * exactly that text over a BLE keyboard without guessing which part of an
 * answer was prose and which part was the draft.
 */
export const INTERACTION_BLOCK_KINDS = ['choice', 'multi', 'confirm', 'handover', 'schedule', 'draft'] as const
export type InteractionBlockKind = typeof INTERACTION_BLOCK_KINDS[number]

/**
 * The kinds that actually render as a card in this release. The other kinds
 * parse (so a future release only flips this list) but degrade to a numbered
 * list today — shipping a half-built `schedule` picker would be worse than
 * prose.
 */
export const RENDERED_INTERACTION_BLOCK_KINDS: readonly InteractionBlockKind[] = ['confirm', 'choice']

/**
 * The kinds `POST /api/interactions` accepts an answer for: all of them.
 *
 * Rendering and answering are two different questions. A kind may still
 * degrade to a numbered list here (see above) while a client that DOES draw it
 * — the Android app draws `multi` and `handover` — must be able to send the
 * answer back. Declaring a kind in the contract and then answering 404 for it
 * is a broken contract; this constant is what keeps the two in step.
 */
export const ANSWERABLE_INTERACTION_BLOCK_KINDS: readonly InteractionBlockKind[] =
  INTERACTION_BLOCK_KINDS.filter(kind => kind !== 'draft')

/** Restraint: a decision with a closed set of at most five sensible options. */
export const INTERACTION_BLOCK_MAX_OPTIONS = 5
/** `multi` may carry up to eight (SPEC 7.4c), it is not rendered yet. */
export const INTERACTION_BLOCK_MAX_MULTI_OPTIONS = 8
/** At most one card per message; the rest of the deck degrades to text. */
export const INTERACTION_BLOCKS_PER_MESSAGE = 1

/**
 * Upper bound for a `draft` text. Four thousand characters is roughly two
 * screens of mail — long enough for anything a person dictates at a device,
 * short enough that typing it over a BLE keyboard stays a bounded operation.
 */
export const INTERACTION_DRAFT_TEXT_MAX = 4000

const ID_MAX = 64
const LABEL_MAX = 120
const QUESTION_MAX = 500

export interface InteractionBlockOption {
  id: string
  label: string
  /** Optional icon hint for the card (e.g. `handover`). */
  icon?: string
  /** `danger` paints the option in the destructive colour. */
  style?: 'default' | 'danger'
}

export interface InteractionBlock {
  kind: InteractionBlockKind
  id: string
  question: string
  options: InteractionBlockOption[]
  /** `confirm` variant that paints the affirmative option red. */
  destructive: boolean
  /**
   * `draft` only: the plain text to be typed verbatim. Never markdown, never
   * a fence — see {@link parseInteractionBlockPayload}.
   */
  text?: string
  /** ISO timestamp after which answering returns 410 `stale`. */
  expiresAt?: string
  /** False for kinds that are reserved but not rendered as a card yet. */
  supported: boolean
}

export type InteractionSegment =
  | { type: 'text'; text: string }
  | { type: 'block'; block: InteractionBlock; raw: string }

const FENCE_LANGUAGE = 'offtangent'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

function maxOptionsFor(kind: InteractionBlockKind): number {
  return kind === 'multi' ? INTERACTION_BLOCK_MAX_MULTI_OPTIONS : INTERACTION_BLOCK_MAX_OPTIONS
}

function defaultConfirmOptions(payload: Record<string, unknown>): InteractionBlockOption[] {
  const yes = readString(payload.confirmLabel, LABEL_MAX) ?? 'Yes'
  const no = readString(payload.cancelLabel, LABEL_MAX) ?? 'No'
  return [
    { id: 'yes', label: yes, ...(payload.destructive === true ? { style: 'danger' as const } : {}) },
    { id: 'no', label: no },
  ]
}

function parseOptions(raw: unknown, kind: InteractionBlockKind): InteractionBlockOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  if (raw.length > maxOptionsFor(kind)) return null

  const options: InteractionBlockOption[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!isRecord(entry)) return null
    const id = readString(entry.id, ID_MAX)
    const label = readString(entry.label, LABEL_MAX)
    if (!id || !label || seen.has(id)) return null
    seen.add(id)
    const icon = readString(entry.icon, ID_MAX)
    const style = entry.style === 'danger' ? 'danger' as const : undefined
    options.push({ id, label, ...(icon ? { icon } : {}), ...(style ? { style } : {}) })
  }
  return options
}

/**
 * Turn one parsed JSON body into a block. Returns null for anything that does
 * not satisfy the format — the caller then keeps the fence as plain text,
 * which is the whole degradation story.
 */
export function parseInteractionBlockPayload(payload: unknown): InteractionBlock | null {
  if (!isRecord(payload)) return null

  const rawKind = payload.block ?? payload.kind
  if (typeof rawKind !== 'string') return null
  const kind = INTERACTION_BLOCK_KINDS.find(candidate => candidate === rawKind)
  if (!kind) return null

  if (kind === 'draft') return parseDraftPayload(payload)

  const id = readString(payload.id, ID_MAX)
  const question = readString(payload.question, QUESTION_MAX)
  if (!id || !question) return null

  const options = payload.options === undefined && kind === 'confirm'
    ? defaultConfirmOptions(payload)
    : parseOptions(payload.options, kind)
  if (!options) return null

  const expiresAt = typeof payload.expiresAt === 'string' && !Number.isNaN(Date.parse(payload.expiresAt))
    ? payload.expiresAt
    : undefined

  return {
    kind,
    id,
    question,
    options,
    destructive: payload.destructive === true,
    ...(expiresAt ? { expiresAt } : {}),
    supported: RENDERED_INTERACTION_BLOCK_KINDS.includes(kind),
  }
}

/**
 * A `draft` block: `{ "block": "draft", "text": "…" }`.
 *
 * Deliberately strict, because the text is typed into a foreign program
 * verbatim and there is no second chance to sanitize it:
 *   - `text` is required, a string, 1..{@link INTERACTION_DRAFT_TEXT_MAX}
 *     characters after trimming the outer whitespace; `\n` inside is kept.
 *   - a markdown fence (```) inside the text is rejected. It cannot survive
 *     the transport (the fence scanner would close on it) and it is never
 *     something a person wants typed into a mail.
 *   - `question` and `options` carry no meaning here and are ignored; `id` is
 *     optional and defaults to `draft`, because nothing answers a draft.
 */
function parseDraftPayload(payload: Record<string, unknown>): InteractionBlock | null {
  if (typeof payload.text !== 'string') return null
  const text = payload.text.trim()
  if (!text || text.length > INTERACTION_DRAFT_TEXT_MAX) return null
  if (text.includes('```')) return null

  return {
    kind: 'draft',
    id: readString(payload.id, ID_MAX) ?? 'draft',
    question: '',
    options: [],
    destructive: false,
    text,
    supported: RENDERED_INTERACTION_BLOCK_KINDS.includes('draft'),
  }
}

interface RawFence {
  /** Index in the source string where the fence starts. */
  start: number
  /** Index just after the closing fence (or end of input when unterminated). */
  end: number
  /** The JSON body between the fences. */
  body: string
  /** The verbatim fence including the ``` lines. */
  raw: string
  /** An unterminated fence is never a block; it stays text. */
  closed: boolean
}

/**
 * Scan for ```offtangent fences line by line. A regex over the whole string
 * cannot tell an unterminated fence from a terminated one, and an
 * unterminated fence is exactly the case a streaming message produces.
 */
function findFences(content: string): RawFence[] {
  const fences: RawFence[] = []
  const lines = content.split('\n')
  let offset = 0
  let openIndex = -1
  let openOffset = 0
  let bodyLines: string[] = []

  for (const line of lines) {
    const lineLength = line.length + 1
    const trimmed = line.trim()
    if (openIndex === -1) {
      if (/^`{3,}\s*offtangent\s*$/i.test(trimmed)) {
        openIndex = fences.length
        openOffset = offset
        bodyLines = []
      }
    } else if (/^`{3,}\s*$/.test(trimmed)) {
      const end = offset + line.length
      fences.push({
        start: openOffset,
        end,
        body: bodyLines.join('\n'),
        raw: content.slice(openOffset, end),
        closed: true,
      })
      openIndex = -1
    } else {
      bodyLines.push(line)
    }
    offset += lineLength
  }

  if (openIndex !== -1) {
    fences.push({
      start: openOffset,
      end: content.length,
      body: bodyLines.join('\n'),
      raw: content.slice(openOffset),
      closed: false,
    })
  }

  return fences
}

function pushText(segments: InteractionSegment[], text: string): void {
  if (!text) return
  const last = segments[segments.length - 1]
  if (last && last.type === 'text') {
    last.text += text
    return
  }
  segments.push({ type: 'text', text })
}

/**
 * Split a message into text and interactive blocks.
 *
 * Guarantees, all of them covered by tests:
 *   - never throws, whatever the message contains
 *   - broken / incomplete JSON stays verbatim text (it renders as a code
 *     block, the message around it is unaffected)
 *   - at most `INTERACTION_BLOCKS_PER_MESSAGE` block segments; every further
 *     valid block degrades to its readable numbered-list form so no user ever
 *     sees raw JSON
 */
export function parseInteractionMessage(content: string): InteractionSegment[] {
  if (!content || !content.includes(FENCE_LANGUAGE)) {
    return content ? [{ type: 'text', text: content }] : []
  }

  const segments: InteractionSegment[] = []
  const fences = findFences(content)
  let cursor = 0
  let blockCount = 0

  for (const fence of fences) {
    pushText(segments, content.slice(cursor, fence.start))
    cursor = fence.end

    let block: InteractionBlock | null = null
    if (fence.closed) {
      try {
        block = parseInteractionBlockPayload(JSON.parse(fence.body) as unknown)
      } catch {
        block = null
      }
    }

    if (!block) {
      // Broken, incomplete or unknown payload: keep the fence as text.
      pushText(segments, fence.raw)
      continue
    }

    if (blockCount >= INTERACTION_BLOCKS_PER_MESSAGE || !block.supported) {
      // One card per message (SPEC 7.4c restraint), and kinds that do not
      // render yet: degrade to the readable list instead of raw JSON.
      pushText(segments, formatInteractionBlockAsText(block))
      continue
    }

    blockCount += 1
    segments.push({ type: 'block', block, raw: fence.raw })
  }

  pushText(segments, content.slice(cursor))
  return segments
}

/**
 * The inverse of the parser: turn a block into the fenced form a message
 * carries. The server writes blocks too (a note asks whether it should be
 * answered, see the captures service), and hand-rolling the fence there would
 * be a second format by accident — the exact thing this module exists to
 * prevent. Whatever this produces parses back into an equal block, which is
 * what the round-trip test pins.
 *
 * `kind` travels as `block`, the key the parser prefers, and only the fields
 * that carry meaning are written, so the JSON stays readable in every
 * degradation path.
 */
/**
 * The fence form of a draft, the counterpart of {@link extractDraftText}.
 * Used by tests and by any server-side producer of a draft; hand-rolling the
 * JSON elsewhere would be a second format by accident.
 */
export function formatDraftFence(text: string): string {
  return ['```' + FENCE_LANGUAGE, JSON.stringify({ block: 'draft', text }), '```'].join('\n')
}

export function formatInteractionBlockFence(block: {
  kind: InteractionBlockKind
  id: string
  question: string
  options: InteractionBlockOption[]
  destructive?: boolean
  expiresAt?: string
}): string {
  const payload: Record<string, unknown> = {
    block: block.kind,
    id: block.id,
    question: block.question,
    options: block.options,
  }
  if (block.destructive) payload.destructive = true
  if (block.expiresAt) payload.expiresAt = block.expiresAt
  return ['```' + FENCE_LANGUAGE, JSON.stringify(payload), '```'].join('\n')
}

/** Every renderable block of a message, in order. */
export function extractInteractionBlocks(content: string): InteractionBlock[] {
  return parseInteractionMessage(content)
    .filter((segment): segment is Extract<InteractionSegment, { type: 'block' }> => segment.type === 'block')
    .map(segment => segment.block)
}

/** Find one block by id among the blocks a client renders as a card. */
export function findInteractionBlock(content: string, blockId: string): InteractionBlock | null {
  return extractInteractionBlocks(content).find(block => block.id === blockId) ?? null
}

/**
 * Every well-formed block of a message, whatever its kind and wherever it
 * sits — the answering view, as opposed to the rendering view of
 * {@link extractInteractionBlocks}.
 *
 * The two differ on purpose. Rendering is restrained: one card per message,
 * and only the kinds a client actually draws (`RENDERED_INTERACTION_BLOCK_KINDS`);
 * everything else degrades to a numbered list. Answering must not be: the
 * contract DECLARES five kinds, clients ship buttons for them (the Android app
 * renders `multi` and `handover` today), and a declared kind that answers
 * `404 unknown_block` is a broken contract, not restraint. Measured on the
 * live backend on 2026-09-15: `POST /api/interactions` with a `multi` or
 * `handover` block id returned 404 while the app showed the buttons.
 *
 * So the server accepts an answer for any kind in {@link ANSWERABLE_INTERACTION_BLOCK_KINDS},
 * and the value is still validated against that block's own options by
 * {@link validateInteractionAnswer} — an unknown option stays a 400.
 */
export function extractAnswerableInteractionBlocks(content: string): InteractionBlock[] {
  if (!content || !content.includes(FENCE_LANGUAGE)) return []
  const blocks: InteractionBlock[] = []
  const seen = new Set<string>()
  for (const fence of findFences(content)) {
    if (!fence.closed) continue
    let block: InteractionBlock | null = null
    try {
      block = parseInteractionBlockPayload(JSON.parse(fence.body) as unknown)
    } catch {
      block = null
    }
    // A `draft` is output, not a question: there is nothing to answer, so it
    // is invisible here and `POST /api/interactions` replies 404 unknown_block
    // for it — the same answer an id that does not exist gets.
    if (block && !ANSWERABLE_INTERACTION_BLOCK_KINDS.includes(block.kind)) continue
    // First block of an id wins, same as the renderer, so a duplicated id
    // cannot make the answered block ambiguous.
    if (!block || seen.has(block.id)) continue
    seen.add(block.id)
    blocks.push(block)
  }
  return blocks
}

/** Find one block by id, for answer validation (`POST /api/interactions`). */
export function findAnswerableInteractionBlock(content: string, blockId: string): InteractionBlock | null {
  return extractAnswerableInteractionBlocks(content).find(block => block.id === blockId) ?? null
}

/**
 * The text form of a block: the question plus a numbered list, which is what
 * Telegram (7.11 parity) and every plain-text fallback show. The reply is
 * parsed the same way a typed answer is, so a block is an accelerator and
 * never the only path.
 */
export function formatInteractionBlockAsText(block: InteractionBlock): string {
  // A draft degrades to exactly its own text: it IS the readable form, and a
  // numbered list of zero options would be nonsense.
  if (block.kind === 'draft') return block.text ?? ''
  const lines = [block.question]
  block.options.forEach((option, index) => {
    lines.push(`${index + 1}. ${option.label}`)
  })
  lines.push(block.kind === 'multi'
    ? '(Reply with the numbers or the labels.)'
    : '(Reply with the number or the label.)')
  return lines.join('\n')
}

/**
 * Replace every interactive fence in a message with its readable text form.
 * Used by Telegram and by any surface without a card renderer: the guarantee
 * is that raw block JSON never reaches a user.
 */
export function renderInteractionMessageAsText(content: string): string {
  if (!content) return content
  return parseInteractionMessage(content)
    .map(segment => segment.type === 'text' ? segment.text : formatInteractionBlockAsText(segment.block))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** True when the message carries at least one renderable card. */
export function hasInteractionBlock(content: string): boolean {
  return extractInteractionBlocks(content).length > 0
}

/**
 * The draft text of a message, or null when it carries none.
 *
 * Independent of the rendering restraint on purpose: a draft is DATA a device
 * fetches (`GET /api/chat/history` exposes it as the `draft` field), not a
 * card competing for the one card slot of a message. The first well-formed
 * draft wins, so a persona that writes two of them cannot make the typed text
 * ambiguous.
 */
export function extractDraftText(content: string): string | null {
  if (!content || !content.includes(FENCE_LANGUAGE)) return null
  for (const fence of findFences(content)) {
    if (!fence.closed) continue
    let block: InteractionBlock | null = null
    try {
      block = parseInteractionBlockPayload(JSON.parse(fence.body) as unknown)
    } catch {
      block = null
    }
    if (block?.kind === 'draft' && block.text) return block.text
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Answer state — stored in `chat_messages.metadata`, no schema change.
 * ------------------------------------------------------------------ */

export interface InteractionAnswerRecord {
  blockId: string
  /** Option id (`choice`, `confirm`) or option ids (`multi`). */
  value: string | string[]
  /** The label(s) of the chosen option(s) — what the collapsed chip shows. */
  label: string
  answeredAt: string
  /** Idempotency key of the request that produced this answer. */
  clientMessageId: string
  /** True when the answer resumed a parked turn. */
  resumed: boolean
}

export type InteractionAnswerState = Record<string, InteractionAnswerRecord>

/** Read the answer map out of a metadata object or its JSON string. */
export function readInteractionAnswers(metadata: unknown): InteractionAnswerState {
  let parsed: unknown = metadata
  if (typeof metadata === 'string') {
    if (!metadata.trim()) return {}
    try {
      parsed = JSON.parse(metadata)
    } catch {
      return {}
    }
  }
  if (!isRecord(parsed)) return {}
  const answers = parsed.interactionAnswers
  if (!isRecord(answers)) return {}

  const state: InteractionAnswerState = {}
  for (const [blockId, record] of Object.entries(answers)) {
    if (!isRecord(record)) continue
    const value = record.value
    if (typeof value !== 'string' && !Array.isArray(value)) continue
    state[blockId] = {
      blockId,
      value: value as string | string[],
      label: typeof record.label === 'string' ? record.label : '',
      answeredAt: typeof record.answeredAt === 'string' ? record.answeredAt : '',
      clientMessageId: typeof record.clientMessageId === 'string' ? record.clientMessageId : '',
      resumed: record.resumed === true,
    }
  }
  return state
}

/**
 * Merge one answer into a metadata object (parsed from the row's JSON or
 * `{}`), preserving everything else that lives in that metadata.
 */
export function withInteractionAnswer(
  metadata: unknown,
  record: InteractionAnswerRecord,
): Record<string, unknown> {
  let base: Record<string, unknown> = {}
  if (typeof metadata === 'string' && metadata.trim()) {
    try {
      const parsed = JSON.parse(metadata) as unknown
      if (isRecord(parsed)) base = parsed
    } catch {
      base = {}
    }
  } else if (isRecord(metadata)) {
    base = { ...metadata }
  }

  const answers = isRecord(base.interactionAnswers) ? { ...base.interactionAnswers } : {}
  answers[record.blockId] = record
  return { ...base, interactionAnswers: answers }
}

/**
 * Validate an answer against a block. Returns the labels for the chip, or an
 * error code the API turns into a 400.
 */
export function validateInteractionAnswer(
  block: InteractionBlock,
  value: string | string[],
): { ok: true; label: string; value: string | string[] } | { ok: false; code: 'invalid_value' } {
  const ids = new Set(block.options.map(option => option.id))
  if (Array.isArray(value)) {
    if (block.kind !== 'multi') return { ok: false, code: 'invalid_value' }
    if (value.length === 0 || value.some(entry => !ids.has(entry))) return { ok: false, code: 'invalid_value' }
    const labels = value.map(entry => block.options.find(option => option.id === entry)!.label)
    return { ok: true, label: labels.join(', '), value }
  }
  if (!ids.has(value)) return { ok: false, code: 'invalid_value' }
  return { ok: true, label: block.options.find(option => option.id === value)!.label, value }
}
