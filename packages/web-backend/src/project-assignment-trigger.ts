/**
 * The trigger side of the running strand to project assignment (Stufe 2).
 *
 * Two hooks feed it: the end of every chat turn and the end of a session. Both
 * are places where the user is already served, which is the whole point — the
 * gate below is a handful of indexed reads, everything expensive happens in a
 * detached promise, and nothing here is ever awaited by a turn.
 *
 * Mirrors `fact-extraction-session-end.ts` in shape (settings, deps injection
 * for tests, fire and forget), because it has the same job: spend tokens after
 * the conversation, never during it.
 */
import {
  evaluateStrandProject,
  getStrandForAssignment,
  getStrandProjectSuggestion,
  loadConfig,
  planProjectAssignment,
} from '@axiom/core'
import type { Database, ProjectAssignmentTrigger, EvaluateStrandProjectResult } from '@axiom/core'
import type { ChatEventBus } from './chat-event-bus.js'

export interface ProjectAssignmentSettings {
  /** Kill switch. The feature costs tokens, so it must be switchable off. */
  enabled: boolean
}

const DEFAULT_PROJECT_ASSIGNMENT_SETTINGS: ProjectAssignmentSettings = { enabled: true }

export interface ProjectAssignmentDeps {
  loadSettings: () => { projectAssignment?: Partial<ProjectAssignmentSettings> }
  evaluate: typeof evaluateStrandProject
  console: Pick<typeof console, 'log' | 'warn' | 'error'>
}

const defaultDeps: ProjectAssignmentDeps = {
  loadSettings: () => loadConfig<{ projectAssignment?: Partial<ProjectAssignmentSettings> }>('settings.json'),
  evaluate: evaluateStrandProject,
  console,
}

function getSettings(loadSettings: ProjectAssignmentDeps['loadSettings']): ProjectAssignmentSettings {
  try {
    return { ...DEFAULT_PROJECT_ASSIGNMENT_SETTINGS, ...(loadSettings().projectAssignment ?? {}) }
  } catch {
    return { ...DEFAULT_PROJECT_ASSIGNMENT_SETTINGS }
  }
}

/**
 * Strands with a running evaluation. A turn end and a session end can arrive
 * within the same second for the same strand; without this the second one
 * pays for a duplicate classification whose result the first one overwrites.
 */
const inFlight = new Set<string>()

/** Test hook: forget which strands are considered in flight. */
export function resetProjectAssignmentInFlight(): void {
  inFlight.clear()
}

export interface TriggerProjectAssignmentOptions {
  db: Database
  sessionId: string
  trigger: ProjectAssignmentTrigger
  chatEventBus?: ChatEventBus | null
  /** Resolved after the run so the caller can await it in a test. */
  onSettled?: (result: EvaluateStrandProjectResult) => void
  deps?: Partial<ProjectAssignmentDeps>
}

function numericUserId(value: string | null): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Evaluate one strand in the background. Returns synchronously: `true` when a
 * run was started, `false` when the gate refused it. Never throws.
 */
export function triggerProjectAssignment(options: TriggerProjectAssignmentOptions): boolean {
  const { db, sessionId, trigger } = options
  const deps = { ...defaultDeps, ...(options.deps ?? {}) }
  if (!getSettings(deps.loadSettings).enabled) return false
  if (inFlight.has(sessionId)) return false

  let plan: ReturnType<typeof planProjectAssignment>
  try {
    plan = planProjectAssignment(db, sessionId, trigger)
  } catch (err) {
    deps.console.warn(`[project-assignment] Gate failed for strand ${sessionId}: ${(err as Error).message}`)
    return false
  }
  if (!plan.run) return false

  inFlight.add(sessionId)
  void (async () => {
    try {
      const result = await deps.evaluate(db, sessionId, trigger)
      if (result.outcome === 'assigned' || result.outcome === 'suggested') {
        deps.console.log(
          `[project-assignment] Strand ${sessionId}: ${result.outcome} project ${result.projectId} `
          + `at ${(result.confidence ?? 0).toFixed(2)} (${result.model}, ${result.latencyMs} ms, trigger ${trigger})`,
        )
        broadcast(options, sessionId)
      }
      options.onSettled?.(result)
    } catch (err) {
      deps.console.error(`[project-assignment] Failed for strand ${sessionId}:`, err)
    } finally {
      inFlight.delete(sessionId)
    }
  })()
  return true
}

function broadcast(options: TriggerProjectAssignmentOptions, strandId: string): void {
  const bus = options.chatEventBus
  if (!bus) return
  const strand = getStrandForAssignment(options.db, strandId)
  if (!strand) return
  const userId = numericUserId(strand.userId)
  if (userId === null) return
  bus.broadcast({
    type: 'strand_project_changed',
    userId,
    source: 'web',
    sessionId: strandId,
    agentId: strand.agentId,
    projectId: strand.projectId,
    projectSuggestion: strand.projectId ? null : getStrandProjectSuggestion(options.db, strandId),
  })
}
