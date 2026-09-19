# Agent

Language preferences, active provider + model, reasoning level, and the user-editable rules the agent follows on every turn.

**URL:** `/settings?tab=agent`

## Agent Rules

A card at the top of the panel links to `/data/config/AGENTS.md` — the file the agent reads on every conversation as its "user-editable behavior rules" block.

Click **Open editor** to jump to the [Agent Instructions](../concepts/instructions#agents-md) page, where the file opens in a full-screen Markdown editor with a **Restore default** button.

See [Agent Instructions](../concepts/instructions) for what belongs in this file, the default template, and editing tips.

## Agent language

Forces the agent's reply language. Mapped to the `<language>` block in the system prompt.

| Value                                                                                                                  | Behavior                                               |
|------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------|
| `match`                                                                                                                | Mirror the user's language on each turn.               |
| `English`, `German`, `French`, `Spanish`, `Italian`, `Portuguese`, `Dutch`, `Russian`, `Chinese`, `Japanese`, `Korean` | Reply in this language regardless of the user's input. |

Applies immediately on the next turn.

```json
{ "language": "German" }
```

## Timezone

The current date in this timezone is injected into the system prompt, and the minute-level time is appended to each user message, so the agent always knows "now" (the time is kept out of the system prompt to avoid invalidating provider prompt caches every minute — see [System Prompt → layer 16](../concepts/system-prompt#_16-current-date-current-date)). Also used for cron evaluation (Tasks & Heartbeat) and the naming of `memory/daily/<date>.md` files.

Default: `UTC`. Mirrors the container's `TZ` env var if set.

```json
{ "timezone": "Europe/Vienna" }
```

## Provider

The active provider + model used for all normal chat conversations. The dropdown shows every enabled model across every configured provider (e.g. `ChatGPT Plus (gpt-5.4-mini)`, `Anthropic (claude-sonnet-4)`, `Ollama (qwen2.5-coder)`).

Changing this value activates the chosen combination immediately — in-flight sessions will use the new provider on their next turn.

Internally stored as two keys:

```json
{
  "activeProviderId": "openai-chatgpt-plus",
  "activeModelId": "gpt-5.4-mini"
}
```

Configure providers themselves (add new ones, enable/disable models, set API keys) on the [Providers](../web-ui/providers) page, not here.

## Thinking level

How hard the main chat agent reasons before replying. Higher levels are slower and more expensive; they are silently ignored by models that don't support reasoning (e.g. plain GPT‑4o).

| Value     | Use for                                             |
|-----------|-----------------------------------------------------|
| `off`     | Plain chat, no reasoning tokens.                    |
| `minimal` | Tiny amount of reasoning — default for most people. |
| `low`     | Quick internal planning.                            |
| `medium`  | Multi-step problems.                                |
| `high`    | Hard reasoning, tool-heavy flows.                   |

This only applies to the **interactive chat agent**. Background jobs (tasks, heartbeat) have their own setting in [Tasks → Background thinking level](./tasks#background-thinking-level).

```json
{ "thinkingLevel": "minimal" }
```

## Upload retention

How many days uploaded files in `/data/uploads/` are kept before the cleanup job removes them. Applies to images, audio, and any other files users attach from the web UI or Telegram. Default: `30`. Set to `0` to have the next cleanup run delete all uploads.

```json
{
  "uploads": {
    "retentionDays": 30
  }
}
```

> The cleanup job also prunes the referencing rows in the database so stale upload metadata doesn't linger after the files are gone. It also sweeps part files of interrupted uploads (`/data/uploads/.tmp`) once they are older than a day.

## Now set size

How many strands may be in the now set at the same time — the strands that are
currently in play. Default: `4`, allowed range `1`–`12`.

```json
{
  "offtangent": {
    "nowSetMax": 4
  }
}
```

The value is read per request, so a save applies to the next call without a
restart. It is enforced in three places: `PUT /api/now` (a longer list answers
**400** `now_set_too_large` and the message names the value in force), the
limit used when listing the now set, and the automatic pull of a strand into
the set when a capture is filed into it.

**Lowering the value never removes a strand.** A set that is larger than the
new value stays as it is and is still returned in full; only further additions
are refused until the set fits again. `GET /api/now` reports the value in force
as `max`, so clients do not have to guess it — see
[Strands API → Now set](../reference/strands-api#now-set).

## Upload limits

Attachments are not filtered by type — photos, videos, archives, binaries, anything. The only limits are the ones that keep the host alive, and they are environment variables, not settings:

| Limit | Default | Variable |
|---|---|---|
| Size per file | 500 MB | `UPLOAD_MAX_FILE_SIZE_MB` |
| Files per message | 20 | `UPLOAD_MAX_FILES` |
| Free disk floor (else `507`) | 2048 MB | `UPLOAD_MIN_FREE_DISK_MB` |

See [Environment Variables → Uploads](../reference/env-vars#uploads-attachments).

## Resilience

How the agent reacts when a provider misbehaves mid-turn. All five fields are read at the **start of every turn**, so a save applies to the next message — no restart needed.

### Automatic retry

When a turn fails with a transient provider error (429, 5xx, timeout, dropped stream, or a watchdog stall abort), Offtangent discards the failed attempt and re-runs the turn from the existing transcript — the user message is never sent twice. Errors the provider won't recover from on its own (invalid API key, quota, billing) fail immediately, and a turn you stop yourself is never retried.

| Field                 | Default | Range              | Effect                                                                       |
|-----------------------|---------|--------------------|------------------------------------------------------------------------------|
| **Automatic retry**   | on      | —                  | Master switch. Off means every provider error ends the turn immediately.     |
| **Maximum retries**   | `3`     | `0` – `10`         | Retry budget per turn. `0` behaves like the switch being off.                |
| **Base delay**        | `2000` ms | `100` – `60000` ms | Backoff base; attempt *n* waits `base × 2^(n-1)` — with the defaults 2s / 4s / 8s. |

While a retry is pending the chat shows a `Retrying (n/max)…` status. Once the budget is exhausted, the turn ends with a persisted error message containing the provider's error text.

```json
{
  "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 2000 }
}
```

### Stall thresholds

The watchdog measures how long a turn goes without a single chunk from the provider. At the warn threshold a `provider_stall` message is written to the chat (it survives a reload and is updated in place when the provider recovers); at the abort threshold the stream is hard-aborted, which counts as a retryable error.

| Field                       | Default   | Range                                        |
|-----------------------------|-----------|-----------------------------------------------|
| **Stall warning threshold** | `30000` ms | `1000` – `600000` ms                          |
| **Stall abort threshold**   | `90000` ms | `1000` – `3600000` ms, must be ≥ the warning threshold |

```json
{
  "watchdog": { "stallWarnMs": 30000, "stallAbortMs": 90000 }
}
```

Stall frequency and average duration (split by recovered vs. aborted) are aggregated on the [Token Usage](../web-ui/token-usage) page. Telegram delivery of the warning is opt-in — see [Telegram → Send stall warnings](./telegram#send-stall-warnings).
