# Interaction blocks

Reference for the interactive blocks a persona can write into a message and
for `POST /api/interactions`, the endpoint that answers them (Offtangent SPEC
7.4c, "answers you tap instead of type"). The wire format, the parser and the
limits live in one dependency-free module,
`packages/core/src/contracts/interaction-blocks.ts`, which the web app (card
renderer), the backend (answer validation) and every plain-text surface
(degradation) share.

The endpoint is JWT protected like `/api/chat/*`
(`Authorization: Bearer <access token>`). Bodies are JSON. Errors are
`{ "error": "<message>", "code": "<machine code>" }`.

## Wire format

A block is a fenced markdown block with the language `offtangent` and a JSON
body, written by the persona into the ordinary message text:

````markdown
```offtangent
{ "block": "choice", "id": "b1", "question": "Hand this to Bob?",
  "options": [ { "id": "yes", "label": "Hand over to Bob" },
               { "id": "stay", "label": "Keep it here" } ] }
```
````

There is **no schema change** on `chat_messages`: the fence stays inside
`content`, so history, search and every existing client keep working. A
surface that cannot draw a card degrades the block to a readable numbered
list, never to raw JSON. Anything that does not parse stays text; the parser
never throws.

| Field | Rules |
|---|---|
| `block` | One of the kinds below. Required. |
| `id` | 1 to 64 characters. Required for every kind except `draft`. |
| `question` | 1 to 500 characters. Required for every kind except `draft`. |
| `options` | 1 to 5 entries (`multi`: up to 8), each `{ "id", "label", "icon"?, "style"? }`; `label` at most 120 characters, `style` is `default` or `danger`. `confirm` builds its two options itself from `confirmLabel` / `cancelLabel` (defaults `Yes` / `No`) and `destructive: true` paints the affirmative one red. |
| `expiresAt` | Optional ISO timestamp; answering after it returns **410** `stale`. |

### Kinds

| Kind | Rendered as a card | Answerable | Notes |
|---|---|---|---|
| `choice` | yes | yes | One option out of at most five. |
| `confirm` | yes | yes | Two options, `destructive` variant. |
| `multi` | no (numbered list) | yes | Up to eight options, several may be chosen. The Android app draws it. |
| `handover` | no (numbered list) | yes | Choice with an icon hint, used for persona handovers. The Android app draws it. |
| `schedule` | no (numbered list) | yes | Reserved; parses, but no picker ships yet. |
| `draft` | no (its own text) | **no** | Output, not a question. See [`draft`](#draft). |

"Rendered" and "answerable" are two different questions on purpose
(`RENDERED_INTERACTION_BLOCK_KINDS` vs. `ANSWERABLE_INTERACTION_BLOCK_KINDS`):
a kind may still degrade to a list in the web app while a client that does draw
it has to be able to send the answer back. Declaring a kind and answering 404
for it would be a broken contract.

### Restraint

- At most **one** interactive card per message. Further blocks in the same
  message degrade to text.
- The first block of an `id` wins; a duplicated id cannot make an answer
  ambiguous.
- A block is an accelerator, never the only path: the plain-text form is the
  question plus a numbered list, and a typed reply ("2" or the label) is parsed
  exactly like a tap.

## `draft`

`draft` (W1 of the puck assist waves, see
[capture modes](./captures-api#capture-modes)) is the odd one out. It carries no
question and no options, only the plain text the user wants to **type**
somewhere else: a mail, a chat message, a form field. It exists so a screenless
device can send exactly that text over a BLE keyboard without guessing which
part of an answer was prose and which part was the draft.

````markdown
Short and polite, here is the reply:

```offtangent
{ "block": "draft", "text": "Hi Alex,\n\nThursday 10:00 works for me.\n\nBest\nSam" }
```
````

The parser is deliberately strict, because the text is typed into a foreign
program verbatim and there is no second chance to sanitize it:

| Rule | Effect |
|---|---|
| `text` required, a string | anything else is not a block and stays text |
| 1 to **4000** characters after trimming the outer whitespace (`INTERACTION_DRAFT_TEXT_MAX`) | longer drafts stay text; `\n` inside is kept |
| no markdown fence (```` ``` ````) inside `text` | rejected: it cannot survive the transport and nobody wants it typed into a mail |
| `id` optional, defaults to `draft` | nothing answers a draft, so the id is only a label |
| `question`, `options` | ignored |

What the surfaces do with it:

- **`GET /api/chat/history`** exposes it as a field: every message carries
  `draft: string | null`, the text of its first well-formed `draft` block, or
  null. Only an **assistant** message can carry a draft; a user message that
  happens to contain the fence gets `null`, because that is the user's own
  text. `content` stays untouched, the fence remains in the message like every
  other block kind. A device therefore never has to run a markdown parser to
  find the text it should type.
- **Plain-text surfaces** degrade a draft to exactly its text (`formatInteractionBlockAsText`);
  a numbered list of zero options would be nonsense.
- **`POST /api/interactions`** does not know it: a draft is invisible to the
  answerable-block lookup, so answering it returns **404** `unknown_block`, the
  same answer an id that does not exist gets.
- **The rendering restraint does not apply.** A draft is data a device fetches,
  not a card competing for the one card slot of a message, so a message may
  carry a `choice` card and a draft at the same time.

The persona is asked to write a draft by the `assist` capture mode: the style
instruction (`captureModes.assist.styleHint`) requests short prose, at most one
question, and the typable text in exactly one `draft` block. Producers on the
server side use `formatDraftFence(text)` rather than hand-rolling the fence.

## `POST /api/interactions`

Answers one block of one message.

```json
{ "messageId": 812, "blockId": "b1", "value": "yes", "clientMessageId": "ans-01J..." }
```

- `messageId` the id of the chat message that carries the block (integer or
  numeric string).
- `blockId` the block's `id`, at most 64 characters.
- `value` the chosen option id (string, at most 64 characters), or for `multi`
  an array of one to eight option ids.
- `clientMessageId` required, at most 64 characters: the idempotency key of the
  user message the answer becomes.

```json
{ "applied": true, "resumed": true, "idempotent": false, "value": "yes", "label": "Hand over to Bob" }
```

`idempotent` is true when this exact `clientMessageId` had already been
applied: the stored answer is returned and nothing is filed or resumed again.

Three things happen on a successful answer, in this order:

1. The answer is recorded in the `chat_messages.metadata` of the message that
   carries the block, so the card rebuilds its collapsed chip after a reload.
2. The chosen **label** is filed as an ordinary user message in the same strand,
   exactly what typing it would have produced, with `clientMessageId` as its
   idempotency key. A retry is a no-op at the database level.
3. If a turn runner is available the turn is resumed with that text
   (`resumed: true`). Without one the answer is filed and nothing runs
   (`resumed: false`).

| Status | Code | When |
|---|---|---|
| **400** | `invalid_body`, `invalid_message_id`, `invalid_block_id`, `invalid_client_message_id`, `invalid_value` | malformed body |
| **400** | `invalid_value` | the value is not an option of this block |
| **404** | `unknown_message` | no such message for this user |
| **404** | `unknown_block` | no answerable block with that id in the message (also every `draft`) |
| **409** | `already_answered` | the block has an answer; the response carries the old `value` |
| **410** | `stale` | the block's `expiresAt` has passed, or the strand the question belonged to is gone |
