/**
 * task-reply.ts: answering a background task, transport neutral.
 *
 * Replying to a task used to exist only inside the Telegram handler
 * (`handleTelegramTaskReply` in `bootstrap/runtime-composition.ts`). The app
 * needs the same thing over HTTP (`POST /api/tasks/:id/reply`), and the rule
 * for that is: ONE code path, two formatters. This module owns the decision
 * tree, the Telegram handler and the HTTP controller only turn the result
 * into their own wire shape.
 *
 * The decision tree is unchanged:
 *   - `paused`    → resume the run with the user's text
 *   - `running`   → say so, change nothing
 *   - otherwise   → start a follow-up task on the SAME provider/model/persona,
 *                   carrying the previous prompt and result as context
 *
 * Callers that cannot act on a task answer with the typed errors below:
 * {@link TaskReplyNotFoundError} (unknown id) and
 * {@link TaskReplyNotResumableError} (the runtime refused the resume).
 */
import type { ProviderConfig, TaskRuntimeTaskBoundary } from '@axiom/core'
import { getProviderDefaultModel } from '@axiom/core'

export type TaskReplyOutcome = 'resumed' | 'running' | 'follow_up'

export interface TaskReplyResult {
  outcome: TaskReplyOutcome
  /** The task that was replied to — NOT the follow-up. */
  taskId: string
  /** Set only for `outcome: 'follow_up'`: the task that was just started. */
  followUpTaskId?: string
  /** Human readable one-liner, rendered verbatim by Telegram and the app. */
  message: string
}

export interface TaskReplyInput {
  taskId: string
  /** Already trimmed and length-checked by the caller. */
  text: string
  /**
   * Persona the follow-up runs as. Omitted (HTTP) means "the persona of the
   * task that is being replied to" — a reply must not move the work to
   * another persona.
   */
  agentId?: string
  /** Numeric user id as a string; `null` disables the session lineage link. */
  userId: string | null
  /** Session source the follow-up is linked to: `telegram`, `app`, `web`. */
  source: string
}

export class TaskReplyNotFoundError extends Error {
  constructor() {
    super('Task not found')
    this.name = 'TaskReplyNotFoundError'
  }
}

export class TaskReplyNotResumableError extends Error {
  constructor() {
    super('Task could not be resumed')
    this.name = 'TaskReplyNotResumableError'
  }
}

export interface TaskReplyDeps {
  tasks: TaskRuntimeTaskBoundary
  /** Resolve a provider by id or name (the task row stores the name). */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /** Fallback provider when the task pinned none (or its provider is gone). */
  getDefaultProvider: () => ProviderConfig
  /** Duration budget for the follow-up, read per call (settings can change). */
  getMaxDurationMinutes: () => number
  /**
   * Session of the replying user, used as `parentSessionId` so the follow-up's
   * result is delivered back to the channel the reply came from. `null` when
   * there is no agent core / no user.
   */
  getParentSessionId: (userId: string, source: string, agentId: string) => string | null
}

export type ReplyToTask = (input: TaskReplyInput) => Promise<TaskReplyResult>

export function createTaskReply(deps: TaskReplyDeps): ReplyToTask {
  return async function replyToTask(input: TaskReplyInput): Promise<TaskReplyResult> {
    const task = deps.tasks.getById(input.taskId)
    if (!task) throw new TaskReplyNotFoundError()

    if (task.status === 'paused') {
      const resumed = await deps.tasks.resume(input.taskId, input.text)
      if (!resumed) throw new TaskReplyNotResumableError()
      return {
        outcome: 'resumed',
        taskId: task.id,
        message: `▶️ Answer passed to task "${task.name}" — it continues in the background.`,
      }
    }

    if (task.status === 'running') {
      return {
        outcome: 'running',
        taskId: task.id,
        message: `⏳ Task "${task.name}" is still running — reply again once it has finished.`,
      }
    }

    // completed / failed → follow-up task with previous prompt+result as context
    const baseProvider = task.provider ? deps.resolveProvider(task.provider) : null
    const provider = baseProvider && task.model
      ? { ...baseProvider, enabledModels: [task.model] }
      : (baseProvider ?? deps.getDefaultProvider())

    const prevPrompt = task.prompt.length > 3000 ? `${task.prompt.slice(0, 3000)}…` : task.prompt
    const prevResult = (task.resultSummary ?? '(no result summary)').slice(0, 4000)
    const followUpPrompt = [
      '<previous_task>',
      `Status: ${task.status}${task.resultStatus ? ` (${task.resultStatus})` : ''}`,
      `Prompt:\n${prevPrompt}`,
      `Result:\n${prevResult}`,
      '</previous_task>',
      '',
      `Follow-up from the user: ${input.text}`,
    ].join('\n')

    const previewText = input.text.length > 50 ? `${input.text.slice(0, 50)}…` : input.text
    // The reply never changes persona: an HTTP caller sends no agentId and
    // inherits the one of the task it answers.
    const agentId = input.agentId ?? task.agentId ?? 'main'
    const followUp = deps.tasks.create({
      name: `Follow-up: ${previewText}`,
      prompt: followUpPrompt,
      triggerType: 'user',
      provider: provider.name,
      model: getProviderDefaultModel(provider),
      isDefaultModel: !task.provider,
      maxDurationMinutes: deps.getMaxDurationMinutes(),
      agentId,
    })

    const parentSessionId = input.userId
      ? deps.getParentSessionId(input.userId, input.source, agentId)
      : null
    await deps.tasks.start(followUp, provider, undefined, parentSessionId)

    return {
      outcome: 'follow_up',
      taskId: task.id,
      followUpTaskId: followUp.id,
      message: `🔁 Follow-up task started on ${provider.name} (${getProviderDefaultModel(provider)}).\n`
        + `Task: ${followUp.name}\nID: ${followUp.id}`,
    }
  }
}
