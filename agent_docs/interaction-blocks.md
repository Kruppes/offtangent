# Interactive blocks (SPEC 7.4c)

One wire format, three consumers. The parser is
`packages/core/src/contracts/interaction-blocks.ts`; the web card is
`ChatInteractionBlock.vue`; Telegram degrades through
`renderInteractionMessageAsText`.

## Wire format

A persona writes the block into the message text as a fenced block:

````
```offtangent
{ "block": "choice", "id": "b1", "question": "Hand this to Bob?",
  "options": [ { "id": "yes", "label": "Hand over to Bob", "icon": "handover" },
               { "id": "stay", "label": "Keep it here" } ] }
```
````

`confirm` needs no options — it defaults to Yes/No, and
`"destructive": true` paints the affirmative red:

````
```offtangent
{ "block": "confirm", "id": "c1", "question": "Delete the draft?", "destructive": true }
```
````

No schema change on `chat_messages`: the block travels inside the message, so
history, search and every other surface keep working.

## What renders today

| Kind | R1 | Note |
|---|---|---|
| `choice` | card | one of up to five |
| `confirm` | card | yes/no, destructive variant |
| `multi` | card | up to eight checkbox rows, one "send answer" button; the answer is the array of ticked option ids |
| `handover` | text | needs persona dots/colours first |
| `schedule` | text | needs the time picker first |

Every open card ends with a subtle "Own answer…" button that focuses the chat
composer: a card is an accelerator, and the way out of it is one tap, not a
sentence of instructions.

Text surfaces are unaffected by the card list: `renderInteractionMessageAsText`
degrades *every* block, rendered or not, to the question plus its numbered
list, so Telegram still reads a `multi` as "1. … 2. … (Reply with the numbers
or the labels.)".

Everything that does not parse — broken JSON, an unterminated fence, an
unknown kind, more than five options — stays plain text. The renderer never
throws, and a user never sees raw block JSON except when the JSON itself is
broken (then the fence stays verbatim, which is the honest failure mode).

## Restraint (from the SPEC, enforced in code)

- at most **five** options, at most **one** card per message (further blocks
  degrade to their numbered-list form)
- a block is for a decision with a closed set of sensible options — not for
  open questions, acknowledgements or summaries
- no free-text fields inside a block; the composer is the free-text field

## Answering

```
POST /api/interactions { messageId, blockId, value, clientMessageId }
  -> 200 { applied: true, resumed, idempotent, value, label }
     409 { code: 'already_answered', value, label }
     410 { code: 'stale' }          strand deleted, or the block expired
```

The answer is recorded in `chat_messages.metadata.interactionAnswers[blockId]`
(no schema change) and filed as an ordinary user message carrying the chosen
label, which is exactly what typing the answer would have produced. The
`clientMessageId` is the idempotency key: it is stored on the filed row
(`client_message_id`, partial unique index) and in the answer record, so a
retry of the same tap is a no-op and a *different* answer is a 409.

Telegram parity: the same question arrives as a numbered list and is answered
by typing the number or the label.
