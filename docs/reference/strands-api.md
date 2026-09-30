# Strands API

Reference for `/api/strands`, `/api/tags`, `/api/now` and `/api/resurface`
(Offtangent SPEC chapters 6.2 and 6.3). A strand is a thread of thought that
lives over time; technically it is an interactive session, exactly what
[Threads API](./threads-api) exposes. This chapter adds tags, the now set and
resurfacing on top of it.

All endpoints are JWT protected (`Authorization: Bearer <access token>`).
Errors are `{ "error": "<message>", "code": "<machine code>" }`.

## `Strand`

A `Strand` is a [`Thread`](./threads-api#thread) plus three fields:

```json
{ "...": "all Thread fields", "tags": ["haus", "handwerker"], "nowRank": 2, "links": 1 }
```

| Field | Notes |
|---|---|
| `tags` | tag names on the strand, sorted |
| `nowRank` | rank in the now set (1 first), otherwise `null` |
| `links` | number of `strand_links` rows pointing at or from the strand |

`GET /api/strands` and `GET /api/strands/:id` add the read state (see
[Read state](#read-state)) and the attention state (see
[Attention](#attention)):

| Field | Notes |
|---|---|
| `lastActivityAt` | ISO-8601 UTC of the newest NON-user message, `null` when there is none |
| `unread` | `true` when that message is newer than the strand's read marker |
| `attention` | the open question of the strand that is still live, or `null` |

Every strand also carries its fork lineage (see [Forks](#forks)):

| Field | Notes |
|---|---|
| `parentStrandId` | the strand this one was forked off, `null` when it is a root |
| `forkedAt` | ISO-8601 UTC of the fork, `null` when it is a root |

`GET /api/threads` returns the same three fields on every thread. Old clients
ignore them. Every thread also carries `projectSuggestion`, see
[Project suggestions](#project-suggestions).

## `GET /api/strands`

Query: `tag=<name>` · `now=1` · `agent_id=<persona>` · `project_id=<id>|none` ·
`include_archived=0|1` · `attention=0|1` · `unread=0|1` · `limit=1..100`
(default 50) · `offset`.

**200** `{ "strands": Strand[] }`, ordered like threads (pinned first, then
last activity). With `now=1` the result is ordered by rank. An unknown tag
matches nothing. **400** unknown `agent_id`.

`attention=1` keeps only strands with an open question, `unread=1` only
strands with unread activity; both combine as AND and with every other filter.
The filter runs server side before `limit`/`offset`, so pages stay full and
the offset keeps meaning what it means. Unlike `include_archived`, a value
that is neither `1`/`true`/`yes` nor `0`/`false`/`no` is **400**
`invalid_attention` / `invalid_unread` — a filter that silently degrades to
"off" would answer **200** with the full list and the client would show it as
the filtered one.

## Read state

The read marker is server side (`sessions.last_read_at`), so a second device
and a fresh install see the same unread strands.

`POST /api/strands/:id/read` -> **204**, no body. Marks the strand as read at
`now`. Idempotent: calling it again just moves the marker again. **404**
unknown or foreign strand.

`unread` is derived, never stored:

- `lastActivityAt` is the timestamp of the newest message in the strand whose
  role is **not** `user` (assistant answers, system rows such as task result
  cards). Deliberately not `Thread.lastActivity`, which also moves when the
  user types — typing must not make a strand unread.
- `unread` is `true` when such a message exists and it is newer than
  `last_read_at`. A strand that was never opened but has an answer is unread; a
  strand with only the user's own messages never is.

Both fields are computed in one joined query for the whole list, so the list
endpoint stays a single round trip. No WebSocket frame carries strand list
rows today, so clients refresh the list by pulling it (after sending a turn,
on a task outcome frame, or on resume).

## Attention

`unread` answers "did something happen here" and disappears when the strand is
opened. `attention` answers the other question: **is this strand waiting for
me**. It disappears when the question is answered — and when the question went
stale (see [Staleness](#staleness)).

```json
{
  "kind": "interaction",
  "since": "2026-09-26T10:15:00.000Z",
  "prompt": "Hand this to Bob?",
  "messageId": 4711,
  "taskId": null
}
```

| Field | Notes |
|---|---|
| `kind` | `interaction` (an unanswered card) or `task_question` (a paused task) |
| `since` | ISO-8601 UTC of the block message / of the task start |
| `prompt` | the question, whitespace collapsed to one line, at most 120 characters with a trailing `…` |
| `messageId` | the message carrying the block for `interaction`, else `null` |
| `taskId` | the paused task for `task_question`, else `null` |

Exactly two things count, both of them exact signals — a question asked inside
ordinary prose is deliberately **not** attention:

- **`interaction`**: the strand contains an interactive block
  ([SPEC 7.4c](./interaction-blocks)) that `POST /api/interactions` would still
  accept an answer for. "Still open" is decided by the same core function the
  endpoint uses, so the badge and the endpoint cannot drift: a block is closed
  when it carries an answer (the endpoint's **409** `already_answered`) or when
  its `expiresAt` has passed (**410** `stale`), and the message must belong to
  the caller and live in an existing strand (**404** / **410**). On top of that
  the strand-level staleness rules below apply — they only ever take a badge
  away, they never change what the endpoint accepts.
- **`task_question`**: a task of this strand is `paused` with
  `result_status = question`, i.e. exactly the state
  `POST /api/tasks/:id/reply` resumes. `prompt` is the question the task left
  (its result summary). A sub-task of a task does not count: it asks the task
  that spawned it, not the user.

A strand with nothing open reports `attention: null`. A client that sees no
`attention` field at all is talking to an older backend.

### Staleness

`attention` is **answerable AND not stale**. A card that went stale keeps its
buttons in the chat — it just stops claiming the user's attention. The reverse
never happens: a badge over a card `POST /api/interactions` would refuse is a
bug. Three rules, all of them attention-only, for `kind: "interaction"`:

1. **Superseded by the user** — any later genuine user turn in the same strand
   (a `role = user` message of the same user with a higher message id) clears
   the card: the user answered in prose or moved on. Rows the system injects
   (task results and task questions as `system`, task injection answers and
   file deliveries as `assistant`, tool rows as `tool`) are not user turns and
   clear nothing.
2. **Superseded by a newer card** — only the newest open card of a strand
   counts; older open cards below it are history. So a strand reports its
   **newest** open card, and `since` is that card's timestamp.
3. **Age limit** — a card older than the configured age is not attention any
   more. The age is the setting `offtangent.attentionMaxAgeHours` (integer
   `1`–`720`, default `48`), editable on the settings page or in
   `settings.json`. It is read per derivation, so a change applies to the next
   request without a restart. Precedence: an explicit `maxAgeMs` option (used
   by tests, `Number.POSITIVE_INFINITY` disables the limit) > a valid setting >
   the deployment fallback `AXIOM_ATTENTION_MAX_AGE_MS` (milliseconds) >
   `ATTENTION_MAX_AGE_MS` (48 h). An invalid value in the file is ignored, not
   clamped — see [Settings → `offtangent`](./settings#offtangent).

A `task_question` gets rule 3 only: a paused task stays blocked until
`POST /api/tasks/:id/reply` answers it, so chatting in the strand does not
clear it — but a question from last week stops being "waiting on you".

If a card and a paused task are both live in one strand, the **oldest `since`
wins**.

### `GET /api/strands/attention-summary`

```json
{ "awaiting": 3, "unread": 7, "firstAwaitingStrandId": "6f0f…" }
```

Counts over **all** non-archived strands of the user, deliberately independent
of the 100-per-page cap of the list — a badge must not go wrong at strand 101.
`awaiting` is the number of strands with an open question, `unread` the number
with unread activity, `firstAwaitingStrandId` the awaiting strand with the
oldest `since` (ties broken by id), or `null`. **401** without a token.

## `PUT /api/strands/:id/tags`

```json
{ "tags": ["Haus", "handwerker"] }
```

Replaces the tag set of the strand. Names are normalised to lowercase slugs
(spaces become dashes, at most 40 characters) and unknown tags are created.

**200** `{ "strand": Strand }` · **400** `invalid_tags` · **404** unknown or
foreign strand.

## Tags

```json
{ "id": "3b7d...", "name": "haus", "color": "#ff8800", "archived": false, "createdAt": "2026-09-13T09:00:00.000Z" }
```

- `GET /api/tags?include_archived=0|1` -> `{ "tags": Tag[] }`, sorted by name.
- `POST /api/tags` `{ "name", "color"? }` -> **201** `{ "tag" }`. A name that
  already exists answers **200** with the stored tag. **400** `invalid_tag`
  for an empty name or a colour that is not `#rrggbb`.
- `PATCH /api/tags/:id` `{ "name"?, "color"?, "archived"? }` -> `{ "tag" }`.
  **400** `invalid_tag` (also for a rename onto an existing name), **404**
  unknown or foreign tag.

Tags created by the router are attached with `source = router` in
`strand_tags`; the tag itself carries no difference.

## Now set

The strands that are currently in play. The size is the setting
`offtangent.nowSetMax` (integer, `1`–`12`, default `4`) — see
[Agent → Now set size](../settings/agent#now-set-size).

How it is filled is the setting `offtangent.nowSetMode` (`auto` by default,
`manual` for the curated set) — see
[Settings → offtangent.nowSetMode](settings#offtangent).

- `GET /api/now` -> `{ "strands": Strand[], "max": number, "mode": "auto" | "manual" }`
  ordered by rank. In `auto` the list is computed from the user's activity on
  every request (`nowRank` = position in that list); in `manual` it is the
  curated `now_set` table.
- `PUT /api/now` `{ "strandIds": ["...", "..."] }` ->
  `{ "strands": Strand[], "max": number, "mode": "manual" }`. The order of the
  ids is the rank. **409** `now_set_auto` while the mode is `auto` (nothing is
  written), **400** `now_set_too_large` for more ids than `max` (the message
  names the value in force, e.g. `The now set holds at most 6 strands`),
  **400** `strand_not_found` for an unknown, foreign or archived id, **400**
  `invalid_strand_ids` for a malformed body.

| Field | Notes |
|---|---|
| `strands` | the now set, ordered by rank |
| `max` | the size in force right now, so clients do not have to hardcode it |
| `mode` | `auto` (computed, read only) or `manual` (curated) |

In `auto` the ranking counts the distinct calendar days on which the user
wrote in a strand (last 14 days, 1-day half-life, pinned strands first, other
roles ignored); see
[Captures and strands → The now-set](../concepts/captures-and-strands#the-now-set).

Lowering `offtangent.nowSetMax` never drops a strand: a set that is larger than
the new value keeps every strand and `GET /api/now` still returns all of them
(`strands.length` can therefore exceed `max`); only adding more is refused
until the set fits again. Removing strands from an oversized set always works.

In `manual` a capture filed into a strand pulls that strand into the now set
when there is room; the set is never auto evicted. In `auto` nothing is
written at all — the list is recomputed after a filing and after a user
message. Every change is pushed as
`{ "type": "now_set_changed", "strandIds": [...] }` on `/ws/chat`; in `auto`
only when the computed list really changed.

## Resurface

`GET /api/resurface?limit=5` -> `{ "items": [...] }`

```json
{ "strandId": "0f4c...", "title": "Haus Dach", "personaId": "main", "tags": ["haus"],
  "lastActivity": "2026-08-30T18:03:00.000Z", "summary": "Angebote fuer die Nordseite ...",
  "reason": "unanswered" }
```

Eligible strands have content, are not archived, not in the now set, not
snoozed, and were last active between 3 and 30 days ago. Ordering is a simple
score: an open question (open items in the summary or a trailing question mark
in the last user message) beats a tag overlap with the now set, which beats
plain dormancy; ties go to recency. `reason` names the strongest signal:
`unanswered`, `tag_match` or `dormant`. `summary` is the latest structured
session summary rendered as text, empty when none exists.

`POST /api/resurface/:strandId/snooze` `{ "days": 7 }` -> **204** hides the
strand from resurfacing for that many days (1..365). **404** unknown or foreign
strand, **400** `invalid_days`.

## Project suggestions

A strand without a project is classified again while it grows (see
[Projects API](./projects-api#automatic-assignment)). A confident result is
written straight onto the strand; a plausible but uncertain one becomes a
proposal the user accepts or throws away.

Every `Thread` and `Strand` carries the open proposal:

```json
{
  "projectId": null,
  "projectSuggestion": {
    "projectId": "6a1c…-…-…",
    "projectName": "Haus & Handwerk",
    "confidence": 0.63,
    "reason": "Der Strand dreht sich um die Dachrinne am Haus.",
    "createdAt": "2026-09-15T13:22:04.000Z"
  }
}
```

`projectSuggestion` is `null` whenever `projectId` is set: a strand that has a
project is never proposed another one. `projectName` is resolved at read time,
so a renamed project can never show a stale label.

### `POST /api/strands/:id/project-suggestion/accept`

Writes the proposed project onto the strand and clears the proposal.

**200** `{ "strand": Strand }` · **404** `strand_not_found` (unknown or
foreign) · **404** `suggestion_not_found` · **409** `project_already_set` when
the strand got a project in the meantime. Nothing on this path ever moves a
strand that is already filed.

### `POST /api/strands/:id/project-suggestion/dismiss`

Throws the proposal away for good. The `(strand, project)` pair is recorded
permanently: it is never proposed again, and it is never assigned
automatically either, however confident a later run is.

**200** `{ "strand": Strand }` · **404** `strand_not_found` ·
**404** `suggestion_not_found`.

### Live updates

Both outcomes are pushed on `/ws/chat`:

```json
{ "type": "strand_project_changed", "sessionId": "0f4c…", "agentId": "main",
  "projectId": null, "projectSuggestion": { "...": "as above" } }
```

`projectId` is set and `projectSuggestion` is `null` when the strand was filed
automatically. Clients that do not know the frame ignore it.

## Forks

A strand forks when a topic inside it grows its own life: the agent calls
`fork_strand`, and a new strand starts with one message — the handoff the agent
wrote — instead of the whole history. See
[Captures and strands](../concepts/captures-and-strands#forking-a-strand) for
when that happens and what the agent puts in the seed.

Every strand carries `parentStrandId` and `forkedAt` (both `null` for a root),
in the list and in the detail. `GET /api/strands/:id` adds two more:

| Field | Notes |
|---|---|
| `parentStrandTitle` | title of the parent, `null` when it has none or was deleted |
| `childStrandIds` | direct forks of this strand, oldest first (`[]` when there are none) |

Build the back-link chip from `parentStrandId` + `parentStrandTitle`, the
children list from `childStrandIds` (each id is a normal strand you read with
`GET /api/strands/:id`). The lineage is a tree: nesting is allowed up to five
levels, and an id never points at a descendant, so you can walk upwards without
a visited set. A deleted parent leaves the id in place and the title `null` —
the fork still happened, the way back is just gone.

The parent keeps a `system` message with
`metadata.type = "strand_forked"` (`childStrandId`, `childTitle`, `autoRun`),
the fork starts with a `user` message with
`metadata.type = "strand_fork_seed"` (`parentStrandId`, `parentTitle`,
`forkedFromMessageId`). So the jump works in both directions even in a plain
text export, and a client that knows nothing about forks still renders both
rows. The fork also counts as one `strand_links` row (`kind: "reference"`), so
`links` goes up by one on both strands.

### `strand_forked` frame

When a fork appears, `/ws/chat` sends one frame to every socket of the owner:

```json
{
  "type": "strand_forked",
  "sessionId": "<parent strand id>",
  "agentId": "main",
  "fork": {
    "strandId": "…", "title": "Privacy: Gmail scopes", "parentStrandId": "…",
    "forkedAt": "2026-09-26T10:00:00.000Z", "agentId": "main",
    "projectId": null, "runStarted": false
  }
}
```

`sessionId` is the **parent** (that is where the new "forked into" row
appeared), `fork.strandId` the new strand. `runStarted` says whether a turn is
already running in it. A fork is the one strand creation no client triggered
itself, so without this frame the list would only learn about it on the next
pull. Additive frame: a client that does not know it ignores it.

## Model selection

`GET /api/models` lists provider/model pairs with `selectable`. Explicit choices
must use a selectable pair; disabled, unknown or errored models are refused.
`PATCH /api/strands/:id/model` sets a persistent pin with `{providerId, modelId}`
(or clears it with both `null`). Foreign strands return **404**; changing a pin
while its turn is active returns **409** `strand_busy`.

Resolution priority is **turn → strand → persona → global → fallback**.
`GET /api/strands/:id` includes `pendingTurn`: the turn of this strand that is
enqueued but has not started yet, `null` otherwise (including while its turn is
actually running — the turn frames show that). Shape:

```json
{ "queued": true, "position": 2, "blockedBy": { "agentId": "coder", "sessionId": "…", "title": "Hotfix Deploy" } }
```

`position` is 1-based within the persona's queue, `blockedBy` is the turn that
has to finish first (`title` null when the strand has none). A client that
missed the live `turn_queued` frame (reload, second device) reads the wait
state here.

`GET /api/strands/:id` includes `pinnedModel` and `effectiveModel`. While a live
turn override exists, `effectiveModel.source` is `turn`; after it ends, the
normal inherited selection is shown again. Reading an override never changes
the pin.

For a one-shot choice, send optional `modelProviderId` **and** `modelId` in
[POST /api/captures](./captures-api), or the existing `/ws/chat` message:

```json
{"type":"message","content":"Explain this","sessionId":"<strand-id>","modelProviderId":"<provider-id>","modelId":"<model-id>"}
```

Both fields must be nonempty strings or both omitted (not `null`). Invalid
pairs yield `invalid_model_pin`; unknown/non-selectable pairs yield
`model_unavailable` (**400** for captures; an `error` frame for WebSocket).
Validation is server-side and also repeated before model resolution after a
queued turn acquires the runtime, so a disabled choice cannot silently fall
back to another model. No fields means the previous inheritance behaviour.

Conservatively, appending to an existing strand, including WebSocket messages,
**never overwrites its pin**. A capture routed to `new_strand` additionally pins
the chosen model for following messages. The router keeps its own model; these
fields select only the answer model. WebSocket still uses its existing queue
and session checks; this adds no new channel or routing behaviour.
