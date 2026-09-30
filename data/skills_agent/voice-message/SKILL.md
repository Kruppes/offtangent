---
name: voice-message
version: 1.0.0
description: Rules for speaking an answer instead of only writing it — when a voice message is the right form, how to write text that works for the ear, how to call send_voice_message exactly once, and what to do when the tool fails. Load this before sending any voice message.
requires_toolsets: [send_voice_message]
---

# Voice message

A voice message is an answer someone listens to, often while doing something else. It cannot be skimmed, scrolled back or copied. Write it like you would leave it on someone's voicemail: the point first, a few sentences, done.

## When to send one

Send a voice message when:

- the user asks for one ("say that out loud", "send it as audio", "read it to me"),
- the user says they cannot read right now (driving, walking, cooking, eyes busy, hands busy),
- the conversation is already spoken — the user dictates and expects to be answered the same way.

Do **not** send one when:

- the turn already carries a `<voice_reply>` hint. That hint means the server speaks your written answer automatically. Write the answer and stop; a second spoken version is noise.
- the content only works on screen: code, commands, tables, long lists, links, file paths, id strings.
- the user did not ask and nothing suggests they cannot read. Text is the cheaper default.

One voice message per answer. Never call the tool twice in the same turn.

## Write for the ear

- Say the outcome in the first sentence. Details after, only the ones that matter.
- Short, plain sentences. No subordinate-clause towers.
- No markdown: no headings, bullets, asterisks, backticks, tables.
- No code, no commands, no urls, no file paths, no hashes, no ids. If the answer depends on them, keep them in the written line and say "the details are in the message".
- Numbers, dates, units and abbreviations the way they are spoken: "about three hundred", "twenty past four", "roughly two gigabytes", "for example" instead of "e.g.".
- No secrets, no keys, no tokens, no passwords, no private addresses — spoken audio is easy to overhear and hard to redact.
- Keep it under a minute of speech unless the user asked for more. Fewer sentences beat a complete but exhausting monologue.

## How to call the tool

1. Write the final spoken text yourself, already cleaned up by the rules above.
2. Call `send_voice_message` once with that exact text. It is spoken verbatim — nothing summarizes or rewrites it afterwards, so whatever you hand over is what the user hears.
3. Keep a short written line in your answer next to it (one or two sentences, or the details that do not belong in audio). Do not paste the whole spoken text again.

The text has a character limit. If the tool answers that the text is too long, shorten it — cut details, not sentences into fragments — and call it once more. Never try to split one answer across several voice messages.

## When it fails

The tool returns the real error. If it fails:

- say so plainly in your written answer ("the voice message could not be created: …"),
- give the full answer in text instead,
- do not retry more than once, and never silently drop the answer.

If the tool reports that there is no live turn to attach the voice message to (for example in a background job), answer in text and mention that audio is not available in that context.
