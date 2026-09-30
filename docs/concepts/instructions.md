# Agent Instructions

Offtangent's behavior is shaped by plain-Markdown "instruction files" that live in `/data/config/`. They tell the agent *what to do* — how to talk, what to remember, what to do in background tasks, and what to check on a schedule — while the [Settings](./../settings/) pages control *when* and *with which provider* it does those things.

This page describes each file, what it controls, when the agent reads it, and what belongs inside. Each file ships with a sensible default template on first startup; the exact templates live in `packages/core/src/memory.ts` — per-file links are in the sections below.

## `AGENTS.md`

The agent contract — and the single most important file for shaping day-to-day behavior. It defines *how* the agent communicates, what it's allowed to do autonomously, and where it should stop and ask.

Living at `/data/config/AGENTS.md`, the file is read on every conversation, every task, and every heartbeat run, and concatenated verbatim into the system prompt as the `<agent_rules>` block (see [System Prompt → layer 3](./system-prompt#_3-agent-rules-config-agents-md)). The shipped default — `AGENTS_TEMPLATE` in `memory.ts` — is a sensible starting point you can rewrite freely.

### What the default template covers

The shipped template has five sections — use them as a starting point, rewrite whatever doesn't fit:

| Section | Purpose |
|---|---|
| **Communication Rules** | Concrete do/don't rules for verbosity, formatting, and phrasing. (High-level *voice* and *character* belong in [`SOUL.md`](./memory#soul-soul-md), not here.) |
| **Execution Rules** | When to ask vs. act; how to handle ambiguity, destructive changes, external actions. |
| **Anti-Hallucination Rules** | "Say I don't know." Strict-mode vs. creative-mode. Citing sources. |
| **Memory Rules** | What belongs in `MEMORY.md` vs. daily files vs. user profiles. |
| **Red Lines** | Hard "never do this" boundaries. |

### Keep it tight

`AGENTS.md` is concatenated verbatim into *every* system prompt. Long rulebooks cost tokens on every turn and dilute the model's attention. Good rules are:

- **Imperative** ("Prefer small, verifiable changes over large rewrites.")
- **Observable** — the user can tell whether the rule is being followed.
- **Specific to your setup** — generic advice the model already knows is wasted space.

If you catch yourself writing "the agent should be helpful and friendly" — cut it. Save that kind of guidance for `SOUL.md`.

### Example snippet

```md
## Communication Rules

- Start with the point — no warm-up, no praise, no conversational padding.
- Default verbosity: low — scale up only when the topic genuinely requires it.
- Never use bold text as a substitute for a heading.

## Execution Rules

- Be resourceful before asking — read files, check context, search first.
- Ask before destructive changes (deleting files, dropping data, overwriting config).
- When multiple approaches exist, recommend one with its tradeoff.
```

## `CONSOLIDATION.md`

The rules that govern memory consolidation. The consolidation job condenses the last few days of `memory/daily/<date>.md` files into durable entries in `MEMORY.md`, user profiles, and the wiki — then trims the dailies. `CONSOLIDATION.md` is the prompt that tells it how to judge each candidate entry.

The file lives at `/data/config/CONSOLIDATION.md` and is read on every scheduled consolidation run (see [Settings → Memory → Memory consolidation](./../settings/memory#memory-consolidation)). It is *not* part of the chat system prompt — only the consolidation job ever sees it. The shipped default — `CONSOLIDATION_TEMPLATE` in `memory.ts` — is a starting point you can adapt to your own taxonomy.

### What the default template covers

The shipped template maps out the **memory architecture** and gives explicit rules for each tier:

- **Promote to `MEMORY.md`** — recurring patterns, technical decisions, persistent facts, corrections.
- **Update user profiles** (`memory/users/*.md`) — preferences, work context, personal details the user shared.
- **Update wiki pages** (`memory/wiki/*.md`) — project discoveries, architecture notes, evergreen concepts.
- **Archive under `sources/`** — immutable raw material (articles, transcripts, papers) the wiki cites.
- **Ignore** — ephemeral one-shot commands, temporary paths, noise.

Customize it to match your taxonomy. For example, if you don't use the `wiki/` layer at all, remove that section so the consolidator stops trying.

### Tuning tips

- If your `MEMORY.md` grows unbounded, tighten the "promote" section — raise the bar.
- If you find user profiles get bloated, move those rules into "ignore" for that user's style.
- If the consolidator keeps duplicating entries across `MEMORY.md` and user profiles, add an explicit "prefer user profile for anything person-specific" rule.

## `TASKS.md`

The **background task guidelines** — generic rules injected into the system prompt of every agent that runs in the background. Where `AGENTS.md` shapes the *interactive* chat agent, `TASKS.md` shapes the *task* agent: the autonomous worker spawned by `create_task`, by `task`-type cronjob runs, by the heartbeat, and by memory consolidation.

The file lives at `/data/config/TASKS.md` and is read on every background task start (in `packages/core/src/task-runner.ts`, function `buildTaskSystemPrompt`). Its content is concatenated into the spawned task's system prompt under a `<task_guidelines>` block, after the hardcoded identity / workspace framing and before the final `STATUS: … / SUMMARY: …` output contract. The shipped default — `TASKS_TEMPLATE` in `memory.ts` — captures the generic "work autonomously, report concrete results, don't paraphrase what you did" advice; rewrite it freely to match how *you* want background work done.

### What stays hardcoded

`TASKS.md` holds *guidelines only*. The non-negotiable parts of a task system prompt are still hardcoded in `task-runner.ts` and cannot be edited from the UI:

- The identity / framing line ("You are a background task agent. You are NOT a chatbot …").
- The concrete `Your task: <prompt>` block built from the task's `prompt` field.
- The `<workspace>` block pointing at `/workspace`.
- The optional `<memory_reference>` block.
- The final `STATUS: completed | failed | question | silent` / `SUMMARY: …` output contract, including the protocol for `question`, `silent`, and `failed`.

If you blank `TASKS.md` entirely, the `<task_guidelines>` block is omitted from the prompt and tasks fall back to whatever rules the per-task prompt or attached skills carry. The hardcoded framing always remains.

### Distinction from `attached_skills` and per-task prompts

Background tasks see four complementary instruction layers:

| Source | Scope | Where it lives |
|---|---|---|
| `TASKS.md` | Global generic guidelines for **every** background task run. | `/data/config/TASKS.md` |
| `attached_skills` | Skill-specific rules pinned when the task or cronjob is created — always loaded for that specific run. | `/data/skills_agent/<name>/SKILL.md` (or installed skills) |
| Task `prompt` | The concrete work this run must do. | `tasks.prompt` column / per-cronjob `prompt` field |
| `AGENTS.md` | Read by the **interactive** agent only — NOT injected into background task prompts. | `/data/config/AGENTS.md` |

Use `TASKS.md` for rules that should apply to *all* background work ("always commit before pushing", "never auto-merge PRs", "prefer pnpm over npm"). Use `attached_skills` for rules that only matter to one run or one cronjob ("this nitter scrape needs the nitter skill"). Put the actual work in the task `prompt`. Don't copy `AGENTS.md` content into `TASKS.md` — the two roles are different and the chat-only rules waste tokens on every task run.

### Effect on cronjobs

A cronjob with `action_type: "task"` spawns a fresh task on every tick, and that task reads `TASKS.md` at start time. Editing `TASKS.md` therefore takes effect on the **next** scheduled run — no restart, no per-cronjob update needed. `action_type: "injection"` cronjobs (and their reminder shortcut) deliver static text and never spawn an agent, so `TASKS.md` does not apply to them.

### Tuning tips

- Keep it tight. Every line ships in every task system prompt — long lists cost tokens on every run.
- Be imperative and observable ("verify with the project's test command before reporting success"), not aspirational ("do good work").
- Resist re-stating what `AGENTS.md` already covers — the chat agent's tone rules don't help a task that has no user to talk to.
- If a rule only matters in one specific task or scheduled job, prefer `attached_skills` or embedding it in that prompt over polluting `TASKS.md`.

## `HEARTBEAT.md`

The scheduled self-prompt the agent runs on each heartbeat tick. The heartbeat makes the agent wake up on a schedule with *no user message* and run a short self-driven turn — `HEARTBEAT.md` is the prompt it receives every time.

The file lives at `/data/config/HEARTBEAT.md` and is read on every tick (interval configured in [Settings → Agent Heartbeat](./../settings/agent-heartbeat)). It is *not* part of the chat system prompt — it is delivered as the agent's own user-message stand-in instead. The default template (`HEARTBEAT_TEMPLATE` in `memory.ts`) ships near-empty; an empty file no-ops cleanly.

### Default template

The template is intentionally empty-ish:

```md
# Heartbeat Tasks

<!-- Define periodic tasks here. The agent will execute them during each heartbeat cycle. -->
<!-- Both the user and the agent can edit this file. -->
<!-- If this file has no actionable content, the heartbeat will skip automatically. -->
```

If the file has no actionable content, the heartbeat silently no-ops — enabling the feature in Settings without filling this file is safe.

### What belongs here

One-line tasks the agent should run on its own, in sequence, on every tick. Keep the list short — every line is processed on every heartbeat.

```md
# Heartbeat Tasks

1. Scan /data/memory/MEMORY.md for items marked TODO. Act on the oldest one if feasible, otherwise leave it.
2. Check open cronjobs: if any are overdue by more than 24h, flag them in today's daily file.
3. Check for new emails since the last tick. If anything looks important or time-sensitive, notify the user; otherwise stay quiet.
```

### What does *not* belong here

- Anything requiring user input. The heartbeat has no user to talk back to.
- Long-running work. Use [Tasks & Cronjobs](./tasks-and-cronjobs) instead — they have proper duration limits, loop detection, and status updates.
- Experiments. Broken rules here cost you one tick interval's worth of API calls every interval. Test in a one-shot task first, then promote.

## See also

- [System Prompt](./system-prompt) — how `AGENTS.md` is composed into the live prompt with all the other layers.
- [Memory System](./memory) — the file layout `CONSOLIDATION.md` operates on.
- [Settings → Agent](./../settings/agent#agent-rules) — jump-off point for `AGENTS.md` from the Agent panel.
- [Settings → Memory](./../settings/memory#memory-consolidation) — consolidation schedule, provider, and manual "Run now".
- [Settings → Agent Heartbeat](./../settings/agent-heartbeat) — heartbeat interval, night mode.
