/**
 * session-store.ts — Pure functions for topic-matching and sliding-window detection.
 * No class, no LLM, no embeddings — pure keyword extraction and Jaccard similarity.
 *
 * Sliding-Window Topic-Shift Detection with Hysteresis (≥2 signals).
 * Used to detect when a user changes topic, triggering fact injection from memories.
 */

import type { Database } from './database.js'
import { RECALLED_MARKER } from './message-digest.js'
import { loadHeuristics } from './heuristics.js'
import { toIsoUtc } from './timestamps.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A lightweight message record for sliding-window analysis.
 */
export interface SessionMessage {
  content: string
  /** Unix timestamp in milliseconds */
  timestampMs: number
  /** Approximate token count (characters / 4) */
  tokens: number
  /** True if the message contains an attachment marker */
  hasAttachment: boolean
}

/**
 * Result of the sliding-window topic-shift detection.
 */
export interface TopicShiftResult {
  /** Score: 0-4. Shift detected when score >= 2. */
  score: number
  /** True when a shift is detected (score >= 2) */
  shiftDetected: boolean
  /** Breakdown of which signals fired */
  signals: {
    timeGap: boolean       // Signal 1: >30 min gap
    jaccardShift: boolean  // Signal 2: Jaccard < 0.25 over sliding window
    explicit: boolean      // Signal 3: explicit /new trigger
  }
  /** Jaccard overlap computed between left/right windows (or null if insufficient data) */
  jaccardOverlap: number | null
  /** True when there is not enough data for detection (< 5 messages or < 200 tokens) */
  insufficient: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop-word list (German + English, ~50 words)
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // English
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'from', 'they', 'will',
  'what', 'when', 'then', 'than', 'there', 'their', 'about', 'which', 'would',
  'could', 'should', 'were', 'been', 'being', 'some', 'into', 'also', 'just',
  'more', 'very', 'your', 'here', 'like', 'over', 'only', 'back', 'other',
  'after', 'such', 'where', 'these',
  // German
  'und', 'der', 'die', 'das', 'ist', 'ich', 'mit', 'ein', 'eine', 'nicht',
  'auch', 'sich', 'von', 'dem', 'des', 'auf', 'wie', 'aber', 'noch', 'bei',
  'oder', 'wenn', 'dann', 'durch', 'wird', 'kann', 'sind', 'alle', 'als',
  'nach', 'hier', 'dass', 'mehr', 'nur', 'schon', 'sein', 'hat', 'haben',
  'wurde', 'aus', 'zum', 'zur',
])

// ─────────────────────────────────────────────────────────────────────────────
// Token estimation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate token count from text (rough approximation: chars / 4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachment detection
// ─────────────────────────────────────────────────────────────────────────────

const ATTACHMENT_MARKERS = ['[File:', '[Anhang:', 'attachment:']

/**
 * Returns true if a message contains an attachment marker.
 */
export function hasAttachmentMarker(text: string): boolean {
  const lower = text.toLowerCase()
  return ATTACHMENT_MARKERS.some(m => lower.includes(m.toLowerCase()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract topic fingerprint from an array of text strings.
 * Pure keyword extraction — no LLM, no embedding.
 *
 * Algorithm:
 *  1. Lowercase all text, combine into a single string
 *  2. Split on non-alpha characters
 *  3. Remove stop words and tokens <= 4 chars
 *  4. Count frequency
 *  5. Return top 8 by frequency
 */
export function extractTopicTags(texts: string[]): string[] {
  const combined = texts.join(' ').toLowerCase()

  // Split on any non-letter character (also handles umlauts via unicode range)
  const tokens = combined.split(/[^a-z\u00c0-\u024f]+/)

  const freq = new Map<string, number>()
  for (const token of tokens) {
    // Only keep tokens > 4 chars and not in stop-word list
    if (token.length > 4 && !STOP_WORDS.has(token)) {
      freq.set(token, (freq.get(token) ?? 0) + 1)
    }
  }

  // Sort by frequency descending, return top 8 keys
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word)
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic similarity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two tag arrays.
 * Returns a value in [0.0, 1.0].
 */
export function topicOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0

  const setA = new Set(a)
  const setB = new Set(b)

  let intersectionSize = 0
  for (const tag of setA) {
    if (setB.has(tag)) intersectionSize++
  }

  const unionSize = setA.size + setB.size - intersectionSize
  return unionSize === 0 ? 0.0 : intersectionSize / unionSize
}

// ─────────────────────────────────────────────────────────────────────────────
// Sliding-Window Topic-Shift Detection
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_MIN_TOKENS = 200
const WINDOW_MAX_TOKENS = 1000
const LARGE_MSG_THRESHOLD = 500 // messages > this → only first 200 tokens used
const LARGE_MSG_SLICE = 200     // chars used from large messages (≈50 tokens)
const SMALL_MSG_THRESHOLD = 50  // messages < this → don't count for token-minimum

/**
 * Topic shift thresholds (SPEC 12.1). Defaults come from
 * `heuristics.topicShift` in settings.json; pass an object to pin them,
 * which the regression script does.
 */
export interface TopicShiftThresholds {
  jaccardThreshold: number
  timeGapMinutes: number
  windowSize: number
  minMessages: number
  minTokens: number
}

export function resolveTopicShiftThresholds(override?: Partial<TopicShiftThresholds>): TopicShiftThresholds {
  return { ...loadHeuristics().topicShift, ...(override ?? {}) }
}

/**
 * Build a sliding window from an array of messages.
 */
function buildWindow(msgs: SessionMessage[], windowSize: number): string[] | null {
  if (msgs.length === 0) return null

  const window = msgs.slice(-windowSize)
  const texts: string[] = []
  let tokenSum = 0

  for (const msg of window) {
    let text = msg.content
    let tokens = msg.tokens

    if (tokens > LARGE_MSG_THRESHOLD) {
      text = msg.content.slice(0, LARGE_MSG_SLICE * 4)
      tokens = LARGE_MSG_SLICE
    }

    if (tokens < SMALL_MSG_THRESHOLD) {
      texts.push(text)
      continue
    }

    if (tokenSum + tokens > WINDOW_MAX_TOKENS) {
      const remainingTokens = WINDOW_MAX_TOKENS - tokenSum
      if (remainingTokens <= 0) break
      text = text.slice(0, remainingTokens * 4)
      tokens = remainingTokens
    }

    texts.push(text)
    tokenSum += tokens
  }

  let qualifyingTokens = 0
  for (const msg of window) {
    const tokens = msg.tokens < LARGE_MSG_THRESHOLD ? msg.tokens : LARGE_MSG_SLICE
    if (tokens >= SMALL_MSG_THRESHOLD) {
      qualifyingTokens += Math.min(tokens, WINDOW_MAX_TOKENS - qualifyingTokens)
      if (qualifyingTokens >= WINDOW_MIN_TOKENS) break
    }
  }

  if (qualifyingTokens < WINDOW_MIN_TOKENS) return null

  return texts
}

/**
 * Sliding-Window Topic-Shift Detection.
 *
 * Signal 1 (+1): Time gap > 30 min between last stored message and new message
 * Signal 2 (+1): Jaccard overlap < 0.25 between LEFT and RIGHT sliding windows
 * Signal 3 (+2): Explicit trigger (pass explicitTrigger=true for /new command)
 *
 * Shift is detected when score >= 2.
 */
export function detectTopicShift(
  history: SessionMessage[],
  newMessage: SessionMessage,
  explicitTrigger = false,
  thresholds?: Partial<TopicShiftThresholds>,
): TopicShiftResult {
  const t = resolveTopicShiftThresholds(thresholds)
  const WINDOW_SIZE = t.windowSize
  const JACCARD_SHIFT_THRESHOLD = t.jaccardThreshold
  const TIME_GAP_MS = t.timeGapMinutes * 60 * 1000
  const insufficient = history.length < t.minMessages ||
    getTotalQualifyingTokens(history) < t.minTokens

  let score = 0
  const signals = { timeGap: false, jaccardShift: false, explicit: false }

  // Signal 3: Explicit trigger (always fires if provided)
  if (explicitTrigger) {
    score += 2
    signals.explicit = true
    return { score, shiftDetected: score >= 2, signals, jaccardOverlap: null, insufficient: false }
  }

  if (insufficient) {
    return { score: 0, shiftDetected: false, signals, jaccardOverlap: null, insufficient: true }
  }

  if (newMessage.hasAttachment) {
    return { score: 0, shiftDetected: false, signals, jaccardOverlap: null, insufficient: false }
  }

  // Signal 1: Time gap > 30 min
  const lastMsg = history[history.length - 1]
  if (lastMsg && newMessage.timestampMs - lastMsg.timestampMs > TIME_GAP_MS) {
    score += 1
    signals.timeGap = true
  }

  // Signal 2: Jaccard shift via sliding windows
  const rightWindow = buildWindow(history.slice(0, -WINDOW_SIZE), WINDOW_SIZE)
  const leftWindowMsgs = [...history.slice(-WINDOW_SIZE), newMessage]
  const leftWindow = buildWindow(leftWindowMsgs, WINDOW_SIZE + 1)

  let jaccardOverlap: number | null = null

  if (rightWindow && leftWindow) {
    const rightTags = extractTopicTags(rightWindow)
    const leftTags = extractTopicTags(leftWindow)
    jaccardOverlap = topicOverlap(rightTags, leftTags)

    if (jaccardOverlap < JACCARD_SHIFT_THRESHOLD) {
      score += 1
      signals.jaccardShift = true
    }
  }

  return {
    score,
    shiftDetected: score >= 2,
    signals,
    jaccardOverlap,
    insufficient: false,
  }
}

/**
 * Compute the total qualifying token count from a message array.
 */
function getTotalQualifyingTokens(msgs: SessionMessage[]): number {
  let total = 0
  for (const msg of msgs) {
    const tokens = Math.min(msg.tokens, LARGE_MSG_SLICE)
    if (tokens >= SMALL_MSG_THRESHOLD) {
      total += tokens
    }
  }
  return total
}

/**
 * Convert raw chat_messages DB rows to SessionMessage records.
 */
export function toSessionMessages(
  rows: Array<{ content: string; timestamp: string }>
): SessionMessage[] {
  return rows.map(row => {
    const content = row.content ?? ''
    const tokens = estimateTokens(content)
    // The stored value is UTC without a zone marker; `new Date(...)` would
    // read it as local time and shift every gap by the local UTC offset.
    const timestampMs = new Date(toIsoUtc(row.timestamp)).getTime()
    return {
      content,
      timestampMs: isNaN(timestampMs) ? Date.now() : timestampMs,
      tokens,
      hasAttachment: hasAttachmentMarker(content),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers (simplified — no reactivation, no topic_tags/token_count columns)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load all chat_messages for a session and return their text content.
 */
export function getSessionMessageTexts(db: Database, sessionId: string): string[] {
  const rows = db.prepare(
    // `id` is the tiebreaker: `timestamp` has second resolution, several rows
    // per second are normal, and without it their order is undefined.
    `SELECT content FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC`,
  ).all(sessionId) as Array<{ content: string }>

  return rows.map(r => r.content)
}

/**
 * Load all chat_messages for a session as SessionMessage records.
 * Used for sliding-window topic-shift detection.
 */
export function getSessionMessages(db: Database, sessionId: string): SessionMessage[] {
  const rows = db.prepare(
    `SELECT content, timestamp FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC`,
  ).all(sessionId) as Array<{ content: string; timestamp: string }>

  return toSessionMessages(rows)
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory FTS5 retrieval (fact injection on topic shift / session start)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query the memories FTS5 table for relevant facts given topic keywords.
 * Returns the top N matching fact records.
 *
 * When agentId is specified, only facts for that agent and 'shared' are returned.
 * When agentId is undefined/null, all facts are searched (legacy behavior).
 */
export function queryMemoriesFts(
  db: Database,
  keywords: string[],
  limit: number = 5,
  agentId?: string,
): Array<{ id: number; content: string; source: string; timestamp: string }> {
  if (keywords.length === 0) return []

  // Build an OR query for FTS5
  const ftsQuery = keywords
    .filter(k => k.length > 2)
    .map(k => `"${k.replace(/"/g, '')}"`)
    .join(' OR ')

  if (!ftsQuery) return []

  try {
    let sql: string
    let params: unknown[]

    if (agentId) {
      sql = `SELECT m.id, m.content, m.source, m.timestamp
       FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ? AND m.agent_id IN (?, 'shared')
         AND m.status = 'active' AND m.provenance IN ('owner','agent')
       ORDER BY rank
       LIMIT ?`
      params = [ftsQuery, agentId, limit]
    } else {
      sql = `SELECT m.id, m.content, m.source, m.timestamp
       FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ?
         AND m.status = 'active' AND m.provenance IN ('owner','agent')
       ORDER BY rank
       LIMIT ?`
      params = [ftsQuery, limit]
    }

    const rows = db.prepare(sql).all(...params) as Array<{ id: number; content: string; source: string; timestamp: string }>

    return rows
  } catch {
    // FTS5 table may not exist yet
    return []
  }
}

/**
 * Build a context injection string from memory facts for the system prompt.
 */
export function buildFactInjection(facts: Array<{ content: string }>): string {
  if (facts.length === 0) return ''

  // Every injected line carries the recalled marker so a transcript that
  // ever contains it is stripped before fact extraction (SPEC 11.4 gate 2).
  const lines = facts.map((f, i) => `${RECALLED_MARKER} ${i + 1}. ${f.content}`)
  return `\n\n## Relevant Facts from Memory\n${lines.join('\n')}\n`
}
