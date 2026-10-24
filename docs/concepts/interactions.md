# Interactions

An interaction is a question card the agent puts in front of you: a choice, a confirm, a short free-text field. Until Stufe 1 the card lived only as an `offtangent` fence inside the assistant message and its state was spread over message metadata and read-time heuristics. Since S1-A the card has one row in the `interactions` table, and that row is the **only** source of its state.

The message text still carries the fence, so old clients keep rendering the card. Whether the card is open, answered or gone is decided by the table, not by the text.

## The row

| Column | Meaning |
|---|---|
| `id` | `ia_<ulid>`, stable across devices |
| `strand_id`, `message_id`, `block_id` | Where the card lives: strand, assistant message, block id inside the fence |
| `tool_call_id` | Reserved for cards that arrive as a tool call (later stage) |
| `user_id`, `agent` | Whose card and which persona asked |
| `payload` | The block JSON, validated with the core contract (`parseInteractionBlockPayload`) before it is written |
| `blocking` | Whether the card waits for you (default yes) |
| `status` | `open`, `answered`, `dismissed`, `superseded`, `expired` |
| `answer` | Value, label, `answeredAt`, `clientRequestId`, `resumed` |
| `draft` | Partial answers, saved per step so a wizard can be continued on another device |
| `created_at`, `expires_at`, `closed_at` | Timestamps, ISO UTC |
| `closed_surface` | `web`, `app`, `telegram`, `system` |
| `close_source` | `answer`, `dismiss`, `user_continued`, `timeout`, `newer_question`, `backfill` |

An index over the open rows per strand keeps the attention query cheap.

## States

```
open ──answer──────────────> answered    (terminal)
open ──dismiss─────────────> dismissed   (terminal)
open ──user_continued──────> superseded
open ──newer_question──────> superseded
open ──timeout─────────────> expired     (terminal)
```

The contract is strict: only `open` leaves its state. All four closed states are terminal, `superseded` included — a passed-over card is no longer answerable or dismissable (the app shows it as not clickable since S0-B/B4). An answer or dismiss on a closed card is `409` with its `status` (`410` for `expired`), on the id endpoints and on the legacy door alike.

Every state change goes through one function in `packages/core/src/interaction-store.ts`. An edge that is not in that list throws `InteractionTransitionError` (for example `answered -> open`), so no endpoint can produce a state the model above does not know.

Two edges are written without an endpoint:

- **user_continued.** You write in the strand instead of tapping. There is no database trigger: every place that persists a user message (`POST /api/chat/message`, the WebSocket chat, Telegram, the capture router, the answer row of a card) calls `supersedeOpenOnUserMessage(strandId, userId)` in the same step. It closes the open cards of that strand that are older than your message — every agent, cards of the same user or without owner, never another user's — through the transition function, so every closed card emits `interaction.updated`.
- **newer_question.** When a new assistant message brings a card, the open cards of older messages in the same strand are closed. Cards of one message stay open side by side.

`superseded` is stored, not recomputed: answering a newer card does not bring an older one back.

**Expired before superseded, live too.** Both live stale paths (`createInteraction` for a newer card, `supersedeOpenOnUserMessage` for a user message) first move every open card of the strand whose `expires_at` has passed to `expired` (`timeout`), in the same transaction; only cards still answerable become `superseded`. Same precedence as the backfill.

- **timeout.** There is no background job. Whenever open cards are read (attention, `GET /api/strands/:id/interactions`), every open row whose `expires_at` has passed is moved to `expired` (`close_source = timeout`, `closed_at` = the expiry time) and an `interaction.updated` event goes out. A card that expires while nobody looks at it stays `open` in the table until the next read, but it is never shown as open.

## Endpoints

| Endpoint | Body | Effect | Turn |
|---|---|---|---|
| `POST /api/interactions/:id/answer` | `{ value, clientRequestId }` | Answers the card, files your answer as a user message, starts the turn | yes |
| `POST /api/interactions/:id/dismiss` | `{}` | Closes the card as `dismissed` | **no** |
| `PUT /api/interactions/:id/draft` | `{ answers }` | Stores partial answers | no |
| `GET /api/strands/:id/interactions?status=open` | | Lists the cards of a strand, optionally filtered by status | no |
| `POST /api/interactions` (legacy) | `{ messageId, blockId, value, clientMessageId }` | Same as answer; looks the row up by message and block id and writes through the table | yes |

**Ownership.** A card or strand belongs to its `user_id`. A foreign card is `404`, the same as a missing one. A card or strand without owner (`user_id` NULL) is visible and operable only for a user with the `admin` role; for everybody else it is `404` on list, answer, dismiss and draft. The backfill takes the owner of a card from `sessions.user_id` where the strand has one.

**Idempotency.** The key `(user_id, clientRequestId)` is bound, in the same transaction as the transition, to the card AND a hash of the value (`interaction_requests`). Before every transition: same key, same card, same value is a replay (`200`, `idempotent: true`, no second turn); same key with another card or another value is `409 idempotency_conflict` with the `status` of the card the key was first bound to, and nothing changes. Any answer to a card that is no longer open returns `409` with the current `status` and the stored answer, so the client can show what actually happened.

**Order of an answer.** Binding, transition (`answer.resumed = false`) and the user row are one transaction; the turn starts after the commit. If the turn does not start, the answer stays stored with `resumed = false` and the endpoint answers `502` with `retryable: true`. A retry with the same key and value only starts the turn again; it writes no second user row. After the turn started, `resumed` is set to `true`.

**Non-blocking cards** (`blocking = 0`): the answer is stored and emitted, no user row is written and no turn starts. Feeding the answer into the context of the next turn is S1-B.

**Dismiss** never starts a turn and writes no user message. Dismissing twice is harmless.

**Secrets.** The payload is the question as the model wrote it and never passed the secret boundary. Every response that carries a row (answer, dismiss, draft, list, `409` bodies) and every WebSocket frame sends the payload, the draft and the answer with every string sealed, recursively (`sealText`, tier `user`, as for the answer label). The table stays the raw source: backfilled answer labels are imported as they were and sealed on the way out. The attention prompt in `GET /api/strands` passes the same boundary before it is cut. A credential in a question or an option label therefore leaves the server only as a `{{secret:…}}` handle. See `packages/web-backend/src/interaction-seal.ts`.

## Live updates

Every state change emits an event on `interactionEvents`; the WebSocket layer forwards it to every client of the strand. Inside a transaction (`runInteractionTransaction`) the events are collected and emitted only after the COMMIT; a transaction that fails emits nothing.

- **Nesting.** A `runInteractionTransaction` inside another one hands its events to the outer one; only the outermost (the owner of the real transaction) emits, after its COMMIT.
- **Foreign transactions.** Inside a transaction the outbox does not own (a caller's raw `db.transaction`, entered while `db.inTransaction` is already true) the outbox cannot see the commit. Events produced there are dropped with a one-time warning; they are never sent before that commit. Code that needs the events runs its transaction through `runInteractionTransaction`.
- **Best effort.** The outbox lives in process memory. A crash between the COMMIT and the emission loses those WebSocket events; the table stays the truth and clients re-sync through the list endpoints. Events are not a durable delivery guarantee.

- `interaction.open`: a new card
- `interaction.updated`: status changed (answer, dismiss, superseded, expired)
- `interaction.draft`: partial answers changed

## Attention

"Awaiting you" for a strand (`strand-attention.ts`) reads only the table: the newest open row per strand, younger than the attention age limit and not past its `expires_at`. The message text is not parsed any more. A card that exists only as a fence without a row is not attention.

## Backfill

Cards written before S1-A exist only as fences. On startup `initDatabase` runs `backfillInteractions` once; the marker `s1a-backfill-v1` in `interaction_migrations` makes a second run a no-op. Every legacy card gets a row with the state the shared stale rule (S0-B/B4) gives it:

| Legacy card | Row |
|---|---|
| Answer in the message metadata | `answered`, `close_source = answer` |
| `expiresAt` in the past | `expired`, `close_source = timeout` |
| A later user message in the strand | `superseded`, `close_source = user_continued` |
| A newer card in the strand | `superseded`, `close_source = newer_question` |
| Strand no longer exists | `superseded`, `close_source = backfill` |
| Otherwise | `open` |

A card that appears twice (same message and block id) gets one row. Payloads that fail the contract get no row. Precedence is top to bottom: an answered card stays answered even if it has expired since, and a card that is both expired and passed over is `expired` (`timeout`). This deliberately differs from report.md 3.x (which ranks "passed over" first): the merged S0-B client (shared fixture and Kotlin) ranks `expired` above `skipped`, and the web/app contract takes precedence over the report.

## Live path

When the turn runner persists an assistant message, it hands the content to `ingestInteractionMessage`, which writes one row per answerable fence card in the same step. Output-only blocks (`draft`) get no row.

## See also

- [Captures & Strands](./captures-and-strands): the confirmation card of the router uses the same endpoint
