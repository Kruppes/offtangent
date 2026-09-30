/**
 * message-digest.ts: restorable compression of chat messages (SPEC 11.1).
 *
 * Every shortened message keeps its `chat_messages.id` in the text so the
 * model can reload the original with `recall_message`. The digest format is
 * one constant here, never an ad hoc `slice()` at the call site.
 *
 * Masking runs over a transcript oldest first: the newest turns always stay
 * verbatim (TRACE, arXiv:2608.06503: weakening the newest interactions is
 * what makes recurrent compression harmful), older turns turn into digest
 * lines until the total budget fits.
 */

export type DigestRole = 'user' | 'assistant' | 'tool' | 'system' | 'task'

export interface DigestableMessage {
  /** chat_messages primary key */
  id: number
  role: DigestRole
  /** Verbatim text as the transcript would show it (label already stripped) */
  content: string
  /** Optional label prefix used when the message is rendered verbatim, e.g. "Assistant (task update)" */
  label?: string
}

export interface MaskTranscriptOptions {
  /** Total character budget for the rendered transcript */
  totalChars: number
  /** Assistant, task and system messages above this length become digests */
  perMessageChars: number
  /** Tool messages are always digests unless this is set */
  keepToolResults?: boolean
}

export const DEFAULT_MASK_OPTIONS: MaskTranscriptOptions = {
  totalChars: 12000,
  perMessageChars: 2000,
}

/** Marker prefix for injected content that must never be re extracted (SPEC 11.4 gate 2). */
export const RECALLED_MARKER = '[recalled]'

function firstSentence(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const m = flat.match(/^(.{1,200}?[.!?])(\s|$)/)
  const sentence = m ? m[1] : flat
  return sentence.length > max ? `${sentence.slice(0, max - 1)}\u2026` : sentence
}

/**
 * `[msg:<id>] <role>, <n> chars: <first sentence>`
 * The id is the primary key of chat_messages. This is the only digest format.
 */
export function formatMessageDigest(msg: Pick<DigestableMessage, 'id' | 'role' | 'content'>): string {
  const head = firstSentence(msg.content)
  return `[msg:${msg.id}] ${msg.role}, ${msg.content.length} chars${head ? `: ${head}` : ''}`
}

/** Parse a digest line back to its message id, or null when the line is not a digest. */
export function parseMessageDigestId(line: string): number | null {
  const m = line.match(/^\[msg:(\d+)\]/)
  return m ? Number.parseInt(m[1], 10) : null
}

function renderVerbatim(msg: DigestableMessage): string {
  const label = msg.label ?? defaultLabel(msg.role)
  return `${label}: ${msg.content}`
}

function defaultLabel(role: DigestRole): string {
  switch (role) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'tool': return 'Tool'
    case 'task': return 'Background task'
    default: return 'System'
  }
}

export interface MaskResult {
  text: string
  /** ids rendered as digest lines (reloadable with recall_message) */
  masked: number[]
  /** ids rendered verbatim */
  verbatim: number[]
}

/**
 * Render a transcript under a character budget without losing anything
 * that cannot be reloaded.
 *
 * Pass 1: per message rule. Tool results always digest. Assistant, task and
 * system messages above `perMessageChars` digest. User messages verbatim.
 * Pass 2: total budget. Walking oldest first, verbatim messages are turned
 * into digests until the rendered text fits `totalChars`. The newest
 * messages are the last to be touched.
 */
export function maskTranscript(
  messages: DigestableMessage[],
  options: MaskTranscriptOptions = DEFAULT_MASK_OPTIONS,
): MaskResult {
  const lines: string[] = new Array(messages.length)
  const isDigest: boolean[] = new Array(messages.length).fill(false)

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const forceDigest = msg.role === 'tool' && !options.keepToolResults
    const overBudget = msg.role !== 'user' && msg.content.length > options.perMessageChars
    if (forceDigest || overBudget) {
      lines[i] = formatMessageDigest(msg)
      isDigest[i] = true
    } else {
      lines[i] = renderVerbatim(msg)
    }
  }

  let total = lines.reduce((n, l) => n + l.length + 1, 0)
  for (let i = 0; i < messages.length && total > options.totalChars; i++) {
    if (isDigest[i]) continue
    const digest = formatMessageDigest(messages[i])
    total -= lines[i].length - digest.length
    lines[i] = digest
    isDigest[i] = true
  }

  const masked: number[] = []
  const verbatim: number[] = []
  messages.forEach((m, i) => (isDigest[i] ? masked : verbatim).push(m.id))

  return { text: lines.join('\n'), masked, verbatim }
}

/**
 * Drop lines that carry injected content (fact injection, wiki reads,
 * previous session tail) before a transcript goes to fact extraction. A
 * fact recalled a hundred times stays one fact.
 */
export function stripRecalledLines(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trimStart().startsWith(RECALLED_MARKER))
    .join('\n')
}
