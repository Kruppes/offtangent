# Telegram Bot

Offtangent ships with a Telegram integration so you can talk to the **same agent** — same memory, same tools, same tasks — from your phone. This page walks you through the one-time setup. For ongoing day-to-day options (per-field reference, user approval flow, advanced fields), see [Settings → Telegram](../settings/telegram).

## Overview

The Telegram integration is a separate process inside the same container. Once enabled, it:

- Connects to the Telegram Bot API as **your** bot (you create it via BotFather).
- Routes incoming messages to the same agent core that powers the web UI.
- Persists Telegram conversations to the same session store, so a chat you start on your phone shows up in **Sessions** in the web UI.
- Lets [Tasks & Cronjobs](../concepts/tasks-and-cronjobs) deliver their results to a Telegram chat.

You only need to do steps 1–3 below once. After that, Telegram is just another way into the same agent.

## Setup

Three steps, around five minutes: create the bot on Telegram, paste its token into Offtangent, then send `/start` and approve yourself in the UI. You'll switch between Telegram and the Offtangent web UI a few times — keep both open.

### 1. Create a bot with @BotFather

Telegram bots are created via the official [@BotFather](https://t.me/BotFather). Recent Telegram clients ship a small BotFather **mini app** that makes this a guided form instead of a back-and-forth chat.

1. Open Telegram and start a chat with **@BotFather**.
2. Tap the lilac **Open** button next to the message input. The BotFather mini app opens with a **My bots** section listing any bots you already own.
3. Tap **Create a New Bot**.
4. Fill in the form:
   - **Bot Name** — the display name shown in chats (e.g. `My Offtangent`).
   - **About** — optional one-liner shown on the bot's profile.
   - **Username** — must end in `bot` and be globally unique on Telegram (e.g. `my_offtangent_bot`). The mini app validates this live.
5. Tap **CREATE BOT**.

The mini app jumps straight to the new bot's detail view: avatar, name, `@username`, and the **bot token** (a string like `123456789:ABCdefGhIJKlmNoPQRsTuvWxYz...`). Tap **Copy** to grab the token — that's exactly what you'll paste into Offtangent in step 2. The same view also offers a **Revoke** button to rotate the token later.

::: warning Treat the token like a password
Anyone with this token can send and receive messages as your bot. If it ever leaks, reopen the bot in the BotFather mini app and tap **Revoke** to issue a fresh one.
:::

### 2. Configure Offtangent

In the Offtangent web UI, go to **Settings → Telegram** and:

1. Toggle **Enabled** on.
2. Paste your **Bot token** from BotFather.
3. Save.

The backend will start the bot in the background. Within a few seconds the bot is live.

### 3. Send `/start` and approve yourself

Offtangent's Telegram bot is **single-tenant by default**: it ignores everyone except the users you explicitly approve.

1. Open Telegram, search for your bot's username (the one ending in `bot`), and start a chat.
2. Send `/start`. The bot replies with a welcome message and registers you in Offtangent as a **`pending`** user.
3. Back in the Offtangent web UI, on **Settings → Telegram**, your account now appears in the **Telegram users** list — along with your numeric Telegram ID, which the UI picks up automatically.
4. Click **Approve** on your row.
5. **Recommended:** Open the row's `⋮` menu and use **Assign user** to link the Telegram account to your Offtangent user. This tells the agent which `memory/users/<username>.md` profile to load when you message from Telegram, and which user "owns" tasks created from this chat.

From now on, anything you send to the bot is processed by the agent. Anyone else who messages the bot lands in `pending` and stays silent until you approve them.

## Bot commands

The bot understands a handful of slash commands inside Telegram. They are
shared with the web chat — same names, same descriptions — so muscle memory
carries between surfaces. Telegram's native command menu (the `/` button next
to the input field) is populated automatically on bot startup via
`setMyCommands`, so you get autocomplete for every entry below.

| Command     | What it does                                                                |
|-------------|-----------------------------------------------------------------------------|
| `/start`    | Welcome message. Registers you as `pending` on first use.                   |
| `/help`     | List all available slash commands.                                          |
| `/new`      | Summarize the current session, persist it, and start a fresh conversation.  |
| `/stop`     | Abort the current agent turn and clear queued messages. (alias `/kill`)     |
| `/tasks`    | Show running and recent background tasks (read-only).                       |
| `/cronjobs` | Show configured cronjobs and their next run time. (alias `/cron`)           |
| `/model`    | Show or switch the active provider and model. (alias `/provider`)           |
| `/thinking` | Show or set the global main-agent thinking level.                           |
| `/tts`      | Toggle automatic Telegram voice replies. (alias `/voice`)                   |
| `/skill`    | Load a skill into the current conversation. (`/skill:<name> [prompt]`)      |

On Telegram, `/model` (and its alias `/provider`) renders as an inline
keyboard: provider picker → model picker → confirmation. The same message is
edited in place between steps. Selecting a model writes `providers.json` and
switches the active model for the next turn. The picker auto-expires after
10 minutes if untouched, so scrolling back to an old picker and tapping a
button will return an "expired" notice instead of switching models.

`/skill` works in two ways. A bare `/skill` opens an inline keyboard listing
every loadable skill (self-created agent skills and enabled installed
skills). Tapping one injects its `SKILL.md` into the conversation; the agent
confirms that the skill is loaded and waits, so your next message is the
actual request. Telegram buttons cannot carry free text, which is why this is
a two-step flow. If you already know the name, type everything in one line:
`/skill:<name> <prompt>` loads the skill and runs the prompt immediately (no
native autocomplete for the name, but the same result). Unknown names reply
with the list of available skills.

Everything else is treated as a normal message and forwarded to the agent.
If the menu does not appear in your Telegram client, restart the chat or wait
a minute — Telegram caches the command list per device. Failures during
`setMyCommands` are non-fatal: typing a slash command still works, the menu
just stays empty until the next successful start.

## Voice messages

Offtangent can transcribe incoming Telegram voice messages and optionally reply with synthesized speech. Configuration lives in two places:

- **Speech-to-Text** — pick a provider and model under [Settings → Speech-to-Text](../settings/speech-to-text). Voice messages sent to the bot are transcribed and forwarded to the agent as text.
- **Text-to-Speech (optional)** — pick a provider and voice under [Settings → Text-to-Speech](../settings/text-to-speech), then enable [Send voice reply](../settings/telegram#send-voice-reply) on the Telegram settings page or run `/tts` (alias `/voice`) directly in the Telegram chat. Each agent reply is then also synthesized and uploaded as a voice/audio message. `/tts on`, `/tts off`, and `/tts status` are also accepted; the toggle persists to `telegram.json` and is independent of the global TTS settings.

If TTS synthesis fails for a given reply, the text reply is still delivered — voice is best-effort.

## Troubleshooting

**Bot doesn't reply at all** — Check the container logs for `✅ Telegram bot connected`. If you see `Failed to start Telegram bot: 401 Unauthorized`, the token is wrong (or was revoked via BotFather). If you see `409 Conflict`, another instance of the bot is already polling — stop the other one or revoke and re-issue the token.

**Bot replies "waiting for approval" forever** — Your user is still `pending`. Approve yourself in **Settings → Telegram → Telegram users**.

**Messages from a group chat are ignored** — Group support is intentionally minimal: only the configured users (admin or approved) are answered, and the bot must be allowed to read messages in the group (BotFather → `/setprivacy` → `Disable`).

**Multi-line messages get split into separate replies** — Telegram delivers each line as a separate update. Offtangent batches them with a small delay (`batchingDelayMs`, default 2.5 s). Increase the value if your messages are still being split, or set it to `0` to disable batching entirely. See [Settings → Telegram → Batching delay](../settings/telegram#batching-delay).
