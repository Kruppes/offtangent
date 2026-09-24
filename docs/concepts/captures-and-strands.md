# Captures & Strands

Offtangent's input model is not "pick a chat, then type". You send a thought, and the system decides where it belongs. That decision is made by a small model — the **router** — and the container it files into is a **strand**.

This page explains the four objects involved: capture, router decision, strand, and the now-set, plus the tray where unrouted captures wait for you.

## Capture

A capture is one inbound unit of input: a piece of text, optionally with attachments, always owned by a user. It is stored in the `captures` table before anything else happens to it (`packages/core/src/offtangent-schema.ts`), so nothing that reached the server can be lost by a failing router call.

Columns that matter:

| Column | Meaning |
|---|---|
| `text` | The captured content. Required. |
| `kind` | `text`, `voice`, `image`, or `file`. |
| `source` | Free-form client label, defaults to `web`. |
| `client_message_id` | Client-generated idempotency key, unique per user. |
| `agent_id` | The persona the capture is addressed to. |
| `status` | `pending`, `filed`, `needs_review`, `unsorted`, `moved`, `failed`, `dismissed`. |
| `strand_id` / `message_id` | Where it ended up, once it is filed. |
| `attachments` | Serialized upload descriptors. |

### How a capture gets in

The one write path is `POST /api/captures`, defined in `packages/web-backend/src/api/modules/captures/route.ts`:

```
POST /api/captures
{ text, clientMessageId?, agentId?, strandId?, kind?, source?, attachments?, intent? }
-> 201 { capture, decision }
-> 200 { capture, decision }   // when clientMessageId was seen before
```

The unique index on `(user_id, client_message_id)` is what makes retries safe: a client that resends after a dropped connection gets `200` and the original decision back, not a duplicate thought. Any client that can hold a JWT and send JSON — the web capture surface, a mobile client, a script — uses this endpoint. `source` is just a label the client sets; the server does not restrict it.

Two fields steer the routing before the model is asked:

- `strandId` — the caller already knows the target. The capture is appended there and the router is not consulted for placement ("explicit beats heuristic" in `service.ts`).
- `intent` — `note` or `ask`. See [Intent](#intent-note-or-ask) below. A stated intent overrides everything the router and the server guards would have decided.

### Input paths

| Path | How it arrives | Router? |
|---|---|---|
| Web UI | `POST /api/captures` with `source: 'web'` (the default when the client sends none) | yes |
| Android app | `POST /api/captures` with `source: 'android'` — the app is a separate client, not part of this repo, and it speaks the same endpoint with the same JWT | yes |
| Voice | transcript posted as capture text; see below | yes |
| Script / integration | anything that can hold a JWT and post JSON | yes |
| Telegram | not a capture; see below | no |

`source` is a free-form label the client sets; the server stores it and does not restrict the value.

### Voice

There is no audio routing path: voice always becomes text before it becomes a capture.

- The web client transcribes through the speech API and posts `kind: 'voice'` with the transcript in `text`.
- The Android client transcribes **on the device** and posts the result as `kind: 'text'`. The code notes this explicitly — in the reference database all 51 captures from that client are `kind: 'text'` (`packages/core/src/silence-guard.ts`).

Because of that, server-side handling of dictation must never key on `kind: 'voice'`. The silence guard is the example: it runs on every capture regardless of kind.

### The silence guard

Speech-to-text does not return an empty string for silence, it returns its training data: `* Musik *`, `[Applaus]`, `Thank you.`, subtitle credits. `isSilenceTranscript` (`packages/core/src/silence-guard.ts`) catches those before the router is called:

1. the **whole** text is a bracketed non-speech annotation, up to 40 characters (`* Musik *`, `(Music)`, `♪♪`), or
2. the whole text equals one of a short list of known bare artefacts (subtitle credits, `thank you`, `vielen dank`, …).

A match is stored and immediately dismissed: no router call, no strand, no card in the tray. The response still carries the discarded capture, so the client can say what happened and offer the undo. The rules are deliberately narrow — `Musik aufnehmen für den Film` is speech, because the marker has to *be* the text, not appear in it.

### Telegram is not a capture path

Telegram messages do not go through `/api/captures`. The bot resolves a session per `(user, 'telegram', agentId)` through the session manager and writes the message into that session directly (`packages/telegram/src/bot.ts`, `getOrCreateSession(userId, 'telegram', this.agentId)`), then runs a turn. Documents, photos and voice messages take the same path — attachments are stored via `saveUpload({ source: 'telegram', … })` and attached to that session's message.

Consequences, all of them behavioural:

- A Telegram message never gets a `router_decisions` row and never lands in the tray.
- It always goes to one fixed persona: the bot's `agentId`, `'main'` unless configured otherwise.
- It always produces an answer; there is no `note` intent on this path.

If you want router placement for mobile input, use a client that posts captures.

### Attachments

Attachments are uploaded first through the uploads API and referenced by descriptor on the capture. The service serializes them into `captures.attachments` and passes the same descriptors through to the message it writes into the strand (`packages/web-backend/src/api/modules/captures/service.ts`). The router reasons over the capture text, not over the file content.

## The router

The router turns a capture into a **proposal**: which strand, or a new one, or nothing. It lives in `packages/core/src/capture-router.ts`.

### Which model

The router is its own role in the model policy (`packages/core/src/router-model.ts`), separate from the chat model and the task model. It resolves to a chain of `providerId:modelId` candidates; the chain is tried in order, and the pair that answered is written to `router_decisions.model` together with `latency_ms`. Configure it under the router role rather than assuming the chat model is used.

### What it sees

The router is not shown the whole history. It gets a candidate set: the 20 most recently active strands, plus strands whose tags match a keyword of the capture, capped at 25 candidates. That cap is why placement quality degrades on very large workspaces with a stale tag vocabulary — tags are how an old strand stays reachable.

### The three actions

`router_decisions.action` is one of `append`, `new_strand`, `link` — constrained in SQL. Plus the fourth outcome, which is *no* action: the capture stays unsorted.

| Outcome | Meaning |
|---|---|
| `append` | Add the capture to an existing strand. |
| `link` | Attach it to a strand while recording a second, related strand (`secondary_strand_id`). |
| `new_strand` | Open a new strand; title, persona and project proposal are stored in `new_strand_title`, `new_strand_persona`, `new_strand_project`. |
| unsorted | Nothing is applied. The capture goes to the tray with status `unsorted`. |

### Confidence bands

Two thresholds, both exported from `capture-router.ts`:

```ts
export const CONFIDENCE_HIGH = 0.7
export const CONFIDENCE_MEDIUM = 0.4
```

They are the band boundaries: at or above `0.7` is *high*, at or above `0.4` is *medium*, below that is *low*.

The important guard is on appends. An `append` or `link` proposal whose confidence is **below `CONFIDENCE_HIGH`** is not applied as proposed — it becomes a new strand instead, and the decision records why, with the marker `router guard: append below the high band` plus the actual number and the strand it wanted to append to. The asymmetry is deliberate: a wrong new strand costs you one merge, a wrong append buries a thought inside an unrelated conversation.

Project assignment has a separate, lower bar: a project suggestion is only attached at or above `PROJECT_SUGGESTION_MIN_CONFIDENCE = 0.55`, and it is a *suggestion* — the strand carries it until you accept or dismiss it (`POST /api/strands/:id/project-suggestion/accept` / `/dismiss`).

### Intent: note or ask

Placement and answering are two separate questions. `intent` decides the second one, and it decides it alone: in `file()` the turn runs if and only if `proposal.intent === 'ask'` (`packages/web-backend/src/api/modules/captures/service.ts`). A `note` is filed silently, bumps the strand's activity and stops there.

The router proposes the intent (`ask` whenever the capture expects something from you, `note` only for a pure self-note), and the server then re-checks it, because the two mistakes are not equally expensive: a wrong `ask` costs one superfluous paragraph, a wrong `note` leaves a question sitting silently in a strand nobody looks at.

Two server-side guards can upgrade a `note`:

| Guard | Condition | Result |
|---|---|---|
| `guardNoteIntoLiveDialog` | `note` filed into an existing strand in which a persona has already answered (`action` ≠ `new_strand`) | intent becomes `ask`, marker in the rationale |
| `guardAddressedNote` | `note` whose text carries address markers, measured server-side by `addressStrength` | **strong** (two marker classes or more) → `ask`; **weak** (exactly one) → stays `note` and asks back; **none** → filed in silence |

The weak band is the interesting one: instead of guessing, the service writes one short confirmation card into the strand with two options — keep it as a note, or answer it after all. No model call, no turn until you tap. The tap arrives through `POST /api/interactions` and lands in `confirmNoteFiling`, which marks the decision `confirmed`, sets the capture to `filed`, and only starts the turn for the "answer" option. Both paths are idempotent: a capture that is already being answered is left alone.

Whichever guard fires first owns the rationale, so a decision row never carries two markers. A client that sends `intent` explicitly skips all of this.

### Confidence and `needs_review`

The confidence band decides *where* the capture goes and whether that placement stays open for review; the intent decides whether an answer is owed. The two were deliberately decoupled:

| Band | Capture status | Answers? |
|---|---|---|
| high (≥ 0.70) | `filed` | when intent is `ask` |
| medium (≥ 0.40) | `needs_review` | when intent is `ask` **and** the action is `new_strand` |
| low (< 0.40) | `unsorted` (tray), or `failed` when the router never really ran | no |

The medium-band restriction is safe because the low-confidence guard has already rewritten every sub-0.70 `append`/`link` into a `new_strand`: a medium-band filing always lands in a strand that this very capture opened, never in a foreign history.

Confirming a `needs_review` filing through `/apply` moves the decision to `confirmed` and the capture to `filed`, and starts the turn that never ran if the intent asked for one.

### When the router fails

Every failure — no provider, a provider error, an unparseable answer — degrades to the same thing: an unsorted decision that is never applied. The capture is already persisted at that point, so a router outage costs you sorting, not content. You can retry the placement later from the tray.

### How the decision is stored

Every routing attempt writes a `router_decisions` row keyed by `capture_id`:

- `action`, `target_strand_id`, `secondary_strand_id`, `created_strand_id`
- `intent`, `confidence`, `alternatives`, `tags`, `rationale`
- `new_strand_title`, `new_strand_persona`, `new_strand_project`, `project_suggestion`
- `model`, `latency_ms`
- `state`: `proposed`, `applied`, `confirmed`, `undone`, `superseded`
- `created_at`, `applied_at`, `resolved_at`

The stored `action` is what actually happened, not what the model asked for — when the low-confidence guard rewrites an append into a new strand, the row says `new_strand` and the rationale carries the marker. The `state` column is what makes filing reversible: an undo moves a decision to `undone` instead of deleting the history of it.

To see what the router *would* do without writing anything, admins can call `POST /api/router/preview { text, agentId? }`.

## Strand

A strand is the container a capture is filed into. Technically it is a thread — the same sessions and messages a chat uses — with strand-specific state on top: tags, now-set rank, links, a project, an archived and a pinned flag (`GET /api/strands` returns `Thread + { tags, nowRank, links }`).

What makes it different from a classic chat thread is not the storage, it is who decides membership:

- **A thread is chosen by you before you type.** A strand is chosen by the router after you send.
- **A thread is a conversation.** A strand is a topic that may collect many small, unrelated-in-time inputs — three notes in the morning, a question in the evening — without you navigating anywhere.
- **A strand carries routing metadata.** Tags (set by you or by the router, `strand_tags.source` records which), a now-set rank, links to other strands.

Strands are addressed by the normal endpoints: `PATCH /api/strands/:id` for `archived`, `pinned`, `title`; `PUT /api/strands/:id/tags` for tags; `DELETE /api/strands/:id?confirm=1` with a mandatory preview at `GET /api/strands/:id/delete-preview`. A delete is refused with `409 strand_busy` while a turn of that strand is running.

### Projects

Projects sit one level above strands: a strand may belong to at most one project, and the router may *propose* one (`new_strand_project`, `project_suggestion`). A proposal never silently becomes an assignment — you accept it, which sets the project, or dismiss it, which buries that (strand, project) pair permanently. Accepting a project on a strand that already has one fails with `409 project_already_set`. See the [Projects API](../reference/projects-api).

## The now-set

The now-set is the short, ordered list of strands you are actually working on. It is not a filter and not a pin — it is a bounded set with a rank.

- `GET /api/now` returns the strands by rank plus the effective `max` and the `mode` the set is filled with.
- `PUT /api/now { strandIds }` replaces the set (manual mode only). Exceeding the limit fails with `400 now_set_too_large`.

### Automatic (default) or manual

The setting `offtangent.nowSetMode` decides who fills the set:

| Mode | Where the list comes from | `PUT /api/now` |
|---|---|---|
| `auto` (default) | computed from your own activity, per request | `409 now_set_auto` |
| `manual` | the curated `now_set` table | replaces the set as before |

In `auto` the ranking is `rankStrandsByActivity` (`packages/core/src/strand-store.ts`):

- Candidates are your own interactive, non-archived strands that carry a title.
- A strand scores per **distinct calendar day** (UTC) on which it saw a message with `role = 'user'` in the last **14 days**; a day contributes `0.5 ^ (age / 1 day)`. Days, not messages: a bench thread with 92 messages in two days must not outrank a strand you came back to on five separate days. With a one-day half-life recency is the dominant term (a strand touched today beats four days of last week), while returning still wins between two strands of the same age: today plus the two days before scores 1.75 against 1.0 for a single fresh day. Only your own messages count, so cron runs, task reports and system injections never pull a strand in.
- Pinned strands come first (among themselves by score), then the rest by score; ties break by the most recent user activity, then by id, so two reads give the same list.
- Strands without a score appear only when they are pinned, and the list is cut at `max`. A short or even empty now-set is a valid answer.

Window and half-life are documented constants (`NOW_SET_RANKING_WINDOW_DAYS`, `NOW_SET_RANKING_HALF_LIFE_DAYS`), not settings.

In `auto` the `now_set` table is never read or written — switching back to `manual` restores exactly the set that was curated before, which is also the rollback path. A filing does not pull its strand into the table any more; instead the computed list is recomputed after the capture's message and after a user message in the chat, and `now_set_changed { strandIds }` is broadcast only when the computed list actually changed. Archiving a strand simply drops it out of the computed list.

In `manual` a filing adds to the set by itself: after a capture is written into a strand, `addToNowSetIfRoom` puts that strand into the now-set **if there is room**, and broadcasts `now_set_changed`. It never evicts anything you put there.

The bound is the setting `offtangent.nowSetMax`, default **4** (`DEFAULT_NOW_SET_MAX` in `packages/core/src/contracts/settings.ts`). The store enforces it in code as well: `setNowSet` and `addToNowSetIfRoom` take the max and refuse to exceed it, and `addToNowSetIfRoom` is the "add only if there is room" path — it returns `false` rather than evicting something you put there yourself.

The point of the limit is that the now-set is supposed to be a decision, not an inbox. Everything else stays reachable through the strand list, tags, and the resurface queue (`GET /api/resurface`, `POST /api/resurface/:strandId/snooze { days }`).

## The tray: unsorted captures

A capture with status `unsorted` is in the tray. It gets there when the router declined, failed, or had nothing to work with — never because the low-confidence guard rewrote an append (that produces a real strand).

Three endpoints, all under the capture:

| Endpoint | Effect |
|---|---|
| `POST /api/captures/:id/apply { decisionId?, action?, strandId?, title?, personaId? }` | File it. Either confirm the stored proposal or override it with your own action, target strand, new-strand title and persona. |
| `POST /api/captures/:id/undo { strandId? }` | Take it back out of the strand it was filed into. The capture returns to the tray, the decision moves to `undone`. |
| `POST /api/captures/:id/dismiss` | Throw the card away. Status becomes `dismissed`; the capture row and its text stay in the database, and undo restores it. |

So filing is reversible in both directions: you can file an unsorted capture, and you can unfile a filed one. Dismiss is the "this was noise" button, not a delete — nothing is erased, the card just stops asking for attention.

Listing: `GET /api/captures?status=&limit=&offset=` returns `{ captures, decisions }` together, so a client can render each card next to the reasoning that produced it.

## From input to filed thought

The path for one capture, with the file to open when it misbehaves:

| Step | Where |
|---|---|
| 1. Client posts the capture | `POST /api/captures` — `packages/web-backend/src/api/modules/captures/route.ts` |
| 2. Validation, idempotency, persistence | `packages/web-backend/src/api/modules/captures/service.ts`, table in `packages/core/src/offtangent-schema.ts` |
| 2b. Silence transcripts discarded before routing | `packages/core/src/silence-guard.ts`, `isSilenceTranscript` |
| 3. Router model resolved (chain, fallbacks) | `packages/core/src/router-model.ts` |
| 4. Candidates collected, model asked, proposal scored | `packages/core/src/capture-router.ts` |
| 5. Low-confidence append rewritten into a new strand | `capture-router.ts`, `LOW_CONFIDENCE_APPEND_MARKER` |
| 6. Intent re-checked server-side (`note` → `ask`, or ask back) | `guardNoteIntoLiveDialog`, `guardAddressedNote` in the captures service |
| 6b. Decision persisted | `router_decisions` |
| 7. Applied: message written into the strand, `captures.status = 'filed'` | captures service |
| 8. Not applied: `status = 'unsorted'`, card in the tray | captures service |
| 9. You confirm, re-file, undo, or dismiss | `/apply`, `/undo`, `/dismiss` |
| 10. Strand state afterwards: tags, now-set, project | `packages/web-backend/src/api/modules/strands/route.ts`, `packages/core/src/strand-store.ts` |

The feed (`GET /api/feed`) is the read side of the same data: it merges captures, strands and their recent activity into one chronological surface. See the [Feed API](../reference/feed-api).

## See also

- [Captures API](../reference/captures-api) — full request and response shapes for `/api/captures` and `/api/router`.
- [Strands API](../reference/strands-api) — strands, tags, now-set, resurface.
- [Feed API](../reference/feed-api) — the merged read surface.
- [Personas](./personas) — `agent_id` on a capture picks which persona answers.
