# Changelog

Notable behavior changes. Newest first.

## Unreleased — feat/eco-context-policy

### Context-overflow guard for every request (Normal and Eco) — intentional behavior change

One shared pre-send check (`packages/core/src/request-overflow-guard.ts`, wired once in `buildStreamFn`, used by interactive strands and background tasks alike). Details: [docs/guide/models.md → Context-overflow guard](docs/guide/models.md).

What changes for requests that were previously sent:

- **Refused before sending (new):** when both input estimates (chars/3 safety estimate and the SDK's own measured-usage + chars/4 estimate) exceed the operative window (declared, or lower learned), the turn ends with a typed `[context-guard]` message instead of an HTTP 400 from the provider. Also refused: a learned window that could only be met by changing the thinking budget (the guard never changes reasoning fields).
- **Changed on the wire (new):** only when a provider has reported a smaller window than declared, the SDK's own `max_tokens` clamp runs against the learned window (the model copy passed to the SDK has `contextWindow` = learned value). Only `max_tokens` differs; history, system prompt, tool schemas, model id and thinking fields are identical.
- **One transparent retry (new):** a provider overflow error is retried at most once inside the same model call, before any event was forwarded (no tool re-runs, no history change). A second overflow fails fast with a typed, non-retryable message.
- **Persistence (new file):** learned windows are stored in `<DATA_DIR>/config/observed-context-limits.json` (lower-only, 7-day expiry).
- **Trusted learning only:** a window is learned only from a genuine provider overflow: HTTP 400/413 with a JSON error body, the provider's own `message` matching an anchored known grammar (OpenAI/vLLM, llama.cpp typed `n_ctx`, Anthropic), an overflow in the expected direction and an integer window of 1024–16,777,216 tokens. Echoed/validation text, 429/5xx, plain text and nonsense values never change the shared window; the original provider error is passed through.
- **Privacy:** the file stores only a fixed source label (e.g. `openai:max-context-length`), never upstream text, prompts or URLs; older (version 1) files are sanitized on load.

Unchanged: every request with no learned limit and not refused is passed to the SDK with the very same objects (wire byte-identical); ordinary provider errors pass through unmasked; Eco projection and busy toggles are not involved. Not covered: native adapters outside `buildStreamFn`.
