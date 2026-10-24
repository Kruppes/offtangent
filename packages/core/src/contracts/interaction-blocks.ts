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
export const RENDERED_INTERACTION_BLOCK_KINDS: readonly InteractionBlockKind[] = ['confirm', 'choice', 'multi']

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
/** `multi` may carry up to eight (SPEC 7.4c). */
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
  /**
   * A card that is still being streamed (S0-B/QW1): an unterminated
   * `offtangent` fence while the message is live. Only produced with
   * `{ streaming: true }`; the client draws a placeholder instead of raw JSON.
   */
  | { type: 'pending' }

/** Options of {@link parseInteractionMessage}. */
export interface ParseInteractionMessageOptions {
  /**
   * The message is still streaming. An unterminated fence then becomes a
   * `pending` segment. Without it (a finished or aborted message) the fence
   * degrades to readable text: the block's numbered list when the partial
   * JSON can be repaired, else {@link INTERACTION_INCOMPLETE_TEXT}.
   */
  streaming?: boolean
}

/** What an aborted card leaves behind when nothing readable can be salvaged. */
export const INTERACTION_INCOMPLETE_TEXT = '(The question was cut off before it was complete.)'

/**
 * What a closed card fence leaves behind when its JSON is broken beyond the
 * repair pass (S0-B review finding 7): a readable hint, never the raw JSON.
 */
export const INTERACTION_BROKEN_TEXT = '(A question could not be displayed.)'

/**
 * A trailing line that is the start of a card fence whose language tag is
 * still arriving (`\`\`\`off` at the very end of a streamed chunk, S0-B review
 * finding 1). Three or more fence characters followed by a non-empty prefix
 * of `offtangent`; a bare fence opener stays text because it may open any
 * ordinary code block.
 */
const PARTIAL_FENCE_OPENER = /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[ \t]*([A-Za-z]{1,10})[ \t]*$/

function partialFenceStart(content: string): number {
  const match = PARTIAL_FENCE_OPENER.exec(content)
  if (!match) return -1
  const tag = match[1]!.toLowerCase()
  if (tag === FENCE_LANGUAGE || !FENCE_LANGUAGE.startsWith(tag)) return -1
  return match.index + (match[0].startsWith('\n') ? 1 : 0)
}

/** How one fence body parsed (S0-B telemetry). */
export type InteractionParseOutcome = 'ok' | 'repaired' | 'broken'

/** Info string of the fenced interactive block (```offtangent). */
export const INTERACTION_FENCE_LANGUAGE = 'offtangent'
const FENCE_LANGUAGE = INTERACTION_FENCE_LANGUAGE


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
  let closer: '`' | '~' = '`'

  for (const line of lines) {
    const lineLength = line.length + 1
    const trimmed = line.trim()
    if (openIndex === -1) {
      if (/^(`{3,}|~{3,})\s*offtangent\s*$/i.test(trimmed)) {
        closer = trimmed.startsWith('~') ? '~' : '`'
        openIndex = fences.length
        openOffset = offset
        bodyLines = []
      }
    } else if ((closer === '~' ? /^~{3,}\s*$/ : /^`{3,}\s*$/).test(trimmed)) {
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

/**
 * Repair pass (S0-B/QW3): the mistakes models actually make in a block body,
 * fixed conservatively. Returns the repaired JSON text, or null when nothing
 * was changed. Every step is purely syntactic; the repaired payload still has
 * to pass {@link parseInteractionBlockPayload}, so a repair can never invent
 * an option or a question.
 *
 *   - typographic quotes (\u201C \u201D \u201E) used as JSON quotes
 *   - a trailing comma before `}` or `]`
 *   - missing closing brackets at the end (a cut-off body)
 */
export function repairInteractionJson(body: string): string | null {
  let text = body.trim().replace(/^\uFEFF/, '')
  const original = text
  text = text.replace(/[\u201C\u201D\u201E]/g, '"')
  text = text.replace(/,\s*([}\]])/g, '$1')
  // Close what is still open, ignoring brackets inside strings.
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return null
    }
  }
  if (inString) text += '"'
  text = text.replace(/,\s*$/, '')
  while (stack.length) text += stack.pop()
  text = text.replace(/,\s*([}\]])/g, '$1')
  return text === original ? null : text
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Parse one fence body: strict first, then the repair pass. `outcome` is what
 * the telemetry counts; the body itself never leaves this function.
 */
export function parseInteractionFenceBody(body: string): { block: InteractionBlock | null; outcome: InteractionParseOutcome } {
  let payload = parseJsonOrNull(body)
  let repaired = false
  if (payload === undefined) {
    const fixed = repairInteractionJson(body)
    payload = fixed === null ? undefined : parseJsonOrNull(fixed)
    if (payload === undefined) return { block: null, outcome: 'broken' }
    repaired = true
  }
  const block = parseInteractionBlockPayload(payload)
  if (block) return { block, outcome: repaired ? 'repaired' : 'ok' }
  const normalized = repairInteractionPayload(payload)
  const salvaged = normalized ? parseInteractionBlockPayload(normalized) : null
  return salvaged ? { block: salvaged, outcome: 'repaired' } : { block: null, outcome: 'broken' }
}

/** Cut a too-long label at a word boundary and mark the cut with an ellipsis. */
function shorten(value: string, max: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}\u2026`
}

/**
 * Payload half of the repair pass (S0-B/QW3), run only when the strict schema
 * rejects a payload that is valid JSON:
 *
 *   - synonyms: `type` for `block`, `prompt`/`title` for `question`,
 *     `choices` for `options`, `text`/`title` for an option `label`
 *   - an option label over 120 characters (or a question over 500) is cut at a
 *     word boundary with an ellipsis; the option id, which is what an answer
 *     carries, stays untouched
 *
 * Returns a new payload, or null when nothing applied. Never adds an option.
 */
export function repairInteractionPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null
  const next: Record<string, unknown> = { ...payload }
  let changed = false
  if (next.block === undefined && next.kind === undefined && typeof next.type === 'string') {
    next.block = next.type
    changed = true
  }
  if (next.question === undefined) {
    const alt = typeof next.prompt === 'string' ? next.prompt : typeof next.title === 'string' ? next.title : undefined
    if (alt !== undefined) { next.question = alt; changed = true }
  }
  if (typeof next.question === 'string' && next.question.trim().length > QUESTION_MAX) {
    next.question = shorten(next.question, QUESTION_MAX)
    changed = true
  }
  if (next.options === undefined && Array.isArray(next.choices)) {
    next.options = next.choices
    changed = true
  }
  if (Array.isArray(next.options)) {
    next.options = next.options.map((entry: unknown) => {
      if (!isRecord(entry)) return entry
      const option: Record<string, unknown> = { ...entry }
      if (option.label === undefined) {
        const alt = typeof option.text === 'string' ? option.text : typeof option.title === 'string' ? option.title : undefined
        if (alt !== undefined) { option.label = alt; changed = true }
      }
      if (typeof option.label === 'string' && option.label.trim().length > LABEL_MAX) {
        option.label = shorten(option.label, LABEL_MAX)
        changed = true
      }
      return option
    })
  }
  return changed ? next : null
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
 *   - a closed fence with broken JSON gets the repair pass
 *     ({@link repairInteractionJson}); what still fails becomes the readable
 *     hint {@link INTERACTION_BROKEN_TEXT}, never the raw JSON (the message
 *     around it is unaffected)
 *   - an unterminated fence is a `pending` segment while `streaming`, and
 *     readable text otherwise (S0-B/QW1) — never raw JSON
 *   - while `streaming`, a trailing fence opener whose language tag is a
 *     partial `offtangent` (`\`\`\`offt`) is a `pending` segment too
 *   - at most `INTERACTION_BLOCKS_PER_MESSAGE` block segments; every further
 *     valid block degrades to its readable numbered-list form so no user ever
 *     sees raw JSON
 */
export function parseInteractionMessage(
  content: string,
  options: ParseInteractionMessageOptions = {},
): InteractionSegment[] {
  if (!content) return []
  if (options.streaming) {
    const partial = partialFenceStart(content)
    if (partial !== -1) {
      const head = parseInteractionMessage(content.slice(0, partial), options)
      return [...head, { type: 'pending' }]
    }
  }
  if (!content.includes(FENCE_LANGUAGE)) return [{ type: 'text', text: content }]

  const segments: InteractionSegment[] = []
  const fences = findFences(content)
  let cursor = 0
  let blockCount = 0

  for (const fence of fences) {
    pushText(segments, content.slice(cursor, fence.start))
    cursor = fence.end

    if (!fence.closed) {
      if (options.streaming) {
        segments.push({ type: 'pending' })
        continue
      }
      // Aborted mid-card: salvage the question as text, never the raw JSON.
      const salvaged = parseInteractionFenceBody(fence.body).block
      pushText(segments, salvaged ? formatInteractionBlockAsText(salvaged) : INTERACTION_INCOMPLETE_TEXT)
      continue
    }

    const block = parseInteractionFenceBody(fence.body).block

    if (!block) {
      // Broken, incomplete or unknown payload beyond the repair pass: a
      // readable hint instead of the raw JSON (review finding 7).
      pushText(segments, INTERACTION_BROKEN_TEXT)
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
 * renders `handover` too), and a declared kind that answers
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
    const block = parseInteractionFenceBody(fence.body).block
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
    .map(segment => segment.type === 'text'
      ? segment.text
      : segment.type === 'block' ? formatInteractionBlockAsText(segment.block) : '')
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
    const block = parseInteractionFenceBody(fence.body).block
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
 * Why `POST /api/interactions` would refuse an answer for a block that DOES
 * exist in the message: `'expired'` becomes the 410 `stale`, `'answered'` the
 * 409 `already_answered` (or the idempotent replay when the client key
 * matches).
 */
export type InteractionBlockClosedReason = 'expired' | 'answered'

export interface InteractionBlockState {
  block: InteractionBlock
  /** The recorded answer of this block, or null while it is unanswered. */
  answer: InteractionAnswerRecord | null
  /** Null exactly while an answer would still be accepted. */
  closedReason: InteractionBlockClosedReason | null
}

/**
 * Is this block still open, i.e. would `POST /api/interactions` accept an
 * answer for it?
 *
 * THE one answer to that question. Two things ask it: the endpoint itself
 * (409/410 above) and the "awaiting you" state of a strand
 * (`strand-attention.ts`, plan 2026-09-26). A second implementation of the
 * rule would drift, and a badge that says "waiting" over a card the server
 * refuses to take is exactly the kind of lie the plan forbids.
 *
 * Order matters and mirrors the endpoint: an expired block reports `expired`
 * even when an answer was recorded before it expired, because the endpoint
 * checks `expiresAt` before the answer map.
 *
 * NOT covered here (there is no block in hand for it): a deleted strand and a
 * foreign/unknown message — the endpoint answers 410 `stale` / 404 for those,
 * and the attention query mirrors them by only ever looking at rows of
 * existing, owned strands.
 */
export function resolveInteractionBlockState(
  block: InteractionBlock,
  metadata: unknown,
  options: { now?: number } = {},
): InteractionBlockState {
  const now = options.now ?? Date.now()
  if (block.expiresAt && Date.parse(block.expiresAt) <= now) {
    return { block, answer: readInteractionAnswers(metadata)[block.id] ?? null, closedReason: 'expired' }
  }
  const answer = readInteractionAnswers(metadata)[block.id] ?? null
  return { block, answer, closedReason: answer ? 'answered' : null }
}

/**
 * Why an unanswered, unexpired card is shown closed anyway (S0-B/QW7).
 *
 *   - `later_user_turn`: the user wrote in the strand after the card (in
 *     prose, by typing, or answered something else) — the card was passed by
 *   - `newer_card`: a newer card in the same strand replaces it
 *
 * Both close the card as **skipped** ("übergangen"), never as "answered
 * elsewhere": nobody knows whether the prose was an answer.
 */
export type InteractionSkipReason = 'later_user_turn' | 'newer_card'

/**
 * Where a card sits in its strand. Positions are any monotonic order of the
 * strand's rows — `chat_messages.id` on the server, the same id or the list
 * index on a client — as long as all three use the same one.
 */
export interface InteractionCardPosition {
  /** The row carrying the card. */
  at: number
  /** The newest genuine user turn (`role = 'user'`) of the strand, or null. */
  lastUserTurnAt: number | null
  /** The newest row of the strand that carries a card, or null. */
  newestCardAt: number | null
}

/**
 * THE stale rule shared by web, app (mirrored in Kotlin, pinned by
 * `fixtures/interaction-contract.json`) and `strand-attention.ts`. Returns null while
 * the card is neither passed by a user turn nor replaced by a newer card.
 * `expiresAt` is not part of this: {@link resolveInteractionBlockState}
 * covers it, and {@link resolveInteractionCardDisplay} folds both.
 */
export function interactionSkipReason(position: InteractionCardPosition): InteractionSkipReason | null {
  if (position.lastUserTurnAt !== null && position.lastUserTurnAt > position.at) return 'later_user_turn'
  if (position.newestCardAt !== null && position.newestCardAt > position.at) return 'newer_card'
  return null
}

/** What a client draws for one card. */
export type InteractionCardDisplay = 'open' | 'answered' | 'expired' | 'skipped'

/**
 * The display state of a card: the endpoint's answer first (answered /
 * expired, see {@link resolveInteractionBlockState}), then the skip rule.
 * A skipped card is drawn closed and not clickable.
 */
export function resolveInteractionCardDisplay(
  block: InteractionBlock,
  metadata: unknown,
  position: InteractionCardPosition,
  options: { now?: number } = {},
): InteractionCardDisplay {
  const state = resolveInteractionBlockState(block, metadata, options)
  if (state.closedReason) return state.closedReason
  return interactionSkipReason(position) ? 'skipped' : 'open'
}

/**
 * Every block of a message that is still answerable right now, in document
 * order. Thin fold of {@link extractAnswerableInteractionBlocks} over
 * {@link resolveInteractionBlockState}.
 */
export function findOpenInteractionBlocks(
  content: string,
  metadata: unknown,
  options: { now?: number } = {},
): InteractionBlock[] {
  return extractAnswerableInteractionBlocks(content)
    .filter(block => resolveInteractionBlockState(block, metadata, options).closedReason === null)
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

/**
 * Parse outcome of every `offtangent` fence of a finished message, in order
 * (S0-B/B1 telemetry). Unterminated fences count as broken. Only the outcome
 * leaves this function, never content.
 */
export function classifyInteractionFences(content: string): InteractionParseOutcome[] {
  if (!content || !content.includes(FENCE_LANGUAGE)) return []
  return findFences(content).map(fence => fence.closed ? parseInteractionFenceBody(fence.body).outcome : 'broken')
}
