# Telegram

Per-field reference for the **Settings → Telegram** panel. This page assumes you already have a bot token and have the bot up and running — if not, start with the [Telegram Bot setup guide](../guide/telegram), which walks through BotFather, finding your Telegram user ID, and approving yourself.

**URL:** `/settings?tab=telegram`

::: warning Where these values are stored
Unlike most settings (which live in `/data/config/settings.json`), all fields on this page are stored in **`/data/config/telegram.json`**. Each section below shows the exact key and snippet.
:::

## Enabled

Master toggle for the Telegram integration. When off, the bot is not started on container boot and no incoming messages are processed. Toggling this in the UI takes effect immediately — no restart needed.

```json [/data/config/telegram.json]
{ "enabled": true }
```

## Bot token

The secret token from [@BotFather](https://t.me/BotFather). The Settings UI renders it as a password field, but the value is **stored in plain text** in `telegram.json` — protect that file (and your `/data` directory) accordingly. It is **not** kept in [Secrets](./secrets).

To rotate: paste a new token here and save. The old bot stops working on the next request; the new one becomes active immediately.

> If you don't have a token yet, see [step 1 of the setup guide](../guide/telegram#_1-create-a-bot-with-botfather).

```json [/data/config/telegram.json]
{ "botToken": "123456:ABC..." }
```

## Batching delay

When a human types a multi-line message on Telegram, each line often arrives as a separate update. Offtangent waits `batchingDelayMs` after each arriving message before flushing them all to the agent — this way "Hi / how are you / btw" becomes one prompt instead of three.

Default: `2500` (2.5 s). Range: `0` – `10000`. Set to `0` to disable batching (each message triggers an agent turn immediately).

```json [/data/config/telegram.json]
{ "batchingDelayMs": 2500 }
```

## Send voice reply

When enabled, after the agent produces a text reply the Telegram gateway also synthesises that reply via the configured TTS provider and uploads the result to the Telegram chat in addition to the regular text message.

Requires a working Text-to-Speech configuration (see [Settings → Text-to-Speech](./text-to-speech)). The TTS provider, voice, and audio format set there control how the voice reply is generated; this toggle only controls *whether* it is sent to Telegram.

Delivery mode is picked automatically based on the TTS [Audio format](./text-to-speech#audio-format):

- `opus` — sent via `sendVoice`, renders as a native Telegram voice message.
- Anything else (`mp3`, `wav`, `flac`) — sent via `sendAudio`, renders as a regular audio attachment.

Failures are non-fatal: if synthesis or upload fails, the text reply is still delivered and a warning is logged server-side.

```json [/data/config/telegram.json]
{ "sendVoiceReply": false }
```

## Send stall warnings

When the provider stops sending data mid-turn, Offtangent writes a stall warning into the chat (see [Agent → Resilience](./agent#resilience)). This toggle controls whether that warning is also pushed to the Telegram chat.

Default: **off** — short provider hiccups usually resolve themselves and would otherwise show up as noise in Telegram. Terminal error messages and the retry button are always delivered, regardless of this toggle.

```json [/data/config/telegram.json]
{ "sendStallWarnings": false }
```

## Telegram users

The user directory. Every Telegram account that has ever `/start`ed the bot shows up here with one of three statuses:

| Badge | Meaning |
|---|---|
| `pending` | First contact — the bot replied "waiting for approval" and is ignoring this user until you approve. |
| `approved` | Messages are processed as normal. |
| `rejected` | Explicitly blocked. The bot silently drops all incoming messages from this account. |

Each row shows avatar, display name, `@username`, numeric Telegram ID, and the linked Offtangent user (if any).

The list itself is **not** stored in any config file — it lives in the Offtangent database (`telegram_users` table), managed via this panel or the `/api/telegram-users` endpoints.

### Approve

Primary action on a `pending` row. Clicking it flips status to `approved` and lets the user talk to the agent.

### Row menu

Additional actions under the `⋮` menu:

- **Approve** / **Reject** — toggle status.
- **Assign user** — link this Telegram account to an Offtangent user (or leave unassigned). The assignment determines which `memory/users/<username>.md` profile the agent loads for this conversation, and which user "owns" any tasks created from Telegram.
- **Delete** — remove the Telegram user entry entirely. They re-appear as `pending` if they message the bot again.

### Refresh

Reloads the list from the backend — useful after someone joins while you're looking at the page.

## See also

- [Telegram Bot setup guide](../guide/telegram) — one-time setup: BotFather, token, approval, bot commands.
- [Tasks settings](./tasks) — `telegramDelivery` for routing task results into Telegram.
