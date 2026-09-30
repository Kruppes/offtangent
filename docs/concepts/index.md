# Core Concepts

The architectural reference for Offtangent's behavior. Each page here explains *how* a part of the system works — the data model, the lifecycle, the contracts — rather than *which button to click* (that's [Web UI](../web-ui/)) or *which value to set* (that's [Settings](../settings/)).

Read these when you want to understand *why* the agent behaves the way it does, debug something that's not doing what you expected, or write a skill or instruction file that plays nicely with the existing machinery.

## Pages

| Page | What it covers |
|---|---|
| [Agent Instructions](./instructions) | `AGENTS.md`, `HEARTBEAT.md`, `CONSOLIDATION.md` — the plain-Markdown files that shape day-to-day behavior. |
| [Built-in Tools](./tools) | The tool registry: which tools the agent has every turn, which are opt-in, what each one does. |
| [Captures & Strands](./captures-and-strands) | The input model: how a capture is routed into a strand, the confidence bands, the now-set, the tray. |
| [Memory System](./memory) | The file-based memory tiers (`SOUL.md`, `MEMORY.md`, daily, users, wiki, sources) plus the SQLite fact store. |
| [Personas](./personas) | Multiple agents on one instance: the six Markdown files, scoped memory, `ask_agent`, what is and isn't enforced. |
| [Skills](./skills) | How skills are discovered, indexed, loaded on demand, and built-in vs. user-installed. |
| [System Prompt](./system-prompt) | The full layered system prompt — every block the model sees before your message. |
| [Tasks & Cronjobs](./tasks-and-cronjobs) | Background jobs, scheduled work, one-shot reminders — lifecycle, isolation, the scheduler. |

## Where to next?

- New to Offtangent? Read [Captures & Strands](./captures-and-strands) first — it's the product's core loop — then [Memory System](./memory) and [Skills](./skills).
- Running more than one agent role? [Personas](./personas).
- Want to tune behavior? Concepts → [Agent Instructions](./instructions), then [Settings](../settings/) for the knobs.
- Building a skill or task? [Skills](./skills) and [Tasks & Cronjobs](./tasks-and-cronjobs) describe the contracts.
