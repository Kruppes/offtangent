# Upstream bug report (draft) — pi-ai `transformMessages` orphans tool_result when it drops error/aborted assistant messages

> Draft for `@earendil-works/pi-ai` (Mario / pi-agent-core team). NOT yet filed.
> Prepared 2026-08-17 by the Axiom fork. Package versions in use:
> `@earendil-works/pi-ai` **0.82.1**, `@earendil-works/pi-agent-core` **0.82.1**.

## Summary

`transformMessages` (`dist/api/transform-messages.js`) drops any assistant
message whose `stopReason` is `"error"` or `"aborted"`, but it does **not** drop
the `toolResult` messages that those tool calls produced. When the surviving
`toolResult` ends up at the front of the transformed history, the provider
rejects the request:

```
400 messages.0.content.0: unexpected `tool_use_id` found in `tool_result`
blocks: toolu_XXX. Each `tool_result` block must have a corresponding
`tool_use` block in the previous message.
```

The mirror problem exists for the leading edge in general: the function
synthesizes results for **trailing** orphaned tool calls
(`insertSyntheticToolResults`) but has no handling for **leading** orphaned tool
results left behind by a dropped assistant turn.

## Where

`transformMessages`, second pass:

```js
if (msg.role === "assistant") {
    insertSyntheticToolResults();
    const assistantMsg = msg;
    if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
        continue;               // <-- assistant (incl. its toolCall blocks) dropped
    }
    const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall");
    ...
}
else if (msg.role === "toolResult") {
    existingToolResultIds.add(msg.toolCallId);
    result.push(msg);           // <-- orphaned result still pushed
}
```

If the dropped assistant message was the one that *emitted* the tool calls, the
following `toolResult` message(s) now have no matching `tool_use` in the output
and the request is invalid.

## Reproduction (message level)

History (AgentMessage[]):

1. `assistant` (`stopReason: "aborted"`) with a `toolCall` block `id: toolu_1`
2. `toolResult` (`toolCallId: toolu_1`)
3. `user` "continue"

After `transformMessages`:

1. `toolResult` (`toolCallId: toolu_1`)   ← orphan at index 0
2. `user` "continue"

Provider then returns the 400 above.

### How we hit it in practice

We drive the bare `Agent` class. A tool executes and its `toolResult` is pushed
to `state.messages`; then the *next* assistant stream fails or is aborted
(watchdog abort via `agent.abort()`, a mid-stream provider 5xx/context-limit
error after the tool ran, `handleRunFailure` synthesizing an `stopReason:"error"`
assistant). On the next turn `transformMessages` drops the error/aborted
assistant and the orphan `toolResult` wedges the session — the same 400 on every
subsequent turn until context is cleared.

## Suggested fix

When an assistant message with tool calls is dropped for `stopReason`
`error`/`aborted`, also drop (or synthesize a placeholder assistant `tool_use`
for) the `toolResult` messages that reference those call ids. Symmetric to the
existing trailing-orphan handling. Concretely, either:

- track the tool-call ids of dropped assistant messages and skip any subsequent
  `toolResult` whose `toolCallId` is in that set (until the next assistant turn
  or user message), or
- drop leading/unmatched `toolResult` messages in the same pass that already
  synthesizes trailing results, so the invariant holds on both edges.

## Workaround we shipped in our fork

A pure `sanitizeHistoryBoundaries(messages)` function enforces the invariant on
both edges (drop leading orphan `toolResult`, strip trailing dangling
`toolCall`, keep valid pairs atomic, cover both dialects via `toolCallId`). We
install it as a `transformContext` hook on the `Agent` (runs immediately before
`convertToLlm`) and also repair `state.messages` after each turn. Happy to
upstream the boundary logic if useful.
