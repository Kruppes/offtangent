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
| `decision.partIndex` / `partCount` | topic part of the capture this decision belongs to. `0` / `1` for every capture that was not split |
| `decision.partText` / `partTitle` | consolidated text and title of that part; `partText` is `null` for a single part, where the part IS `capture.text` |
| `decision.sentenceIds` | 1-based sentence numbers of the capture this part was built from, `[]` for a single part |

## Split on intake

A long dictation that mixes unrelated matters is cut into topic parts BEFORE
the router runs. Every part is consolidated (nothing is summarised away), gets
its own router decision, its own strand and its own apply/undo. A capture about
one matter is not touched: it keeps its text verbatim and produces exactly one
decision with `partIndex 0`, `partCount 1`, `partText null`.

Two model calls decide it, the code decides everything else:

1. Stage 1 assigns every sentence to exactly one topic. The answer is validated
   (each sentence id once, none missing), a rejected answer is echoed back up
   to three times.
2. Topics of a single sentence are folded into their neighbour, and a split
   whose `splitConfidence` is below `0.7` is discarded: the capture is filed as
   one. Splitting a coherent note is the expensive mistake.
3. Stage 2 consolidates each part from its own sentences only. A failed
   consolidation degrades to the verbatim sentences of that part; a capture is
   never lost because a model was unavailable.

A capture is eligible when the setting is on and it is either `kind: "voice"`
or at least `captures.splitMinChars` characters long. **Never split:** captures
with an explicit `strandId`, `mode: "quick"` (no router call at all by design)
and `mode: "assist"` (an assist capture asks for one draft, and two parallel
drafts out of one dictation is nothing the client can render).

The part message stored in `chat_messages` holds the consolidated part text and
carries `metadata.capturePart = { index, count, captureId }` plus
`part_index`. The persona sees one extra line in front of it
(`[Teil 2 von 3 einer Sprachnotiz; Original: capture <id>]`, language follows
the capture) so it knows it is reading a fragment; that line is never stored.

`captures.strand_id` / `message_id` stay bound to **part 0**, so the tray, the
home screen and `GET /api/captures` keep showing one strand per capture. The
other parts are reached through `parts[]`.

Capture status over the parts:

| Situation | `capture.status` |
|---|---|
| every part applied, none in the review band | `filed` |
| any part applied in the medium band, or some parts still unapplied | `needs_review` |
| no part applied (all undone, or all below the low band) | `unsorted` (`failed` when every part got a synthetic decision) |

### Settings

```json
{ "captures": { "splitOnIntake": true, "splitMinChars": 400 } }
```

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `captures.splitOnIntake` | `boolean` | `true` | master switch; `false` files every capture as one, exactly as before |
| `captures.splitMinChars` | `number` | `400` | shortest non voice capture that is considered for a split |

The split uses the same model chain as the router
(`modelPolicy.roles.router`), first resolvable entry.

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
  "kind": "text", "source": "web", "attachments": [], "intent": "ask", "mode": "work" }
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
- `mode` one of `work`, `quick`, `assist` (default `work`, see
  [Capture modes](#capture-modes)). An unknown value is **400**
  `invalid_mode`; `null` and `""` are treated as absent, i.e. `work`.

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

**201** `{ capture, decision, turn, parts, partCount }` new capture, router ran (or was skipped).
`parts`/`partCount` (split on intake) are additive: one entry for a capture
that was not split, the shape of `GET /api/captures/:id`.
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
`invalid_attachments`, `invalid_intent`, `invalid_mode`, `invalid_model_pin`,
`model_unavailable`.
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

## Capture modes

`mode` says **how** a capture is answered, not what it is. The field is defined
in `CAPTURE_MODES` (`packages/web-backend/src/api/modules/captures/schema.ts`)
and comes from the devices that send it: the puck firmware writes `work` or
`quick` into every capture body, an assist wave writes `assist`.

| Value | Router | Model of the answer turn | Thinking level | Style instruction |
|---|---|---|---|---|
| `work` (default) | runs | persona / strand / global | persona's own | source hint only (`captureSources.puck.styleHint`) |
| `quick` | **skipped** when no `strandId` is given | `captureModes.quick.providerId` + `modelId`, else the persona's | `captureModes.quick.thinkingLevel` (default `off`) | `captureModes.quick.styleHint` plus the source hint |
| `assist` | runs, like `work` | persona's own | persona's own | `captureModes.assist.styleHint` plus the source hint |

- **`work`** is the behaviour that always shipped, and therefore also what a
  missing, empty or `null` field means — an older client keeps working
  unchanged.
- **`quick`** is a short spoken question from a device without a screen.
  Without `strandId` it does not call the router at all: the capture is filed
  into one strand per `source` (title from `captureModes.quick.strandTitle`,
  default `Kurzfragen`), which is found again through the
  `router_decisions.created_strand_id` of an earlier quick filing of the same
  user and source. An archived or deleted strand is skipped and the next quick
  capture opens a fresh one. The decision of such a filing carries
  `model: "quick-mode"` and the rationale
  `Kurzfrage-Modus: fixer Strand, kein Router`, so quick filings stay countable
  next to router ones. A configured model pair that is not selectable does not
  fail the capture: the turn falls back to the persona model and the reason is
  logged (`[captures] quick mode: …`). An explicit client pin
  (`modelProviderId` + `modelId`) outranks the configured pair.
- **`assist`** is a spoken request whose answer contains something the user
  wants to **type** somewhere. It is the smallest mode: it adds one style
  instruction and nothing else — no model pin, no thinking level, no fixed
  strand, so the router files an assisted capture exactly like a working one.
  The instruction asks for short prose, at most one question, and the typable
  text in exactly one [`draft` block](./interaction-blocks#draft).

A `quick` capture **with** an explicit `strandId` takes the normal explicit
path: the strand decides where the answer goes, the mode still decides how it
sounds. `kind: "voice"` captures stay subject to the silence guard and the
courtesy filter in every mode.

The mode is remembered on the capture (`captures.metadata`, only when it is not
`work`), so a later turn started from the same capture is still answered in that
mode. It is **not** part of the `capture` object in any response — `mode` is an
input field only.

## `GET /api/captures`

Query: `status=unsorted|needs_review|filed|moved|failed|pending|dismissed|all`
(default `all`), `limit=1..200` (default 50), `offset`.

**200** `{ "captures": Capture[], "decisions": Decision[], "parts": { [captureId]: Part[] } }`,
newest first. `decisions` holds the current decision of **part 0** of every
listed capture (one entry per capture, as before). `parts` is additive and
holds every part:

```json
{ "index": 1, "title": "Auto zum Service", "text": "Das Auto muss zum Service, Termin am Montag.",
  "sentenceIds": [3, 4], "decision": { ... } }
```

`all` means "everything that still counts": a `dismissed` capture is only
returned when it is asked for by name. That is what lets the tray reach zero
while nothing is actually deleted — and it keeps the card away from clients
that filter the tray themselves.

## `GET /api/captures/:id`

**200** `{ "capture": Capture, "decision": Decision, "parts": Part[], "partCount": 2,
"split": { "confidence": 0.93, "rationale": "...", "gated": false },
"sentences": ["Das Dach tropft seit dem Sturm.", "..."] }`.

`sentences` are the sentences of the original text exactly as the split
numbered them, so `parts[i].sentenceIds` (1-based) index into this array and a
client can mark a part inside the original. Empty for a capture with one part.

`capture.text` is always the ORIGINAL dictation. `decision` is the decision of
part 0. `split.confidence` is the `splitConfidence` stage 1 returned,
`split.gated` is true when a proposed split was discarded by the confidence
gate (then there is exactly one part). All three are `null` / `false` for a
capture the split never looked at.

**404** `capture_not_found`.

## `POST /api/captures/:id/apply`

```json
{ "decisionId": "9a2e...", "action": "append", "strandId": "0f4c...", "title": null, "personaId": null, "partIndex": 0 }
```

All fields optional. `partIndex` names the topic part of a split capture;
absent means part 0, which is the whole capture for everything that was not
split. **404** `part_not_found` for a part that does not exist.

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

**200** `{ capture, decision, turn, parts, partCount }` (every write answers
with the current parts, see `GET /api/captures/:id`; the same holds for
`undo`, `dismiss` and `keep-as-one`). **404** unknown or foreign capture.
**400** `invalid_strand` for an unknown, foreign or archived strand.

## `POST /api/captures/:id/undo`

```json
{ "strandId": "0f4c...", "partIndex": 1 }
```

`partIndex` undoes exactly that part of a split capture. **Without
`partIndex` every part is undone** and the whole capture goes back to the
tray, which is what the undo button on the card means. On a capture that was
not split both are the same call as before.

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

## `POST /api/captures/:id/keep-as-one`

The escape hatch of the split: the user says "that was one thought". Body
empty.

Every part is undone (chat rows removed, created empty strands deleted), all
current decisions become `superseded`, and the ORIGINAL capture text is routed
once with splitting switched off. Same capture row and same id, so nothing the
client holds goes stale. The response has the same shape as `apply`:
`{ capture, decision, turn, parts, partCount }` with `decision.partCount === 1`.

Idempotent: on a capture that already is one part (never split, or kept as one
a moment ago) it answers **200** with the current state and routes nothing, so
a double tap cannot open a second strand. A second call while the first one is
still routing joins it and gets the same answer.

**409** `capture_dismissed` when the capture was thrown away.

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

**200** `{ "decision": {...}, "parts": [...], "partCount": 1, "split": { confidence, rationale, gated } }`.

`decision` is the preview decision of part 0 with the fields
`action, strandId, secondaryStrandId, title, personaId, projectId,
projectSuggestion, intent, confidence, tags, rationale, alternatives, partIndex,
partCount, partText, partTitle, sentenceIds, model, latencyMs, newStrand, notes`.
`notes` lists skipped chain entries, repair retries and threshold hand-overs.
The preview runs the split as well, so a text that would be split previews one
part per topic (`parts[i].decision` is the router decision of that part).

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
{ "type": "capture_routed", "sessionId": "0f4c...", "agentId": "main", "capture": {...}, "decision": {...}, "parts": [{...}], "partCount": 1 }
{ "type": "capture_needs_review", "sessionId": "0f4c...", "agentId": "main", "capture": {...}, "decision": {...}, "parts": [{...}], "partCount": 1 }
{ "type": "now_set_changed", "strandIds": ["0f4c...", "a3d1..."] }
{ "type": "turn_queued", "sessionId": "0f4c...", "agentId": "main", "position": 2, "blockedBy": { "agentId": "main", "sessionId": "a3d1...", "title": "Umzug" } }
```

A split capture still produces exactly ONE `capture_routed` /
`capture_needs_review` frame: a second frame with the same capture id would
show up as a second card in every client that does not know parts.
`decision` and `sessionId` are those of part 0 (backward compatible for the
Android app 0.16.x and the web client), `parts` carries every part in part
order in the shape of `GET /api/captures/:id` (`{ index, title, text,
sentenceIds, decision }`) and `partCount` their number. `parts` is present on
every frame, with one entry for a capture that was not split. The per part user rows
are delivered through the ordinary `user_message` frame of the part's strand,
one per part.

`turn_queued` fires when the answer turn of a capture has to wait for another
turn of the same persona (position >= 2) — the capture path used to stay
completely silent in that case.

A filed capture also produces the existing `external_user_message` frame (now
carrying `sessionId`) so an open strand view can append the row, and an `ask`
capture streams its answer through the normal turn frames of that strand.
