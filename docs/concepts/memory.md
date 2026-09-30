# Memory System

Offtangent uses a **file-based, plain-Markdown memory system**. Everything the agent remembers lives under `/data/memory/` as readable, hand-editable files. No opaque vector blob — you can `cat`, `grep`, and `git diff` your agent's memory. A small SQLite-backed fact store sits next to the files for atomic facts that the agent searches on demand.

## Why files?

- **Inspectable.** You always know what the agent thinks it knows.
- **Portable.** Back up the volume, you've backed up the memory.
- **User-editable.** Override or correct anything via the web UI's Memory page or by editing the file directly.
- **Diffable.** `git init` the directory and you have full history of how the agent's understanding evolved.

## Memory tiers

The memory directory looks like this:

```text
/data/memory/
├── SOUL.md                  ← personality
├── MEMORY.md                ← long-term curated memory
├── daily/
│   ├── 2025-01-14.md        ← per-day session notes
│   └── …
├── users/
│   ├── admin.md             ← per-user profile
│   └── …
├── wiki/
│   ├── homelab.md           ← agent-maintained knowledge base
│   └── …
└── sources/                 ← immutable raw material the wiki cites
    ├── articles/
    ├── youtube/
    ├── podcasts/
    ├── papers/
    └── notes/
```

Plus one non-file tier: the SQLite **`memories`** table, holding atomic facts the agent searches on demand.

Each tier has a clear role; the next sections walk through them.

### SOUL - `SOUL.md`

`SOUL.md` defines *who the agent is* — its tone, voice, character. It's the most stable file in memory: written by the user, rarely touched by the agent, and intended to be rewritten when you want to change the agent's "vibe". The default template is conservative; customize it. (Note: *concrete* communication rules — "no filler", "use markdown lists" — belong in [`AGENTS.md`](./instructions#agents-md), not here.)

### Core memory - `MEMORY.md`

The agent's long-term scratchpad: learned lessons, recurring patterns, technical decisions, corrections. Included in every prompt, so keep it short and curated.

The agent edits it directly with `edit_file` / `write_file` whenever it learns something durable. The nightly consolidation job also promotes content here from daily notes.

### Daily notes - `daily/<date>.md`

Per-day activity log. The agent appends entries during a session when something is worth noting, and the [session-end](#session-end) job adds a short summary when the session times out. The most recent few days are loaded into every prompt as recent context.

Daily files are **append-only source material for consolidation** — the consolidator reads them but never edits them. Older days get folded into `MEMORY.md`, user profiles, or wiki pages by the nightly job, and the dailies are then trimmed.

### User profiles - `users/<username>.md`

One file per user, holding name, location, communication preferences, work context, interests — anything person-specific. Loaded into the prompt only when *that* user is talking to the agent, so multi-user setups stay clean.

The agent maintains the file as it learns about the user.

### Wiki - `wiki/*.md`

The agent's own structured knowledge base: project notes, architecture decisions, key dependencies, evergreen concepts. Pages have an optional YAML frontmatter (`aliases: [Foo, foo-thing]`) and are listed in the system prompt **by title only** — the agent loads a page on demand with `read_file` when the topic comes up.

The agent maintains the wiki autonomously: it adds new pages, extends existing ones, merges duplicates, fixes stale entries, and keeps cross-links healthy without asking. Only genuine contradictions (new info conflicts with an existing page) get escalated to the user.

For non-trivial wiki work, the agent uses the bundled `wiki` skill (`/data/skills_agent/wiki/SKILL.md`), which carries the canonical conventions for frontmatter, filenames, cross-links, and the `## Sources` section.

### Sources - `sources/**/*.md`

The **immutable, append-only** layer beneath the wiki. Articles, YouTube transcripts, podcasts, papers, hand-captured notes — raw material the wiki cites so factual claims stay verifiable. Subfolders (`articles/`, `youtube/`, `podcasts/`, `papers/`, `notes/`) are created on first use.

Each file follows `<yyyy-mm-dd>-<slug>.md` with YAML frontmatter (`source_type`, `url`, `author`, `captured`) and the raw captured body. The agent archives sources during consolidation or when ingesting external material; it **never rewrites an existing file** — if the upstream changes, it adds a new dated entry. Wiki pages link back to sources in a `## Sources` (or `## Quellen`) section.

### Facts - `memories` table

Not a file — a small SQLite-backed store of atomic, sentence-sized facts ("User prefers `npm` over `yarn`", "The project's PostgreSQL runs on port 5433").

The agent doesn't see this table in its prompt. Instead, it queries it on demand via the **`search_memories`** tool, which supports FTS5 syntax (word matching, `prefix*`, phrase queries, boolean operators). This lets long-term memory grow far beyond what fits in a single prompt while keeping the prompt small.

Facts are written automatically by the [session-end fact-extraction job](#session-end). They're per-user and timestamped, so the agent can answer "what did we decide about X?" even months later.

## Session end

A session is a continuous chunk of conversation. It ends when either `sessionTimeoutMinutes` of inactivity passes (default 30) or the user runs the `/new` command in the chat. On session end Offtangent runs two background jobs in parallel: one writes a summary into the daily note, the other extracts atomic facts. Both have their own provider knob and tuning under [Settings → Memory](./../settings/memory).

### Session summary

A small LLM gets the transcript and writes a short activity-log entry, appended to `memory/daily/<date>.md`. This is what the [nightly consolidation](#memory-consolidation) later reads when it promotes durable content into `MEMORY.md`, user profiles, and the wiki.

The summary provider defaults to the active chat provider; most setups override it with something cheap and fast under [Settings → Memory → Sessions](./../settings/memory#sessions).

### Fact extraction

In parallel, the transcript is fed to an extraction model that pulls out atomic, sentence-sized facts and writes them into the `memories` table. Sessions shorter than `minSessionMessages` are skipped — there's nothing worth extracting from a two-line exchange.

Facts are deduplicated against existing entries (token-overlap heuristic) and capped at 10 per session. The agent retrieves them later via [`search_memories`](./tools).

Tune under [Settings → Memory → Fact extraction](./../settings/memory#fact-extraction).

## Memory consolidation

The nightly **memory consolidation** job condenses the last few days of `daily/<date>.md` files into durable entries in `MEMORY.md`, user profiles, and wiki pages — then trims the dailies. This keeps long-term memory rich and the prompt small.

How aggressively it promotes vs. drops is governed by `/data/config/CONSOLIDATION.md` — the prompt the consolidator uses to judge each candidate entry. See [Agent Instructions → CONSOLIDATION.md](./instructions#consolidation-md) for the template and tuning tips.

Schedule, lookback window, and provider are configured under [Settings → Memory](./../settings/memory#memory-consolidation). You can also trigger a consolidation run manually from the Memory page in the web UI.

## See also

- [Agent Instructions](./instructions) — the user-editable `AGENTS.md`, `CONSOLIDATION.md`, and `HEARTBEAT.md` config files. They shape *behavior*, not memory.
- [System Prompt](./system-prompt) — how the memory tiers above are composed into the live prompt the model sees on every turn.
- [Settings → Memory](./../settings/memory) — session timeout, fact extraction, and consolidation schedule.
- [Built-in Tools → `search_memories`](./tools) — the tool the agent uses to query the fact store.
