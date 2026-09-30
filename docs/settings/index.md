# Settings

Tune how the agent behaves, how long sessions live, which provider answers, and how Telegram messages are handled.

All settings described in this section live in the web UI under **Settings**, and are persisted to `/data/config/settings.json`. You can edit either — the UI is the supported path, the file is documented for power users and for the agent itself to reason about.

> **Admin only.** Only users with role `admin` can open the Settings page. Regular users see a locked screen.

## The Settings Subpages

The Settings page has one sidebar entry per concern. Each gets its own docs page here:

| Panel                                | What it controls                                                                        |
|--------------------------------------|-----------------------------------------------------------------------------------------|
| [Agent](./agent)                     | Language, timezone, active provider + model, reasoning level, upload retention, `AGENTS.md` rules. |
| [Agent Heartbeat](./agent-heartbeat) | Whether (and when) the agent runs recurring self-driven tasks from `HEARTBEAT.md`.      |
| [Health Monitor](./health-monitor)   | Provider health checks, automatic fallback, notification toggles.                       |
| [Memory](./memory)                   | Session timeout, memory consolidation, fact extraction.                                 |
| [Secrets](./secrets)                 | API keys and other sensitive values stored in `/data/config/secrets.json`.              |
| [Speech-to-Text](./speech-to-text)   | Transcription provider (OpenAI, Whisper URL, Ollama) and optional LLM rewrite.          |
| [Tasks](./tasks)                     | Default task provider, max duration, loop detection, status updates, Telegram delivery. |
| [Telegram](./telegram)               | Bot token, message batching, user approval + assignment.                                |
| [Text-to-Speech](./text-to-speech)   | Voice output provider (OpenAI, Mistral/Voxtral), voice, audio format.                   |

## Saving changes

Every panel except **Secrets** uses the same **Save** button in the page header. Changes take effect on the next agent turn — no restart needed. Secrets have their own per-row save/delete flow because they are write-only from the UI's perspective (existing values are masked, never returned in full).

## Where values live

| Kind                            | File                            | Edited by                             |
|---------------------------------|---------------------------------|---------------------------------------|
| Non-secret runtime settings     | `/data/config/settings.json`    | UI (all panels except Secrets)        |
| API keys, tokens, other secrets | `/data/config/secrets.json`     | UI (Secrets panel)                    |
| Behavior rules for the agent    | `/data/config/AGENTS.md`        | UI (Instructions page) or direct edit |
| Recurring self-tasks            | `/data/config/HEARTBEAT.md`     | UI (Instructions page) or direct edit |
| Consolidation rules             | `/data/config/CONSOLIDATION.md` | UI (Instructions page) or direct edit |

See [File Paths](../reference/file-paths) for the full volume layout and [`settings.json` Reference](../reference/settings) for the raw schema.
