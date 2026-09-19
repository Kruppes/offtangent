/**
 * session-summary-schema.ts: the session summary as a fixed schema with
 * delta updates (SPEC 11.2).
 *
 * The summary model never rewrites the summary. It receives the previous
 * version and returns a delta: a new goal (optional), items to add, and
 * open items to resolve. The server merges. Removal of decisions or
 * artifacts is not expressible through the delta, which is the point
 * (ACE, arXiv:2510.04618: rewriting is what causes context collapse).
 */

export interface SessionSummary {
  goal: string
  decisions: string[]
  open: string[]
  artifacts: string[]
  next: string[]
}

export interface SessionSummaryDelta {
  goal?: string
  add?: Partial<Record<'decisions' | 'open' | 'artifacts' | 'next', string[]>>
  resolve?: { open?: string[] }
  /** The model says there was nothing of substance (greetings only). */
  empty?: boolean
}

export const EMPTY_SUMMARY_TEXT = 'Empty session.'

export function emptySummary(): SessionSummary {
  return { goal: '', decisions: [], open: [], artifacts: [], next: [] }
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') continue
    const t = v.replace(/\s+/g, ' ').trim()
    if (t) out.push(t)
  }
  return out
}

function stripFences(text: string): string {
  const t = text.trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return m ? m[1].trim() : t
}

export type ParseDeltaResult =
  | { ok: true; delta: SessionSummaryDelta }
  | { ok: false; error: string }

/**
 * Strict parse of a model answer into a delta. Accepts a bare JSON object,
 * optionally wrapped in a code fence. Anything else is rejected and the
 * caller keeps the previous version untouched (OpenClaw safeguard rule).
 */
export function parseSummaryDelta(text: string): ParseDeltaResult {
  const body = stripFences(text)
  if (!body.startsWith('{')) {
    return { ok: false, error: 'delta is not a JSON object' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'delta is not a JSON object' }
  }
  const r = raw as Record<string, unknown>
  const delta: SessionSummaryDelta = {}
  if (typeof r.goal === 'string' && r.goal.trim()) delta.goal = r.goal.replace(/\s+/g, ' ').trim()
  if (r.empty === true) delta.empty = true
  if (r.add && typeof r.add === 'object' && !Array.isArray(r.add)) {
    const a = r.add as Record<string, unknown>
    delta.add = {
      decisions: cleanList(a.decisions),
      open: cleanList(a.open),
      artifacts: cleanList(a.artifacts),
      next: cleanList(a.next),
    }
  }
  if (r.resolve && typeof r.resolve === 'object' && !Array.isArray(r.resolve)) {
    delta.resolve = { open: cleanList((r.resolve as Record<string, unknown>).open) }
  }
  const hasContent = Boolean(delta.goal) || delta.empty === true
    || Object.values(delta.add ?? {}).some(l => l && l.length > 0)
    || (delta.resolve?.open?.length ?? 0) > 0
  if (!hasContent) {
    return { ok: false, error: 'delta carries no goal, no additions and no resolutions' }
  }
  return { ok: true, delta }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function appendUnique(target: string[], items: string[] | undefined): void {
  if (!items) return
  const seen = new Set(target.map(norm))
  for (const item of items) {
    const k = norm(item)
    if (!k || seen.has(k)) continue
    seen.add(k)
    target.push(item)
  }
}

/**
 * Merge a delta into the previous summary. Pure, returns a new object.
 * `resolve.open` matches by normalised text or by prefix so a model that
 * quotes an open item loosely still resolves it.
 */
export function mergeSummaryDelta(prev: SessionSummary | null, delta: SessionSummaryDelta): SessionSummary {
  const base = prev ? {
    goal: prev.goal,
    decisions: [...prev.decisions],
    open: [...prev.open],
    artifacts: [...prev.artifacts],
    next: [...prev.next],
  } : emptySummary()

  if (delta.goal) base.goal = delta.goal

  if (delta.resolve?.open?.length) {
    const keys = delta.resolve.open.map(norm).filter(Boolean)
    base.open = base.open.filter(item => {
      const k = norm(item)
      return !keys.some(r => r === k || k.startsWith(r) || r.startsWith(k))
    })
  }

  appendUnique(base.decisions, delta.add?.decisions)
  appendUnique(base.open, delta.add?.open)
  appendUnique(base.artifacts, delta.add?.artifacts)
  // `next` is replaced when the delta names next steps: old next steps are
  // either done (then they appear in decisions) or stale.
  if (delta.add?.next?.length) {
    base.next = []
    appendUnique(base.next, delta.add.next)
  }
  return base
}

/**
 * Render the schema for the daily file and the session end event. Keeps
 * the `### Open Threads` section that the consolidation prompt and the
 * wiki conventions already look for.
 */
export function renderSummaryMarkdown(summary: SessionSummary): string {
  const lines: string[] = []
  if (summary.goal) lines.push(summary.goal)
  for (const d of summary.decisions) lines.push(`- ${d}`)
  if (summary.artifacts.length > 0) lines.push(`Artifacts: ${summary.artifacts.join(', ')}`)
  if (summary.next.length > 0) lines.push(`Next: ${summary.next.join('; ')}`)
  const head = lines.join('\n').trim()
  if (summary.open.length === 0) return head || EMPTY_SUMMARY_TEXT
  const open = ['### Open Threads', ...summary.open.map(o => `- ${o}`)].join('\n')
  return head ? `${head}\n\n${open}` : open
}

export function isEmptySummary(summary: SessionSummary): boolean {
  return !summary.goal && summary.decisions.length === 0 && summary.open.length === 0
    && summary.artifacts.length === 0 && summary.next.length === 0
}

/** The instruction block for the summary model. Kept here so prompt and parser evolve together. */
export function buildSummaryDeltaSystemPrompt(): string {
  return `You maintain a structured session summary. You never rewrite it; you return a JSON delta that the server merges into the previous version.

## Output format (strict)

Return exactly one JSON object and nothing else. No prose, no markdown headings, no code fence, no "# Activity Log" or similar heading, no horizontal rules ("---").

{
  "goal": "one sentence: what this session is for (omit if the previous goal still holds)",
  "add": {
    "decisions": ["standalone sentences, things that were decided, done, answered or completed"],
    "open": ["unfinished tasks, background tasks without a confirmed result, deferred decisions, unanswered questions"],
    "artifacts": ["files, PRs, wiki pages, URLs, task ids that were created or touched"],
    "next": ["concrete next steps, if any"]
  },
  "resolve": { "open": ["previous open items that are now settled, quoted as they were"] }
}

Rules:
- Only add what the transcript supports. Do not repeat items that are already in the previous summary.
- "add.decisions" is the activity log: what actually happened. Even a single answered question is one sentence. Neutral, factual, no filler, no meta commentary. Write in the language of the conversation.
- If a background task completed or a task result was injected, record its outcome as a decision (e.g. "PR #15 created for X").
- "add.open" lists genuinely unresolved items only. Never add an empty placeholder. Never list an item that everything in the transcript shows as resolved.
- "resolve.open" moves previous open items out of the open list; use it when the transcript shows they were finished.
- Lines of the form "[msg:<id>] <role>, <n> chars: <first sentence>" are shortened messages. Use the visible sentence as a hint, do not invent the rest.
- If the transcript contains nothing but greetings or a bare connection with zero substantive content, return {"empty": true}.`
}
