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
[Read state](#read-state)):

| Field | Notes |
|---|---|
| `lastActivityAt` | ISO-8601 UTC of the newest NON-user message, `null` when there is none |
| `unread` | `true` when that message is newer than the strand's read marker |

`GET /api/threads` returns the same three fields on every thread. Old clients
ignore them. Every thread also carries `projectSuggestion`, see
[Project suggestions](#project-suggestions).

## `GET /api/strands`

Query: `tag=<name>` · `now=1` · `agent_id=<persona>` · `project_id=<id>|none` ·
`include_archived=0|1` · `limit=1..100` (default 50) · `offset`.

**200** `{ "strands": Strand[] }`, ordered like threads (pinned first, then
last activity). With `now=1` the result is ordered by rank. An unknown tag
matches nothing. **400** unknown `agent_id`.

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

- `GET /api/now` -> `{ "strands": Strand[], "max": number }` ordered by rank.
- `PUT /api/now` `{ "strandIds": ["...", "..."] }` ->
  `{ "strands": Strand[], "max": number }`. The order of the ids is the rank.
  **400** `now_set_too_large` for more ids than `max` (the message names the
  value in force, e.g. `The now set holds at most 6 strands`), **400**
  `strand_not_found` for an unknown, foreign or archived id, **400**
  `invalid_strand_ids` for a malformed body.

| Field | Notes |
|---|---|
| `strands` | the now set, ordered by rank |
| `max` | the size in force right now, so clients do not have to hardcode it |

Lowering `offtangent.nowSetMax` never drops a strand: a set that is larger than
the new value keeps every strand and `GET /api/now` still returns all of them
(`strands.length` can therefore exceed `max`); only adding more is refused
until the set fits again. Removing strands from an oversized set always works.

A capture filed into a strand pulls that strand into the now set when there is
room; the set is never auto evicted. Every change is pushed as
`{ "type": "now_set_changed", "strandIds": [...] }` on `/ws/chat`.

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
{ "queued": true, "position": 2, "blockedBy": { "agentId": "bob", "sessionId": "…", "title": "Hotfix Deploy" } }
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
