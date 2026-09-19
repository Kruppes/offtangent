import type { Task, TaskCostSummary } from '@axiom/core'
import { formatTaskEventsCursor } from './schema.js'
import type { TaskProviderFilterOption } from './service.js'
import { EMPTY_TASK_EVENTS_CURSOR, type TaskEventsCursor, type TaskTimelineEvent } from './types.js'

export function mapTasksListResponse(input: {
  tasks: Task[]
  page: number
  limit: number
  total: number
  providerOptions?: TaskProviderFilterOption[]
}) {
  return {
    tasks: input.tasks,
    pagination: {
      page: input.page,
      limit: input.limit,
      total: input.total,
      totalPages: Math.ceil(input.total / input.limit),
    },
    providerOptions: input.providerOptions ?? [],
  }
}

/**
 * `GET /api/tasks/:id` → the full task row, unfiltered.
 *
 * Live shape, verified against the production instance on 2026-09-15
 * (task 0c8f0efe-…, status `running`, `curl` from inside the container):
 *
 * ```json
 * { "task": {
 *   "id": "0c8f0efe-3d2c-478b-9167-56457c490cef",
 *   "name": "OT Backend: Task-Tokens im Baum + Frames",
 *   "prompt": "Du arbeitest am Offtangent-Backend …",   // full text, can be long
 *   "status": "running",                 // queued|running|paused|completed|failed
 *   "triggerType": "agent",              // user|agent|cronjob|heartbeat|consolidation
 *   "triggerSourceId": null,             // parent task id for triggerType=agent
 *   "provider": "Anthropic", "model": "claude-opus-5", "isDefaultModel": false,
 *   "maxDurationMinutes": 75,
 *   "promptTokens": 78, "completionTokens": 8221,
 *   "cacheRead": 1308532, "cacheWrite": 55092,
 *   "estimatedCost": 1.204506,           // USD, float
 *   "toolCallCount": 38,
 *   "resultSummary": null, "resultStatus": null, "errorMessage": null,
 *   "createdAt": "2026-09-15 12:46:38",  // SQLite UTC, NOT ISO-8601
 *   "startedAt": "2026-09-15 12:46:38", "completedAt": null,
 *   "sessionId": "0b106d9b-…",           // the task's OWN session
 *   "agentId": "bob", "outputSchema": null, "contextMode": "clean"
 * } }
 * ```
 *
 * The usage counters are live: the runner persists them on every
 * `message_end`, so polling this endpoint during a run shows them climb.
 */
export function mapTaskResponse(task: Task, cost?: TaskCostSummary | null) {
  // `cost` is additive (token audit 2026-09-17, P7a): `cost.own` mirrors the
  // task row, `cost.subtree` adds every sub-task the task delegated. Omitted
  // when the aggregation is unavailable, so existing clients are unaffected.
  return cost ? { task, cost } : { task }
}

/**
 * `GET /api/tasks/:id/events` → the task's timeline, oldest first.
 *
 * Live shape, verified against the production instance on 2026-09-15 for a
 * RUNNING task (56 events after ~2 min: 39 `tool_call`, 17 `message`), so a
 * client can render the timeline while the task still works:
 *
 * ```json
 * { "events": [
 *     { "type": "tool_call",
 *       "timestamp": "2026-09-15T12:46:40.000Z",   // ISO-8601 UTC
 *       "toolName": "read_file",
 *       "input": "{\"path\":\"/data/…\"}",          // JSON *string*
 *       "output": "{\"content\":[{\"type\":\"text\",…}]}", // JSON string, can be huge
 *       "durationMs": 5,
 *       "status": "success" },                     // success|error
 *     { "type": "message",
 *       "timestamp": "2026-09-15T12:46:40.000Z",
 *       "role": "assistant",                       // assistant|system only
 *       "content": "I'll start by reading the plan file…",
 *       "metadata": { "type": "assistant_message", "provider": "anthropic",
 *                     "model": "claude-opus-5", "thinking": "…" } }
 *   ],
 *   "task": { "id", "name", "status", "triggerType", "prompt", "provider",
 *             "model", "isDefaultModel", "maxDurationMinutes",
 *             "resultSummary", "errorMessage",
 *             "promptTokens", "completionTokens", "cacheRead",
 *             "cacheWrite", "estimatedCost", "toolCallCount" } }
 * ```
 *
 * Notes for clients:
 *   - `metadata` is already parsed JSON (or the raw string for legacy rows).
 *     `content` is empty when the assistant turn was pure thinking.
 *   - `events` is [] for a legacy task without `sessionId`.
 *   - The usage fields on `task` were added so a task detail view does not
 *     need a second call to `GET /api/tasks/:id`.
 *   - `nextSince` (added 2026-09-15) is the cursor for the next poll:
 *     `GET /api/tasks/:id/events?since=t<n>-m<n>` returns only the events
 *     after it, with the same `task` block and a fresh `nextSince`. Without
 *     the parameter `events` is the full timeline, exactly as before — only
 *     this one extra top-level field is new, and every client of this API
 *     parses with unknown keys ignored.
 */
export function mapTaskEventsResponse(input: {
  task: Task
  events: TaskTimelineEvent[]
  nextSince?: TaskEventsCursor
}) {
  return {
    events: input.events,
    nextSince: formatTaskEventsCursor(input.nextSince ?? EMPTY_TASK_EVENTS_CURSOR),
    task: {
      id: input.task.id,
      name: input.task.name,
      status: input.task.status,
      triggerType: input.task.triggerType,
      prompt: input.task.prompt,
      provider: input.task.provider,
      model: input.task.model,
      isDefaultModel: input.task.isDefaultModel,
      maxDurationMinutes: input.task.maxDurationMinutes,
      resultSummary: input.task.resultSummary,
      errorMessage: input.task.errorMessage,
      promptTokens: input.task.promptTokens,
      completionTokens: input.task.completionTokens,
      cacheRead: input.task.cacheRead,
      cacheWrite: input.task.cacheWrite,
      estimatedCost: input.task.estimatedCost,
      toolCallCount: input.task.toolCallCount,
    },
  }
}
