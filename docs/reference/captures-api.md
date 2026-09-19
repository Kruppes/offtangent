# Captures API

Reference for `/api/captures` and `/api/router` (Offtangent SPEC chapters 4 and
6.1). A capture is a raw thought without a destination. The router files it into
a strand with a visible, reversible decision. Captures are never lost: a capture
the router cannot place lands in the unsorted tray.

All endpoints are JWT protected like `/api/chat/*`
(`Authorization: Bearer <access token>`). Bodies are JSON. Errors are
`{ "error": "<message>", "code": "<machine code>" }`.

## Objects

```json
{
  "capture": {
    "id": "6f1c...", "text": "the roofer called back, 4200 for the north side",
    "kind": "text", "source": "web", "agentId": null, "strandId": "0f4c...",
    "messageId": 812, "status": "filed", "createdAt": "2026-09-13T10:22:31.000Z",
    "filedAt": "2026-09-13T10:22:32.000Z", "attachments": [], "clientMessageId": "cap-01J..."
  },
  "decision": {
    "id": "9a2e...", "captureId": "6f1c...", "action": "append",
    "strandId": "0f4c...", "secondaryStrandId": null, "createdStrandId": null,
    "title": null, "personaId": null, "projectId": null,
    "projectSuggestion": { "projectId": "7b31...", "confidence": 0.68, "reason": "the whole strand is about the house" },
    "intent": "note", "confidence": 0.82, "tags": ["haus", "handwerker"],
    "rationale": "Same roofer quote thread", "alternatives": [
      { "action": "new_strand", "strandId": null, "title": "Dach Angebot Nord", "confidence": 0.11, "reason": "could be its own thread" }
    ],
    "state": "applied", "model": "c980...:claude-sonnet-5", "latencyMs": 1420,
    "createdAt": "2026-09-13T10:22:32.000Z", "appliedAt": "2026-09-13T10:22:32.000Z", "resolvedAt": null
  }
}
```

| Field | Notes |
|---|---|
| `capture.status` | `pending`, `filed` (applied, high confidence), `needs_review` (applied, medium confidence), `unsorted` (not applied, low confidence), `moved` (re-filed after an undo), `failed` (router unavailable, treated like `unsorted`), `dismissed` (thrown away by the user or by the silence guard) |
| `capture.strandId` / `messageId` | the strand and the `chat_messages` row the capture was filed into, `null` while unsorted |
| `decision.action` | `append`, `new_strand` or `link` (append to `strandId` and link it to `secondaryStrandId`) |
| `decision.title` / `personaId` | proposed title and persona of a `new_strand` decision, `null` otherwise |
| `decision.projectId` | project written on the strand a `new_strand` decision creates, `null` otherwise and whenever the router proposed no project |
| `decision.projectSuggestion` | `{ projectId, confidence, reason }` for an `append`/`link` onto a strand that has no project yet, else `null`. A proposal only: the server never applies it, a client applies it with `PATCH /api/threads/:id { projectId }`. Never below confidence 0.55, never for a strand that already has a project |
| `decision.intent` | `note` files only, `ask` also runs a turn in the strand |
| `decision.state` | `proposed`, `applied`, `confirmed`, `undone`, `superseded` |
| `decision.model` | `providerId:modelId` of the router entry that answered, `synthetic` when the router failed, `explicit` when the client named the strand, `user` for manual choices |
| `alternatives` | at most 3, best first, never the chosen action and target |

## Confidence bands

| Band | Confidence | Behaviour |
|---|---|---|
| High | >= 0.70 | decision applied, capture `filed`, turn runs when `intent` is `ask` |
| Medium | 0.40 to 0.70 | decision applied, capture `needs_review`, turn runs when `intent` is `ask` |
| Low | < 0.40 | not applied, capture `unsorted`, no strand is created, no turn |

Every capture produces a persisted decision, including the high band. The chip
the app shows is data, not a transient snackbar.

The band and the intent answer two different questions. The band says how sure
the server is about **where** the capture belongs; below 0.70 the filing stays
`needs_review` so it can be corrected. The intent says **whether** an answer is
owed, and that is not made uncertain by an unsure filing: an `ask` is answered
in the medium band too. This is safe because an `append` or `link` below 0.70
has already been rewritten to `new_strand` (see below), so a medium band answer
always lands in a strand the capture itself just opened, never in a strand that
was already there.

An `append` or `link` is only ever carried out in the high band. Below 0.70 the
server rewrites the decision to `new_strand` (title from the model, else from
the first words of the capture), keeps the strand the model proposed as the
first entry of `alternatives` and marks the rationale with
`router guard: append below the high band`. The confidence is left untouched,
so such a decision still lands in the medium band (`needs_review`) or the low
band (`unsorted`). A capture in a fresh strand keeps its context; a capture
appended to the wrong strand does not.

## `POST /api/captures`

```json
{ "text": "...", "clientMessageId": "cap-01J...", "agentId": "bob", "strandId": null,
  "kind": "text", "source": "web", "attachments": [], "intent": "ask" }
```

- `text` required, trimmed, at most 20000 characters.
- `clientMessageId` optional idempotency key (same alphabet as chat messages).
- `agentId` optional persona hint. Absent means "let the router choose".
- `strandId` optional explicit target. When present the router is skipped, the
  capture is appended there (decision `model: "explicit"`, confidence 1).
- `kind` one of `text`, `voice`, `image`, `file` (default `text`); `source`
  a short lowercase token (default `web`); `attachments` upload descriptors
  as returned by [`POST /api/uploads`](./uploads-api), passed through verbatim.
- `intent` optional override. Without it the router decides; explicit
  captures default to `note`.

- `modelProviderId` and `modelId` optional, paired nonempty strings naming a
  selectable model from `/api/models`. Invalid pairs or unavailable models return
  **400** (`invalid_model_pin` or `model_unavailable`). Omit both to inherit the
  normal model defaults. This selects the answering model, not the router model.
  A `new_strand` filing pins the selection on the new strand. An `append` or
  `link` uses it for this capture's turn only, without changing the existing pin.
  The selection survives deferred filing and note confirmation, including server
  restarts; availability is checked again before use.

Persistence: database initialization idempotently adds a nullable
`captures.metadata` JSON-text column to older databases. No new table is created.
Unfiled captures have no chat message yet, so chat-message metadata cannot hold
this selection reliably.

**201** `{ capture, decision, turn }` new capture, router ran (or was skipped).
**200** `{ capture, decision, turn }` known `clientMessageId`, nothing re-run.

`turn` describes the answer turn this capture started:
`{ "queued": true, "position": 2, "blockedBy": { "agentId": "bob", "sessionId": "…", "title": "Hotfix Deploy" } }`.
It is `null` when no turn was started (silent note, low band, dismissed) or
when the turn started immediately. `apply`, `undo` and `dismiss` carry the same
field. The same information reaches open clients as the `turn_queued`
WebSocket frame, and a client that reconnects later finds it as `pendingTurn`
on `GET /api/strands/:id`.
**400** codes `text_empty`, `text_too_long`, `invalid_client_message_id`,
`unknown_agent`, `invalid_strand`, `invalid_kind`, `invalid_source`,
`invalid_attachments`, `invalid_intent`, `invalid_model_pin`, `model_unavailable`.
**404** inaccessible or missing strand. **409** `strand_busy` for an active turn
in the target strand. **503** agent core not available.

The router only sees strands of the calling user: the now set first, then the
20 most recently active strands, then strands whose tags match a keyword of the
capture, at most 25. Outside the now set a strand is only offered when it says
something: a title, tags or a project. A strand with none of the three is a
blank row the router could only guess about, so it is left out. Every candidate
carries `lastMessage`, the last user message of that strand, collapsed to one
line and cut at 160 characters. A capture without any candidate becomes a new
strand at confidence 0.5 without a model call.

## `GET /api/captures`

Query: `status=unsorted|needs_review|filed|moved|failed|pending|dismissed|all`
(default `all`), `limit=1..200` (default 50), `offset`.

**200** `{ "captures": Capture[], "decisions": Decision[] }`, newest first.
`decisions` holds the current decision of every listed capture.

`all` means "everything that still counts": a `dismissed` capture is only
returned when it is asked for by name. That is what lets the tray reach zero
while nothing is actually deleted — and it keeps the card away from clients
that filter the tray themselves.

## `POST /api/captures/:id/apply`

```json
{ "decisionId": "9a2e...", "action": "append", "strandId": "0f4c...", "title": null, "personaId": null }
```

All fields optional.

- Empty body: confirm the current decision. An unsorted capture is filed as
  proposed; a `needs_review` capture becomes `filed` and its decision
  `confirmed`. An `ask` capture was already answered when it was filed, so the
  confirmation runs no second turn; it only catches up the answer when none was
  started and none exists (a decision from before the intent and the band were
  decoupled, or a filing whose turn runner was unavailable).
- `action` plus `strandId` (or `title` and `personaId` for `new_strand`):
  apply an alternative or a manual choice. The proposed decision becomes
  `superseded`, a new decision with `model: "user"` is applied. On an already
  filed capture this is a move with the undo semantics below.
- `decisionId` guards against stale clients: **409** `decision_superseded`
  when it is not the current decision.

**200** `{ capture, decision }`. **404** unknown or foreign capture. **400**
`invalid_strand` for an unknown, foreign or archived strand.

## `POST /api/captures/:id/undo`

```json
{ "strandId": "0f4c..." }
```

- **Before an answer exists** in the strand (no assistant message after the
  capture, always the case for `intent: "note"`): a true move. The chat row
  travels with the capture, the old decision becomes `undone`, a new decision
  with `model: "user"` is applied. Without `strandId` the capture returns to
  `unsorted` and its chat row is removed. A strand that the undone decision
  created and that holds no other message is deleted.
- **After an answer exists**: no history rewrite. The original exchange stays
  where it happened and its user row is badged with `metadata.misfiled = true`,
  a `strand_links` row of kind `moved_from` is written, and the text is
  re-filed into `strandId` as a fresh capture prefixed with
  `moved from <old strand title>`. The response carries the fresh capture.
  Without `strandId` only the badge is set and the old capture becomes `moved`.

- **On a `dismissed` capture**: the discard is undone. The capture returns to
  `unsorted` and its decision to `proposed` with `resolvedAt` cleared, so the
  card offers the same choices as before.

Idempotent: a second undo, or an undo on an unsorted capture, answers **200**
with the current state and changes nothing.

## `POST /api/captures/:id/dismiss`

Empty body. Throws a tray card away: `status` becomes `dismissed`, the open
decision becomes `superseded`, and the capture leaves `GET /api/captures` for
every status except `dismissed` itself. A `capture_routed` event is broadcast,
so an open client loses the card without a refresh.

Only a capture in the tray can be discarded (`unsorted` or `failed`); anything
filed answers **409** `not_in_tray`, because a filed capture is moved with
`apply`/`undo`, not discarded. A second discard answers **200** with the
current state (double tap, offline retry). **404** unknown or foreign capture.

`POST /api/captures/:id/undo` restores it. Nothing is deleted — the row, its
text and its decision stay.

**Client note.** A client that does not know the status yet must not treat it
as a tray card. The Android client maps an unknown status to `unsorted`
(`CaptureStatus.fromWire`), so a build without `dismissed` support puts a
discarded capture straight back into its tray view until the next list refresh
filters it out again. Ship the status to the client before shipping a discard
button there.

### Silence guard

A `kind: "voice"` capture whose transcript is not speech is stored as
`dismissed` immediately: no router call, no strand, no card. Its decision
carries `model: "silence-guard"` and the rationale
`silence guard: the recording contained no speech`.

Whisper does not return an empty string for silence, it returns its training
data: `* Musik *`, `[Applaus]`, `Thank you.`, subtitle credits. Two narrow
rules catch it — a transcript that is entirely a bracketed annotation of at
most 40 characters, or an exact match against a short list of known artefacts.
The marker has to BE the text: `Musik aufnehmen für den Film` is speech, and
typed text is never guessed away.

## `POST /api/router/preview`

Admin only. `{ "text": "...", "agentId": "bob" }` runs the router against the
caller's strands without writing anything.

**200** `{ "decision": { action, strandId, secondaryStrandId, title, personaId, projectId,
projectSuggestion, intent, confidence, tags, rationale, alternatives, model, latencyMs,
newStrand, notes } }`.
`notes` lists skipped chain entries, repair retries and threshold hand-overs.

## Router model chain

The router uses the role `router` of the model policy, read from
`settings.json` on every call:

```json
{ "modelPolicy": { "roles": { "router": "claude-sonnet-5, gpt-5.4-nano:0.9, ministral-3:14b" } } }
```

An entry is a model id (looked up across all configured providers), a
`providerId:modelId` composite, or a provider id or name. A trailing
`:<float>` is a confidence threshold: when the entry's decision is below it, the
next entry is tried and the best decision wins. Entries that are not configured
on the instance are skipped with one warning per process. A malformed answer is
retried once with a repair prompt. When no entry produces a usable decision the
capture becomes `failed` with a synthetic `{ action: "new_strand", confidence: 0 }`
decision. Changing the active chat model never touches this role.

## WebSocket frames

Additive frames on `/ws/chat`, delivered to every connection of the user:

```json
{ "type": "capture_routed", "sessionId": "0f4c...", "agentId": "main", "capture": {...}, "decision": {...} }
{ "type": "capture_needs_review", "sessionId": "0f4c...", "agentId": "main", "capture": {...}, "decision": {...} }
{ "type": "now_set_changed", "strandIds": ["0f4c...", "a3d1..."] }
{ "type": "turn_queued", "sessionId": "0f4c...", "agentId": "main", "position": 2, "blockedBy": { "agentId": "main", "sessionId": "a3d1...", "title": "Umzug" } }
```

`turn_queued` fires when the answer turn of a capture has to wait for another
turn of the same persona (position >= 2) — the capture path used to stay
completely silent in that case.

A filed capture also produces the existing `external_user_message` frame (now
carrying `sessionId`) so an open strand view can append the row, and an `ask`
capture streams its answer through the normal turn frames of that strand.
