# System Prompt

The system prompt is the long block of text the model receives at the top of every turn — before your message, before the conversation history. It's where Offtangent tells the model *who it is*, *what it knows*, *what it can do*, and *what just happened* in your recent days.

This page documents exactly how that prompt is built, what each block contains, and which file or setting drives it.

## How it's assembled

The prompt is rebuilt from scratch on **every turn** by `assembleSystemPrompt()` in `packages/core/src/memory.ts`. Each section is wrapped in an XML-style tag (`<personality>`, `<agent_rules>`, `<core_memory>`, …) so the model can clearly distinguish what each block is for.

Most layers come straight from a Markdown file under `/data/memory/` or `/data/config/` (see [Container file paths](./../reference/file-paths)). A few are computed at request time (current date, the active tool list, the configured language). All of them are concatenated, separated by blank lines, and handed to the LLM as the `system` message.

Because the prompt is rebuilt every turn:

- **File edits take effect on the next message** — no restart, no reload step.
- **The current date is always accurate** — `<current_date>` reflects "today" in the configured timezone.
- **Per-user blocks only appear when that user is talking** — multi-user setups stay clean.
- **Disabled features drop out entirely** — if you have no skills installed, there is no `<available_skills>` block; if no provider is configured yet, there is no `<available_providers>` block.

## The layers

The blocks are emitted in a fixed order. Identity and rules come first (1–3), durable memory next (4–6), then capabilities and references (7–13), and finally the runtime anchors that tell the agent *where it is*, *when*, *how to speak*, and *on which surface* (14–18).

The numbering below is thematic. The *wire* order groups the blocks by volatility (SPEC 11.5): every block that is stable across turns is emitted first, and the memory-derived blocks the agent rewrites at runtime (`<core_memory>`, `<recent_memory>`, `<user_profile>`, `<wiki_pages>`, the skill listings) are appended as a tail behind `<workspace>`, followed by `<current_date>`. That keeps the cached prefix intact when the agent writes to its own memory mid-session — see layer 15.

### 1. `<personality>`: `memory/SOUL.md`

*Always present.*

The agent's *identity*: tone, voice, character, "vibe". This is the most stable file in memory — written once by you, rarely touched by the agent. Customize it to set the personality you want. Concrete *do/don't* rules ("no filler", "use markdown lists") belong in `AGENTS.md` instead — see layer 3. See [Memory System → SOUL](./memory#soul-soul-md).

### 2. `<instructions>`: runtime base instructions

*Optional. Empty in every channel that ships today.*

A small per-channel block of technical instructions a runtime can inject before the agent rules — e.g. the chat backend, Telegram bot, or task runner. Not user-editable; reserved for future surfaces that need a hard, non-negotiable preamble.

### 3. `<agent_rules>`: `config/AGENTS.md`

*Always present.*

The user-editable agent contract: communication rules, execution rules, anti-hallucination rules, memory rules, red lines. Read on every turn, every task, every heartbeat. Where `<personality>` answers *who the agent is*, `<agent_rules>` answers *what it concretely does and doesn't do*. See [Agent Instructions → `AGENTS.md`](./instructions#agents-md).

### 4. `<core_memory>`: `memory/MEMORY.md`

*Always present.*

The agent's long-term scratchpad — learned lessons, recurring patterns, technical decisions, corrections. Included in every prompt, so the agent keeps it short and curated. See [Memory System → Core memory](./memory#core-memory-memory-md).

### 5. `<recent_memory>`: `memory/daily/<date>.md`

*Present when there is non-empty content in the last 3 daily files.*

Concatenated content of the **last 3 days** of daily session notes (`heuristics.recentMemory.days`, the slim prompt profile always uses 1). A short preamble reminds the agent that these are condensed and that the full conversation is available via the `read_chat_history` tool. The block is omitted on a fresh install with no daily files yet. See [Memory System → Daily notes](./memory#daily-notes-daily-date-md).

The block is capped at `heuristics.recentMemory.maxChars` (default 8000 characters, roughly 2k tokens) because it is *fixed* cost on every single turn: before the cap, an unconsolidated three-day window measured up to 85k tokens per turn. The newest day is kept first and in full; older days are cut back to their tail (daily notes are appended chronologically, so the tail is the most recent part of that day). Every cut leaves a marker naming the file it came from — `[truncated: N older chars of this day — read /data/memory/daily/2026-09-16.md for the full notes]` — so the agent can load the rest with `read_file` on demand. When the raw notes exceed the budget by more than `heuristics.recentMemory.warnFactor` (default 3×), a warning is logged: that usually means memory consolidation is not running.

### 6. `<user_profile>`: `memory/users/<username>.md`

*Present when a user is identified. Otherwise replaced by `<user_profiles_path>`.*

The profile of the *currently authenticated* user — name, location, communication preferences, work context, interests. Loaded only when a user is identified, so the agent never mixes up users on a multi-user setup. If no user is identified, a `<user_profiles_path>` block appears instead, pointing the agent at the directory so it can read profiles on demand. See [Memory System → User profiles](./memory#user-profiles-users-username-md).

### 7. `<available_tools>`: built-in tool registry

*Always present.*

A bullet list of every built-in tool the agent can call this turn, with a one-line description of each. The list is computed from the active tool settings — toggling `web_search` or `web_fetch` off under **Skills → Built-in Tools** in the Web UI, for example, drops that line; disabling speech-to-text under [Settings → Speech-to-Text](./../settings/speech-to-text) drops `transcribe_audio`. See [Built-in Tools](./tools).

### 8. `<available_providers>`: configured LLM providers

*Present when at least one LLM provider has a routable model (see below).*

A listing of provider/model pairs that the agent can route background tasks to. Only models that carry a **description** (set via the [Edit Model dialog](./../web-ui/providers#edit-model-dialog)) or are the active agent model / default task model are included — models without a description and without a default flag are hidden, so the description doubles as an opt-in gate for agent model routing.

Each entry shows the provider name, the model id, default-model labels (*"default agent model"*, *"default task model"*), and the free-form description. The block also instructs the agent to autonomously choose models based on these descriptions (preferring cost-effective models for simple work, stronger models for complex tasks) rather than only passing through user-specified names. Dropped entirely if no provider has a routable model. See [Providers](./../web-ui/providers).

### 9. `<wiki_pages>`: `memory/wiki/*.md`

*Present when the wiki has at least one page.*

The titles and aliases of every wiki page — **not** the full content. The agent loads a specific page on demand with `read_file` when a topic comes up. This is the prompt's largest source of agent-curated knowledge while staying token-cheap. See [Memory System → Wiki](./memory#wiki-wiki-md).

### 10. `<memory_paths>`: file paths cheatsheet

*Always present.*

The absolute paths to every memory and config file the agent might want to read or edit (`SOUL.md`, `MEMORY.md`, the daily directory, the wiki/users/sources directories, and the three config files). This is what lets the agent self-modify its memory: it doesn't have to guess where things live.

The path of *today's* daily file is **not** in this block — it carries the date and would rotate a line inside the cached prefix once a day. It is named in `<current_date>` instead (layer 16).

### 11. `<axiom_docs>`: bundled documentation

*Always present.*

Paths to the README and the three top-level subdirectories of the documentation tree that ships with Offtangent (this site you're reading): `concepts/`, `guide/`, `reference/`. The tag name still says `axiom`: it is the identifier the runtime emits and dates back to the upstream project this fork came from. When you ask *"how do I configure X?"*, the agent uses `list_files` on the matching directory, picks the file whose name fits the topic, and reads it — instead of hallucinating from training data.

### 12. `<agent_skills>`: skill creation pointer

*Present when an agent-skills directory is configured (default in shipped images).*

A short pointer telling the agent where new skills live (`/data/skills_agent/<name>/SKILL.md`) and to load the built-in [`skill-creator`](./skills#currently-shipped) skill for the full format guide before writing one. Frontmatter rules, naming regex, gating fields, and worked examples live in `skill-creator/SKILL.md` — loaded on demand instead of paying their token cost on every turn. See [Skills](./skills).

### 13. `<available_skills>`: installed skills listing

*Present when at least one skill is active.*

XML-formatted listing of every active skill — name, description, location of the `SKILL.md` file, and an optional `<warning>` (e.g. when a skill needs an env var that isn't set). The agent reads `SKILL.md` on demand when a request matches the description. Built-in and user-installed skills are listed in full; **agent-created** skills are capped at the 10 most recently used, with the rest reachable through the `list_agent_skills` tool. See [Skills](./skills).

### 14. `<task_system>`: task and cronjob pointer

*Always present.*

A short pointer telling the agent to load the built-in [`tasks-and-cronjobs`](./skills#currently-shipped) skill for the full guide (when to use task vs. cronjob vs. reminder, how to write task prompts, how to handle `<task_injection>` messages, cron expressions, `attached_skills`). The full guide — around 750 tokens — lives in `tasks-and-cronjobs/SKILL.md` and is loaded on demand.

Two things stay inline in the prompt because they have to apply *before* the agent can decide to load the skill:

- **Hard safety rule**: no OS-level schedulers (`crontab`).
- **Trigger note**: when a `<task_injection>` block arrives, load the skill before responding to it.

See [Tasks & Cronjobs](./tasks-and-cronjobs).

### 14b. `<canvas>`: when to hand over an artifact

*Always present.*

The rule that makes personas use the canvas on their own initiative (SPEC 7.4b): send an artifact when the content is visual, tabular beyond four columns, interactive, or something the user will want to open again later — always with a one or two sentence text summary, and never by deleting the fenced block from the message. It also carries the constraints that follow from the artifact sandbox (everything inline, no network, no storage, 2 MB ceiling), because a model that does not know them ships a page that silently breaks behind the CSP.

This stays inline rather than moving into a skill: the "artifact or text" decision is made *while* answering, so it has to be in the prompt before the answer starts. See [Artifacts API](./../reference/artifacts-api).

### 15. `<workspace>`: working directory

*Always present.*

A one-liner declaring `/workspace` as the working directory for shell commands and relative paths. Anchors all file operations so they don't accidentally land in `/data` or the OS root. See [Container file paths → `/workspace`](./../reference/file-paths).

This is the **last stable block**. Everything the agent rewrites at runtime — `<core_memory>`, `<recent_memory>`, `<user_profile>`, the wiki and skill listings, `<current_date>` — is appended behind it, and an invisible cache-breakpoint marker sits at the seam. For Anthropic models that marker becomes a second `cache_control` breakpoint (see [`promptCache`](./../reference/settings#promptcache)), so when the agent writes a note into today's daily file mid-session, only the tail has to be re-cached instead of the entire prompt. The marker itself is stripped before the request is sent, for every provider.

### 16. `<current_date>`: current date

*Always present.*

The current **date** (day-granular), formatted in the configured timezone, plus the path of today's daily file (which is derived from that date). Computed at request time, so the agent always knows "today" — useful for cron creation, daily-note naming, "what day is it" questions, and any date-relative reasoning.

The minute-level **time** is deliberately *not* in the system prompt. It is appended to each **user message** as a small `<current_time>` block instead. Why: the system prompt is handed to the provider as a single cached prefix (Anthropic / OpenAI prompt caching). A minute-granular timestamp *inside* that prefix would change every minute and invalidate the whole cached block — system prompt, tool definitions, and conversation history — forcing an expensive cache re-write on almost every turn. Keeping the date (which only rolls over once per day) in the prompt and moving the precise time into the always-fresh user message preserves the cache while still giving the agent an accurate "now".

### 17. `<language>`: reply language

*Present when a reply language is configured. Dropped otherwise (model picks a sensible default).*

A short directive set from [Settings → Agent](./../settings/agent#agent-language). Either *"match the user's language"* or *"always respond in `<language>`"*. Placed near the end of the prompt on purpose: the directive lands close to the user message, so the model's recency bias works in its favor.

### 18. `<channel_context>`: channel-specific notes

*Optional. Currently only emitted on the Telegram channel.*

A short reminder about the active surface the agent is talking on. For example, on [Telegram](./../guide/telegram) it tells the agent *"you ARE the Telegram bot — don't suggest the user run curl commands to message you"* and to keep responses concise. Omitted on the default web chat.

## What this means in practice

A few things follow from this layout:

- **Long files cost tokens on every turn.** `MEMORY.md`, `AGENTS.md`, and `SOUL.md` are concatenated verbatim into every prompt. Keep them tight. The wiki, by contrast, only contributes its *titles* — that's why wiki content can grow unbounded without paying a per-turn cost.
- **The consolidator's job is to feed this prompt.** [Memory consolidation](./memory#memory-consolidation) is what trims daily notes into the durable layers (4, 6, 9) so the prompt stays small while long-term memory grows.
- **Per-user state is automatic.** As long as a user is authenticated, layer 6 picks the right profile — you don't have to thread username into individual rules.
- **Disabled features disappear cleanly.** If you turn off web search, the agent literally doesn't see `web_search` in `<available_tools>`. There's no out-of-band capability list.

## See also

- [Memory System](./memory) — the file layout that feeds layers 1, 4–6, and 9.
- [Agent Instructions](./instructions) — the user-editable `AGENTS.md` (layer 3) and the two non-prompt files (`CONSOLIDATION.md`, `HEARTBEAT.md`).
- [Built-in Tools](./tools) — the tools enumerated in layer 7.
- [Skills](./skills) — what powers layers 12 and 14.
- [Tasks & Cronjobs](./tasks-and-cronjobs) — the system referenced by layer 14.
- [Container file paths](./../reference/file-paths) — where `/data` and `/workspace` actually live on disk.
