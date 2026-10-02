import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import type { Task } from './task-store.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'
import { getCurrentTaskExecutionContext } from './task-execution-context.js'
import { getToolCalls } from './token-logger.js'
import { timestampSortKey, toIsoUtc } from './timestamps.js'
import { formatTaskRouting } from './task-policy.js'
import { getTaskCostSummary } from './task-cost.js'
import { resolveTaskStrandId } from './task-tree.js'
import {
  cancelTaskTree,
  getManageableTask,
  isActiveTaskStatus,
  listActiveDescendants,
} from './task-control.js'
import type { TaskControlCaller } from './task-control.js'

export interface TaskControlToolsOptions {
  taskRuntime: TaskRuntimeTaskBoundary
  db: Database
  /**
   * User of the interactive turn calling the tool. Inside a background task
   * the ALS task context is used instead and this is never consulted.
   */
  getCurrentUserId?: () => number | undefined
  /** Persona of the interactive turn calling the tool. */
  getCurrentAgentId?: () => string | undefined
}

export const CANCEL_REASON_MAX_CHARS = 300
export const STEER_MESSAGE_MAX_CHARS = 4000
const DEFAULT_EVENT_LIMIT = 15
const MAX_EVENT_LIMIT = 50
const INSPECT_OUTPUT_MAX_CHARS = 9000

function resolveCaller(options: TaskControlToolsOptions): TaskControlCaller {
  const ctx = getCurrentTaskExecutionContext()
  if (ctx?.taskId) {
    return { kind: 'task', taskId: ctx.taskId, userId: ctx.userId ?? null, agentId: ctx.agentId ?? null }
  }
  return {
    kind: 'strand',
    userId: options.getCurrentUserId?.() ?? null,
    agentId: options.getCurrentAgentId?.() ?? null,
  }
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], details: { error: true } }
}

function notFound(taskId: string) {
  return errorResult(`Task "${taskId}" not found or not manageable from here. You can only manage tasks of your own user/persona; inside a background task only the sub-tasks it started.`)
}

function truncate(value: unknown, max: number): string {
  const text = (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)) ?? ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}… [+${flat.length - max} chars]` : flat
}

function minutesBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso) return null
  const start = timestampSortKey(startIso)
  const end = endIso ? timestampSortKey(endIso) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, Math.round((end - start) / 60000))
}

function callerLabel(caller: TaskControlCaller): string {
  return caller.kind === 'task'
    ? `Cancelled by parent task ${caller.taskId.slice(0, 8)}`
    : 'Cancelled by strand orchestrator'
}

function liveState(runtime: TaskRuntimeTaskBoundary, task: Task): string {
  if (task.status === 'paused') {
    return runtime.isPaused(task.id)
      ? 'paused — waiting for an answer (resume_task or steer_task)'
      : 'paused — agent no longer in memory, can only be cancelled'
  }
  if (task.status !== 'running') return task.status
  const queue = runtime.queueInfo?.(task.id)
  if (queue?.queued) {
    const why = queue.reason === 'provider'
      ? `provider limit ${queue.provider_limit}, ${queue.provider_running} running on it`
      : `global limit ${queue.limit}`
    return `queued — position ${queue.position} of ${queue.queued_count} (${why})`
  }
  return runtime.isRunning(task.id) ? 'running' : 'running (no live agent — stale row, cancel to clean up)'
}

interface InspectEvent {
  at: string
  line: string
}

function recentEvents(db: Database, sessionId: string, limit: number): InspectEvent[] {
  const tools = getToolCalls(db, { sessionId, limit }).map((call) => ({
    at: call.timestamp ? toIsoUtc(call.timestamp) : '',
    line: `tool ${call.toolName} [${call.status ?? 'success'}${call.durationMs != null ? `, ${call.durationMs}ms` : ''}] args: ${truncate(call.input, 160)} → ${truncate(call.output, 220)}`,
  }))
  const messages = (db.prepare(
    `SELECT role, content, timestamp FROM chat_messages
      WHERE session_id = ? AND role IN ('assistant', 'system', 'user')
      ORDER BY id DESC LIMIT ?`,
  ).all(sessionId, limit) as Array<{ role: string; content: string; timestamp: string }>)
    .map((row) => ({ at: toIsoUtc(row.timestamp), line: `${row.role}: ${truncate(row.content, 260)}` }))
  return [...tools, ...messages]
    .sort((a, b) => timestampSortKey(a.at) - timestampSortKey(b.at))
    .slice(-limit)
}

export function formatTaskInspection(
  db: Database,
  runtime: TaskRuntimeTaskBoundary,
  task: Task,
  eventLimit: number,
): string {
  const lines: string[] = []
  lines.push(`Task "${task.name}" (${task.id})`)
  lines.push(`Status: ${liveState(runtime, task)}${task.resultStatus ? ` | result: ${task.resultStatus}` : ''}`)

  const parent = task.triggerType === 'agent' && task.triggerSourceId ? ` | parent task: ${task.triggerSourceId}` : ''
  let strand: string | null = null
  try { strand = resolveTaskStrandId(db, task) } catch { strand = null }
  lines.push(`Trigger: ${task.triggerType}${parent}${strand ? ` | strand: ${strand}` : ''}${task.agentId ? ` | persona: ${task.agentId}` : ''}`)

  lines.push(`Model: ${task.routing ? formatTaskRouting(task.routing) : `${task.provider ?? '?'} / ${task.model ?? 'default'}${task.thinkingLevel ? ` · thinking ${task.thinkingLevel}` : ''}`}`)

  const runtimeMin = minutesBetween(task.startedAt, task.completedAt)
  lines.push(`Runtime: ${runtimeMin === null ? 'not started' : `${runtimeMin} min`}${task.maxDurationMinutes ? ` of ${task.maxDurationMinutes} min budget` : ''} | created ${task.createdAt}`)

  lines.push(`Usage: ${task.promptTokens + task.completionTokens} tokens (in ${task.promptTokens}, out ${task.completionTokens}, cache read ${task.cacheRead}) | cost $${task.estimatedCost.toFixed(4)} | ${task.toolCallCount} tool calls${task.status === 'running' ? ' (live values are written when the run ends)' : ''}`)

  try {
    const cost = getTaskCostSummary(db, task.id)
    const active = listActiveDescendants(db, task.id)
    if (cost && cost.descendants > 0) {
      lines.push(`Sub-tasks: ${cost.descendants} total, ${active.length} active${active.length ? ` (${active.slice(0, 5).map((d) => `${d.id.slice(0, 8)} ${d.status}`).join(', ')}${active.length > 5 ? ', …' : ''})` : ''} | incl. sub-tasks: ${cost.subtree.promptTokens + cost.subtree.completionTokens} tokens, $${cost.subtree.estimatedCost.toFixed(4)}`)
    }
  } catch {
    // Accounting is informational; never fail the inspection over it.
  }

  if (task.resultSummary) {
    const label = task.resultStatus === 'question' ? 'Question' : task.status === 'failed' ? 'Result (failed)' : 'Result'
    lines.push(`${label}: ${truncate(task.resultSummary, 1500)}`)
  }
  if (task.errorMessage && task.errorMessage !== task.resultSummary) {
    lines.push(`Error: ${truncate(task.errorMessage, 500)}`)
  }

  if (task.sessionId && eventLimit > 0) {
    let events: InspectEvent[] = []
    try { events = recentEvents(db, task.sessionId, eventLimit) } catch { events = [] }
    lines.push('')
    lines.push(events.length
      ? `Recent activity (last ${events.length}, oldest first):\n${events.map((e) => `- ${e.at.slice(11, 19)} ${e.line}`).join('\n')}`
      : 'Recent activity: none recorded yet.')
  } else if (!task.sessionId) {
    lines.push('Recent activity: none (task has not started yet).')
  }

  const text = lines.join('\n')
  return text.length > INSPECT_OUTPUT_MAX_CHARS
    ? `${text.slice(0, INSPECT_OUTPUT_MAX_CHARS)}\n… [output truncated]`
    : text
}

/** Create the `get_task` agent tool (inspect one task in depth). */
export function createGetTaskTool(options: TaskControlToolsOptions): AgentTool {
  return {
    name: 'get_task',
    label: 'Inspect Background Task',
    description:
      'Inspect one background task in depth: live status (running / queued with position / paused with its question / finished), model routing, runtime, ' +
      'tokens and cost (incl. sub-tasks), parent task and strand, result or error, and its last tool calls and messages (truncated). ' +
      'Use it to check whether a task you started is on track before steering (steer_task) or stopping it (cancel_task).',
    parameters: Type.Object({
      task_id: Type.String({ description: 'The ID of the task to inspect.' }),
      events: Type.Optional(Type.Number({
        description: `How many recent tool calls/messages to include (default ${DEFAULT_EVENT_LIMIT}, max ${MAX_EVENT_LIMIT}, 0 = none).`,
      })),
    }),
    execute: async (_toolCallId, params) => {
      const { task_id, events } = params as { task_id: string; events?: number }
      try {
        const caller = resolveCaller(options)
        const task = getManageableTask(options.db, options.taskRuntime, caller, String(task_id ?? '').trim())
        if (!task) return notFound(task_id)
        const limit = Math.max(0, Math.min(Math.floor(events ?? DEFAULT_EVENT_LIMIT), MAX_EVENT_LIMIT))
        const text = formatTaskInspection(options.db, options.taskRuntime, task, Number.isFinite(limit) ? limit : DEFAULT_EVENT_LIMIT)
        return {
          content: [{ type: 'text' as const, text }],
          details: { taskId: task.id, status: task.status, resultStatus: task.resultStatus },
        }
      } catch (err) {
        return errorResult(`inspecting task failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

/** Create the `cancel_task` agent tool. */
export function createCancelTaskTool(options: TaskControlToolsOptions): AgentTool {
  return {
    name: 'cancel_task',
    label: 'Cancel Background Task',
    description:
      'Stop a background task that is running, queued or paused — e.g. when it goes in the wrong direction, duplicates another run, or is no longer needed. ' +
      'Its active sub-tasks are cancelled with it. The reason is recorded on the task and shown to the user. ' +
      'Prefer steer_task when a correction is enough. Finished tasks cannot be cancelled.',
    parameters: Type.Object({
      task_id: Type.String({ description: 'The ID of the task to cancel.' }),
      reason: Type.String({ description: `Short reason, shown to the user (max ${CANCEL_REASON_MAX_CHARS} characters), e.g. "duplicates task 1a2b3c4d".` }),
    }),
    execute: async (_toolCallId, params) => {
      const { task_id, reason } = params as { task_id: string; reason: string }
      try {
        const trimmedReason = String(reason ?? '').replace(/\s+/g, ' ').trim()
        if (!trimmedReason) return errorResult('reason is required.')
        const caller = resolveCaller(options)
        const task = getManageableTask(options.db, options.taskRuntime, caller, String(task_id ?? '').trim())
        if (!task) return notFound(task_id)

        const recorded = `${callerLabel(caller)}: ${truncate(trimmedReason, CANCEL_REASON_MAX_CHARS)}`
        if (!isActiveTaskStatus(task.status) && listActiveDescendants(options.db, task.id).length === 0) {
          return errorResult(`Task "${task.name}" (${task.id}) is already ${task.status}; nothing to cancel.`)
        }

        const outcome = cancelTaskTree(options.db, options.taskRuntime, task, recorded)
        const after = options.taskRuntime.getById(task.id)
        const children = outcome.cancelledDescendants
        const childLine = children.length
          ? `\nAlso cancelled ${children.length} sub-task(s): ${children.map((c) => `${c.name} (${c.id})`).join(', ')}`
          : ''
        const head = outcome.rootCancelled
          ? `Task "${task.name}" (${task.id}) cancelled (was ${outcome.rootStatusBefore}; now ${after?.status ?? 'unknown'}).`
          : `Task "${task.name}" (${task.id}) was already ${outcome.rootStatusBefore}; only its remaining sub-tasks were cancelled.`
        return {
          content: [{ type: 'text' as const, text: `${head}${childLine}\nRecorded reason: ${recorded}\nA failure notification for the cancelled task(s) will follow — no reaction needed beyond what you planned.` }],
          details: {
            taskId: task.id,
            cancelled: outcome.rootCancelled,
            previousStatus: outcome.rootStatusBefore,
            status: after?.status ?? null,
            reason: recorded,
            cancelledSubTasks: children.map((c) => c.id),
          },
        }
      } catch (err) {
        return errorResult(`cancelling task failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

export function formatOrchestratorSteer(message: string, caller: TaskControlCaller): string {
  const from = caller.kind === 'task' ? `parent task ${caller.taskId.slice(0, 8)}` : 'strand orchestrator'
  return `<orchestrator_steer from="${from}">\n${message}\n</orchestrator_steer>\n`
    + 'This is a course correction from the agent that delegated this task. Follow it; where it conflicts with the original brief, it wins. Continue the task with it.'
}

/** Create the `steer_task` agent tool (correct a task without stopping it). */
export function createSteerTaskTool(options: TaskControlToolsOptions): AgentTool {
  return {
    name: 'steer_task',
    label: 'Steer Background Task',
    description:
      'Send a course correction to a background task without stopping it. Running task: the message is injected as an <orchestrator_steer> ' +
      'after its current step. Queued task: appended to its brief before it starts. Paused task: delivered as the answer that resumes it. ' +
      'Finished tasks cannot be steered (start a new task, optionally with continuation_of).',
    parameters: Type.Object({
      task_id: Type.String({ description: 'The ID of the task to steer.' }),
      message: Type.String({ description: `The correction, self-contained and specific (max ${STEER_MESSAGE_MAX_CHARS} characters). The task cannot see this conversation.` }),
    }),
    execute: async (_toolCallId, params) => {
      const { task_id, message } = params as { task_id: string; message: string }
      try {
        const text = String(message ?? '').trim()
        if (!text) return errorResult('message is required.')
        if (text.length > STEER_MESSAGE_MAX_CHARS) {
          return errorResult(`message too long (${text.length} chars, max ${STEER_MESSAGE_MAX_CHARS}). Shorten it.`)
        }
        const caller = resolveCaller(options)
        const task = getManageableTask(options.db, options.taskRuntime, caller, String(task_id ?? '').trim())
        if (!task) return notFound(task_id)

        const wrapped = formatOrchestratorSteer(text, caller)
        const label = `"${task.name}" (${task.id})`

        if (task.status === 'paused') {
          if (!options.taskRuntime.isPaused(task.id)) {
            return errorResult(`Task ${label} is paused but its agent is no longer in memory; it cannot be resumed. Cancel it and start a new task.`)
          }
          const resumed = await options.taskRuntime.resume(task.id, wrapped)
          if (!resumed) return errorResult(`Task ${label} could not be resumed.`)
          return {
            content: [{ type: 'text' as const, text: `Delivered: task ${label} was paused and has been resumed with your correction.` }],
            details: { taskId: task.id, delivered: true, mode: 'resumed' },
          }
        }

        if (task.status !== 'running') {
          return errorResult(`Task ${label} is already ${task.status}; it cannot be steered. Start a new task (optionally with continuation_of: "${task.id}").`)
        }

        if (!options.taskRuntime.steer) return errorResult('steering is not available in this runtime.')
        const result = options.taskRuntime.steer(task.id, wrapped)
        if (!result.delivered) {
          return {
            content: [{ type: 'text' as const, text: `Not delivered: ${result.reason ?? 'the task cannot take a correction right now'}. Inspect it with get_task; cancel_task if it must stop.` }],
            details: { taskId: task.id, delivered: false, mode: result.mode, error: true },
          }
        }
        const how = result.mode === 'queued_prompt'
          ? 'the task is still queued, so the correction was appended to its brief and applies from its first step'
          : 'it will be read after the task\'s current step (in-flight tool calls finish first)'
        return {
          content: [{ type: 'text' as const, text: `Delivered to task ${label}: ${how}. Check the effect later with get_task.` }],
          details: { taskId: task.id, delivered: true, mode: result.mode },
        }
      } catch (err) {
        return errorResult(`steering task failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

/** The three orchestrator control tools, in registration order. */
export function createTaskControlTools(options: TaskControlToolsOptions): AgentTool[] {
  return [createGetTaskTool(options), createSteerTaskTool(options), createCancelTaskTool(options)]
}
