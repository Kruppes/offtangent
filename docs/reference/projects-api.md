# Projects API

Reference for `/api/projects` and for the project field on the threads
endpoints (Offtangent Stufe 2: "projects light" — a flat grouping layer above
threads).

All endpoints are JWT-protected exactly like `/api/threads`
(`Authorization: Bearer <access token>`). Request and response bodies are JSON.
Errors use `{ "error": "<message>" }`, plus a machine-readable `code` where the
text below says so.

## What a project is

A project is a **named, optionally coloured bucket owned by one user**. A
thread points at *at most one* project (`Thread.projectId`), a project holds
any number of threads across any number of personas — grouping is orthogonal to
personas on purpose ("Umzug" contains the threads with `main` *and* with
`warren`).

Projects are deliberately light:

- no nesting, no sharing, no per-project settings or memory;
- a project of another user is answered with `404`, never with data;
- deleting a project **detaches** its threads (`projectId` back to `null`) and
  never deletes a conversation;
- archiving a project keeps its thread assignments; the threads simply stop
  being offered (an archived project cannot be assigned to a thread).

## `Project`

```json
{
  "id": "6a1c…-…-…",
  "name": "Umzug",
  "color": "#4f46e5",
  "archived": false,
  "createdAt": "2026-09-13T09:12:44.000Z",
  "updatedAt": "2026-09-13T09:31:02.000Z",
  "threadCount": 3
}
```

| Field | Notes |
|---|---|
| `id` | UUID v4 |
| `name` | trimmed, 1…80 characters, required |
| `color` | `#rrggbb` (stored lowercase) or `null`; an empty string is stored as `null` |
| `archived` | `false` by default; archived projects are hidden from the default list |
| `createdAt` / `updatedAt` | ISO-8601 **UTC** strings (not the raw SQLite `YYYY-MM-DD HH:MM:SS`) |
| `threadCount` | number of **non-archived** threads currently in the project |

## `GET /api/projects`

Query: `include_archived=0|1` (default `0`)

**200** `{ "projects": Project[] }`

Ordering is done server-side: `archived ASC, name COLLATE NOCASE ASC, id ASC` —
active projects first, then alphabetically regardless of case.

## `POST /api/projects`

```json
{ "name": "Umzug", "color": "#4f46e5" }
```

`color` is optional (`null` / omitted / empty = no colour).

**201** `{ "project": Project }` (`threadCount` is `0`)

**400** name missing, empty, longer than 80 characters or not a string;
`color` not a `#rrggbb` string.

## `PATCH /api/projects/:id`

```json
{ "name": "Umzug 2026", "color": null, "archived": true }
```

All fields optional; omitted fields stay untouched. `color: null` clears the
colour. Archiving does **not** touch the threads — they keep their `projectId`
and reappear when the project is unarchived.

**200** `{ "project": Project }` · **400** validation errors (same rules as
`POST`) · **404** unknown or foreign project.

## `DELETE /api/projects/:id`

**204** no body — the project row is gone and every thread that pointed at it
now has `projectId: null`. Threads are **never** deleted along with a project.

**404** unknown or foreign project.

## Threads in a project

See the [Threads API](./threads-api) for the full `Thread` shape. The
project-related parts:

| Endpoint | Project support |
|---|---|
| `GET /api/threads?project_id=<id>` | only threads of that project |
| `GET /api/threads?project_id=none` | only threads **without** a project |
| `GET /api/threads?project_id=` (empty) | no project filter at all |
| `POST /api/threads` | optional `projectId` in the body |
| `PATCH /api/threads/:id` | `projectId: "<id>"` moves the thread, `projectId: null` detaches it |

A `projectId` that is unknown, belongs to another user, or names an **archived**
project is refused with

```json
{ "error": "Project not found", "code": "project_not_found" }
```

and HTTP **400** (the three cases are indistinguishable on purpose). Nothing is
written in that case: a refused `POST /api/threads` leaves no thread behind, a
refused `PATCH` changes no field of the thread.

## Storage

| Table | Columns |
|---|---|
| `projects` | `id TEXT PK`, `user_id TEXT NOT NULL` (same semantics as `sessions.session_user`), `name TEXT NOT NULL`, `color TEXT`, `archived INTEGER NOT NULL DEFAULT 0`, `created_at`, `updated_at`; index `idx_projects_user (user_id, archived)` |
| `sessions` | `project_id TEXT` (nullable), index `idx_sessions_project` |

`sessions.project_id` carries **no foreign key**: SQLite cannot add a
constraint via `ALTER TABLE`, and rebuilding `sessions` is the riskiest
migration in the schema. Referential integrity is maintained in application
code — `DELETE /api/projects/:id` runs the detach and the delete in one
transaction.

## Automatic assignment

A strand that has **no** project is classified again and again while it grows,
so a project does not have to be picked by hand and a one-off backfill does not
go stale the next day.

**When.** After a chat turn, never during one: the model call runs detached, a
turn never waits for it. The first look happens at the third user/assistant
message of the strand, every further look needs ten more messages, and a strand
gets one extra look when its session ends. A strand that already has a project
is never looked at again.

**What happens with the answer.**

| Confidence | Result |
|---|---|
| `>= 0.75` | the project is written onto the strand |
| `0.50 … 0.75` | the project is stored as a proposal (see [Strands API](./strands-api#project-suggestions)) |
| `< 0.50` | nothing is stored |

**The invariants.**

- A project that is already on a strand is never overwritten and never moved,
  whatever the classifier says. The write is a single
  `UPDATE … WHERE project_id IS NULL`.
- A dismissed `(strand, project)` pair never returns: not as a proposal, and
  not as an automatic assignment either.
- After three dismissed proposals a strand is left alone for good.
- Projects are never created automatically; the list is closed. Archived
  projects may be chosen as a target, since a strand that clearly belongs to a
  container the user put away still belongs there.

**Configuration.**

```json
{
  "projectAssignment": { "enabled": true },
  "modelPolicy": { "roles": { "projectAssignment": "qwen3:27b" } }
}
```

`projectAssignment.enabled` is the kill switch (default `true`). The
`projectAssignment` model role is an ordered chain in the same notation as the
`router` role and falls back to it when unset.

**Storage.** Three additive tables, no column on `sessions`:

| Table | Columns |
|---|---|
| `strand_project_suggestions` | `strand_id TEXT PK`, `user_id`, `project_id`, `confidence REAL`, `reason`, `model`, `created_at` |
| `strand_project_dismissals` | `strand_id`, `project_id` (composite PK), `dismissed_at` |
| `strand_project_runs` | `strand_id TEXT PK`, `last_run_at`, `last_message_count`, `runs`, `last_outcome`, `last_confidence`, `last_model` |
