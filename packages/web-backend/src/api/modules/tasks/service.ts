import { TaskStore, buildTaskFilterClause, getToolCalls, resolveProviderModelInput, getProviderDefaultModel, resolveTaskOwnerUserIdForTask, toIsoUtc, timestampSortKey, getTaskCostSummary } from '@axiom/core'
import type { TaskCostSummary } from '@axiom/core'
import type {
  Database,
  ProviderConfig,
  Task,
  TaskRuntimeTaskBoundary,
  TaskStatus,
  TaskTriggerType,
} from '@axiom/core'
import type { RestartTaskInput } from './schema.js'
import type { ReplyToTask, TaskReplyResult } from '../../../task-reply.js'
import { TaskReplyNotFoundError, TaskReplyNotResumableError } from '../../../task-reply.js'
import { EMPTY_TASK_EVENTS_CURSOR } from './types.js'
import type { TaskEventsCursor, TaskTimelineEvent, TaskToolCallTimelineEvent } from './types.js'

export interface TasksServiceOptions {
  db: Database
  getTaskRuntime?: () => TaskRuntimeTaskBoundary | null
  /**
   * Resolve a provider by id or name. Required for `restartTask` so the
   * service can look up the (possibly overridden) provider the user chose
   * in the edit form. Injected from the runtime composition so the service
   * stays testable without pulling the whole provider registry.
   */
  resolveProvider?: (nameOrId: string) => ProviderConfig | null
  /**
   * Resolve the current default task provider, used by `restartTask` when
   * neither the user nor the original task pinned a specific provider.
   */
  getDefaultProvider?: () => ProviderConfig | null
  /**
   * The shared "answer a task" function (`task-reply.ts`), injected from the
   * runtime composition exactly like `getTaskRuntime`. The service does the
   * authorization, the injected function does the work — the same work a
   * Telegram reply does.
   */
  replyToTask?: ReplyToTask
}

/**
 * Who is asking. Taken from the verified JWT (`req.user`), never from the
 * request body.
 */
export interface TaskRequester {
  userId: number
  role: string
}

export interface ListTasksInput {
  status?: TaskStatus
  triggerType?: TaskTriggerType
  provider?: string
  model?: string
  isDefaultModel?: boolean
  createdFrom?: string
  createdTo?: string
  limit: number
  offset: number
}

export interface TaskProviderFilterOption {
  provider: string | null
  model: string | null
  isDefaultModel: boolean | null
}

export class TaskNotFoundError extends Error {
  constructor() {
    super('Task not found')
  }
}

export class TaskCannotBeKilledError extends Error {
  constructor(public readonly status: string) {
    super(`Cannot kill task with status '${status}'. Only running tasks can be killed.`)
  }
}

export class TaskCannotBeRestartedError extends Error {
  constructor(public readonly status: string) {
    super(`Cannot restart task with status '${status}'. Kill the task first, then restart.`)
  }
}

export class TaskRestartProviderError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export class TaskRuntimeUnavailableError extends Error {
  constructor() {
    super('Task runtime is not available — cannot restart task.')
  }
}

/**
 * The task exists but belongs to somebody else. Answered as 403 by the reply
 * endpoint — deliberately different from the reads, which hide a foreign task
 * behind a 404: the app needs to tell "gone" from "not yours" to decide
 * whether the reply box may stay open (API contract 2026-09-18, A).
 */
export class TaskForbiddenError extends Error {
  constructor() {
    super('Task belongs to another user')
  }
}

/** The runtime refused to resume a paused task (no live run to hand the text to). */
export class TaskNotResumableError extends Error {
  constructor() {
    super('Task could not be resumed')
  }
}

interface ChatMessageRow {
  id: number
  role: string
  content: string
  metadata: string | null
  timestamp: string
}

export interface GetTaskEventsOptions {
  /**
   * Only events after this cursor. Omitted / null returns the whole
   * timeline — the shipped app does not send the parameter and must keep
   * getting exactly what it got before.
   */
  since?: TaskEventsCursor | null
}

export interface TaskEventsResult {
  task: Task
  events: TaskTimelineEvent[]
  /** Hand this back as `since` on the next poll. Never goes backwards. */
  nextSince: TaskEventsCursor
}

export class TasksService {
  private readonly store: TaskStore

  constructor(private readonly options: TasksServiceOptions) {
    this.store = new TaskStore(options.db)
  }

  private getRuntime(): TaskRuntimeTaskBoundary | null {
    return this.options.getTaskRuntime?.() ?? null
  }

  listTasks(input: ListTasksInput): { tasks: Task[]; total: number; providerOptions: TaskProviderFilterOption[] } {
    const listFilters = {
      status: input.status,
      triggerType: input.triggerType,
      provider: input.provider,
      model: input.model,
      isDefaultModel: input.isDefaultModel,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      limit: input.limit,
      offset: input.offset,
    }

    const runtime = this.getRuntime()
    const tasks = runtime
      ? runtime.list(listFilters)
      : this.store.list(listFilters)

    const countFilterClause = buildTaskFilterClause(input)
    const countSql = `SELECT COUNT(*) as count FROM tasks WHERE 1=1${countFilterClause.sql}`
    const total = (
      this.options.db.prepare(countSql).get(...countFilterClause.params) as { count: number }
    ).count
    const providerOptions = this.listProviderFilterOptions(input)

    return { tasks, total, providerOptions }
  }

  private listProviderFilterOptions(input: ListTasksInput): TaskProviderFilterOption[] {
    // Provider choices must come from historical task rows for the current
    // non-provider filters (especially date range), not from today's provider
    // configuration. Intentionally ignore input.provider/model/isDefaultModel
    // here so the dropdown still shows sibling options while one provider is
    // selected.
    let sql = `
      SELECT provider, model, MAX(is_default_model) AS is_default_model
      FROM tasks
      WHERE 1=1
        AND (provider IS NOT NULL OR model IS NOT NULL OR is_default_model = 1)
    `
    const filterClause = buildTaskFilterClause(input, { includeProviderModel: false })
    sql += filterClause.sql
    sql += ' GROUP BY provider, model ORDER BY lower(provider), lower(model)'

    const rows = this.options.db.prepare(sql).all(...filterClause.params) as Array<{
      provider: string | null
      model: string | null
      is_default_model: number | null
    }>

    return rows.map(row => ({
      provider: row.provider,
      model: row.model,
      isDefaultModel:
        row.is_default_model === null || row.is_default_model === undefined
          ? null
          : row.is_default_model === 1,
    }))
  }

  /** Raw row read, no authorization. Internal use only. */
  private loadTask(id: string): Task | null {
    const runtime = this.getRuntime()
    return runtime ? runtime.getById(id) : this.store.getById(id)
  }

  /**
   * May this requester see/act on this task?
   *
   * A task carries no `user_id`; it is attributed through its session
   * lineage and, when that ends in an orphan session, through the
   * task-parent edge (`resolveTaskOwnerUserIdForTask`). Rules:
   *
   *   - owner resolves and equals the requester → allowed.
   *   - owner resolves and differs → denied (the caller answers 404, never
   *     403: a 403 would confirm that the id exists).
   *   - owner does NOT resolve (cronjob / heartbeat / consolidation, or a
   *     task that has no session yet) → system work with no human origin.
   *     Admins keep full access (the Tasks console lists exactly these),
   *     everyone else is denied. Nothing is guessed in this branch.
   *
   * The task-parent hop was added because a sub-task — a task a task
   * delegated with `create_task` — has a session of its own with no parent
   * (the background task tools pass `parentSessionId = null` deliberately),
   * so the session walk alone answered null and the API hid the sub-task
   * from the very user who started the chain. Measured live: parent
   * `1acb92bd…` 200, child `cef64106…` 404.
   */
  private canAccess(task: Task, requester: TaskRequester): boolean {
    if (requester.role === 'admin') return true
    const ownerId = resolveTaskOwnerUserIdForTask(this.options.db, task)
    if (ownerId == null) return false
    return ownerId === requester.userId
  }

  /**
   * The task, or null when it does not exist OR the requester may not see
   * it. Callers cannot tell the two apart — that is deliberate.
   */
  getTaskById(id: string, requester: TaskRequester): Task | null {
    const task = this.loadTask(id)
    if (!task) return null
    return this.canAccess(task, requester) ? task : null
  }

  /**
   * Cost of a task INCLUDING every sub-task it delegated (token audit
   * 2026-09-17, P7a). The task row itself only carries one agent run, so a
   * delegating task looks cheap without this. Returns null when the task is
   * not visible to the requester; never throws (accounting must not break a
   * detail view).
   */
  getTaskCost(id: string, requester: TaskRequester): TaskCostSummary | null {
    const task = this.getTaskById(id, requester)
    if (!task) return null
    try {
      return getTaskCostSummary(this.options.db, task.id)
    } catch {
      return null
    }
  }

  getTaskEvents(taskId: string, requester: TaskRequester, options?: GetTaskEventsOptions): TaskEventsResult {
    const task = this.getTaskById(taskId, requester)
    if (!task) {
      throw new TaskNotFoundError()
    }

    const since = options?.since ?? null

    // Tasks created since PRD #11 always have a UUID sessionId registered
    // in the `sessions` table. Legacy tasks without a sessionId have no
    // historical events to load.
    const sessionId = task.sessionId
    if (!sessionId) {
      return { task, events: [], nextSince: since ?? EMPTY_TASK_EVENTS_CURSOR }
    }

    // Read the head FIRST and page both sources through it. Without the
    // upper bound, a row inserted between the two reads would be counted
    // into `nextSince` without having been delivered — and a client that
    // advances its cursor past an event it never saw loses it for good.
    const head = this.options.db.prepare(
      `SELECT COALESCE((SELECT MAX(id) FROM tool_calls WHERE session_id = ?), 0) AS toolCallId,
              COALESCE((SELECT MAX(id) FROM chat_messages WHERE session_id = ?), 0) AS messageId`,
    ).get(sessionId, sessionId) as TaskEventsCursor

    const toolCalls: TaskToolCallTimelineEvent[] = getToolCalls(this.options.db, {
      sessionId,
      ...(since ? { afterId: since.toolCallId } : {}),
      throughId: head.toolCallId,
    })
      .reverse()
      .map((toolCall) => ({
        type: 'tool_call' as const,
        // Same normalization as the message rows below — the merge compares
        // both, and a naked SQLite string is not comparable to an ISO one.
        timestamp: toolCall.timestamp ? toIsoUtc(toolCall.timestamp) : toolCall.timestamp,
        toolName: toolCall.toolName,
        input: toolCall.input,
        output: toolCall.output,
        durationMs: toolCall.durationMs,
        status: toolCall.status ?? 'success',
      }))

    const messages = (this.options.db.prepare(
      // `id` breaks the tie inside one second, which is where a task writes
      // most of its rows. The role filter is in SQL so a `since` read does
      // not drag the content of user/tool rows out of the database only to
      // drop them here.
      `SELECT id, role, content, metadata, timestamp FROM chat_messages
       WHERE session_id = ? AND role IN ('assistant', 'system') AND id > ? AND id <= ?
       ORDER BY timestamp ASC, id ASC`,
    ).all(sessionId, since?.messageId ?? 0, head.messageId) as ChatMessageRow[])
      .map((message) => ({
        type: 'message' as const,
        timestamp: toIsoUtc(message.timestamp),
        role: message.role,
        content: message.content,
        metadata: safeParseJson(message.metadata),
      }))

    // Compare instants, not strings: `'T' > ' '` would sort every ISO row
    // after every naked one, and the sort is stable for equal instants.
    const events = [...toolCalls, ...messages].sort((a, b) =>
      timestampSortKey(a.timestamp) - timestampSortKey(b.timestamp),
    )

    // Monotone by construction: the head only grows, and a cursor from the
    // client never pushes it back (a stale or foreign cursor with higher
    // ids simply yields nothing instead of replaying the run).
    const nextSince: TaskEventsCursor = {
      toolCallId: Math.max(head.toolCallId, since?.toolCallId ?? 0),
      messageId: Math.max(head.messageId, since?.messageId ?? 0),
    }

    return { task, events, nextSince }
  }

  killTask(taskId: string, requester: TaskRequester): Task {
    const task = this.getTaskById(taskId, requester)
    if (!task) {
      throw new TaskNotFoundError()
    }

    if (task.status !== 'running') {
      throw new TaskCannotBeKilledError(task.status)
    }

    const runtime = this.getRuntime()
    if (runtime) {
      runtime.abort(task.id, 'Killed by user from web UI')
    } else {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      this.store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: 'Killed by user from web UI',
        errorMessage: 'Killed by user from web UI',
        completedAt: now,
      })
    }

    const updatedTask = this.loadTask(task.id)
    if (!updatedTask) {
      throw new TaskNotFoundError()
    }

    return updatedTask
  }

  /**
   * Answer a task: resume it when paused, refuse while it runs, start a
   * follow-up when it is finished. The decision tree itself lives in
   * `task-reply.ts` and is shared with the Telegram path; this method only
   * authorizes the request.
   *
   * Authorization differs from the reads on purpose (see
   * {@link TaskForbiddenError}): unknown id → 404, foreign task → 403.
   */
  async replyToTask(taskId: string, text: string, requester: TaskRequester): Promise<TaskReplyResult> {
    const task = this.loadTask(taskId)
    if (!task) throw new TaskNotFoundError()
    if (!this.canAccess(task, requester)) throw new TaskForbiddenError()

    const reply = this.options.replyToTask
    if (!reply) throw new TaskRuntimeUnavailableError()

    try {
      return await reply({
        taskId: task.id,
        text,
        // No agentId: the follow-up inherits the persona of the task it
        // answers, it must not move to the requester's chat persona.
        userId: String(requester.userId),
        // SPEC/contract: the follow-up hangs off the requester's `app` session,
        // so its result is delivered back into the app.
        source: 'app',
      })
    } catch (err) {
      if (err instanceof TaskReplyNotFoundError) throw new TaskNotFoundError()
      if (err instanceof TaskReplyNotResumableError) throw new TaskNotResumableError()
      throw err
    }
  }

  /**
   * Clone the given task into a new row with optional field overrides and
   * start it immediately. The original row is left untouched — historical
   * tasks stay visible with their results / failure reasons intact.
   *
   * Rules (agreed with the user):
   *   - Only allowed on `completed` / `failed` tasks. `running` / `paused`
   *     must be killed first.
   *   - The new task always has `triggerType='user'`, even when the original
   *     was a `cronjob` / `heartbeat` / `consolidation` — the user triggered
   *     this run manually, so the cronjob binding is not inherited.
   *   - Any field the client omits inherits from the original.
   *   - The new task gets a fresh session id (handled by the task runner).
   */
  async restartTask(taskId: string, overrides: RestartTaskInput, requester: TaskRequester): Promise<Task> {
    const original = this.getTaskById(taskId, requester)
    if (!original) {
      throw new TaskNotFoundError()
    }

    if (original.status === 'running' || original.status === 'paused') {
      throw new TaskCannotBeRestartedError(original.status)
    }

    const runtime = this.getRuntime()
    if (!runtime) {
      throw new TaskRuntimeUnavailableError()
    }

    // Resolve (provider, model): explicit override wins; otherwise inherit
    // the original's pinned provider/model; otherwise fall back to the
    // configured task default. This matches the behaviour of `create_task`.
    const providerInput = overrides.provider ?? original.provider ?? undefined
    const modelInput = overrides.model ?? original.model ?? undefined

    let provider: ProviderConfig
    let isDefaultModel: boolean

    if (providerInput || modelInput) {
      const resolved = resolveProviderModelInput({ provider: providerInput, model: modelInput })
      if (!resolved.ok) {
        throw new TaskRestartProviderError(resolved.error)
      }
      const base = this.options.resolveProvider?.(resolved.providerId) ?? null
      if (!base) {
        throw new TaskRestartProviderError(
          `Provider "${resolved.providerName}" could not be loaded.`,
        )
      }
      provider = resolved.modelId === getProviderDefaultModel(base)
        ? base
        : { ...base, enabledModels: [resolved.modelId] }
      // Only treat as "default" when the client explicitly selected no
      // provider/model *and* we fell back to default above — which isn't
      // this branch.
      isDefaultModel = false
    } else {
      const def = this.options.getDefaultProvider?.() ?? null
      if (!def) {
        throw new TaskRestartProviderError(
          'No default task provider is configured. Set one in Settings → Tasks, or pick a provider in the restart form.',
        )
      }
      provider = def
      isDefaultModel = true
    }

    // Build the new task row. The new task always becomes a user-triggered
    // task, with no link back to the original cronjob/heartbeat schedule.
    const newTask = runtime.create({
      name: overrides.name ?? original.name,
      prompt: overrides.prompt ?? original.prompt,
      triggerType: 'user',
      provider: provider.name,
      model: getProviderDefaultModel(provider),
      isDefaultModel,
      maxDurationMinutes: overrides.maxDurationMinutes
        ?? (original.maxDurationMinutes ?? undefined),
    })

    // Start the task. `startTask` now marks the row as `failed` on early
    // setup errors (invalid provider, missing API key, …), so a throw here
    // leaves the DB consistent. We surface the error to the caller so the
    // UI can show it instead of silently landing on a failed row.
    await runtime.start(newTask, provider)

    // Re-fetch to capture `startedAt` / status updates from the runner.
    return this.loadTask(newTask.id) ?? newTask
  }
}

export function createTasksService(options: TasksServiceOptions): TasksService {
  return new TasksService(options)
}

function safeParseJson(rawValue: string | null): unknown {
  if (!rawValue) return null
  try {
    return JSON.parse(rawValue)
  } catch {
    // Historical rows may contain non-JSON metadata (legacy data, truncation,
    // etc.). Fall back to the raw string so a single bad row doesn't break
    // the whole timeline request.
    return rawValue
  }
}
