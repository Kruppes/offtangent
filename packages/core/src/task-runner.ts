import { applyEcoRequestView, EcoRequestGate, inheritEcoMode, readStrandEcoMode } from './eco-mode-store.js'
import { Agent as PiAgent } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message, Model, Api } from '@earendil-works/pi-ai'
import { cleanupSessionResources } from '@earendil-works/pi-ai'
import { completeSimple } from './pi-models.js'

import type { Database } from './database.js'
// attached_skills deduplicated onto the upstream module (0.27.0). The fork's
// former inline impl (loadAttachedSkillContent/renderAttachedSkillsBlock) is
// gone; resolveAgentMemoryDir stays (fork per-persona memory roots).
import { renderAttachedSkillsBlock } from './attached-skills.js'
import { readTasksGuidelinesFile, resolveAgentMemoryDir } from './memory.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'
import { formatTaskRouting } from './task-policy.js'
import { readBackgroundThinkingLevelFromConfig, resolveBackgroundReasoning, toPiAiReasoning } from './thinking-level.js'
import { parseOutputSchema, checkOutputAgainstSchema, buildSchemaCorrectionPrompt, buildOutputSchemaInstruction } from './task-output-schema.js'
import { withTimeout } from './promise-utils.js'
import { TaskStore } from './task-store.js'
import type { Task, TaskResultStatus, TaskTriggerType } from './task-store.js'
import type { SessionManager, SessionType } from './session-manager.js'
import { logTokenUsage, logToolCall } from './token-logger.js'
import { estimateCost, parseProviderModelId, buildStreamFn, getProviderDefaultModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import { runWithTaskExecutionContext, type TaskExecutionContext, type TaskOrigin } from './task-execution-context.js'
import {
  ToolCallTracker,
  buildSmartDetectionPrompt,
  parseSmartDetectionResponse,
  resolveDetectionMethod,
  formatPeriodicStatusUpdate,
} from './loop-detection.js'
import type { LoopDetectionConfig, LoopDetectionResult } from './loop-detection.js'
import type { TaskEventBus } from './task-event-bus.js'
import { getWorkspaceDir } from './agent.js'
import { TranscriptCompactor } from './transcript-compaction.js'
import { loadHeuristics } from './heuristics.js'
import { TaskProgressGuard } from './task-progress-guard.js'
import type { ProgressGuardTrip } from './task-progress-guard.js'
import { cacheReadRatio } from './cache-stats.js'
import { withSecretBoundary, redactMessages, sealSystemText } from './secret-boundary.js'
import { buildWrapUpMessage, planWrapUp } from './task-wrap-up.js'
import { buildTaskHandoff, extractHandoffSection } from './task-handoff.js'
import type { HandoffReason } from './task-handoff.js'
import {
  TaskConcurrencyQueue,
  normalizeProviderKey,
  queueAppliesToTrigger,
  readTaskConcurrencyLimitsFromConfig,
} from './task-queue.js'
import type { QueueWaitReason, TaskConcurrencyLimits } from './task-queue.js'

const MAX_STATUS_UPDATE_INTERVAL_MINUTES = 120

/**
 * How often a running task emits a `progress` lifecycle signal (SPEC 10.x).
 *
 * Measured before this existed: the only producer of a `task_progress` frame
 * was `onStatusUpdate`, which is gated behind `tasks.statusUpdates.enabled`
 * — `false` by default and NOT set on the production install (settings.json
 * carries only the legacy `statusUpdateIntervalMinutes: 10`, which migrates
 * the interval but leaves `enabled` false). So a task that ran for an hour
 * produced exactly two frames: `started` and `finished`, and a live token
 * counter had nothing to count with.
 *
 * This ticker is independent of that opt-in feature: it never writes a chat
 * message and never reaches Telegram, it only refreshes the in-memory view
 * of a node that is already on screen. One `setInterval` per running task,
 * cleared in `cleanupRunningTask` (which every terminal path calls), and the
 * emit itself re-checks `runningTasks` so a race cannot outlive the task.
 */
export const TASK_PROGRESS_FRAME_INTERVAL_MS = 30_000

export function parseTaskTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = new Date(value.replace(' ', 'T') + 'Z').getTime()
  return Number.isFinite(ms) ? ms : null
}

function taskStartedAtMs(value: string | null | undefined): number {
  return parseTaskTimestampMs(value) ?? Date.now()
}

/** Map an abort reason string onto the handoff taxonomy (W5/P2). */
function abortHandoffReason(reason: string): HandoffReason {
  return /max duration/i.test(reason) ? 'timeout' : 'aborted'
}

export interface TaskOverrides {
  /** JSON array of tool names to exclude (null = all enabled) */
  toolsOverride?: string | null
  /** JSON array of skill names to exclude (null = all enabled) */
  skillsOverride?: string | null
  /** Custom system prompt — replaces default entirely when set */
  systemPromptOverride?: string | null
  /**
   * Names of agent skills (directories under `/data/skills_agent/<name>/`)
   * whose `SKILL.md` content is injected verbatim into the task system
   * prompt under an `<attached_skills>` block. Missing files are skipped
   * with a warning so the task still runs.
   */
  attachedSkills?: string[] | null
}

export interface TaskRunnerOptions {
  db: Database
  /** Function to build a Model from a provider config */
  buildModel: (provider: ProviderConfig) => Model<Api>
  /** Function to get API key for a provider */
  getApiKey: (provider: ProviderConfig) => Promise<string>
  /** Tools to give to each task agent */
  tools: AgentTool[]
  /** Memory directory reference for task agent system prompt */
  memoryDir?: string
  /** Callback when a task completes/fails — delivers the injection message */
  onTaskComplete: (taskId: string, injection: string, agentId: string | null) => void
  /**
   * Lifecycle signal for the strand activity view: fires when a task starts
   * (`started`), every `TASK_PROGRESS_FRAME_INTERVAL_MS` while it works
   * (`progress`, carrying the live token/cost stand of the row) and when it
   * stops working (`finished` — completed, failed or paused waiting for an
   * answer). The runner is the single funnel every task start goes through,
   * so a sub-task created deep inside a wave is announced here exactly once.
   * Purely informational: throwing consumers are caught and logged, a broken
   * UI signal must never fail a task.
   */
  onTaskLifecycle?: (phase: 'started' | 'progress' | 'finished', task: Task) => void
  /** Callback when a task pauses with a question — delivers the injection message */
  onTaskPaused?: (taskId: string, injection: string, agentId: string | null) => void
  /** Callback for periodic status updates */
  /**
   * Periodic heartbeat callback. Fires every `statusUpdates.intervalMinutes`
   * minutes while a task is in the running map. Receives:
   *   - `taskId` / `statusMessage`: the task id and the legacy
   *     `<task_status type="periodic_update">…</task_status>` XML payload
   *     (kept for potential LLM-injection / logging consumers).
   *   - `details`: structured live metrics so non-LLM consumers
   *     (web UI, Telegram) don't have to regex-parse the XML string.
   */
  onStatusUpdate?: (
    taskId: string,
    statusMessage: string,
    details: {
      taskName: string
      runtimeMinutes: number
      toolCallCount: number
      totalTokens: number
    },
  ) => void
  /** Loop detection configuration */
  loopDetection?: LoopDetectionConfig
  /**
   * Periodic status-update configuration. When `enabled` is true and
   * `intervalMinutes > 0`, the runner calls `onStatusUpdate` every N
   * minutes for each running (and resumed) task. The default is disabled
   * so existing installations stay quiet until the operator opts in.
   */
  statusUpdates?: { enabled: boolean; intervalMinutes: number }
  /**
   * Result verification. When enabled (default), a completed user/agent/
   * cronjob task result is checked by an independent reviewer pass before
   * delivery; on a failed verdict the task agent gets ONE revision round
   * with the critique. `providerId` routes the reviewer call to a specific
   * provider (e.g. a local model) — empty uses the task's own provider.
   * Verification fails open: any reviewer error delivers the original result.
   */
  verification?: { enabled: boolean; providerId?: string }
  /** Function to resolve a provider config by ID (for smart detection) */
  getProviderById?: (providerId: string) => ProviderConfig | null
  /**
   * Resolve the user and the strand a task belongs to. The runner knows the
   * task row; only the composition layer knows how a task session maps back
   * to the strand that triggered it, so it answers that question here and the
   * answer is bound to the task's execution context for its whole run.
   * Without it, a task has no user and tools that deliver to one refuse.
   */
  resolveTaskOrigin?: (task: Task) => TaskOrigin
  /** Optional event bus for streaming task execution events to WebSocket clients */
  taskEventBus?: TaskEventBus
  /**
   * Thinking level applied to every task agent (and the loop-detection agent).
   * Defaults to the `tasks.backgroundThinkingLevel` entry in `settings.json`, or
   * `off` if unavailable.
   */
  backgroundThinkingLevel?: SettingsThinkingLevel
  /**
   * SessionManager used to register every background session in the
   * `sessions` table with the correct `type` and `parent_session_id`.
   */
  sessionManager: SessionManager
  /**
   * Watchdog fallback applied when `task.maxDurationMinutes` is null.
   *
   * Many internal task creators (agent heartbeat, memory consolidation,
   * cronjobs, scheduled tasks) never set `maxDurationMinutes`, so without
   * a fallback a task whose LLM call hangs silently (no error, no return)
   * would sit at status='running' indefinitely. This option puts a hard
   * upper bound on those runs.
   *
   * Set to a positive number to enable; leave undefined for legacy "no
   * limit" behavior. The web-backend wires this to `tasks.maxDurationMinutes`
   * from settings.
   */
  defaultMaxDurationMinutes?: number
  /**
   * Global (host-wide) task concurrency cap across all providers: how many
   * tasks may occupy a slot at the same time. `0` (or negative) = unlimited.
   *
   * A function, not a number, because the limit is re-read on every
   * admission/dequeue decision so a `settings.json` edit applies without a
   * restart. When omitted, `tasks.maxConcurrent` is read from settings.json
   * directly (default 12).
   */
  getMaxConcurrentTasks?: () => number
  /**
   * Per-provider task slots: `perProvider` is the default number of tasks one
   * provider (keyed by provider id) may run at the same time, `byProvider`
   * overrides it per provider id. `0` = unlimited. Further `user`/`agent`
   * tasks of a saturated provider wait in the queue; tasks of other
   * providers are not held up by them.
   *
   * Re-read on every decision like `getMaxConcurrentTasks`. When omitted,
   * `tasks.maxConcurrentPerProvider` (default 5) and
   * `tasks.maxConcurrentByProvider` are read from settings.json directly.
   */
  getProviderTaskLimits?: () => Pick<TaskConcurrencyLimits, 'perProvider' | 'byProvider'>
}

/** Concurrency-queue state of one task (see `TaskRunner.getQueueInfo`). */
export interface TaskQueueInfo {
  queued: boolean
  /** 1-based position in the overall waiting list, 0 when not waiting. */
  position: number
  /** Tasks occupying a slot, all providers. */
  running: number
  /** Tasks waiting for a slot, all providers. */
  queued_count: number
  /** Global cap (0 = unlimited). */
  limit: number
  /** Which limit keeps the task waiting (null when it is not waiting). */
  reason: QueueWaitReason | null
  /** Provider key the task's slot is counted against (null when unknown to the queue). */
  provider: string | null
  /** Tasks of that provider occupying a slot. */
  provider_running: number
  /** Slot limit of that provider (0 = unlimited). */
  provider_limit: number
}

/** Slot key of a task: the id of the provider it runs on. */
function providerKeyOf(provider: ProviderConfig | null | undefined): string {
  return normalizeProviderKey(provider?.id)
}

/**
 * Map a task trigger type to the session type stored in `sessions.type`.
 * - `triggerType='heartbeat'` -> `type='heartbeat'`
 * - `triggerType='consolidation'` -> `type='consolidation'`
 * - all other triggers (`user`, `agent`, `cronjob`) -> `type='task'`
 */
function triggerTypeToSessionType(triggerType: TaskTriggerType): SessionType {
  if (triggerType === 'heartbeat') return 'heartbeat'
  if (triggerType === 'consolidation') return 'consolidation'
  return 'task'
}

interface RunningTask {
  taskId: string
  agent: PiAgent
  /** Provider the task runs on (null on resume — provider not persisted in PausedTask). */
  provider?: ProviderConfig | null
  /**
   * Concurrency slot key: the provider the task was admitted with. Carried
   * through pause/resume so a resumed task re-occupies a slot of the same
   * provider; a model/provider fallback inside the run does not change it.
   */
  slotProviderKey: string
  abortController: AbortController
  timeoutTimer: ReturnType<typeof setTimeout> | null
  /**
   * W5/P0: fires at `heuristics.taskWrapUp.budgetFraction` of the budget and
   * steers one wrap-up message into the agent. Null when disabled or already
   * fired.
   */
  wrapUpTimer: ReturnType<typeof setTimeout> | null
  /** W5/P0: the wrap-up signal was delivered — send it at most once per task. */
  wrapUpSent: boolean
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
  toolCallCount: number
  toolCallTimers: Map<string, number>
  toolCallArgs: Map<string, unknown>
  /** Tracker for loop detection */
  toolCallTracker: ToolCallTracker
  /** Timer for periodic status updates */
  statusUpdateTimer: ReturnType<typeof setInterval> | null
  /** Timer for the periodic `progress` lifecycle frame (live tokens). */
  progressFrameTimer: ReturnType<typeof setInterval> | null
  /** When the task started running (for status update runtime calc) */
  startedAtMs: number
  /**
   * Budget-bounded model view of this agent's transcript (SPEC 11.3 for the
   * task loop). Belongs to the agent, so it survives pause/resume. Null only
   * for agents created before the compactor existed (defensive).
   */
  history: TranscriptCompactor | null
  /**
   * Cheap progress guards (tool-call cap, identical-call repetition, input
   * token budget). Fails the task with an honest message instead of letting
   * it burn tokens forever (token audit 2026-09-17, P5c).
   */
  progressGuard: TaskProgressGuard
  /**
   * Set by `handleGuardTripped` once a guard has finalized this task as
   * failed. Every post-run path checks it and returns without touching the
   * row again — a guarded task must never be overwritten by a "completed"
   * (or by a generic abort error) after the fact.
   */
  guardTripped: ProgressGuardTrip | null
  /**
   * Set by the paths that already finalized this task (abort / max duration /
   * loop detection / guard). pi-agent RESOLVES `prompt()` on an abort — it
   * records a `stopReason: 'aborted'` assistant message instead of throwing
   * — so without this flag the post-run path looks at an empty result and
   * overwrites the honest "Max duration exceeded" row with "Task produced no
   * output (0 tokens) — likely provider error". Same contract as
   * `guardTripped`: once set, no later path touches the row again.
   */
  aborted: boolean
}

/** Outcome of {@link TaskRunner.steerTask}. */
export interface TaskSteerResult {
  delivered: boolean
  /** `steered` = agent steering queue, `queued_prompt` = appended to the brief of a waiting task. */
  mode: 'steered' | 'queued_prompt' | 'none'
  reason?: string
}

interface PausedTask {
  taskId: string
  agent: PiAgent
  provider: ProviderConfig
  /** Slot key to re-occupy on resume (see `RunningTask.slotProviderKey`). */
  slotProviderKey: string
  pausedAt: number
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
  toolCallCount: number
  /** Carried across the pause with the agent it belongs to. */
  history: TranscriptCompactor | null
}

/**
 * Everything needed to start a task later, captured when it is put on the
 * concurrency queue. The DB row (status='running', startedAt NULL) is the
 * durable marker; this is only the in-memory continuation.
 */
interface PendingStart {
  task: Task
  provider: ProviderConfig
  overrides?: TaskOverrides
  parentSessionId?: string | null
}

/** `provider-a 2/5, provider-b 1/unlimited` — for the slot log lines. */
function formatProviderOccupancy(providers: Record<string, { running: number; queued: number; limit: number }>): string {
  const parts = Object.entries(providers).map(
    ([key, p]) => `${key} ${p.running}/${p.limit || 'unlimited'}${p.queued ? ` +${p.queued} queued` : ''}`,
  )
  return parts.length ? parts.join(', ') : 'no provider busy'
}

/** Interval for cleaning up stale paused tasks (1 hour) */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
/** Max time a task can remain paused before being cleaned up (24 hours) */
const MAX_PAUSE_DURATION_MS = 24 * 60 * 60 * 1000

function buildTaskSystemPrompt(
  taskPrompt: string,
  memoryDir?: string,
  configDir?: string,
  options: { budgetMinutes?: number | null } = {},
): string {
  const sections: string[] = []

  const workspaceDir = getWorkspaceDir()
  sections.push(`You are a background task agent. You are NOT a chatbot — you are an autonomous worker.

Your task: ${taskPrompt}

<workspace>
Your working directory is ${workspaceDir}. All shell commands execute in this directory by default.
All relative paths in read_file, write_file, and list_files resolve against this directory.
Use this directory for cloning repos, creating files, and all file operations.
Do NOT create working directories elsewhere (e.g. /tmp) — use ${workspaceDir} instead.
</workspace>`)

  const taskGuidelines = readTasksGuidelinesFile(configDir).trim()
  if (taskGuidelines.length > 0) {
    sections.push(`<task_guidelines>
${taskGuidelines}
</task_guidelines>`)
  }

  if (memoryDir) {
    sections.push(`<memory_reference>
Your memory files are located in: ${memoryDir}
You can read SOUL.md and MEMORY.md if you need context about the user's preferences or prior interactions.
</memory_reference>`)
  }

  // W5/P1: budget awareness + anti-reward-hacking. Deliberately short — it
  // competes for attention with everything else in this prompt.
  const budgetLine = options.budgetMinutes && options.budgetMinutes > 0
    ? `Time budget: ${options.budgetMinutes} minutes. Plan for it, and when a <time_budget_warning> arrives, stop starting new work and finish immediately.`
    : 'Time budget: limited. When a <time_budget_warning> arrives, stop starting new work and finish immediately.'
  sections.push(`<budget_and_honesty>
${budgetLine}
Never report a test, build, lint or check as green that you did not actually run, or that failed — quote the real command and its real result.
Never weaken, skip, delete or narrow tests (or checks) to make them pass; fix the cause or report the failure.
Partial success is reported as partial success. Do not present a smaller result as if it were the requested one.
If work stays unfinished, end your final message with a "HANDOFF:" section (goal, done, open, current error, exact next step) instead of implying success.
</budget_and_honesty>`)

  sections.push(`Your final message MUST follow this exact format:

STATUS: completed | failed | question | silent
SUMMARY:
<your complete, detailed results here — this is the ONLY thing the user will see, so include ALL data, analysis, findings, content, etc. Do NOT write a meta-description of what you did. Instead, write the actual output the user asked for.>

Use STATUS: question only when you are blocked and need the user to answer something specific before you can continue. In that case, the SUMMARY must contain exactly one concrete question plus the minimal context needed to answer it.
Do not ask multi-part questions. Ask only for the smallest missing piece required to continue.

Use STATUS: silent when there is genuinely nothing to report to the user (e.g. a periodic check found no changes). The task will be recorded as completed but NO message will be delivered to the user. Only use this when the prompt explicitly allows silent completion.

If you encounter an unrecoverable error, use STATUS: failed and explain what went wrong.`)

  return sections.join('\n\n')
}

/**
 * Extract the text content of the agent's most recent assistant message.
 */
function extractAgentResultText(agent: PiAgent): string {
  const lastAssistantMsg = getLastAssistantMessage(agent)

  if (!lastAssistantMsg || !('content' in lastAssistantMsg) || !Array.isArray(lastAssistantMsg.content)) {
    return ''
  }
  return lastAssistantMsg.content
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { type: string; text?: string }) => c.text ?? '')
    .join('')
}

/** Most recent assistant message in the agent's state, if any. */
function getLastAssistantMessage(agent: PiAgent): AssistantMessage | undefined {
  const messages = agent.state.messages
  return [...messages].reverse().find(
    (m) => 'role' in m && m.role === 'assistant'
  ) as AssistantMessage | undefined
}

/**
 * Detect a provider-level failure that pi-agent recorded as an assistant
 * message instead of throwing (Bug B, task aed6184a: a 400
 * `claude_code_version_too_old` died on the first model call, leaving 0
 * tokens and an empty body, yet the run "succeeded" and defaulted to
 * status='completed' with an empty summary).
 *
 * Three signals, any of which means the run produced no real result:
 *   1. the last assistant message carries `stopReason === 'error'` (pi-ai
 *      maps refusals / provider errors here and attaches the real
 *      `errorMessage`),
 *   2. the run yielded no assistant text AND consumed no completion tokens, or
 *   3. the run yielded no assistant text at all although it did produce
 *      tokens — the last turn was thinking-only or a bare stop. 2026-09-24:
 *      after pi-ai 0.87.1 the first transcript trim dropped the leading
 *      system message (prompt + tool declarations); every task then ended
 *      with a thinking-only turn and was recorded as an empty "completed".
 *      A final message without text is never a result.
 *
 * Returns the surfaced error message when a failure is detected, else null.
 * The `errorMessage` from the assistant message is preferred so the true
 * provider cause (e.g. the 400 body) reaches the injection instead of a
 * silent empty "completed".
 */
function detectAgentRunFailure(
  agent: PiAgent,
  resultText: string,
  completionTokens: number,
): string | null {
  const last = getLastAssistantMessage(agent)
  const stopReason = last && 'stopReason' in last ? last.stopReason : undefined
  const errorMessage = last && 'errorMessage' in last ? last.errorMessage : undefined

  if (stopReason === 'error') {
    return errorMessage || 'Provider returned an error with no message'
  }

  if (resultText.trim().length === 0 && completionTokens === 0) {
    return errorMessage || 'Task produced no output (0 tokens) — likely provider error'
  }

  if (resultText.trim().length === 0) {
    return errorMessage
      || `Task ended without a final message: the last turn had no text and no tool call (${completionTokens} output tokens). The model usually lost its prompt or its tools mid-run; check the transcript.`
  }

  return null
}

/**
 * Parse the task agent's final output to extract status and summary.
 * Returns the FULL content after the SUMMARY: marker (multi-line) so that
 * detailed results are preserved and forwarded to the main agent.
 */
function parseTaskOutput(text: string): { status: TaskResultStatus; summary: string } {
  const statusMatch = text.match(/STATUS:\s*(completed|failed|question|silent)/i)
  const status = (statusMatch?.[1]?.toLowerCase() as TaskResultStatus) ?? 'completed'

  // Capture everything after SUMMARY: to end of string (greedy, no m-flag)
  const summaryMatch = text.match(/SUMMARY:\s*([\s\S]*)$/i)
  if (summaryMatch) {
    const summary = summaryMatch[1].trim()
    if (summary.length > 0) {
      return { status, summary }
    }
  }

  // Fallback: use the full text with STATUS line stripped (no length cap)
  const fullText = text
    .replace(/STATUS:\s*(completed|failed|question)\s*/i, '')
    .replace(/SUMMARY:\s*/i, '')
    .trim()

  return { status, summary: fullText || text.trim() }
}

/**
 * Model, thinking level and routing reason of a task chosen by the task
 * policy, as extra `<task_injection>` attributes so the delegating agent sees
 * what the sub-task ran on. Empty for tasks without a routing record
 * (cronjob, heartbeat, legacy rows) — their injection stays byte-identical.
 */
function formatRoutingAttributes(task: Task): string {
  const routing = task.routing
  if (!routing) return ''
  const attr = (value: string) => value.replace(/[&"<>]/g, (ch) => `&#${ch.charCodeAt(0)};`)
  return ` model="${attr(task.model ?? routing.modelId)}" thinking="${attr(task.thinkingLevel ?? 'default')}" routing="${attr(formatTaskRouting(routing))}"`
}

/**
 * Format a task injection message for the main agent
 */
export function formatTaskInjection(task: Task, durationMinutes: number): string {
  return `<task_injection task_id="${task.id}" task_name="${task.name}" status="${task.resultStatus ?? task.status}" trigger="${task.triggerType}" duration_minutes="${durationMinutes}" tokens_used="${task.promptTokens + task.completionTokens}"${formatRoutingAttributes(task)}>
${task.resultSummary ?? task.errorMessage ?? 'Task completed without summary.'}
</task_injection>`
}

/**
 * Task Runner — spawns and manages isolated PiAgent instances for background tasks
 */
export class TaskRunner {
  private store: TaskStore
  private db: Database
  private runningTasks: Map<string, RunningTask> = new Map()
  private pausedTasks: Map<string, PausedTask> = new Map()
  private options: TaskRunnerOptions
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Task concurrency slots per provider plus a global cap, with a FIFO
   * waiting list (plans 2026-09-26 and 2026-10-01). A slot is counted against
   * the provider the task was admitted with (`provider.id`) and keeps that key
   * until it is released. Slots are taken in `startTask`/`resumeTask` and
   * released in
   * `cleanupRunningTask` — the single funnel every terminal path (completed,
   * failed, aborted, timeout, guard, pause) already goes through.
   */
  private queue: TaskConcurrencyQueue<PendingStart>
  /** Re-entrancy guard for `pumpQueue` (a start can release a slot again). */
  private pumping = false

  constructor(options: TaskRunnerOptions) {
    this.options = options
    this.db = options.db
    this.store = new TaskStore(options.db)
    this.queue = new TaskConcurrencyQueue<PendingStart>(() => this.resolveConcurrencyLimits())

    // Start periodic cleanup of stale paused tasks
    this.cleanupTimer = setInterval(() => this.cleanupStalePausedTasks(), CLEANUP_INTERVAL_MS)
  }

  /**
   * Limits for one queue decision: runner options win, everything else is
   * read live from settings.json (one read per decision).
   */
  private resolveConcurrencyLimits(): TaskConcurrencyLimits {
    const { getMaxConcurrentTasks, getProviderTaskLimits } = this.options
    const fromConfig = getMaxConcurrentTasks && getProviderTaskLimits ? null : readTaskConcurrencyLimitsFromConfig()
    const providerLimits = getProviderTaskLimits?.()
    return {
      global: getMaxConcurrentTasks?.() ?? fromConfig!.global,
      perProvider: providerLimits?.perProvider ?? fromConfig!.perProvider,
      byProvider: providerLimits ? (providerLimits.byProvider ?? {}) : fromConfig!.byProvider,
    }
  }

  /**
   * Resolve the thinking level for a new task / loop-detection call. Options
   * passed to the runner win; otherwise we re-read settings.json on every
   * start so that live settings updates take effect without a restart.
   */
  private resolveBackgroundThinkingLevel(): SettingsThinkingLevel {
    return this.options.backgroundThinkingLevel
      ?? readBackgroundThinkingLevelFromConfig()
      ?? 'off'
  }

  /**
   * Thinking level of ONE task (task policy, plan 2026-10-01). A level chosen
   * for the task at creation (`tasks.thinking_level`) wins; rows without one
   * (cronjob, heartbeat, consolidation, legacy rows, calls without a profile)
   * keep the background setting exactly as before. Used at start, recovery
   * (the resumed row carries the column) and by the verifier.
   */
  private resolveTaskThinkingLevel(task: Pick<Task, 'thinkingLevel'> | null | undefined): SettingsThinkingLevel {
    return task?.thinkingLevel ?? this.resolveBackgroundThinkingLevel()
  }

  /**
   * Get the task store
   */
  getStore(): TaskStore {
    return this.store
  }

  /**
   * The execution context bound around every agent run of a task (initial
   * run, revision round, schema correction, resume). Built in one place so
   * all four answer "whose task is this and where does its output go?"
   * identically.
   */
  private taskExecutionContext(taskId: string, provider: ProviderConfig | null): TaskExecutionContext {
    const task = this.store.getById(taskId)
    let origin: TaskOrigin | null = null
    if (task && this.options.resolveTaskOrigin) {
      try {
        origin = this.options.resolveTaskOrigin(task)
      } catch (err) {
        console.warn(`[task-runner] Could not resolve the origin of task ${taskId}:`, (err as Error).message)
      }
    }
    return {
      provider,
      agentId: task?.agentId ?? null,
      taskId,
      userId: origin?.userId ?? null,
      sessionId: origin?.sessionId ?? null,
    }
  }

  /**
   * Ensure the task has a session ID registered in the `sessions` table.
   * If the task already has a sessionId, it's used as-is. Otherwise a new
   * session is created via SessionManager with the correct `type` derived
   * from `task.triggerType` and the provided `parentSessionId`.
   * The resulting sessionId is persisted on the task row.
   */
  private ensureTaskSession(task: Task, parentSessionId?: string | null): string {
    if (task.sessionId) return task.sessionId

    const sessionType = triggerTypeToSessionType(task.triggerType)
    const session = this.options.sessionManager.createSession({
      type: sessionType,
      source: 'system',
      parentSessionId: parentSessionId ?? undefined,
      // Label the task session with the owning persona so downstream
      // agent-scoped reads (chat history, consolidation) attribute the
      // task's messages to the right agent instead of 'main'.
      agentId: task.agentId ?? 'main',
    })
    const sessionId = session.id
    inheritEcoMode(this.db, parentSessionId, sessionId)

    this.store.update(task.id, { sessionId })
    task.sessionId = sessionId
    return sessionId
  }

  /**
   * Build the transcript compactor for one task agent.
   *
   * Budget, hysteresis target and index size come from `heuristics.taskHistory`
   * (SPEC 12.1), read once per task start so a settings change applies to new
   * tasks without a restart. Every trim is logged to `tool_calls` as
   * `task_history` — the same place the interactive path logs `strand_context`.
   */
  private createHistoryCompactor(taskId: string): TranscriptCompactor {
    const h = loadHeuristics().taskHistory
    return new TranscriptCompactor({
      windowTokens: h.windowTokens,
      targetTokens: h.targetTokens,
      indexLines: h.indexLines,
      onTrim: (event) => {
        const sessionId = this.store.getById(taskId)?.sessionId
        console.log(
          `[task-runner] Trimmed the context window of task ${taskId}: ` +
          `${event.droppedNow} messages hidden (${event.droppedTotal} total), ` +
          `${event.tokensBefore} → ${event.tokensAfter} tokens`,
        )
        if (!sessionId) return
        try {
          logToolCall(this.db, {
            sessionId,
            toolName: 'task_history',
            input: JSON.stringify({ budgetTokens: h.windowTokens, targetTokens: h.targetTokens }),
            output: JSON.stringify(event),
            durationMs: 0,
            status: 'success',
          })
        } catch {
          // Metrics are best effort — never fail a task over a log row.
        }
      },
    })
  }

  /**
   * Start a new task, or queue it when the global concurrency limit
   * (`tasks.maxConcurrent`) is already reached.
   *
   * CONTRACT: resolving does NOT mean the agent is running. A `user`/`agent`
   * task may be admitted to the FIFO queue instead; it then stays at
   * `status='running'` with `startedAt = NULL` (the queued marker) and is
   * started automatically by `pumpQueue` once a slot frees up. Callers that
   * need to know must ask `isQueued(taskId)` / `getQueueInfo(taskId)` — they
   * must not assume `isRunning(taskId)` right after the call.
   *
   * `cronjob`, `heartbeat` and `consolidation` triggers bypass the wait (they
   * do occupy a slot). `parentSessionId`, if provided, links the task's
   * session to the user's interactive session (or another parent session)
   * via `sessions.parent_session_id`.
   */
  async startTask(
    task: Task,
    provider: ProviderConfig,
    overrides?: TaskOverrides,
    parentSessionId?: string | null,
  ): Promise<string> {
    return this.admitTask(task, provider, overrides, parentSessionId, false)
  }

  /**
   * Shared admission logic of `startTask` and `recoverTasks`.
   * `forceQueue` makes even bypassing trigger types wait — used by recovery,
   * where nothing is time-critical and starting everything at once is exactly
   * the failure mode this queue exists for (E6).
   */
  private async admitTask(
    task: Task,
    provider: ProviderConfig,
    overrides: TaskOverrides | undefined,
    parentSessionId: string | null | undefined,
    forceQueue: boolean,
  ): Promise<string> {
    const taskId = task.id
    // The provider the caller resolved (task pin, persona, role or
    // tasks.defaultProvider) is the slot key. A missing id lands in the
    // shared `unknown` bucket instead of failing the start.
    const providerKey = providerKeyOf(provider)

    if (!forceQueue && !queueAppliesToTrigger(task.triggerType)) {
      // Bypass: counts towards its provider and the global cap, never waits.
      this.queue.occupy(taskId, providerKey)
      return this.startTaskNow(task, provider, overrides, parentSessionId)
    }

    // Let older waiters use capacity that appeared without a release (a limit
    // raised in settings.json) before the newcomer is judged.
    this.pumpQueue()

    const admission = this.queue.admit(taskId, { task, provider, overrides, parentSessionId }, providerKey)
    if (!admission.admitted) {
      console.log(
        `[task-runner] Queued task ${taskId} ("${task.name}") at position ${admission.position} — `
        + `waiting for the ${admission.reason} limit; provider ${admission.providerKey}: `
        + `${admission.providerRunning}/${admission.providerLimit || 'unlimited'} running, `
        + `all providers: ${admission.running}/${this.queue.limit() || 'unlimited'} running`,
      )
      return taskId
    }

    return this.startTaskNow(task, provider, overrides, parentSessionId)
  }

  /**
   * Really start a task: the slot is already taken by the caller
   * (`startTask` or `pumpQueue`). Every error path in here releases it.
   */
  private async startTaskNow(
    task: Task,
    provider: ProviderConfig,
    overrides?: TaskOverrides,
    parentSessionId?: string | null,
  ): Promise<string> {
    const taskId = task.id

    try {
      // Inside the try on purpose: the caller already holds a slot, and only
      // the catch below releases it. A throw before the try leaked the slot.
      this.validateStatusUpdatesConfig()
      const sessionId = this.ensureTaskSession(task, parentSessionId)

      // Pre-resolve once so broken credentials still fail before the task starts.
      const model = this.options.buildModel(provider)
      const initialApiKey = await this.options.getApiKey(provider)

      // Determine effective system prompt
      const baseSystemPrompt = overrides?.systemPromptOverride
        ? overrides.systemPromptOverride
        // RC5 (multi-persona bleeding): persona tasks get THEIR memory root
        // in <memory_reference>, not main's — otherwise the task LLM reads
        // (and is pointed at) main's SOUL.md/MEMORY.md.
        : buildTaskSystemPrompt(
            task.prompt,
            resolveAgentMemoryDir(task.agentId, { fallbackMemoryDir: this.options.memoryDir }),
            undefined,
            { budgetMinutes: this.resolveBudgetMinutes(task) },
          )

      // Inject attached-skills block (before the base prompt) so skill rules are
      // anchored at the top and apply regardless of the rest of the prompt.
      const attachedSkillsBlock = renderAttachedSkillsBlock(overrides?.attachedSkills ?? null)
      const withSkills = attachedSkillsBlock
        ? `${attachedSkillsBlock}\n\n${baseSystemPrompt}`
        : baseSystemPrompt
      // Output contract (SPEC 11.6): the schema is stated at the end so it
      // sits next to the STATUS/SUMMARY format it constrains.
      const systemPromptRaw = task.outputSchema
        ? `${withSkills}\n\n${buildOutputSchemaInstruction(task.outputSchema)}`
        : withSkills
      // Privacy (plan 2026-09-26, F2 of the review triage 19:25): the task
      // system prompt carries the task prompt, the attached SKILL.md files and
      // the persona memory reference. It never passed a boundary — pi-agent
      // keeps the system prompt out of the message list, so `redactMessages`
      // in the context transform does not see it. `sealSystemText` is the same
      // strong-tier + known-value seal the interactive system prompt uses and
      // is deterministic, so the prompt prefix cache stays stable.
      const systemPrompt = sealSystemText(systemPromptRaw, 'task')

      // Determine effective tools (filter out disabled tools).
      // Privacy (plan 2026-09-26, step 3): the task agent gets the same
      // secret boundary as the interactive runtime — tool results and error
      // texts are sealed, only `shell` resolves handles (D5).
      let effectiveTools = withSecretBoundary(this.options.tools)
      if (overrides?.toolsOverride) {
        try {
          const disabledTools: string[] = JSON.parse(overrides.toolsOverride)
          if (Array.isArray(disabledTools) && disabledTools.length > 0) {
            effectiveTools = effectiveTools.filter(t => !disabledTools.includes(t.name))
          }
        } catch {
          // Invalid JSON — use all tools
        }
      }

      // Create isolated PiAgent
      const resolveApiKey = async (): Promise<string> => {
        try {
          const fresh = this.options.getProviderById?.(provider.id) ?? provider
          return await this.options.getApiKey(fresh)
        } catch (err) {
          console.error(`[task-runner] Failed to refresh API key for task ${taskId}:`, err)
          return initialApiKey
        }
      }

      // Verlaufskompression (token audit 2026-09-17, §3.2): the task loop used
      // to resend the whole transcript on every LLM call. `transformContext`
      // is a pure view — `agent.state.messages` keeps everything, so result
      // extraction, verifier and schema correction are unaffected.
      const history = this.createHistoryCompactor(taskId)

      const ecoGate = new EcoRequestGate()
      const agent = new PiAgent({
        initialState: {
          systemPrompt,
          model,
          tools: effectiveTools,
          thinkingLevel: this.resolveTaskThinkingLevel(task),
        },
        // The task session id is stable for the whole run — hand it to the
        // provider so a per-session prompt cache keeps hitting across the
        // hundreds of tool-loop calls a task makes.
        // Eco (B1): the limits the pre-send view budgeted are applied to the
        // same request (options.maxTokens + effective window).
        streamFn: buildStreamFn(provider, undefined, {
          getSessionId: () => sessionId,
          ecoGate,
          readEcoMode: sid => readStrandEcoMode(this.db, sid),
        }),
        // Fail open: a bug in the compaction must never kill a running task,
        // it may only cost tokens.
        transformContext: async (messages) => {
          let view: AgentMessage[]
          try {
            view = history.compact(messages)
          } catch (err) {
            console.error(`[task-runner] Context compaction failed for task ${taskId}, sending the full transcript:`, err)
            view = [...messages]
          }
          // Eco (opt-in per task session, inherited from the spawning strand):
          // the SAME stage as the interactive runtime, on top of the existing
          // compactor — one policy path, budgeted before every request.
          view = applyEcoRequestView({
            db: this.db,
            sessionId,
            messages: view,
            transcript: messages,
            model,
            systemPrompt: agent.state.systemPrompt,
            tools: agent.state.tools,
            gate: ecoGate,
          })
          // Privacy (plan 2026-09-26, step 4): last net before the request
          // leaves the process. Fail open — redaction must never kill a task.
          try {
            return redactMessages(view)
          } catch (err) {
            console.error(`[task-runner] redactKnown failed on the outgoing context of task ${taskId}:`, err)
            return view
          }
        },
        ...(provider.transport && provider.transport !== 'sse'
          && { transport: provider.transport }),
        getApiKey: resolveApiKey,
      })

      const abortController = new AbortController()

      const runningTask: RunningTask = {
        taskId,
        agent,
        provider,
        slotProviderKey: providerKeyOf(provider),
        abortController,
        timeoutTimer: null,
        wrapUpTimer: null,
        wrapUpSent: false,
        promptTokens: 0,
        completionTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        estimatedCost: 0,
        toolCallCount: 0,
        toolCallTimers: new Map(),
        toolCallArgs: new Map(),
        toolCallTracker: new ToolCallTracker(),
        statusUpdateTimer: null,
        progressFrameTimer: null,
        startedAtMs: Date.now(),
        history,
        // Limits are read once per task start, like taskHistory above, so a
        // settings edit applies to new tasks without a restart.
        progressGuard: new TaskProgressGuard(loadHeuristics().taskGuard),
        guardTripped: null,
        aborted: false,
      }

      this.runningTasks.set(taskId, runningTask)

      // Set up max duration timeout
      this.scheduleMaxDurationTimeout(runningTask, task)
      // If already past the deadline, scheduleMaxDurationTimeout aborted the
      // task synchronously — bail out before subscribing/running anything.
      if (!this.runningTasks.has(taskId)) {
        return taskId
      }

      // Set up periodic status updates
      this.startStatusUpdateTimer(runningTask, task)
      // …and the (always-on, cheap) live progress frame.
      this.startProgressFrameTimer(runningTask)

      // Update task as started
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      this.store.update(taskId, {
        startedAt: now,
        provider: provider.name,
        model: getProviderDefaultModel(provider),
      })

      // Subscribe to agent events for token/tool tracking
      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        this.handleTaskEvent(runningTask, event, sessionId, model)
      })

      // Run the task asynchronously
      this.runTaskAsync(runningTask, unsubscribe, sessionId)

      // Announce the start AFTER the row carries startedAt/session, so the
      // frame the UI receives matches what the catch-up endpoint would return.
      this.emitLifecycle('started', taskId)

      return taskId
    } catch (err) {
      // Startup failed before `runTaskAsync` could take over error handling
      // (e.g. invalid provider config, missing API key, model build error).
      // Without this, the task row stays stuck at status='running' forever
      // and cannot be killed from the UI (abortTask silently no-ops for
      // tasks not in the runningTasks Map).
      const errorMessage = err instanceof Error ? err.message : String(err)
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      try {
        this.store.update(taskId, {
          status: 'failed',
          resultStatus: 'failed',
          resultSummary: `Task failed to start: ${errorMessage}`,
          errorMessage,
          completedAt: now,
        })
      } catch (updateErr) {
        console.error(`[task-runner] Failed to mark task ${taskId} as failed after start error:`, updateErr)
      }
      // Clean up any partial state that may have been registered before the throw.
      this.cleanupRunningTask(taskId)
      // A startup error is a terminal path too: without this explicit release
      // the slot would leak whenever the throw happened before the task was
      // registered in `runningTasks` (cleanupRunningTask no-ops then), and
      // every future task would queue behind a ghost.
      this.releaseSlot(taskId, 'start error')
      throw err
    }
  }

  /**
   * Release the slot of a task that stopped occupying one and let the next
   * queued task in. Idempotent — safe to call from any terminal path.
   */
  private releaseSlot(taskId: string, reason: string): void {
    const held = this.queue.release(taskId)
    if (held) {
      const snapshot = this.queue.snapshot()
      console.log(
        `[task-runner] Released the slot of task ${taskId} (${reason}) — `
        + `${snapshot.running} running, ${snapshot.queued} queued, global limit ${snapshot.limit}`
        + ` (${formatProviderOccupancy(snapshot.providers)})`,
      )
    }
    this.pumpQueue()
  }

  /**
   * Start as many queued tasks as the current limits allow. Called after every
   * slot release; the limits are re-read inside `takeNext`, so changing them
   * in settings.json applies from the next dequeue on. `takeNext` skips
   * waiters of saturated providers, so one busy provider never holds up the
   * others.
   */
  private pumpQueue(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        const next = this.queue.takeNext()
        if (!next) return
        const { task, provider, overrides, parentSessionId } = next.payload

        // The row is the source of truth: an abort while the task waited
        // finalizes it (E7), and such a task must never start later.
        const row = this.store.getById(task.id)
        if (!row || row.status !== 'running') {
          console.log(`[task-runner] Skipping queued task ${task.id}: no longer runnable (status ${row?.status ?? 'missing'})`)
          this.queue.release(task.id)
          continue
        }

        const waitedSeconds = Math.round((Date.now() - next.enqueuedAtMs) / 1000)
        const snapshot = this.queue.snapshot()
        console.log(
          `[task-runner] Dequeued task ${task.id} ("${task.name}", provider ${next.providerKey}) after ${waitedSeconds}s — `
          + `${snapshot.running} running, ${snapshot.queued} still queued, global limit ${snapshot.limit}`,
        )

        // Start with the freshest row so the time budget is anchored on the
        // real start (the queued row carries startedAt = NULL).
        void this.startTaskNow(row, provider, overrides, parentSessionId).catch((err) => {
          // startTaskNow already finalized the row and released the slot.
          console.error(`[task-runner] Queued task ${task.id} failed to start:`, err)
        })
      }
    } finally {
      this.pumping = false
    }
  }

  /**
   * Independent reviewer pass over a "completed" task result, with at most
   * ONE revision round. Only for user/agent/cronjob tasks (heartbeat and
   * consolidation are internal plumbing). Fails open — any reviewer error
   * delivers the original result unchanged (returns null = keep original).
   */
  private async maybeVerifyAndRevise(
    taskId: string,
    agent: PiAgent,
    resultText: string,
    taskProvider: ProviderConfig | null,
  ): Promise<{ status: TaskResultStatus; summary: string } | null> {
    const cfg = this.options.verification
    // Default ON in production; default OFF under vitest so completion tests
    // don't fire real reviewer HTTP calls (suites opt in via explicit cfg).
    const enabled = cfg?.enabled ?? !process.env.VITEST
    if (!enabled) return null

    const task = this.store.getById(taskId)
    if (!task) return null
    if (!['user', 'agent', 'cronjob'].includes(task.triggerType)) return null

    try {
      const dedicatedReviewer = cfg?.providerId ? this.options.getProviderById?.(cfg.providerId) ?? null : null
      const reviewerProvider = dedicatedReviewer ?? taskProvider
      if (!reviewerProvider) return null

      const model = this.options.buildModel(reviewerProvider)
      const apiKey = await this.options.getApiKey(reviewerProvider)

      const promptExcerpt = task.prompt.length > 4000 ? `${task.prompt.slice(0, 4000)}…` : task.prompt
      const resultExcerpt = resultText.length > 6000 ? `${resultText.slice(0, 6000)}…` : resultText

      const response = await withTimeout(completeSimple(model, {
        systemPrompt:
          'You are a strict reviewer for results of autonomous background tasks. ' +
          'Judge ONLY whether the reported result actually fulfills the task: are the claims concrete and backed by the described work, is anything essential missing, does it answer what was asked? ' +
          'Minor style issues are NOT a fail. Respond in exactly this format:\n' +
          'VERDICT: pass|fail\nCRITIQUE: <if fail: the specific, actionable gaps to fix — max 5 bullet points. If pass: "-">',
        messages: [{
          role: 'user' as const,
          content: `<task>\n${promptExcerpt}\n</task>\n\n<reported_result>\n${resultExcerpt}\n</reported_result>`,
          timestamp: Date.now(),
        }],
      }, {
        apiKey,
        temperature: 0,
        // When the reviewer runs on the task's own provider/model it judges
        // with the task's thinking level (task policy). A dedicated reviewer
        // provider is a different model: it keeps the background setting, as
        // do tasks without a level of their own.
        reasoning: task.thinkingLevel && !dedicatedReviewer
          ? toPiAiReasoning(task.thinkingLevel)
          : resolveBackgroundReasoning(),
      }), 120_000, 'Task result verification')

      const verdictText = response.content
        .filter((item) => item.type === 'text')
        .map((item) => (item as { type: 'text'; text: string }).text)
        .join('')
      const failed = /VERDICT:\s*fail/i.test(verdictText)
      if (!failed) return null

      const critique = (verdictText.match(/CRITIQUE:\s*([\s\S]*)$/i)?.[1] ?? '').trim().slice(0, 2000)
      if (!critique || critique === '-') return null

      console.log(`[task-runner] Verifier requested revision for task ${taskId}`)
      this.emitStatusChange(taskId, 'running', 'Result verification requested improvements — running one revision round')

      // Bounded like every other plumbing call: a revision round whose
      // completion never settles must not zombify the task (fail-open keeps
      // the original result via the outer catch).
      try {
        // The revision round can itself call create_task — keep the task
        // execution context bound so sub-tasks spawned here still inherit
        // this task's provider/persona (same contract as runTaskAsync).
        await withTimeout(runWithTaskExecutionContext(
          this.taskExecutionContext(taskId, taskProvider),
          () => agent.prompt(
            'An independent reviewer checked your reported result against the original task and found gaps:\n\n' +
            `${critique}\n\n` +
            'Address these points (do additional work with your tools if needed), then report your final result again in the required STATUS/SUMMARY format.'
          ),
        ), 600_000, 'Task revision round')
      } catch (err) {
        try {
          agent.abort()
        } catch {
          // best effort — revision agent is abandoned either way
        }
        throw err
      }

      const revisedText = extractAgentResultText(agent)
      const parsed = parseTaskOutput(revisedText)
      // A revision must not silently downgrade to question/silent mid-flight;
      // only accept completed/failed outcomes, else keep the original.
      if (parsed.status === 'completed' || parsed.status === 'failed') {
        return parsed
      }
      return null
    } catch (err) {
      console.warn(`[task-runner] Result verification skipped (fail-open) for ${taskId}:`, (err as Error).message)
      return null
    }
  }

  /**
   * `output_schema` enforcement (SPEC 11.6). Returns null when the task has
   * no schema or the SUMMARY already satisfies it. Otherwise one correction
   * turn with the errors verbatim; a SUMMARY that still fails turns the
   * task into `failed` with the errors as the message. Never throws.
   */
  private async enforceOutputSchema(
    taskId: string,
    agent: PiAgent,
    summary: string,
    taskProvider: ProviderConfig | null,
  ): Promise<{ status: TaskResultStatus; summary: string } | null> {
    const task = this.store.getById(taskId)
    if (!task?.outputSchema) return null
    const parsedSchema = parseOutputSchema(task.outputSchema)
    if (!parsedSchema.ok) {
      console.warn(`[task-runner] Stored output_schema of task ${taskId} is unusable (${parsedSchema.error}); accepting result`)
      return null
    }

    const first = checkOutputAgainstSchema(parsedSchema.schema, summary)
    if (first.ok) return null

    console.log(`[task-runner] output_schema violated by task ${taskId}: ${first.errors.join('; ')}. Running the one correction turn`)
    this.emitStatusChange(taskId, 'running', `Result does not match output_schema (${first.errors.length} error${first.errors.length === 1 ? '' : 's'}), one correction round`)

    try {
      await withTimeout(runWithTaskExecutionContext(
        this.taskExecutionContext(taskId, taskProvider),
        () => agent.prompt(buildSchemaCorrectionPrompt(parsedSchema.serialized, first.errors)),
      ), 600_000, 'Task output_schema correction')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { status: 'failed', summary: `output_schema correction turn failed: ${message}\n\nValidation errors:\n${first.errors.map(e => `- ${e}`).join('\n')}` }
    }

    const corrected = parseTaskOutput(extractAgentResultText(agent))
    if (corrected.status !== 'completed') {
      return { status: 'failed', summary: `output_schema not satisfied after the correction turn (task reported ${corrected.status}).\n\nValidation errors:\n${first.errors.map(e => `- ${e}`).join('\n')}` }
    }
    const second = checkOutputAgainstSchema(parsedSchema.schema, corrected.summary)
    if (second.ok) return { status: 'completed', summary: corrected.summary }
    return {
      status: 'failed',
      summary: `output_schema not satisfied after the correction turn.\n\nValidation errors:\n${second.errors.map(e => `- ${e}`).join('\n')}\n\nLast SUMMARY:\n${corrected.summary.slice(0, 4000)}`,
    }
  }

  /**
   * Finalize a task as FAILED with the given provider error message.
   *
   * Shared by both the initial and resume completion paths for Bug B: when a
   * run produced no usable result (provider error stored as an assistant
   * message, or empty output with 0 tokens), we record a real failure with
   * the true cause instead of an empty "completed". Assumes the caller has
   * already unsubscribed and torn down the running-task entry, mirroring the
   * surrounding completion code.
   *
   * `formatTaskInjection` falls back to `errorMessage` for the injection body
   * when `resultSummary` is unset, so the surfaced error reaches the main
   * agent; we set both to be explicit and robust.
   */
  private finalizeTaskFailure(taskId: string, runningTask: RunningTask, errorMessage: string): void {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    const updatedTask = this.store.update(taskId, {
      status: 'failed',
      resultStatus: 'failed',
      resultSummary: `Task failed: ${errorMessage}`,
      errorMessage,
      completedAt: now,
      promptTokens: runningTask.promptTokens,
      completionTokens: runningTask.completionTokens,
      cacheRead: runningTask.cacheRead,
      cacheWrite: runningTask.cacheWrite,
      estimatedCost: runningTask.estimatedCost,
      toolCallCount: runningTask.toolCallCount,
    })

    // W5/P2: a run that died on a provider/run failure always leaves work behind.
    this.persistHandoff(taskId, 'error', { errorMessage })

    if (updatedTask) {
      const task = this.store.getById(taskId)!
      const startedAt = taskStartedAtMs(task.startedAt)
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      const injection = formatTaskInjection(task, durationMinutes)
      this.notifyTaskComplete(taskId, injection, 'failed', errorMessage, task.agentId)
    }
  }

  /**
   * Run the task agent asynchronously
   */
  private async runTaskAsync(
    runningTask: RunningTask,
    unsubscribe: () => void,
    _sessionId: string,
  ): Promise<void> {
    const { taskId, agent } = runningTask

    try {
      // Bind the per-task execution context for the whole agent run so any
      // create_task the task issues (sub-task / sub-sub-task) can inherit THIS
      // task's model when it does not pin one explicitly. AsyncLocalStorage
      // keeps concurrent tasks isolated from each other's provider.
      // Prompt the task agent with the task — the system prompt already contains the full task description
      await runWithTaskExecutionContext(
        this.taskExecutionContext(taskId, runningTask.provider ?? null),
        () => agent.prompt('Begin working on the task described in your system prompt. Work autonomously and report your results when done.'),
      )

      // Task completed successfully
      unsubscribe()
      this.cleanupRunningTask(taskId)

      // A progress guard already failed this task (P5c) — whatever the agent
      // returned after the abort must not overwrite that verdict.
      if (runningTask.guardTripped) return
      // Same for an abort (max duration, user kill, loop detection): the row
      // already carries the true reason and its handoff.
      if (runningTask.aborted) return

      // Extract result from agent messages
      const resultText = extractAgentResultText(agent)

      // Bug B: a provider error that pi-agent stored as an assistant message
      // (stopReason 'error') or a run that produced no text and burned 0
      // completion tokens must be surfaced as a FAILURE with the real cause,
      // not defaulted to an empty "completed" by parseTaskOutput('').
      const runFailure = detectAgentRunFailure(agent, resultText, runningTask.completionTokens)
      if (runFailure) {
        this.finalizeTaskFailure(taskId, runningTask, runFailure)
        return
      }

      let { status, summary } = parseTaskOutput(resultText)

      // Verifier pass: independent review of a "completed" result before it
      // reaches the user; one revision round on a failed verdict. Skip it on
      // an empty result — reviewing nothing just burns a pointless round.
      if (status === 'completed' && resultText.trim().length > 0) {
        const revised = await this.maybeVerifyAndRevise(taskId, agent, resultText, runningTask.provider ?? null)
        if (revised) {
          status = revised.status
          summary = revised.summary
        }
      }

      // Output contract (SPEC 11.6): validate, one correction turn, then accept or fail.
      if (status === 'completed') {
        const enforced = await this.enforceOutputSchema(taskId, agent, summary, runningTask.provider ?? null)
        if (enforced) {
          status = enforced.status
          summary = enforced.summary
        }
      }

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

      // Handle "question" status — pause the task instead of completing
      if (status === 'question') {
        // Clear every timer but keep the agent in memory. This used to clear
        // only the timeout and drop the map entry by hand, which left the
        // status-update interval (and now the progress-frame interval)
        // running for a task that no longer runs.
        this.cleanupRunningTask(taskId)

        // Store as paused task
        const pausedTask: PausedTask = {
          taskId,
          agent: runningTask.agent,
          provider: {} as ProviderConfig, // provider info already saved in DB
          slotProviderKey: runningTask.slotProviderKey,
          pausedAt: Date.now(),
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          cacheRead: runningTask.cacheRead,
          cacheWrite: runningTask.cacheWrite,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
          history: runningTask.history,
        }
        this.pausedTasks.set(taskId, pausedTask)

        this.store.update(taskId, {
          status: 'paused',
          resultStatus: 'question',
          resultSummary: summary,
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          cacheRead: runningTask.cacheRead,
          cacheWrite: runningTask.cacheWrite,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
        })

        // Notify via injection with question status
        const task = this.store.getById(taskId)!
        const startedAt = taskStartedAtMs(task.startedAt)
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(task, durationMinutes)
        this.notifyTaskPaused(taskId, injection, summary, task.agentId)
        unsubscribe()
        return
      }

      // Handle "silent" status — record as completed but skip injection/notification
      if (status === 'silent') {
        this.store.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: summary || 'Nothing to report.',
          completedAt: now,
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          cacheRead: runningTask.cacheRead,
          cacheWrite: runningTask.cacheWrite,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
        })
        // Emit status change event (for task event bus) but skip injection
        this.emitStatusChange(taskId, 'completed', 'Silent completion — nothing to report')
        return
      }

      const updatedTask = this.store.update(taskId, {
        status: status === 'failed' ? 'failed' : 'completed',
        resultStatus: status,
        resultSummary: summary,
        completedAt: now,
        promptTokens: runningTask.promptTokens,
        completionTokens: runningTask.completionTokens,
        cacheRead: runningTask.cacheRead,
        cacheWrite: runningTask.cacheWrite,
        estimatedCost: runningTask.estimatedCost,
        toolCallCount: runningTask.toolCallCount,
      })

      // W5/P2: persist the handoff when this run did not finish the job —
      // an honest `failed`, or a `completed` that was written under the
      // wrap-up signal and still names open work.
      if (status === 'failed') {
        this.persistHandoff(taskId, 'reported_failed', { summary })
      } else if (runningTask.wrapUpSent && extractHandoffSection(summary)) {
        this.persistHandoff(taskId, 'wrap_up', { summary })
      }

      if (updatedTask) {
        const task = this.store.getById(taskId)!
        const startedAt = taskStartedAtMs(task.startedAt)
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(task, durationMinutes)
        this.notifyTaskComplete(taskId, injection, task.status, task.resultSummary ?? undefined, task.agentId)
      }
    } catch (err) {
      // Task failed
      unsubscribe()
      this.cleanupRunningTask(taskId)

      // Guarded tasks are already finalized with the guard's message; the
      // abort error that follows is noise.
      if (runningTask.guardTripped) return
      if (runningTask.aborted) return

      const errorMessage = err instanceof Error ? err.message : String(err)
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

      const updatedTask = this.store.update(taskId, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: `Task failed with error: ${errorMessage}`,
        errorMessage,
        completedAt: now,
        promptTokens: runningTask.promptTokens,
        completionTokens: runningTask.completionTokens,
        cacheRead: runningTask.cacheRead,
        cacheWrite: runningTask.cacheWrite,
        estimatedCost: runningTask.estimatedCost,
        toolCallCount: runningTask.toolCallCount,
      })

      this.persistHandoff(taskId, 'error', { errorMessage })

      if (updatedTask) {
        const task = this.store.getById(taskId)!
        const startedAt = taskStartedAtMs(task.startedAt)
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(task, durationMinutes)
        this.notifyTaskComplete(taskId, injection, "failed", errorMessage, task.agentId)
      }
    }
  }

  /**
   * Handle events from a task agent (token tracking, tool call logging)
   */
  private handleTaskEvent(
    runningTask: RunningTask,
    event: AgentEvent,
    sessionId: string,
    model: Model<Api>,
  ): void {
    // A progress guard already finalized this task (P5c). The agent may still
    // flush a few in-flight events while it aborts — they must not rewrite the
    // finished row's counters or append to a session that is done.
    if (runningTask.guardTripped) return

    switch (event.type) {
      case 'message_update': {
        // Emit text deltas to task event bus
        const assistantEvent = event.assistantMessageEvent
        if (assistantEvent.type === 'text_delta') {
          this.options.taskEventBus?.emitTaskEvent({
            type: 'text_delta',
            taskId: runningTask.taskId,
            timestamp: new Date().toISOString(),
            text: assistantEvent.delta,
          })
        }
        break
      }

      case 'message_end': {
        const msg = event.message as Message
        if ('role' in msg && msg.role === 'assistant') {
          const assistantMsg = msg as AssistantMessage
          const cost = estimateCost(
            model,
            assistantMsg.usage.input,
            assistantMsg.usage.output,
            assistantMsg.usage.cacheRead,
            assistantMsg.usage.cacheWrite,
          )
          const finalCost = assistantMsg.usage.cost.total > 0
            ? assistantMsg.usage.cost.total
            : cost

          runningTask.promptTokens += assistantMsg.usage.input
          runningTask.completionTokens += assistantMsg.usage.output
          runningTask.cacheRead += assistantMsg.usage.cacheRead
          runningTask.cacheWrite += assistantMsg.usage.cacheWrite
          runningTask.estimatedCost += finalCost

          this.persistLiveMetrics(runningTask)

          // Progress guard: the input side of this response (what the
          // provider bills as input) counts against the task token budget.
          if (this.checkProgressGuard(runningTask, (guard) => guard.recordUsage(
            assistantMsg.usage.input + assistantMsg.usage.cacheRead + assistantMsg.usage.cacheWrite,
          ))) {
            break
          }

          // Log to token_usage table with task's session_id
          logTokenUsage(this.db, {
            provider: assistantMsg.provider,
            model: assistantMsg.model,
            promptTokens: assistantMsg.usage.input,
            completionTokens: assistantMsg.usage.output,
            cacheRead: assistantMsg.usage.cacheRead,
            cacheWrite: assistantMsg.usage.cacheWrite,
            estimatedCost: finalCost,
            sessionId,
          })

          // Persist assistant text and thinking to chat_messages for the task viewer
          const textParts = assistantMsg.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map(c => c.text)
          const thinkingParts = assistantMsg.content
            .filter((c): c is { type: 'thinking'; thinking: string } => c.type === 'thinking')
            .map(c => c.thinking)

          if (textParts.length > 0 || thinkingParts.length > 0) {
            const content = textParts.join('\n')
            const metadata = JSON.stringify({
              type: 'assistant_message',
              thinking: thinkingParts.length > 0 ? thinkingParts.join('\n') : undefined,
              provider: assistantMsg.provider,
              model: assistantMsg.model,
            })
            try {
              const taskAgentId = this.store.getById(runningTask.taskId)?.agentId ?? 'main'
              const inserted = this.db.prepare(
                'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
              ).run(sessionId, null, 'assistant', content, metadata, taskAgentId)
              // Keep the row id next to the transcript message so a later
              // digest line stays reloadable with recall_message.
              runningTask.history?.noteMessageId(assistantMsg as unknown as object, Number(inserted.lastInsertRowid))
            } catch {
              // Ignore persistence errors — non-critical
            }
          }
        }
        break
      }

      case 'tool_execution_start': {
        runningTask.toolCallTimers.set(event.toolCallId, Date.now())
        runningTask.toolCallArgs.set(event.toolCallId, event.args)

        // Emit to task event bus
        this.options.taskEventBus?.emitTaskEvent({
          type: 'tool_call_start',
          taskId: runningTask.taskId,
          timestamp: new Date().toISOString(),
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolArgs: event.args,
        })
        break
      }

      case 'tool_execution_end': {
        const startTime = runningTask.toolCallTimers.get(event.toolCallId) ?? Date.now()
        const durationMs = Date.now() - startTime
        const args = runningTask.toolCallArgs.get(event.toolCallId) ?? {}
        runningTask.toolCallTimers.delete(event.toolCallId)
        runningTask.toolCallArgs.delete(event.toolCallId)

        runningTask.toolCallCount++

        this.persistLiveMetrics(runningTask)

        const outputStr = JSON.stringify(event.result ?? {})
        const isError = event.isError === true || (typeof event.result === 'string' && event.result.startsWith('Error'))

        // Track for loop detection
        runningTask.toolCallTracker.record(event.toolName, args, outputStr, isError)

        // Check for loops
        this.checkForLoops(runningTask)

        // Emit to task event bus
        this.options.taskEventBus?.emitTaskEvent({
          type: 'tool_call_end',
          taskId: runningTask.taskId,
          timestamp: new Date().toISOString(),
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolResult: event.result,
          toolIsError: isError,
          durationMs,
        })

        // Log to tool_calls table with task's session_id
        logToolCall(this.db, {
          sessionId,
          toolName: event.toolName,
          input: JSON.stringify(args),
          output: outputStr,
          durationMs,
        })

        // Persist the result as a `tool` chat row as well — same shape the
        // interactive path writes (turn-runner.ts) — so `recall_message` can
        // hand a compacted task its own tool results back. Without this a
        // trimmed tool result would be unrecoverable.
        try {
          const taskAgentId = this.store.getById(runningTask.taskId)?.agentId ?? 'main'
          const inserted = this.db.prepare(
            'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(sessionId, null, 'tool', `Tool: ${event.toolName}`, JSON.stringify({
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolArgs: args,
            toolResult: event.result ?? null,
            toolIsError: isError,
          }), taskAgentId)
          runningTask.history?.noteToolResultId(event.toolCallId, Number(inserted.lastInsertRowid))
        } catch (err) {
          // Not fatal for the task, but no longer silent: without this row the
          // result has no recall reference, so Eco will refuse to shorten it
          // (fail closed) instead of cutting an unrecoverable result.
          console.error(`[task-runner] persisting tool result ${event.toolCallId} failed; it is not recallable:`, err)
        }

        // Progress guard last, so the call that trips it is fully logged
        // (tool_calls row + chat row) before the task is torn down.
        this.checkProgressGuard(runningTask, (guard) => guard.recordToolCall(event.toolName, args))
        break
      }
    }
  }

  /**
   * Check for loops after each tool call
   */
  private checkForLoops(runningTask: RunningTask): void {
    const config = this.options.loopDetection
    if (!config?.enabled) return

    const method = resolveDetectionMethod(config, runningTask.toolCallCount)
    if (method === 'none') return

    if (method === 'systematic') {
      const result = runningTask.toolCallTracker.checkSystematicLoop(config.maxConsecutiveFailures)
      if (result.loopDetected) {
        this.handleLoopDetected(runningTask, result)
      }
    } else if (method === 'smart') {
      // Smart detection runs every M tool calls
      const checkInterval = config.smartCheckInterval ?? 5
      if (runningTask.toolCallCount % checkInterval === 0) {
        this.runSmartDetection(runningTask).catch(err => {
          console.error(`[task-runner] Smart loop detection error for task ${runningTask.taskId}:`, err)
        })
      }
    }
  }

  /**
   * Run LLM-based smart loop detection
   */
  private async runSmartDetection(runningTask: RunningTask): Promise<void> {
    const config = this.options.loopDetection
    if (!config?.smartProvider || !this.options.getProviderById) return

    const { providerId, modelId } = parseProviderModelId(config.smartProvider)
    if (!providerId) return

    const resolvedProvider = this.options.getProviderById(providerId)
    if (!resolvedProvider) return

    // Apply specific model override if provided
    const provider = modelId ? { ...resolvedProvider, enabledModels: [modelId] } : resolvedProvider

    try {
      const model = this.options.buildModel(provider)
      const apiKey = await this.options.getApiKey(provider)
      const prompt = buildSmartDetectionPrompt(runningTask.toolCallTracker.getHistory())

      // Create a lightweight agent for the detection call
      const detectionAgent = new PiAgent({
        initialState: {
          systemPrompt: 'You are a loop detection assistant. Analyze tool call patterns and determine if an agent is making progress or stuck.',
          model,
          tools: [],
          thinkingLevel: this.resolveBackgroundThinkingLevel(),
        },
        streamFn: buildStreamFn(provider),
        ...(provider.transport && provider.transport !== 'sse'
          && { transport: provider.transport }),
        getApiKey: () => apiKey,
      })

      // Track token usage from detection — register a child session of the task
      const parentTask = this.store.getById(runningTask.taskId)
      const taskSessionId = parentTask?.sessionId ?? null
      const sessionId = this.options.sessionManager.createSession({
        type: 'loop_detection',
        source: 'system',
        parentSessionId: taskSessionId ?? undefined,
        agentId: parentTask?.agentId ?? 'main',
      }).id
      detectionAgent.subscribe((event: AgentEvent) => {
        if (event.type === 'message_end') {
          const msg = event.message as Message
          if ('role' in msg && msg.role === 'assistant') {
            const assistantMsg = msg as AssistantMessage
            const cost = estimateCost(
              model,
              assistantMsg.usage.input,
              assistantMsg.usage.output,
              assistantMsg.usage.cacheRead,
              assistantMsg.usage.cacheWrite,
            )
            const finalCost = assistantMsg.usage.cost.total > 0
              ? assistantMsg.usage.cost.total
              : cost

            logTokenUsage(this.db, {
              provider: assistantMsg.provider,
              model: assistantMsg.model,
              promptTokens: assistantMsg.usage.input,
              completionTokens: assistantMsg.usage.output,
              cacheRead: assistantMsg.usage.cacheRead,
              cacheWrite: assistantMsg.usage.cacheWrite,
              estimatedCost: finalCost,
              sessionId,
            })
          }
        }
      })

      await detectionAgent.prompt(prompt)

      // Extract response
      const messages = detectionAgent.state.messages
      const lastMsg = [...messages].reverse().find(
        (m) => 'role' in m && m.role === 'assistant'
      ) as AssistantMessage | undefined

      let responseText = ''
      if (lastMsg && 'content' in lastMsg && Array.isArray(lastMsg.content)) {
        responseText = lastMsg.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { type: string; text?: string }) => c.text ?? '')
          .join('')
      }

      const result = parseSmartDetectionResponse(responseText)
      if (result.loopDetected) {
        this.handleLoopDetected(runningTask, result)
      }
    } catch (err) {
      console.error(`[task-runner] Smart detection failed for task ${runningTask.taskId}:`, err)
    }
  }

  /**
   * Handle a detected loop — fail the task and notify
   */
  private handleLoopDetected(runningTask: RunningTask, result: LoopDetectionResult): void {
    const { taskId } = runningTask
    const reason = `Loop detected (${result.method}): ${result.details}`

    // Abort the agent. `aborted` first: this path has already decided the
    // verdict, the post-run path must not overwrite it.
    runningTask.aborted = true
    runningTask.agent.abort()
    this.cleanupRunningTask(taskId)

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    this.store.update(taskId, {
      status: 'failed',
      resultStatus: 'failed',
      resultSummary: reason,
      errorMessage: reason,
      completedAt: now,
      promptTokens: runningTask.promptTokens,
      completionTokens: runningTask.completionTokens,
      cacheRead: runningTask.cacheRead,
      cacheWrite: runningTask.cacheWrite,
      estimatedCost: runningTask.estimatedCost,
      toolCallCount: runningTask.toolCallCount,
    })

    this.persistHandoff(taskId, 'progress_guard', { errorMessage: reason })

    const task = this.store.getById(taskId)
    if (task) {
      const startedAt = taskStartedAtMs(task.startedAt)
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      const injection = `<task_injection task_id="${task.id}" task_name="${task.name}" status="failed" trigger="${task.triggerType}" duration_minutes="${durationMinutes}" tokens_used="${task.promptTokens + task.completionTokens}">
${reason}
Hint: Inspect it with get_task (task_id ${task.id}); use cancel_task if anything still needs to be cleaned up.
</task_injection>`
      this.notifyTaskComplete(taskId, injection, "failed", reason, task.agentId)
    }
  }

  /**
   * Run one progress-guard probe. Returns true when the guard tripped and the
   * task has been torn down (callers must stop touching it).
   *
   * Fail-open by contract: a bug in the guard may cost tokens, it must never
   * kill a task. Any throw is logged and treated as "no trip".
   */
  private checkProgressGuard(
    runningTask: RunningTask,
    probe: (guard: TaskProgressGuard) => ProgressGuardTrip | null,
  ): boolean {
    let trip: ProgressGuardTrip | null = null
    try {
      trip = probe(runningTask.progressGuard)
    } catch (err) {
      console.error(`[task-runner] Progress guard failed for task ${runningTask.taskId} (ignored):`, err)
      return false
    }
    if (!trip) return false
    try {
      this.handleGuardTripped(runningTask, trip)
      return true
    } catch (err) {
      console.error(`[task-runner] Progress guard abort failed for task ${runningTask.taskId}:`, err)
      return false
    }
  }

  /**
   * A progress guard tripped: abort the agent and fail the task with the
   * guard's message. Same shape as `handleLoopDetected` — a guarded task is
   * NEVER reported as a silent success, the result always names the guard.
   */
  private handleGuardTripped(runningTask: RunningTask, trip: ProgressGuardTrip): void {
    const { taskId } = runningTask
    // Another terminal path may have won the race (max duration, loop
    // detection, normal completion) — then there is nothing left to abort.
    if (!this.runningTasks.has(taskId)) return
    runningTask.guardTripped = trip

    console.warn(`[task-runner] Progress guard "${trip.kind}" aborted task ${taskId}: ${trip.message}`)

    const sessionId = this.store.getById(taskId)?.sessionId
    if (sessionId) {
      try {
        logToolCall(this.db, {
          sessionId,
          toolName: 'task_guard',
          input: JSON.stringify({ guard: trip.kind }),
          output: JSON.stringify({ ...trip.details, message: trip.message }),
          durationMs: 0,
          status: 'error',
        })
      } catch {
        // Metrics are best effort — never fail over a log row.
      }
    }

    try {
      runningTask.aborted = true
      runningTask.agent.abort()
    } catch (err) {
      console.error(`[task-runner] Agent abort after guard trip failed for task ${taskId}:`, err)
    }
    this.cleanupRunningTask(taskId)

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    this.store.update(taskId, {
      status: 'failed',
      resultStatus: 'failed',
      resultSummary: trip.message,
      errorMessage: trip.message,
      completedAt: now,
      promptTokens: runningTask.promptTokens,
      completionTokens: runningTask.completionTokens,
      cacheRead: runningTask.cacheRead,
      cacheWrite: runningTask.cacheWrite,
      estimatedCost: runningTask.estimatedCost,
      toolCallCount: runningTask.toolCallCount,
    })

    this.persistHandoff(taskId, 'progress_guard', { errorMessage: trip.message })

    const task = this.store.getById(taskId)
    if (task) {
      const startedAt = taskStartedAtMs(task.startedAt)
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      const injection = formatTaskInjection(task, durationMinutes)
      this.notifyTaskComplete(taskId, injection, 'failed', trip.message, task.agentId)
    }
  }

  /**
   * One `task_usage` metric row per finished task run (token audit
   * 2026-09-17, P7b): the run's tokens, cost, tool calls and the cache read
   * ratio `cache_read / (prompt_tokens + cache_read)` — the same definition
   * `cache-stats.ts` uses for strands, so the numbers are comparable.
   *
   * Written from `cleanupRunningTask`, which every path that ends a run goes
   * through: one row per run segment (completed, failed, aborted, guarded —
   * and one when a task pauses for a question). The counters are cumulative
   * across a pause/resume, so the last row of a task is its total.
   */
  private logTaskUsageMetric(runningTask: RunningTask): void {
    try {
      const sessionId = this.store.getById(runningTask.taskId)?.sessionId
      if (!sessionId) return
      const ratio = cacheReadRatio(runningTask.promptTokens, runningTask.cacheRead)
      const payload = {
        taskId: runningTask.taskId,
        promptTokens: runningTask.promptTokens,
        completionTokens: runningTask.completionTokens,
        cacheRead: runningTask.cacheRead,
        cacheWrite: runningTask.cacheWrite,
        estimatedCost: runningTask.estimatedCost,
        toolCalls: runningTask.toolCallCount,
        cacheReadRatio: ratio,
        runtimeMs: Date.now() - runningTask.startedAtMs,
      }
      console.log(
        `[task-runner] Task ${runningTask.taskId} usage: ${runningTask.promptTokens + runningTask.cacheRead + runningTask.cacheWrite} input ` +
        `(${ratio === null ? 'n/a' : `${Math.round(ratio * 100)}% cache read`}), ` +
        `${runningTask.completionTokens} output, ${runningTask.toolCallCount} tool calls, $${runningTask.estimatedCost.toFixed(4)}`,
      )
      logToolCall(this.db, {
        sessionId,
        toolName: 'task_usage',
        input: JSON.stringify({ taskId: runningTask.taskId }),
        output: JSON.stringify(payload),
        durationMs: 0,
        status: 'success',
      })
    } catch (err) {
      // Accounting must never affect task outcome.
      console.error(`[task-runner] Failed to log task usage metric for ${runningTask.taskId}:`, err)
    }
  }

  private validateStatusUpdatesConfig(): void {
    const statusUpdates = this.options.statusUpdates
    if (!statusUpdates?.enabled) return
    if (
      !Number.isInteger(statusUpdates.intervalMinutes)
      || statusUpdates.intervalMinutes < 1
      || statusUpdates.intervalMinutes > MAX_STATUS_UPDATE_INTERVAL_MINUTES
    ) {
      throw new Error(`tasks.statusUpdates.intervalMinutes must be an integer 1-${MAX_STATUS_UPDATE_INTERVAL_MINUTES}`)
    }
  }

  /**
   * Start the periodic status-update timer for a (running or resumed) task,
   * if the feature is enabled and a callback is registered. Invalid intervals
   * fail fast so misconfiguration cannot overflow into a hot timer loop.
   */
  private startStatusUpdateTimer(runningTask: RunningTask, task: Task): void {
    this.validateStatusUpdatesConfig()
    const statusUpdates = this.options.statusUpdates
    if (!statusUpdates?.enabled) return
    if (!this.options.onStatusUpdate) return

    runningTask.statusUpdateTimer = setInterval(() => {
      this.emitStatusUpdate(runningTask, task)
    }, statusUpdates.intervalMinutes * 60 * 1000)
  }

  /**
   * Periodic `progress` lifecycle frame while the task runs.
   *
   * Deliberately NOT tied to `statusUpdates` (that feature writes chat
   * messages and pings Telegram and is off by default). This one only
   * re-reads the task row and hands it to `onTaskLifecycle`, so the strand
   * view can show tokens/cost climbing. No timer without a consumer, and
   * `unref()` where available so a pending tick never keeps the process
   * alive.
   */
  private startProgressFrameTimer(runningTask: RunningTask): void {
    if (!this.options.onTaskLifecycle) return
    if (runningTask.progressFrameTimer) return

    const timer = setInterval(() => {
      // Belt and braces: the timer is cleared in `cleanupRunningTask`, and a
      // tick that still slips through finds the task gone and does nothing.
      if (!this.runningTasks.has(runningTask.taskId)) return
      this.emitLifecycle('progress', runningTask.taskId)
    }, TASK_PROGRESS_FRAME_INTERVAL_MS)
    ;(timer as { unref?: () => void }).unref?.()
    runningTask.progressFrameTimer = timer
  }

  /**
   * Emit a periodic status update for a running task
   */
  private emitStatusUpdate(runningTask: RunningTask, task: Task): void {
    if (!this.options.onStatusUpdate) return
    if (!this.runningTasks.has(runningTask.taskId)) return

    const runtimeMinutes = Math.round((Date.now() - runningTask.startedAtMs) / 60000)
    const totalTokens = runningTask.promptTokens + runningTask.completionTokens

    const statusMessage = formatPeriodicStatusUpdate(
      task.id,
      task.name,
      runtimeMinutes,
      runningTask.toolCallCount,
      totalTokens,
    )

    this.options.onStatusUpdate(task.id, statusMessage, {
      taskName: task.name,
      runtimeMinutes,
      toolCallCount: runningTask.toolCallCount,
      totalTokens,
    })
  }

  /**
   * Emit a status change event to the task event bus
   */
  private emitStatusChange(taskId: string, status: string, message?: string): void {
    this.options.taskEventBus?.emitTaskEvent({
      type: 'status_change',
      taskId,
      timestamp: new Date().toISOString(),
      status,
      statusMessage: message,
    })
  }

  /**
   * Notify completion/failure and emit status change.
   * Passes the task's agentId so the caller can route the notification
   * to the correct persona runtime and Telegram bot.
   */
  private notifyTaskComplete(taskId: string, injection: string, status: string, message?: string, agentId?: string | null): void {
    this.emitStatusChange(taskId, status, message)
    this.emitLifecycle('finished', taskId)
    this.options.onTaskComplete(taskId, injection, agentId ?? null)
  }

  /**
   * Fire the lifecycle hook with the CURRENT row (re-read, never a stale
   * copy). Never throws: the hook feeds a live view, not the task result.
   */
  private emitLifecycle(phase: 'started' | 'progress' | 'finished', taskId: string): void {
    if (!this.options.onTaskLifecycle) return
    try {
      const task = this.store.getById(taskId)
      if (!task) return
      this.options.onTaskLifecycle(phase, task)
    } catch (err) {
      console.error(`[task-runner] onTaskLifecycle(${phase}) failed for task ${taskId}:`, err)
    }
  }

  /**
   * Notify task paused and emit status change.
   * Passes the task's agentId so the caller can route the notification
   * to the correct persona runtime and Telegram bot.
   */
  private notifyTaskPaused(taskId: string, injection: string, message?: string, agentId?: string | null): void {
    this.emitStatusChange(taskId, 'paused', message)
    this.emitLifecycle('finished', taskId)
    this.options.onTaskPaused?.(taskId, injection, agentId ?? null)
  }

  /**
   * Abort a running task.
   *
   * Also handles "zombie" tasks — rows where `status='running'` in the DB
   * but no matching entry exists in `this.runningTasks` (e.g. the task
   * failed during `startTask` setup before `runTaskAsync` took over, or
   * the process restarted without recovering the task). Without this, the
   * UI kill button would silently no-op on those rows.
   */
  abortTask(taskId: string, reason: string = 'Aborted by user'): void {
    const runningTask = this.runningTasks.get(taskId)
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    // E7: a task that is still waiting for a slot leaves the queue first, so
    // it can never be started by a later `pumpQueue`. The row is then
    // finalized by the zombie branch below exactly like a normal abort.
    const cancelled = this.queue.cancel(taskId)
    if (cancelled) {
      console.log(`[task-runner] Removed queued task ${taskId} from the queue (${reason})`)
    }

    const pausedTask = this.pausedTasks.get(taskId)
    if (!runningTask && (pausedTask || this.store.getById(taskId)?.status === 'paused')) {
      this.abortPausedTask(taskId, reason, pausedTask ?? null, now)
      return
    }

    if (!runningTask) {
      // Zombie task: no in-memory state to tear down, but we still need to
      // clear the DB row so the UI reflects the kill and the row no longer
      // counts as running.
      const existing = this.store.getById(taskId)
      if (!existing || existing.status !== 'running') {
        // Nothing to do — already finalized or not present at all.
        return
      }

      this.store.update(taskId, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: reason,
        errorMessage: reason,
        completedAt: now,
      })

      this.persistHandoff(taskId, abortHandoffReason(reason), { errorMessage: reason })

      const task = this.store.getById(taskId)
      if (task) {
        const startedAt = taskStartedAtMs(task.startedAt)
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(task, durationMinutes)
        this.notifyTaskComplete(taskId, injection, 'failed', reason, task.agentId)
      }
      return
    }

    // Abort the agent. The flag goes up FIRST: pi-agent resolves the run on
    // an abort instead of throwing, so the post-run path must already see
    // that this task was finalized here.
    runningTask.aborted = true
    runningTask.agent.abort()
    this.cleanupRunningTask(taskId)

    this.store.update(taskId, {
      status: 'failed',
      resultStatus: 'failed',
      resultSummary: reason,
      errorMessage: reason,
      completedAt: now,
      promptTokens: runningTask.promptTokens,
      completionTokens: runningTask.completionTokens,
      cacheRead: runningTask.cacheRead,
      cacheWrite: runningTask.cacheWrite,
      estimatedCost: runningTask.estimatedCost,
      toolCallCount: runningTask.toolCallCount,
    })

    // W5/P2: the hard deadline (or a kill) always leaves unfinished work —
    // record what the run had reached so a continuation can pick it up.
    this.persistHandoff(taskId, abortHandoffReason(reason), { errorMessage: reason })

    const task = this.store.getById(taskId)
    if (task) {
      const startedAt = taskStartedAtMs(task.startedAt)
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      const injection = formatTaskInjection(task, durationMinutes)
      this.notifyTaskComplete(taskId, injection, "failed", reason, task.agentId)
    }
  }

  /**
   * A paused task holds no slot and no running loop, only its agent in
   * memory (or nothing at all when the row outlived the process). Cancelling
   * it frees the agent and finalizes the row with the usage it had reached.
   */
  private abortPausedTask(taskId: string, reason: string, pausedTask: PausedTask | null, now: string): void {
    if (pausedTask) {
      pausedTask.agent.abort()
      this.pausedTasks.delete(taskId)
    }
    this.store.update(taskId, {
      status: 'failed',
      resultStatus: 'failed',
      resultSummary: reason,
      errorMessage: reason,
      completedAt: now,
      ...(pausedTask
        ? {
            promptTokens: pausedTask.promptTokens,
            completionTokens: pausedTask.completionTokens,
            cacheRead: pausedTask.cacheRead,
            cacheWrite: pausedTask.cacheWrite,
            estimatedCost: pausedTask.estimatedCost,
            toolCallCount: pausedTask.toolCallCount,
          }
        : {}),
    })
    this.persistHandoff(taskId, abortHandoffReason(reason), { errorMessage: reason })
    const task = this.store.getById(taskId)
    if (task) {
      const startedAt = taskStartedAtMs(task.startedAt)
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      this.notifyTaskComplete(taskId, formatTaskInjection(task, durationMinutes), 'failed', reason, task.agentId)
    }
  }

  /**
   * Deliver a correction to a task without stopping it.
   *
   * - running: queued on the agent's steering queue; pi-agent-core drains it
   *   after the current turn's tool calls (also after a final answer, which
   *   then gets one more turn), same channel as the wrap-up signal.
   * - queued (waiting for a slot): appended to the stored prompt. `pumpQueue`
   *   starts the task from the freshest row, so the text is part of the brief.
   * - anything else (paused, finished, zombie, aborted): not delivered —
   *   paused tasks are answered through `resumeTask`.
   */
  steerTask(taskId: string, text: string): TaskSteerResult {
    const runningTask = this.runningTasks.get(taskId)
    if (runningTask) {
      if (runningTask.aborted || runningTask.guardTripped) {
        return { delivered: false, mode: 'none', reason: 'the task is being stopped' }
      }
      const streaming = (runningTask.agent as { state?: { isStreaming?: boolean } }).state?.isStreaming
      if (streaming === false) {
        return { delivered: false, mode: 'none', reason: 'the task agent is between runs (finishing or under review)' }
      }
      runningTask.agent.steer({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
      console.log(`[task-runner] Orchestrator steer queued for task ${taskId}`)
      return { delivered: true, mode: 'steered' }
    }
    if (this.queue.isQueued(taskId)) {
      const row = this.store.getById(taskId)
      if (!row || row.status !== 'running') {
        return { delivered: false, mode: 'none', reason: `the task is ${row?.status ?? 'missing'}` }
      }
      this.store.update(taskId, { prompt: `${row.prompt}\n\n${text}` })
      console.log(`[task-runner] Orchestrator steer appended to the prompt of queued task ${taskId}`)
      return { delivered: true, mode: 'queued_prompt' }
    }
    if (this.pausedTasks.has(taskId)) {
      return { delivered: false, mode: 'none', reason: 'the task is paused; answer it with resume_task' }
    }
    return { delivered: false, mode: 'none', reason: 'the task has no live agent' }
  }

  /**
   * Check if a task is currently running
   */
  isRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId)
  }

  /**
   * Get all running task IDs
   */
  getRunningTaskIds(): string[] {
    return Array.from(this.runningTasks.keys())
  }

  /**
   * Is this task waiting for a concurrency slot? Such a task has
   * `status='running'` with `startedAt = NULL` in the DB and no agent yet.
   */
  isQueued(taskId: string): boolean {
    return this.queue.isQueued(taskId)
  }

  /**
   * The strand a waiting task was delegated from. A queued task has no
   * session yet, so this in-memory link is the only way to attribute it to
   * its owner before it starts.
   */
  getQueuedParentSessionId(taskId: string): string | null {
    return this.queue.payloadOf(taskId)?.parentSessionId ?? null
  }

  /** Ids of the tasks waiting for a slot, in FIFO order. */
  getQueuedTaskIds(): string[] {
    return this.queue.queuedIds()
  }

  /**
   * Queue state for one task, for tool results and diagnostics:
   * `position` is 1-based (0 = not queued), `running` counts the tasks that
   * currently occupy a slot and `limit` is the global cap (0 = unlimited).
   * The provider fields (additive since the per-provider limit) tell which
   * limit keeps a waiting task out: `reason` is `provider` or `global`.
   */
  getQueueInfo(taskId: string): TaskQueueInfo {
    const snapshot = this.queue.snapshot()
    const position = this.queue.position(taskId)
    const provider = this.queue.providerOf(taskId)
    const bucket = provider ? snapshot.providers[provider] : undefined
    return {
      queued: position > 0,
      position,
      running: snapshot.running,
      queued_count: snapshot.queued,
      limit: snapshot.limit,
      reason: this.queue.waitReason(taskId),
      provider,
      provider_running: bucket?.running ?? 0,
      provider_limit: provider ? this.queue.providerLimit(provider) : snapshot.perProviderLimit,
    }
  }

  /**
   * Schedule the max-duration timeout for a running task.
   *
   * The deadline is anchored on `task.startedAt` (the original wall-clock
   * start), NOT on the in-memory `startedAtMs`. This way the limit also
   * survives pause/resume cycles: if a task pauses on a question and is
   * resumed later, the remaining budget is computed against the original
   * start, not refreshed from zero.
   *
   * If the deadline has already passed (e.g. a task is resumed long after
   * `maxDurationMinutes` would have fired), the task is aborted synchronously
   * and no timer is registered.
   */
  private scheduleMaxDurationTimeout(
    runningTask: RunningTask,
    task: { id: string; maxDurationMinutes: number | null; startedAt: string | null },
  ): void {
    if (runningTask.timeoutTimer) {
      clearTimeout(runningTask.timeoutTimer)
      runningTask.timeoutTimer = null
    }
    if (runningTask.wrapUpTimer) {
      clearTimeout(runningTask.wrapUpTimer)
      runningTask.wrapUpTimer = null
    }

    // Per-task limit takes precedence; fall back to the runner-wide default
    // so internal callers (heartbeat, consolidation, cronjobs) that never set
    // maxDurationMinutes still get a watchdog and cannot hang forever.
    const maxMinutes = this.resolveBudgetMinutes(task)
    if (maxMinutes <= 0) return

    const startedAtMs = parseTaskTimestampMs(task.startedAt) ?? runningTask.startedAtMs
    const deadline = startedAtMs + maxMinutes * 60 * 1000
    const remaining = deadline - Date.now()

    if (remaining <= 0) {
      // Already past the deadline (e.g. resumed long after the limit).
      this.abortTask(runningTask.taskId, 'Max duration exceeded')
      return
    }

    runningTask.timeoutTimer = setTimeout(() => {
      this.abortTask(runningTask.taskId, 'Max duration exceeded')
    }, remaining)

    this.scheduleWrapUp(runningTask, maxMinutes, remaining)
  }

  /**
   * Effective time budget of a task in minutes: its own limit, else the
   * runner-wide default, else 0 (= no limit). Single source of truth for the
   * deadline timer, the wrap-up point and the budget line in the prompt.
   */
  private resolveBudgetMinutes(task: { maxDurationMinutes: number | null }): number {
    if (task.maxDurationMinutes && task.maxDurationMinutes > 0) return task.maxDurationMinutes
    const fallback = this.options.defaultMaxDurationMinutes
    return fallback && fallback > 0 ? fallback : 0
  }

  /**
   * W5/P0: one wrap-up message at ~80 % of the budget instead of a silent
   * kill at 100 %. Steering (not `prompt()`) because the agent is mid-run:
   * pi-agent-core drains the steering queue after the current turn's tool
   * calls, so the message lands between turns without interrupting one.
   *
   * Fail-open by construction: a broken steer is logged and the hard abort
   * still fires — the wrap-up can only ever add a turn, never remove the
   * deadline.
   */
  private scheduleWrapUp(runningTask: RunningTask, budgetMinutes: number, remainingMs: number): void {
    if (runningTask.wrapUpSent) return
    let plan: ReturnType<typeof planWrapUp> = null
    try {
      const limits = loadHeuristics().taskWrapUp
      plan = planWrapUp({
        budgetMinutes,
        remainingMs,
        budgetFraction: limits.budgetFraction,
        minLeadSeconds: limits.minLeadSeconds,
      })
    } catch (err) {
      console.warn(`[task-runner] Wrap-up planning failed for task ${runningTask.taskId} (ignored):`, err)
      return
    }
    if (!plan) return

    runningTask.wrapUpTimer = setTimeout(() => {
      runningTask.wrapUpTimer = null
      if (runningTask.wrapUpSent) return
      // Terminal paths (completion, guard, abort) drop the entry first.
      if (!this.runningTasks.has(runningTask.taskId)) return
      runningTask.wrapUpSent = true
      const text = buildWrapUpMessage(plan.remainingMinutesAtWrapUp, budgetMinutes)
      try {
        runningTask.agent.steer({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
        console.log(`[task-runner] Wrap-up signal sent to task ${runningTask.taskId} (~${plan.remainingMinutesAtWrapUp} min left)`)
      } catch (err) {
        console.warn(`[task-runner] Wrap-up steer failed for task ${runningTask.taskId} (hard deadline still applies):`, err)
      }
    }, plan.delayMs)
  }

  /**
   * W5/P2: persist what this run leaves behind when it ends with unfinished
   * work. Best effort — a failed handoff write must never change the outcome
   * of the task itself.
   */
  private persistHandoff(
    taskId: string,
    reason: HandoffReason,
    extra: { errorMessage?: string | null; summary?: string | null } = {},
  ): void {
    try {
      const task = this.store.getById(taskId)
      if (!task) return
      const startedAt = taskStartedAtMs(task.startedAt)
      const handoff = buildTaskHandoff({
        task,
        reason,
        durationMinutes: Math.round((Date.now() - startedAt) / 60000),
        errorMessage: extra.errorMessage ?? null,
        summary: extra.summary ?? null,
      })
      this.store.update(taskId, { handoff })
    } catch (err) {
      console.warn(`[task-runner] Could not persist handoff for task ${taskId}:`, err)
    }
  }

  private persistLiveMetrics(runningTask: RunningTask): void {
    try {
      this.store.update(runningTask.taskId, {
        promptTokens: runningTask.promptTokens,
        completionTokens: runningTask.completionTokens,
        cacheRead: runningTask.cacheRead,
        cacheWrite: runningTask.cacheWrite,
        estimatedCost: runningTask.estimatedCost,
        toolCallCount: runningTask.toolCallCount,
      })
    } catch (err) {
      console.warn(`[task-runner] live metrics update failed for ${runningTask.taskId}:`, err)
    }
  }

  /**
   * Clean up a running task's resources
   */
  private cleanupRunningTask(taskId: string): void {
    const runningTask = this.runningTasks.get(taskId)
    if (!runningTask) return

    // P7b: the run is over (completed, failed, aborted or guarded) — record
    // its usage and cache read ratio exactly once.
    this.logTaskUsageMetric(runningTask)

    if (runningTask.timeoutTimer) {
      clearTimeout(runningTask.timeoutTimer)
    }
    if (runningTask.wrapUpTimer) {
      clearTimeout(runningTask.wrapUpTimer)
      runningTask.wrapUpTimer = null
    }
    if (runningTask.statusUpdateTimer) {
      clearInterval(runningTask.statusUpdateTimer)
    }
    if (runningTask.progressFrameTimer) {
      clearInterval(runningTask.progressFrameTimer)
      runningTask.progressFrameTimer = null
    }
    this.runningTasks.delete(taskId)

    // Every terminal path of a run funnels through here — completion,
    // failure, abort, max-duration timeout, loop detection, progress guard
    // and the pause on a question. So this is the one place that frees the
    // concurrency slot and lets the next queued task in. A pause frees the
    // slot on purpose (E4): the task waits for a human, not for the CPU, and
    // `resumeTask` re-acquires a slot by bypass.
    this.releaseSlot(taskId, 'run ended')

    // The task session id is the provider's prompt-cache key. For ChatGPT
    // Codex pi-ai keeps one WebSocket per session id open for continuation
    // and only closes it after 5 idle minutes; many short tasks would hold
    // sockets against the account's connection limit. Free them now. Scoped
    // to this session id only — `cleanupSessionResources()` without an id
    // would close every session's resources. A resumed task reconnects.
    const finishedSessionId = this.store.getById(taskId)?.sessionId
    if (finishedSessionId) {
      try {
        cleanupSessionResources(finishedSessionId)
      } catch (err) {
        console.warn(`[task-runner] provider session cleanup failed for task ${taskId}:`, err)
      }
    }
  }

  /**
   * Check if a task is currently paused
   */
  isPaused(taskId: string): boolean {
    return this.pausedTasks.has(taskId)
  }

  /**
   * Get all paused task IDs
   */
  getPausedTaskIds(): string[] {
    return Array.from(this.pausedTasks.keys())
  }

  /**
   * Resume a paused task by sending a follow-up message
   */
  async resumeTask(taskId: string, message: string): Promise<boolean> {
    const pausedTask = this.pausedTasks.get(taskId)
    if (!pausedTask) return false
    this.validateStatusUpdatesConfig()

    // E5: a resume bypasses the queue — a human already waited for this
    // answer — but it does occupy a slot again (the pause released it), in
    // the provider the task runs on.
    this.queue.occupy(taskId, pausedTask.slotProviderKey)

    // Remove from paused map
    this.pausedTasks.delete(taskId)

    // Update status back to running
    this.store.update(taskId, {
      status: 'running',
    })

    const { agent } = pausedTask
    const sessionId = this.store.getById(taskId)?.sessionId
    if (!sessionId) {
      console.error(`[task-runner] Cannot resume task ${taskId}: no sessionId on task`)
      // The resume never started: give the slot back so it cannot leak.
      this.releaseSlot(taskId, 'resume aborted — no session')
      return false
    }
    // The agent already carries its model, but the event handler still runs
    // `estimateCost(model, ...)` on every `message_end`. A bare `{}` made that
    // read `model.cost.input` on an undefined `cost` and threw inside the
    // subscribe callback, which failed every resumed task on its first
    // assistant message. Zero pricing is the right placeholder: providers that
    // report real cost (usage.cost.total) win over the estimate anyway.
    const model = {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as Model<Api>

    // Create a new RunningTask entry
    const task = this.store.getById(taskId)!
    const runningTask: RunningTask = {
      taskId,
      agent,
      slotProviderKey: pausedTask.slotProviderKey,
      abortController: new AbortController(),
      timeoutTimer: null,
      wrapUpTimer: null,
      wrapUpSent: false,
      promptTokens: pausedTask.promptTokens,
      completionTokens: pausedTask.completionTokens,
      cacheRead: pausedTask.cacheRead,
      cacheWrite: pausedTask.cacheWrite,
      estimatedCost: pausedTask.estimatedCost,
      toolCallCount: pausedTask.toolCallCount,
      toolCallTimers: new Map(),
      toolCallArgs: new Map(),
      toolCallTracker: new ToolCallTracker(),
      statusUpdateTimer: null,
      progressFrameTimer: null,
      startedAtMs: taskStartedAtMs(task.startedAt),
      // The compactor belongs to the agent, not to the run: carrying it over
      // keeps the cut position (and the recall ids) across the pause.
      history: pausedTask.history,
      // A pause/resume must not reset the budget: seed the guard with what
      // the task already spent, otherwise a task could loop forever by
      // asking a question every N calls.
      progressGuard: new TaskProgressGuard(loadHeuristics().taskGuard, {
        toolCalls: pausedTask.toolCallCount,
        inputTokens: pausedTask.promptTokens + pausedTask.cacheRead + pausedTask.cacheWrite,
      }),
      guardTripped: null,
      aborted: false,
    }

    // Set up periodic status updates for resumed task
    this.startStatusUpdateTimer(runningTask, task)

    this.runningTasks.set(taskId, runningTask)
    // Must come after the map insert: the emit checks membership.
    this.startProgressFrameTimer(runningTask)

    // Re-arm the max-duration timeout against the original startedAt so
    // resumed tasks cannot run past their original budget. If the deadline
    // has already passed, this aborts synchronously and the task is no longer
    // in the runningTasks map.
    this.scheduleMaxDurationTimeout(runningTask, task)
    if (!this.runningTasks.has(taskId)) {
      return true
    }

    // Subscribe to events for the resumed task
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      this.handleTaskEvent(runningTask, event, sessionId, model)
    })

    // Send the follow-up message to the agent, which resumes execution
    this.runResumedTaskAsync(runningTask, unsubscribe, sessionId, message)

    // A resumed task is working again — the activity view must flip the node
    // from "waiting for an answer" back to running.
    this.emitLifecycle('started', taskId)

    return true
  }

  /**
   * Run a resumed task asynchronously (after receiving a follow-up)
   */
  private async runResumedTaskAsync(
    runningTask: RunningTask,
    unsubscribe: () => void,
    sessionId: string,
    message: string,
  ): Promise<void> {
    const { taskId, agent } = runningTask

    try {
      // Re-bind the per-task execution context for the resumed run. PausedTask
      // does not persist the provider, but the task row carries provider name +
      // pinned model — reconstruct it so sub-tasks created after a pause/resume
      // still inherit this task's model (and persona) instead of silently
      // falling back to the system default.
      const taskRow = this.store.getById(taskId)
      let ctxProvider: ProviderConfig | null = null
      if (taskRow?.provider) {
        const base = this.options.getProviderById?.(taskRow.provider) ?? null
        if (base) {
          ctxProvider = taskRow.model ? { ...base, enabledModels: [taskRow.model] } : base
        }
      }

      // Send the follow-up via prompt (which adds a user message and continues the agentic loop)
      await runWithTaskExecutionContext(
        this.taskExecutionContext(taskId, ctxProvider),
        () => agent.prompt(message),
      )

      // Task completed after resume
      unsubscribe()
      this.cleanupRunningTask(taskId)

      // Same as in runTaskAsync: a guard verdict is final.
      if (runningTask.guardTripped) return

      const resultText = extractAgentResultText(agent)

      // Bug B (resume path): same guard as runTaskAsync — surface a provider
      // error / empty-output run as a failure with the real cause.
      const runFailure = detectAgentRunFailure(agent, resultText, runningTask.completionTokens)
      if (runFailure) {
        this.finalizeTaskFailure(taskId, runningTask, runFailure)
        return
      }

      let { status, summary } = parseTaskOutput(resultText)

      // Verifier pass (resume path). Provider is not persisted across the
      // pause, so the reviewer runs only when verification.providerId is
      // configured; otherwise this is a no-op. Skipped on an empty result.
      if (status === 'completed' && resultText.trim().length > 0) {
        const revised = await this.maybeVerifyAndRevise(taskId, agent, resultText, null)
        if (revised) {
          status = revised.status
          summary = revised.summary
        }
      }

      // Output contract (SPEC 11.6), resume path.
      if (status === 'completed') {
        const enforced = await this.enforceOutputSchema(taskId, agent, summary, null)
        if (enforced) {
          status = enforced.status
          summary = enforced.summary
        }
      }

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

      // Handle nested question (task pauses again)
      if (status === 'question') {
        // Same as the first-run pause path: release all timers, keep the agent.
        this.cleanupRunningTask(taskId)

        const pausedTask: PausedTask = {
          taskId,
          agent: runningTask.agent,
          provider: {} as ProviderConfig,
          slotProviderKey: runningTask.slotProviderKey,
          pausedAt: Date.now(),
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          cacheRead: runningTask.cacheRead,
          cacheWrite: runningTask.cacheWrite,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
          history: runningTask.history,
        }
        this.pausedTasks.set(taskId, pausedTask)

        this.store.update(taskId, {
          status: 'paused',
          resultStatus: 'question',
          resultSummary: summary,
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          cacheRead: runningTask.cacheRead,
          cacheWrite: runningTask.cacheWrite,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
        })

        const task = this.store.getById(taskId)!
        const startedAt = taskStartedAtMs(task.startedAt)
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(task, durationMinutes)
        this.notifyTaskPaused(taskId, injection, summary, task.agentId)
        return
      }

      // Handle "silent" status — record as completed but skip injection/notification
      if (status === 'silent') {
        this.store.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: summary || 'Nothing to report.',
          completedAt: now,
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          cacheRead: runningTask.cacheRead,
          cacheWrite: runningTask.cacheWrite,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
        })
        this.emitStatusChange(taskId, 'completed', 'Silent completion — nothing to report')
        return
      }

      this.store.update(taskId, {
        status: status === 'failed' ? 'failed' : 'completed',
        resultStatus: status,
        resultSummary: summary,
        completedAt: now,
        promptTokens: runningTask.promptTokens,
        completionTokens: runningTask.completionTokens,
        cacheRead: runningTask.cacheRead,
        cacheWrite: runningTask.cacheWrite,
        estimatedCost: runningTask.estimatedCost,
        toolCallCount: runningTask.toolCallCount,
      })

      const task = this.store.getById(taskId)!
      const startedAt = taskStartedAtMs(task.startedAt)
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      const injection = formatTaskInjection(task, durationMinutes)
      this.notifyTaskComplete(taskId, injection, task.status, task.resultSummary ?? undefined, task.agentId)
    } catch (err) {
      unsubscribe()
      this.cleanupRunningTask(taskId)

      if (runningTask.guardTripped) return

      const errorMessage = err instanceof Error ? err.message : String(err)
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

      this.store.update(taskId, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: `Task failed with error: ${errorMessage}`,
        errorMessage,
        completedAt: now,
        promptTokens: runningTask.promptTokens,
        completionTokens: runningTask.completionTokens,
        cacheRead: runningTask.cacheRead,
        cacheWrite: runningTask.cacheWrite,
        estimatedCost: runningTask.estimatedCost,
        toolCallCount: runningTask.toolCallCount,
      })

      const task = this.store.getById(taskId)!
      const startedAt = taskStartedAtMs(task.startedAt)
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      const injection = formatTaskInjection(task, durationMinutes)
      this.notifyTaskComplete(taskId, injection, "failed", errorMessage, task.agentId)
    }
  }

  /**
   * Clean up paused tasks that have exceeded their time budget.
   *
   * Two independent limits apply, whichever is reached first:
   *  1. `MAX_PAUSE_DURATION_MS` (24h) — hard cap on how long a task may sit
   *     paused waiting for a user response, regardless of `maxDurationMinutes`.
   *  2. `task.maxDurationMinutes` measured from `task.startedAt` — a paused
   *     task must not silently outlive its configured max duration. Without
   *     this check a task with `maxDurationMinutes=60` could remain paused
   *     for up to 24h, and on resume run on with no remaining budget.
   */
  cleanupStalePausedTasks(): number {
    let cleanedCount = 0
    const now = Date.now()

    for (const [taskId, pausedTask] of this.pausedTasks) {
      const task = this.store.getById(taskId)
      const pausedTooLong = now - pausedTask.pausedAt >= MAX_PAUSE_DURATION_MS

      // Same fallback as scheduleMaxDurationTimeout: per-task limit, or the
      // runner-wide default if the task has none.
      const effectiveMaxMinutes = (task?.maxDurationMinutes && task.maxDurationMinutes > 0)
        ? task.maxDurationMinutes
        : (this.options.defaultMaxDurationMinutes && this.options.defaultMaxDurationMinutes > 0
            ? this.options.defaultMaxDurationMinutes
            : 0)

      let maxDurationExceeded = false
      const startedAtMs = parseTaskTimestampMs(task?.startedAt)
      if (effectiveMaxMinutes > 0 && startedAtMs !== null) {
        const deadline = startedAtMs + effectiveMaxMinutes * 60 * 1000
        maxDurationExceeded = now >= deadline
      }

      if (!pausedTooLong && !maxDurationExceeded) continue

      const reason = maxDurationExceeded
        ? 'Max duration exceeded'
        : 'timeout — no response received'

      // Free the agent from memory
      pausedTask.agent.abort()
      this.pausedTasks.delete(taskId)

      // Mark as failed in DB
      const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19)
      this.store.update(taskId, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: reason,
        errorMessage: reason,
        completedAt: nowStr,
        promptTokens: pausedTask.promptTokens,
        completionTokens: pausedTask.completionTokens,
        cacheRead: pausedTask.cacheRead,
        cacheWrite: pausedTask.cacheWrite,
        estimatedCost: pausedTask.estimatedCost,
        toolCallCount: pausedTask.toolCallCount,
      })

      // Notify via injection
      const updated = this.store.getById(taskId)
      if (updated) {
        const startedAt = taskStartedAtMs(updated.startedAt)
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(updated, durationMinutes)
        this.notifyTaskComplete(taskId, injection, 'failed', reason, updated.agentId)
      }

      cleanedCount++
    }

    return cleanedCount
  }

  /**
   * Recover tasks after server restart.
   * - `running` tasks: re-start with original prompt + progress summary
   * - `paused` tasks: mark as failed with "server restart" reason
   */
  async recoverTasks(
    getProvider: (name: string) => ProviderConfig | null,
    defaultProvider: ProviderConfig,
  ): Promise<{ resumed: number; failed: number }> {
    let resumed = 0
    let failed = 0

    // Handle paused tasks — mark as failed
    const pausedTasks = this.store.list({ status: 'paused' })
    for (const task of pausedTasks) {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      this.store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: 'server restart — please re-ask your question',
        errorMessage: 'server restart',
        completedAt: now,
      })
      failed++
    }

    // Handle running tasks — build summary from stored tool_calls and re-start
    const runningTasks = this.store.list({ status: 'running' })
    for (const task of runningTasks) {
      const baseProvider = task.provider ? getProvider(task.provider) : null
      // Keep the model pin of the interrupted run: `getProvider` returns the
      // provider config whose first enabled model is its default, so without
      // re-applying `task.model` a recovered task silently ran on a different
      // model than the one recorded (and chosen by the task policy).
      // A model that is no longer enabled is not revived. Legacy rows (no
      // task-policy routing) fall back to the provider default, as before.
      const pinStillEnabled = !!task.model && (baseProvider?.enabledModels ?? []).includes(task.model)

      // Task-policy rows were routed deliberately (model, thinking, data-policy
      // gate). If their provider is gone or their model was disabled meanwhile,
      // resuming them on some other model would be exactly the silent switch
      // the policy forbids: fail them clearly instead, the user can restart.
      if (task.routing && (!baseProvider || (task.model && !pinStillEnabled))) {
        const missing = !baseProvider
          ? `provider "${task.provider ?? '(none)'}" is no longer configured`
          : `model "${task.model}" is no longer enabled on provider "${task.provider}"`
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
        this.store.update(task.id, {
          status: 'failed',
          resultStatus: 'failed',
          resultSummary: `server restart — not resumed: ${missing}. Restart the task with an available model.`,
          errorMessage: `server restart; not resumed: ${missing}`,
          completedAt: now,
        })
        failed++
        continue
      }
      const provider = baseProvider
        ? (pinStillEnabled && baseProvider.enabledModels?.[0] !== task.model
          ? { ...baseProvider, enabledModels: [task.model!] }
          : baseProvider)
        : defaultProvider

      // Note: rows that were still queued at shutdown (startedAt = NULL) are
      // recovered through the same "(resumed)" copy path as interrupted runs
      // — existing recovery semantics are kept unchanged. What changed is that
      // the start goes through the concurrency queue below (E6).
      // Build a progress summary from stored tool calls
      const toolCalls = this.db.prepare(
        'SELECT tool_name, output FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(task.sessionId ?? '') as { tool_name: string; output: string }[]

      let progressSummary = ''
      if (toolCalls.length > 0) {
        const toolSummaries = toolCalls.slice(-10).map(tc => {
          const outputPreview = tc.output?.slice(0, 200) ?? ''
          return `- ${tc.tool_name}: ${outputPreview}`
        })
        progressSummary = `\n\nProgress from previous run (${toolCalls.length} tool calls made):\n${toolSummaries.join('\n')}`
      }

      // Create a new task entry for the resumed run
      const resumedTask = this.store.create({
        name: `${task.name} (resumed)`,
        prompt: `${task.prompt}${progressSummary}\n\nNote: This task was interrupted by a server restart. Continue from where you left off.`,
        triggerType: task.triggerType,
        triggerSourceId: task.triggerSourceId ?? undefined,
        provider: task.provider ?? undefined,
        // Record the model the resumed run actually uses: for a legacy row
        // whose pin was disabled meanwhile, that is the provider default.
        model: (task.model && !pinStillEnabled && baseProvider ? getProviderDefaultModel(provider) : task.model) ?? undefined,
        isDefaultModel: task.isDefaultModel ?? undefined,
        maxDurationMinutes: task.maxDurationMinutes ?? undefined,
        sessionId: task.sessionId ?? undefined,
        // Carry the persona forward: without this the resumed row stores
        // agent_id = NULL, and the `?? 'main'` fallbacks downstream (attribution,
        // session labelling, sub-task inheritance) silently re-attribute a
        // restarted analyst/coder/advisor task to main — wrong memory root, wrong
        // per-agent model and wrong result routing (multi-persona bleeding).
        agentId: task.agentId ?? undefined,
        // Task policy: the recovered run (same provider and model, checked
        // above) thinks exactly like the original.
        thinkingLevel: task.thinkingLevel ?? undefined,
        routing: task.routing ?? undefined,
      })

      // Mark the old task as failed
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      this.store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: 'server restart — task being resumed',
        errorMessage: 'server restart',
        completedAt: now,
      })

      try {
        // E6: recovery goes through the queue — including trigger types that
        // normally bypass it. On 2026-09-26 this path restarted seven tasks
        // at once and froze the host; after a restart nothing is so urgent
        // that it may ignore the limit. `resumed` counts a task that is
        // queued for a later start as well: its row stays at
        // status='running' (startedAt NULL) and it will run without further
        // intervention.
        await this.admitTask(resumedTask, provider, undefined, undefined, true)
        resumed++
      } catch {
        // If we can't start the resumed task, mark it as failed too
        this.store.update(resumedTask.id, {
          status: 'failed',
          resultStatus: 'failed',
          resultSummary: 'Failed to resume after server restart',
          errorMessage: 'Failed to resume after server restart',
          completedAt: now,
        })
        failed++
      }
    }

    return { resumed, failed }
  }

  /**
   * Dispose all running and paused tasks, stop cleanup timer
   */
  dispose(): void {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    // Drop slots and the waiting list: nothing may be started while shutting
    // down. Queued rows stay at status='running' with startedAt = NULL and are
    // picked up by `recoverTasks` on the next boot.
    this.queue.clear()

    // Abort running tasks. `aborted` first, for the same reason as in
    // `abortTask`: the aborted run resolves and would otherwise try to write
    // a verdict (and a handoff) into a database the caller is about to close.
    for (const [, runningTask] of this.runningTasks) {
      runningTask.aborted = true
      runningTask.agent.abort()
      if (runningTask.timeoutTimer) {
        clearTimeout(runningTask.timeoutTimer)
      }
      if (runningTask.wrapUpTimer) {
        clearTimeout(runningTask.wrapUpTimer)
      }
      if (runningTask.statusUpdateTimer) {
        clearInterval(runningTask.statusUpdateTimer)
      }
      if (runningTask.progressFrameTimer) {
        clearInterval(runningTask.progressFrameTimer)
      }
    }
    this.runningTasks.clear()

    // Free paused tasks
    for (const [, pausedTask] of this.pausedTasks) {
      pausedTask.agent.abort()
    }
    this.pausedTasks.clear()
  }
}
