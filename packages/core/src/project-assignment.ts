/**
 * project-assignment.ts: the running strand to project assignment (Stufe 2).
 *
 * The capture router (SPEC 4.2b) only ever decides a project at the birth of a
 * strand, and only for strands a capture opens. Everything that starts in the
 * app composer, in Telegram or in the web chat stays unassigned forever, which
 * is why a one-off backfill was a snapshot that went stale the same day.
 *
 * This module evaluates a strand that has NO project, again and again while it
 * grows, and turns one model answer into one of three outcomes:
 *
 *   >= 0.75  the project is written onto the strand
 *   >= 0.50  the project is stored as a proposal the user taps or throws away
 *    < 0.50  nothing is stored at all
 *
 * The numbers come from the product owner. Three invariants hold above them:
 * a strand that already has a project is never touched, a dismissed
 * (strand, project) pair never returns, and the run never blocks a chat turn
 * (callers start it after the turn has ended, fire and forget).
 */
import type { Database } from './database.js'
import { completeSimple } from './pi-models.js'
import { resolveBackgroundReasoning } from './thinking-level.js'
import { getLatestSessionSummary } from './session-summary-store.js'
import { renderSummaryMarkdown } from './session-summary-schema.js'
import { getStrandTags } from './strand-store.js'
import { buildRouterModel, loadRouterChain, parseRouterChain, resolveRouterChain } from './router-model.js'
import type { ResolvedRouterModel } from './router-model.js'
import { loadConfig, warnConfigReadFailed } from './config.js'
import {
  PROJECT_ASSIGNMENT_MAX_DISMISSALS,
  PROJECT_ASSIGN_MIN_CONFIDENCE,
  PROJECT_SUGGEST_MIN_CONFIDENCE,
  assignProjectIfUnset,
  countStrandMessages,
  getProjectAssignmentRun,
  getStrandForAssignment,
  listDismissedProjectsForStrand,
  putStrandProjectSuggestion,
  recordProjectAssignmentRun,
} from './project-assignment-store.js'
import type { ProjectAssignmentOutcome } from './project-assignment-store.js'

/** Never before the third user/assistant message: below that there is nothing to classify. */
export const PROJECT_ASSIGNMENT_MIN_MESSAGES = 3
/** After a run, the next one needs this many further messages. */
export const PROJECT_ASSIGNMENT_MESSAGE_INTERVAL = 10
/** Projects offered to the classifier, active and archived alike. */
export const PROJECT_ASSIGNMENT_PROJECT_CAP = 60
/** Messages quoted in the prompt: the opening of the strand plus its tail. */
export const PROJECT_ASSIGNMENT_HEAD_MESSAGES = 2
export const PROJECT_ASSIGNMENT_TAIL_MESSAGES = 8
/** Hard cap per quoted message, token budget over completeness. */
export const PROJECT_ASSIGNMENT_MESSAGE_CHARS = 300
export const PROJECT_ASSIGNMENT_SUMMARY_CHARS = 400

export type ProjectAssignmentTrigger = 'message' | 'session_end'

export type ProjectAssignmentSkipReason =
  | 'unknown_strand'
  | 'not_interactive'
  | 'archived'
  | 'project_already_set'
  | 'no_user'
  | 'too_few_messages'
  | 'rate_limited'
  | 'already_evaluated_at_this_length'
  | 'dismissed_often_enough'
  | 'no_projects'

export type ProjectAssignmentPlan =
  | { run: true; messageCount: number; userId: string }
  | { run: false; reason: ProjectAssignmentSkipReason }

/**
 * May this strand be evaluated right now? Pure bookkeeping, no model call.
 *
 * `message` is the throttled path: the third message opens the door, every
 * further run needs {@link PROJECT_ASSIGNMENT_MESSAGE_INTERVAL} messages on
 * top. `session_end` is the one extra look a closing strand gets, so a
 * conversation that ends at message 7 is still classified; it skips the
 * interval but not the minimum, and not a length that was already judged.
 */
export function planProjectAssignment(
  db: Database,
  strandId: string,
  trigger: ProjectAssignmentTrigger,
): ProjectAssignmentPlan {
  const strand = getStrandForAssignment(db, strandId)
  if (!strand) return { run: false, reason: 'unknown_strand' }
  if (strand.type !== 'interactive') return { run: false, reason: 'not_interactive' }
  if (strand.archived) return { run: false, reason: 'archived' }
  if (strand.projectId !== null) return { run: false, reason: 'project_already_set' }
  if (!strand.userId) return { run: false, reason: 'no_user' }

  if (listDismissedProjectsForStrand(db, strandId).length >= PROJECT_ASSIGNMENT_MAX_DISMISSALS) {
    return { run: false, reason: 'dismissed_often_enough' }
  }

  const messageCount = countStrandMessages(db, strandId)
  if (messageCount < PROJECT_ASSIGNMENT_MIN_MESSAGES) return { run: false, reason: 'too_few_messages' }

  const previous = getProjectAssignmentRun(db, strandId)
  if (previous) {
    if (messageCount <= previous.lastMessageCount) {
      return { run: false, reason: 'already_evaluated_at_this_length' }
    }
    if (trigger === 'message' && messageCount - previous.lastMessageCount < PROJECT_ASSIGNMENT_MESSAGE_INTERVAL) {
      return { run: false, reason: 'rate_limited' }
    }
  }
  return { run: true, messageCount, userId: strand.userId }
}

/** One entry of the project list handed to the classifier. */
export interface AssignmentProject {
  id: string
  name: string
  archived: boolean
}

export interface ProjectAssignmentInput {
  strandId: string
  title: string | null
  personaId: string
  tags: string[]
  summary: string
  messages: string[]
  messageCount: number
  projects: AssignmentProject[]
  now: string
}

/**
 * Every project of the user, active first. Archived ones are offered on
 * purpose: a strand that clearly belongs to a container the user has put away
 * still belongs there, and hiding it would push the classifier towards a
 * wrong active project. The list is flagged so the model can weigh it.
 */
export function listAssignmentProjects(db: Database, userId: string): AssignmentProject[] {
  const rows = db.prepare(
    `SELECT id, name, archived FROM projects WHERE user_id = ?
     ORDER BY archived ASC, name COLLATE NOCASE ASC, id ASC LIMIT ?`,
  ).all(userId, PROJECT_ASSIGNMENT_PROJECT_CAP) as { id: string; name: string; archived: number }[]
  return rows.map(r => ({ id: r.id, name: r.name, archived: !!r.archived }))
}

function collapse(text: string, max: number): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Head plus tail of the transcript: how a strand started and where it is now. */
function strandMessages(db: Database, strandId: string): string[] {
  const head = db.prepare(
    `SELECT role, content FROM chat_messages
     WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id ASC LIMIT ?`,
  ).all(strandId, PROJECT_ASSIGNMENT_HEAD_MESSAGES) as { role: string; content: string }[]
  const tail = db.prepare(
    `SELECT role, content FROM chat_messages
     WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?`,
  ).all(strandId, PROJECT_ASSIGNMENT_TAIL_MESSAGES) as { role: string; content: string }[]

  const seen = new Set<string>()
  const out: string[] = []
  for (const row of [...head, ...tail.reverse()]) {
    const line = `${row.role}: ${collapse(row.content, PROJECT_ASSIGNMENT_MESSAGE_CHARS)}`
    if (!line.endsWith(': ') && !seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }
  return out
}

export function buildProjectAssignmentInput(
  db: Database,
  strandId: string,
  userId: string,
): ProjectAssignmentInput | null {
  const strand = getStrandForAssignment(db, strandId)
  if (!strand) return null
  const latest = getLatestSessionSummary(db, strandId)
  const summary = latest
    ? collapse(renderSummaryMarkdown(latest.summary), PROJECT_ASSIGNMENT_SUMMARY_CHARS)
    : ''
  return {
    strandId,
    title: strand.title,
    personaId: strand.agentId,
    tags: getStrandTags(db, strandId),
    summary,
    messages: strandMessages(db, strandId),
    messageCount: countStrandMessages(db, strandId),
    projects: listAssignmentProjects(db, userId),
    now: new Date().toISOString(),
  }
}

export const PROJECT_ASSIGNMENT_SYSTEM_PROMPT = `You sort threads of thought into long lived containers. A project is one product, one vehicle, one house, one area of life, alive for months; a strand is a single thread of thought that may belong inside one of them.

You get ONE strand and the complete list of the user's projects. Answer with ONE JSON object and nothing else: no prose, no markdown fences.

Schema:
{
  "projectId": string | null,
  "confidence": number,
  "reason": string
}

Rules:
- "projectId" is an id from the project list, or null. Never invent an id, never answer with a project name.
- null is a perfectly good answer and the most common one. A wrong container is worse than no container: the user finds an unsorted strand, but a strand filed under the wrong project is lost behind a name that does not match it.
- "confidence" is a float between 0 and 1 and it is your honest estimate that the WHOLE strand belongs to that project. 0.8 and above only when the strand names the project, its product, its vehicle, its files or its people. 0.5 to 0.75 when it plausibly fits but the evidence is thin. Below 0.5 when you are guessing.
- Evidence is content, not sound. A project name that merely rhymes with a word in the strand is not evidence. The list gives you names, not contents.
- A strand that jumps between subjects belongs to no project. Say null.
- Some projects are marked "archived": the user has put them away. Choose one only when the strand unmistakably belongs to it.
- "reason": one short sentence, in the language of the strand, naming the concrete evidence.

Answer with the JSON object only.`

export function buildProjectAssignmentPrompt(input: ProjectAssignmentInput): string {
  const projects = input.projects.map(p => (p.archived ? { ...p, archived: true } : { id: p.id, name: p.name }))
  const strand = {
    title: input.title,
    persona: input.personaId,
    tags: input.tags,
    messageCount: input.messageCount,
    ...(input.summary ? { summary: input.summary } : {}),
    messages: input.messages,
  }
  return `Projects of this user (id, name, archived):\n${JSON.stringify(projects, null, 2)}\n\n`
    + `Which project does this strand belong to?\n\n${JSON.stringify(strand, null, 2)}\n\n`
    + 'Answer with the JSON object only.'
}

export interface ProjectAssignmentProposal {
  projectId: string | null
  confidence: number
  reason: string
}

export type ParseProjectAssignmentResult =
  | { ok: true; proposal: ProjectAssignmentProposal }
  | { ok: false; error: string }

function stripFences(text: string): string {
  const t = (text ?? '').trim()
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return fenced[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) return t.slice(start, end + 1)
  return t
}

function clamp01(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

/**
 * Strict parse. An id the user does not own is an error, not a null answer:
 * a model that invents ids is a model whose confidence means nothing, and the
 * caller gets one repair retry for it.
 */
export function parseProjectAssignmentOutput(
  text: string,
  input: ProjectAssignmentInput,
): ParseProjectAssignmentResult {
  let raw: unknown
  try {
    raw = JSON.parse(stripFences(text))
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'not an object' }
  const obj = raw as Record<string, unknown>

  const confidence = clamp01(obj.confidence)
  if (confidence === null) return { ok: false, error: 'confidence must be a number' }
  const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 400) : ''

  const rawProject = obj.projectId
  if (rawProject === null || rawProject === undefined || rawProject === '') {
    return { ok: true, proposal: { projectId: null, confidence, reason } }
  }
  if (typeof rawProject !== 'string') return { ok: false, error: 'projectId must be a project id or null' }
  const projectId = rawProject.trim()
  if (!input.projects.some(p => p.id === projectId)) {
    return { ok: false, error: 'projectId is not one of the listed projects' }
  }
  return { ok: true, proposal: { projectId, confidence, reason } }
}

export const PROJECT_ASSIGNMENT_REPAIR_PROMPT =
  'Your previous answer was not a valid assignment object. Reply again with exactly one JSON object matching the schema, no other text.'

/** One model call: system prompt fixed, `userPrompt` is the whole conversation. */
export type ProjectAssignmentCompletion = (
  entry: ResolvedRouterModel,
  userPrompt: string,
) => Promise<string>

async function defaultCompletion(entry: ResolvedRouterModel, userPrompt: string): Promise<string> {
  const handle = await buildRouterModel(entry)
  if (!handle) throw new Error(`model ${entry.composite} is not available`)
  const response = await completeSimple(handle.model, {
    systemPrompt: PROJECT_ASSIGNMENT_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: userPrompt, timestamp: Date.now() }],
  }, {
    apiKey: handle.apiKey,
    reasoning: resolveBackgroundReasoning(),
  })
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new Error(response.errorMessage ?? response.stopReason)
  }
  return response.content
    .filter(item => item.type === 'text')
    .map(item => (item as { type: 'text'; text: string }).text)
    .join('')
    .trim()
}

interface ProjectAssignmentPolicyBlock {
  modelPolicy?: { roles?: { projectAssignment?: unknown } }
}

/**
 * The model chain of the `projectAssignment` role. Falls back to the `router`
 * role, so an instance that never configures it classifies with the same
 * models it already routes with. Set it in `settings.json` to point the
 * classification at a cheaper (for this instance: local) model without
 * touching the router:
 *
 *   "modelPolicy": { "roles": { "projectAssignment": "qwen3.8:27b-mlx" } }
 */
export function loadProjectAssignmentChain(): ReturnType<typeof loadRouterChain> {
  let raw: unknown
  try {
    raw = loadConfig<ProjectAssignmentPolicyBlock>('settings.json').modelPolicy?.roles?.projectAssignment
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
  }
  const chain = parseRouterChain(raw)
  return chain.length > 0 ? chain : loadRouterChain()
}

export interface RunProjectAssignmentOptions {
  chain?: ResolvedRouterModel[]
  complete?: ProjectAssignmentCompletion
}

export interface ProjectAssignmentModelResult {
  proposal: ProjectAssignmentProposal | null
  model: string
  latencyMs: number
  notes: string[]
}

/**
 * Run the chain for one strand. Each entry gets one call and one repair
 * retry; an entry with a threshold hands over when its confidence is below
 * it, and the most confident proposal wins. Every failure degrades to
 * `proposal: null`, which stores nothing — the strand simply stays unsorted.
 */
export async function runProjectAssignment(
  input: ProjectAssignmentInput,
  options: RunProjectAssignmentOptions = {},
): Promise<ProjectAssignmentModelResult> {
  const startedAt = Date.now()
  const notes: string[] = []
  const chain = options.chain ?? resolveRouterChain(loadProjectAssignmentChain())
  const complete = options.complete ?? defaultCompletion
  const userPrompt = buildProjectAssignmentPrompt(input)

  if (input.projects.length === 0) {
    return { proposal: null, model: 'synthetic', latencyMs: Date.now() - startedAt, notes: ['no projects'] }
  }
  if (chain.length === 0) {
    notes.push('project assignment chain has no available entry')
    return { proposal: null, model: 'synthetic', latencyMs: Date.now() - startedAt, notes }
  }

  let best: { proposal: ProjectAssignmentProposal; model: string } | null = null
  for (const entry of chain) {
    let prompt = userPrompt
    let proposal: ProjectAssignmentProposal | null = null
    for (let attempt = 0; attempt < 2 && !proposal; attempt += 1) {
      let text: string
      try {
        text = await complete(entry, prompt)
      } catch (err) {
        notes.push(`${entry.composite}: ${(err as Error).message}`)
        break
      }
      const parsed = parseProjectAssignmentOutput(text, input)
      if (parsed.ok) {
        proposal = parsed.proposal
      } else {
        notes.push(`${entry.composite}: malformed answer (${parsed.error})${attempt === 0 ? ', retrying' : ''}`)
        prompt = `${userPrompt}\n\nYour previous answer was rejected (${parsed.error}):\n${text.slice(0, 1000)}\n\n${PROJECT_ASSIGNMENT_REPAIR_PROMPT}`
      }
    }
    if (!proposal) continue
    if (!best || proposal.confidence > best.proposal.confidence) best = { proposal, model: entry.composite }
    if (entry.threshold !== null && proposal.confidence < entry.threshold) {
      notes.push(`${entry.composite}: confidence ${proposal.confidence.toFixed(2)} below threshold ${entry.threshold}, trying next entry`)
      continue
    }
    break
  }

  if (!best) return { proposal: null, model: 'synthetic', latencyMs: Date.now() - startedAt, notes }
  return { proposal: best.proposal, model: best.model, latencyMs: Date.now() - startedAt, notes }
}

export interface EvaluateStrandProjectResult {
  outcome: ProjectAssignmentOutcome | 'skipped'
  reason?: ProjectAssignmentSkipReason
  projectId?: string | null
  confidence?: number
  model?: string
  latencyMs?: number
  notes?: string[]
}

/**
 * The whole path for one strand: gate, classify, apply the bands, record the
 * run. Never throws — a failing classification must not take a chat turn or a
 * session end with it.
 */
export async function evaluateStrandProject(
  db: Database,
  strandId: string,
  trigger: ProjectAssignmentTrigger,
  options: RunProjectAssignmentOptions = {},
): Promise<EvaluateStrandProjectResult> {
  const plan = planProjectAssignment(db, strandId, trigger)
  if (!plan.run) return { outcome: 'skipped', reason: plan.reason }

  const input = buildProjectAssignmentInput(db, strandId, plan.userId)
  if (!input) return { outcome: 'skipped', reason: 'unknown_strand' }
  if (input.projects.length === 0) return { outcome: 'skipped', reason: 'no_projects' }

  let result: ProjectAssignmentModelResult
  try {
    result = await runProjectAssignment(input, options)
  } catch (err) {
    recordProjectAssignmentRun(db, strandId, plan.messageCount, 'error')
    return { outcome: 'error', notes: [(err as Error).message] }
  }

  const proposal = result.proposal
  if (!proposal || !proposal.projectId || proposal.confidence < PROJECT_SUGGEST_MIN_CONFIDENCE) {
    recordProjectAssignmentRun(db, strandId, plan.messageCount, 'none', {
      confidence: proposal?.confidence ?? null,
      model: result.model,
    })
    return {
      outcome: 'none',
      projectId: proposal?.projectId ?? null,
      confidence: proposal?.confidence,
      model: result.model,
      latencyMs: result.latencyMs,
      notes: result.notes,
    }
  }

  const common = {
    projectId: proposal.projectId,
    confidence: proposal.confidence,
    model: result.model,
    latencyMs: result.latencyMs,
    notes: result.notes,
  }

  if (proposal.confidence >= PROJECT_ASSIGN_MIN_CONFIDENCE) {
    const assigned = assignProjectIfUnset(db, strandId, plan.userId, proposal.projectId)
    recordProjectAssignmentRun(db, strandId, plan.messageCount, assigned ? 'assigned' : 'none', {
      confidence: proposal.confidence,
      model: result.model,
    })
    return { ...common, outcome: assigned ? 'assigned' : 'none' }
  }

  const stored = putStrandProjectSuggestion(db, {
    strandId,
    userId: plan.userId,
    projectId: proposal.projectId,
    confidence: proposal.confidence,
    reason: proposal.reason,
    model: result.model,
  })
  recordProjectAssignmentRun(db, strandId, plan.messageCount, stored ? 'suggested' : 'none', {
    confidence: proposal.confidence,
    model: result.model,
  })
  return { ...common, outcome: stored ? 'suggested' : 'none' }
}
