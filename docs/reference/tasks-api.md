# Tasks API

Reference for the single-task endpoints under `/api/tasks`. All of them are
JWT protected (`Authorization: Bearer <access token>`); errors are
`{ "error": "<message>" }`.

| Endpoint | Purpose |
|---|---|
| `GET /api/tasks/:id` | one task row |
| `GET /api/tasks/:id/events` | its timeline, whole or incremental |
| `POST /api/tasks/:id/kill` | abort a running task |
| `POST /api/tasks/:id/reply` | answer a task: resume it, or start a follow-up |
| `POST /api/tasks/:id/restart` | clone a finished task and start the clone |

`GET /api/tasks` (the list) is the admin console's endpoint and is not
described here.

## Who may read a task

A task row has no `user_id`. Its owner is derived, in this order:

1. **Session lineage** — `tasks.session_id` → `sessions.parent_session_id`
   (repeatedly, bounded) → the root session, whose `session_user` / `user_id`
   names the human who triggered the work.
2. **Task lineage** — if that ends without a user and the task is a
   `trigger_type = 'agent'` task with a `trigger_source_id`, the walk
   continues at the parent TASK and asks question 1 again. This is what makes
   a sub-task (a task started by another task with `create_task`) readable
   for the human who started the chain: such a task gets a session of its own
   with no parent session, so step 1 alone finds nobody. The walk is bounded
   (8 hops, visited set), and `trigger_source_id` is only followed for
   `agent` tasks — for a cronjob task that column holds a cronjob id.

The result decides:

| Owner resolves to | Requester | Answer |
|---|---|---|
| the requester | anyone | the task |
| another user | non-admin | **404** |
| nobody (cronjob / heartbeat / consolidation, or no session) | non-admin | **404** |
| nobody | admin | the task |

A task the requester may not see answers **404**, never 403 — a 403 would
confirm that the id exists. The same rule guards `/events`, `/kill` and
`/restart`.

## `GET /api/tasks/:id`

**200** `{ "task": Task }` with the full row (prompt, status, provider,
model, usage counters, `sessionId`, `triggerSourceId`, …). Timestamps are
SQLite UTC strings (`"2026-09-15 12:46:38"`), not ISO-8601.

**404** unknown or foreign id.

## `GET /api/tasks/:id/events`

Query: `since=<cursor>` (optional).

**200**

```json
{
  "events": [
    { "type": "tool_call", "timestamp": "2026-09-15T12:46:40.000Z",
      "toolName": "read_file", "input": "{…}", "output": "{…}",
      "durationMs": 5, "status": "success" },
    { "type": "message", "timestamp": "2026-09-15T12:46:41.000Z",
      "role": "assistant", "content": "…", "metadata": { "…": "…" } }
  ],
  "nextSince": "t106249-m90800",
  "task": { "id": "…", "name": "…", "status": "running", "…": "usage fields" }
}
```

- `events` is ordered oldest first and merged from the task's tool calls and
  its `assistant` / `system` messages. `metadata` is already parsed JSON (or
  the raw string for legacy rows).
- `events` is `[]` for a task without a session (legacy rows).
- `task` always carries the current status and the usage counters, so a
  detail view does not need a second request — a poll refreshes them even
  when no new event arrived.

### `since` — incremental reads

A detail view that polls this endpoint every few seconds does not want the
whole run back every time; a long task carries megabytes of tool payloads.

Pass the `nextSince` value of the previous response as `since` and the
response contains only the events written after it:

```
GET /api/tasks/8f3…/events                      → 240 events, nextSince "t1042-m377"
GET /api/tasks/8f3…/events?since=t1042-m377     →   3 events, nextSince "t1045-m379"
GET /api/tasks/8f3…/events?since=t1045-m379     →   0 events, nextSince "t1045-m379"
```

Rules:

- **Without `since` the response is the full timeline**, exactly as before
  the parameter existed. `nextSince` is present in both cases (the first
  read needs to learn a cursor).
- The cursor is **a pair of row ids**, format `t<toolCallId>-m<messageId>`.
  Treat it as opaque: read it from `nextSince`, send it back unchanged.
  It is a pair of ids rather than a timestamp because the two source tables
  are append-only with `AUTOINCREMENT` ids, while their `timestamp` column
  has second resolution and ties across the two tables — a time cursor would
  have to choose between repeating a whole second and dropping events inside
  it.
- `nextSince` never moves backwards. A poll that finds nothing returns the
  cursor it was given.
- A cursor belongs to one task. Sending the cursor of another task is not an
  error, but yields whatever its ids mean for this task — usually nothing.
- **400** for a `since` that is not of that form, including an empty value
  (`?since=`) and a repeated parameter. There is no silent fallback to the
  full timeline; validation happens before the task lookup, so a 400 says
  nothing about whether the id exists.

**404** unknown or foreign id (see [Who may read a task](#who-may-read-a-task)).

## `POST /api/tasks/:id/kill`

**200** `{ "task": Task }` with the aborted row · **400** when the task is not
`running` · **404** unknown or foreign id.

## `POST /api/tasks/:id/reply`

Body: `{ "text": "<1..8000 chars>" }`. The text is trimmed first. Runs the same
decision tree a Telegram reply to a task message runs (one shared
implementation, `packages/web-backend/src/task-reply.ts`):

| Task status | Effect | Status |
|---|---|---|
| `paused` | the run is resumed with the text | **200** `outcome: "resumed"` |
| `running` | nothing; reply again when it has finished | **409** `outcome: "running"` |
| anything finished | a follow-up task is started, carrying the previous prompt and result as context | **201** `outcome: "follow_up"` |

Response body in all three cases:

```json
{
  "outcome": "resumed" | "running" | "follow_up",
  "taskId": "<the task that was replied to>",
  "followUpTaskId": "<only for follow_up>",
  "message": "<one line, ready to display>"
}
```

The follow-up inherits provider, model and persona of the task it answers (the
configured task default provider when the original pinned none) and hangs off
the requester's `app` session, so its result is delivered back into the app.

**400** `{ "error": "validation_error", "message": ... }` for a missing, empty,
whitespace-only or over-long text · **403** the task belongs to another user ·
**404** unknown id · **409** also when the runtime refuses to resume a paused
task (`{ "error": "Task could not be resumed" }`) · **503** the reply path is
not wired (no task runtime).

Unlike the reads, this endpoint distinguishes 403 from 404 on purpose: the
client has to tell "this task is gone" from "this task is not yours" to decide
whether it may keep its reply box open.

## `POST /api/tasks/:id/restart`

Body (all optional, empty string means "inherit"): `name`, `prompt`,
`provider`, `model`, `maxDurationMinutes`. Clones the row, starts the clone
and leaves the original untouched.

**201** `{ "task": Task }` · **400** invalid body or unusable provider ·
**404** unknown or foreign id · **409** the original is `running` / `paused`
(kill it first) · **503** the task runtime is unavailable.

## Strand isolation for task delivery

A task result, question, progress update or generated file belongs only to
`resolveTaskStrandOrigin`: the first interactive ancestor of the task session.
The currently open strand never overrides that origin. Nested tasks follow the
same session lineage. Result cards, injection responses, feed links and push
links use that single destination, even when another strand is open.

Cronjobs, heartbeats, consolidation and tasks without an interactive ancestor
remain feed-only. Their persisted notifications and files use their own task
transcript, not an existing or newly created strand. No LLM injection runs for
these outcomes. The existing feed-only notification policy is unchanged.

Interactive tool attribution is bound to each runtime iterator operation using
AsyncLocalStorage. `create_task` therefore records its calling turn's parent
session even when asynchronous work outlives a queue slot. Each persona's
runtime parks and restores transcripts by session before prompting, so an
injection into A cannot become context for the next turn in B.
