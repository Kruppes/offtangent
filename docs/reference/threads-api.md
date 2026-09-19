# Threads API

Reference for `/api/threads` and for the thread-related fields on the chat
endpoints (Offtangent Stufe 1: named, parallel conversations per persona).

All endpoints are JWT-protected exactly like `/api/chat/*`
(`Authorization: Bearer <access token>`). Request and response bodies are JSON.
Errors use `{ "error": "<message>" }`, plus a machine-readable `code` where the
table below says so.

## What a thread is

A thread **is** an interactive session row: only `sessions` rows with
`type = 'interactive'` are threads. Background sessions (task, heartbeat,
consolidation, loop_detection) are never listed or selectable. Threads are
scoped to one user and one persona (`agentId`); a thread of another user or of
another persona is answered with `404` / a `session_*` error code, never with
data.

Per `(user, persona)` **exactly one thread is active** — it occupies the
session slot and owns the inactivity timer. Every other thread of that pair is
*parked*.

## `Thread`

```json
{
  "id": "0f4c…-…-…",
  "agentId": "bob",
  "title": "Deploy plan",
  "pinned": false,
  "archived": false,
  "startedAt": "2026-09-12T11:00:00.000Z",
  "lastActivity": "2026-09-12T12:31:07.000Z",
  "endedAt": null,
  "messageCount": 12,
  "lastMessage": {
    "role": "assistant",
    "content": "…max 200 characters…",
    "timestamp": "2026-09-12T12:31:07.000Z"
  },
  "active": true,
  "projectId": "6a1c…-…-…"
}
```

| Field | Notes |
|---|---|
| `title` | `null` when unnamed; trimmed, max 200 characters |
| `projectId` | project this thread is grouped under, `null` when ungrouped (see [Projects API](./projects-api)) |
| `projectSuggestion` | open project proposal of the automatic assignment, `null` when there is none and always `null` while `projectId` is set (see [Strands API](./strands-api#project-suggestions)) |
| `startedAt` / `lastActivity` / `endedAt` | ISO-8601 **UTC** strings (not the raw SQLite `YYYY-MM-DD HH:MM:SS`) |
| `endedAt` | `null` while the thread is open (active or parked); set once it was summarized and closed |
| `lastMessage` | newest `user`/`assistant` row of the thread, content truncated to 200 characters; `null` for an empty thread |
| `active` | `true` for the thread that currently holds the `(user, persona)` slot |

## `GET /api/threads`

Query: `agent_id=<persona>` · `include_archived=0|1` · `limit=1…100` (default
50) · `offset=0…` · `project_id=<id>|none`

**200** `{ "threads": Thread[] }`

Ordering is done server-side:

```
pinned DESC, COALESCE(last_activity, started_at) DESC, started_at DESC
```

Pinned threads therefore stay on top **across pages** — a client that only
sees one page cannot pull a pinned thread up from page 2. Ended threads are
included (that is how you resume an old conversation); archived ones only with
`include_archived=1`.

`agent_id` that is **present but empty** (`?agent_id=`) means "every persona",
exactly like omitting it — a client that builds its query string from an empty
filter state must not silently get main's threads. (The WebSocket frames keep
the legacy mapping: an empty `agentId` there still means `main`.)

`project_id=<id>` restricts to one project, `project_id=none` lists only
threads **without** a project, an empty `project_id=` is no filter at all. An
unknown project id is not an error here — it simply matches nothing (`200`
with an empty list).

**400** unknown `agent_id`.

## `POST /api/threads`

```json
{ "agentId": "bob", "title": "Deploy plan", "projectId": "6a1c…-…-…" }
```

`agentId` defaults to `main`, `title` is optional (`null` / empty = unnamed),
`projectId` is optional (`null` / omitted = ungrouped).

**201** `{ "thread": Thread }` — the row is created but deliberately **not**
made active: a thread becomes active on the first message that names it.

**400** unknown `agentId`, non-string `title`/`projectId`, or a `projectId`
that is unknown, foreign or archived — the latter as
`{ "error": "Project not found", "code": "project_not_found" }`, and no thread
is created.

## `PATCH /api/threads/:id`

```json
{ "title": "Renamed", "pinned": true, "archived": false, "projectId": null }
```

All fields optional; omitted fields stay untouched. `title: null` clears the
title, `projectId: null` detaches the thread from its project. Archiving the
thread that currently holds the slot **parks** it (slot and timer released) so
nothing keeps writing into an archived thread.

**200** `{ "thread": Thread }` · **400** malformed field types, or a
`projectId` that is unknown, foreign or archived
(`{ "error": "Project not found", "code": "project_not_found" }`, the thread
stays unchanged) · **404** unknown or foreign thread.

## `DELETE /api/threads/:id`

Deletes a thread that was created by accident. Only allowed while the thread
carries **no messages at all** (neither a `message_count` nor any
`chat_messages` row). Anything with content is archived instead, so chat
history and the daily-log summaries referring to it stay intact. If the
deleted thread held the session slot, slot and timer are released.

**204** no body · **404** unknown or foreign thread ·
**409** `{ "error": "Thread is not empty; archive it instead", "code": "thread_not_empty" }`

## `GET /api/threads/:id/context-stats`

Prompt cache measurement per strand (Offtangent SPEC 11.5). Returns the token
counters accumulated on the session row and the version of its structured
summary.

```json
{ "stats": { "sessionId": "…", "promptTokens": 1000, "completionTokens": 300,
             "cacheRead": 3000, "cacheWrite": 500, "cacheReadRatio": 0.75, "summaryVersion": 2 } }
```

`cacheReadRatio` is `cacheRead / (promptTokens + cacheRead)`, `null` before the
first turn. **404** unknown or foreign thread.

## Sending into a thread

`POST /api/chat/message` takes `sessionId` as an additional multipart field
(next to `agentId`, `clientMessageId`). The WebSocket frame is
`{ "type": "message", "content": "…", "agentId": "bob", "sessionId": "<thread id>" }`.

Refusals carry the same wire codes on both transports:

| Code | REST status | Meaning |
|---|---|---|
| `session_not_found` | 404 | unknown id, or not an interactive session |
| `session_agent_mismatch` | 409 | the thread belongs to another persona |
| `session_forbidden` | 403 | the thread belongs to another user, or is archived |

While a turn of another message of the SAME persona is still running, the
socket emits two frames with identical payload:

```json
{ "type": "queued",      "sessionId": "…", "agentId": "bob", "position": 2, "blockedBy": { "agentId": "bob", "sessionId": "…", "title": "Hotfix Deploy" } }
{ "type": "turn_queued", "sessionId": "…", "agentId": "bob", "position": 2, "blockedBy": { "agentId": "bob", "sessionId": "…", "title": "Hotfix Deploy" } }
```

`queued` is the legacy name and stays; `turn_queued` is the same event on the
ChatEventBus, so every other connection of the user (second tab, phone) sees
the wait too. `position` is 1-based and only sent from 2 upwards — position 1
means the turn starts immediately. `blockedBy` is the turn that has to finish
first; `title` is null when the strand has no title. Since 2026-09-19 queues
are **per persona**: a running turn of `bob` no longer delays a turn of `main`
(a global concurrency limit, `AXIOM_TURN_CONCURRENCY`, default 3, still caps
how many turns run at once).

## Reading a thread

`GET /api/chat/history?session_id=<thread id>&since_id=<cursor>&limit=100`

- works for **ended** threads too (needed to reopen an old conversation);
- `since_id` switches to cursor mode: only rows with `id > since_id`, ordered
  **ascending** by id, so a client appends the batch as-is and keeps the last
  id as the next cursor;
- `agent_id` may be combined; all filters are ANDed, so a thread never shows
  another thread's rows.

## Lifecycle

| State | `ended_at` | Slot | Inactivity timer |
|---|---|---|---|
| **active** | `NULL` | holds the `(user, persona)` slot | armed (`sessionTimeoutMinutes`) |
| **parked** | `NULL` | — | none |
| **ended** | set | — | none |
| **archived** | either | released on archiving | none |

- **active → parked**: another thread of the same persona is named explicitly,
  or the thread is archived. Parking writes no summary and no `ended_at`; the
  model transcript stays cached in memory.
- **active → ended**: the inactivity timer fires (`sessionTimeoutMinutes`,
  default 30), `/new` is used, or the provider changes. A summary is written to
  the daily memory file and `ended_at` is set.
- **parked → ended**: the parked-thread sweep. Every 10 minutes the server
  closes parked threads whose last activity is older than the parked timeout
  (default **24 h**, `SessionManagerOptions.parkedTimeoutHours`): summary,
  `ended_at`, `session_timeout` entry in the activity log with
  `reason: "parked_timeout"`. Empty threads are closed without a summary,
  already-summarized ones are not summarized twice. A thread that holds the
  slot is never swept — it is owned by the inactivity timer.
- **ended → active**: writing into an ended thread reopens it (`ended_at` back
  to `NULL`, the written summary is kept). Its model context is gone, so the
  server injects the thread's own verbatim tail plus matching facts.
- **archived**: hidden from the default list and refused for sending
  (`session_forbidden`) until it is un-archived via `PATCH`.

On restart, open interactive sessions are restored oldest-first, so the most
recent one wins the slot. **Empty threads are never restored into the slot and
never closed on startup** — however old they are, they stay open and
timer-less, so a thread created right before a restart is still there
afterwards; only the sweep retires it.
