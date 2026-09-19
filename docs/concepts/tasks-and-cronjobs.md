# Tasks & Cronjobs

Offtangent has three related but distinct ways to run work *outside the current chat turn*: **tasks** (one-shot background runs), **cronjobs** (recurring scheduled runs), and **reminders** (one-shot scheduled text). They share the same underlying machinery — a SQLite-backed scheduler, a `TaskRunner` that spawns isolated agents, and a notification layer that funnels results back into the right chat session — but they're meant for different kinds of work.

| | **Tasks** | **Cronjobs** | **Reminders** |
|---|---|---|---|
| Trigger | Fire-and-forget, on demand | Recurring on a 5-field cron schedule | One-shot at a future time |
| Spawns an agent? | Always | Only when `action_type: "task"` | Never — static text |
| Tools / skills available? | Full registry, plus optional `attached_skills` | Full registry (task type only), plus optional `attached_skills` | None |
| Typical use | "Build this app." "Refactor X across the repo." | "Every weekday at 9, summarize my GitHub notifications." | "Remind me at 17:30 to leave for the train." |

Defaults — provider, max duration, loop detection, telegram delivery, status updates, background thinking level — live in **Settings → Tasks** (see [Settings → Tasks](./../settings/tasks)). Everything below is the *mechanism*: how each flavor actually runs, what guarantees Offtangent makes, and what to expect when things go wrong.

> The agent-facing usage guide — when to pick which, how to write good task prompts, how to handle `<task_injection>` blocks — lives in the built-in [`tasks-and-cronjobs`](./skills#currently-shipped) skill so it only costs tokens when the agent is actually creating background work. This page is the architectural reference.

## Tasks

A **task** is a self-contained agent run that proceeds in the background. The user (or the agent itself) hands off a prompt; a fresh agent instance spins up in isolation, works through the prompt with the full tool and skill registry, and reports back when it's done.

### Lifecycle

A task moves through four states, persisted in the `tasks` SQLite table. Rows are inserted directly as `running` — there is no `queued` state, the `TaskRunner` starts the agent inline.

```text
running ──┬──▶ completed
          ├──▶ failed
          └──▶ paused ──▶ running ──▶ …
```

- **`running`** — the agent is actively working. The `TaskRunner` keeps the live agent instance in memory in a `runningTasks` map.
- **`paused`** — the agent's final output had `STATUS: question`, so it's blocked waiting for a follow-up. The agent stays in memory in a `pausedTasks` map, ready to resume.
- **`completed`** — final status was `completed` or `silent`. `silent` means the task chose not to emit a chat message (e.g. a periodic cronjob that found nothing to report).
- **`failed`** — the agent threw, hit the duration cap, or got terminated by [loop detection](./../settings/tasks#loop-detection).

Paused agents that nobody resumes are garbage-collected after a stale-cleanup interval; their database row stays as `paused` but the in-memory agent is gone, so calling `resume_task` on them returns *"agent is no longer in memory"*.

### Isolation

Every task runs in its own agent instance with its own session ID — separate from the parent chat. A task agent has:

- **No chat history.** It cannot read what was said in the conversation that triggered it. Anything it needs has to be in the `prompt` field.
- **A different system prompt.** Built by `buildTaskSystemPrompt` (`packages/core/src/task-runner.ts`) — it tells the agent *"You are a background task agent. You are NOT a chatbot — you are an autonomous worker"*, points at `/workspace`, injects the user-editable `<task_guidelines>` block from [`TASKS.md`](./instructions#tasks-md), and enforces the `STATUS: … / SUMMARY: …` final-message format described below.
- **The full toolset and skill index.** Same `<available_tools>` and `<available_skills>` as a chat agent. Both `create_task` and `create_cronjob` can additionally pin specific skills via [`attached_skills`](#attached-skills).
- **A fresh provider/model session.** The task either uses the configured task default provider (Settings → Tasks) or whatever was explicitly pinned at creation time. A `modelPolicy.roles["task:<trigger>"]` entry in `settings.json` can pin a model per *kind* of background work — cheap models for heartbeat/consolidation, a strong one for delegated implementation work. See [Settings → modelPolicy](../reference/settings#modelpolicy).
- **A bounded context window.** A long task can run hundreds of tool calls; sending all of them on every model call is what made background tasks the single biggest token consumer (audit 2026-09-17: up to 721k input tokens per call). The runner therefore shows the model only the newest part of its transcript: once the window passes `heuristics.taskHistory.windowTokens` (60.000 estimated tokens) it is cut back to `targetTokens` (30.000), and everything older is replaced by an `<earlier_messages>` digest. Cuts are rare and large on purpose, so the prompt prefix — and with it the provider's prompt cache — stays stable between them. The agent keeps the *full* transcript internally (result extraction, verification and schema correction still see everything), and each hidden assistant message or tool result can be reloaded verbatim with `recall_message(message_id)`; the ids are in the digest. Every trim writes a `task_history` row to `tool_calls`.
- **Progress guards.** Three cheap, deterministic limits stop a task that burns tokens without converging (audit 2026-09-17: two failed tasks spent 44,3 Mio tokens and produced nothing): a hard cap on tool calls (`heuristics.taskGuard.maxToolCalls`, default 300), a repetition detector (`repeatedToolCalls`, default 5 consecutive calls with the same tool *and* byte-identical arguments) and an input-token budget (`maxInputTokens`, default 30 Mio, counting `input + cache read + cache write`). A trip aborts the agent and finalizes the task as **failed** with a message naming the guard and its numbers — never a silent success — and writes a `task_guard` row to `tool_calls`. Every limit is disabled by setting it to `0`, and an error inside the guard itself is swallowed (fail-open): a guard bug must never kill a working task.
- **A usage record.** When a task finishes, the runner logs one `task_usage` metric row (`tool_calls`) with the run's prompt/completion tokens, cache read/write, estimated cost, tool-call count and the **cache read ratio** (`cache_read / (prompt_tokens + cache_read)`) — the number that tells you whether prompt caching is actually working for background work. `list_tasks` additionally shows the aggregated cost of a task's whole delegation subtree (`Incl. N sub-task(s): …`), so a task that delegates no longer looks cheap while its children carry the bill.

### Triggers

The `tasks.trigger_type` column records *who created the task*. There are five trigger types:

| Trigger | Meaning |
|---|---|
| `user` | Manually started from the **Tasks** page in the web UI. |
| `agent` | The chat agent called `create_task` mid-conversation. |
| `cronjob` | A scheduled `action_type: "task"` cronjob fired and spawned this run. |
| `heartbeat` | The [agent heartbeat](./../settings/agent-heartbeat) ticked and produced an actionable item. |
| `consolidation` | The memory-consolidation job spawned a task to act on a candidate entry. |

The trigger flows through into the `<task_injection>` block (see below) so the chat agent knows whether the result it's reading came from a user-initiated job or a scheduled run, and can phrase the reply accordingly.

### Final-message format

The task system prompt requires the agent to end its run with exactly:

```text
STATUS: completed | failed | question | silent
SUMMARY:
<full content here>
```

The runner parses this with `parseTaskOutput` in `task-runner.ts`. If the agent forgets the format, the runner falls back to using the whole text as the summary and assumes `completed`. Each status has a specific meaning:

| Status | Meaning |
|---|---|
| `completed` | The work is done. The `SUMMARY` is the final deliverable — it gets piped into the parent chat verbatim. |
| `failed` | Unrecoverable error. The `SUMMARY` explains what went wrong. The task row is marked `failed` with an error message. |
| `question` | The agent is blocked and needs the user. The `SUMMARY` contains *one* concrete question. The task transitions to `paused` instead of terminating, and the `<task_injection>` block flags `status="question"` so the parent agent relays the question conversationally. |
| `silent` | Nothing to report — terminate cleanly without delivering a chat message. The task is recorded as `completed` but no `<task_injection>` is emitted to the user. Use case: periodic checks that found no changes. |

### `<task_injection>`: how results come back

When a task terminates (or pauses), the `TaskRunner` builds a `<task_injection>` block and calls the configured `onTaskComplete` / `onTaskPaused` callback. The orchestrator in `agent.ts` calls `injectTaskResult` which inserts that block into the parent session as a system message and resumes the parent agent if it isn't already running.

Concretely, the parent agent's *next* turn starts with a system-role message like:

```xml
<task_injection task_id="…" task_name="…" status="completed|failed|question"
  trigger="user|agent|cronjob|heartbeat|consolidation"
  duration_minutes="…" tokens_used="…">
… SUMMARY content …
</task_injection>
```

The parent agent's job is to *translate* this into a natural reply — the system prompt's `<task_system>` block (see [System Prompt → layer 14](./system-prompt#_14-task-system-task-and-cronjob-pointer)) tells it to load the `tasks-and-cronjobs` skill before responding, which carries the conventions (don't echo the raw block, route follow-ups via `resume_task`, …).

### Delivery durability: surviving a restart

An injection used to live only in process memory between "task finished" and "agent answered". That is exactly long enough to lose it: deploying the agent's own stack restarts the container, the session that was waiting for the result dies with it, and the task sits `completed` in the database while the strand hears nothing. The agent goes quiet until a human asks.

Every strand-bound injection is therefore written to the `task_injections` table **before** any delivery attempt, and acknowledged only when the injection turn actually reached its `done` chunk without an `error` chunk:

| Status | Meaning |
| --- | --- |
| `pending` | Enqueued, not acknowledged. Eligible for (re)delivery. |
| `delivered` | An agent run consumed it and finished. |
| `abandoned` | Given up on — older than `heuristics.taskDelivery.maxAgeHours` or past `maxAttempts`. |

Three things consume that table:

- **Fresh delivery.** `injectIntoStrand` enqueues the row and delivers it immediately. The row id *is* the per-injection correlation token that the streamed chunks already carried, so nothing downstream needed a second identifier.
- **Boot resume.** After task recovery, the server re-delivers pending rows (prefixed with a `<delivery_notice>` so the agent can tell a repeat from a fresh result) and, for strands that have running tasks but no pending result, injects one `<system_injection type="restart_resume">` naming those tasks. One wake-up per strand: a strand that gets a result back is not additionally notified.
- **Sweep.** Every `heuristics.taskDelivery.sweepIntervalSeconds` a small interval retries rows whose last attempt is older than `retryAfterSeconds` — the case where a session dies mid-flight *without* a container restart.

Delivery is deliberately at-least-once: if the process dies between the agent's answer and the ack, the result is injected again. A duplicate result is visible and cheap; a lost result is invisible and expensive. Feed-only work (cronjob, heartbeat, consolidation) never enqueues a row — it has no strand to wake.

### Feed-only outcomes: the announcement at the next run

Feed-only work has no strand, so the queue above never sees it — and for a while nothing else did either. A cronjob would finish, write its card to the task feed, and the agent it belongs to simply never learned about it: the result waited for a turn that only a human could start, and the turn that eventually came carried the user's message and nothing else. On 2026-09-17 a `w4-deploy-verify` cronjob completed at 16:17 and its result reached the agent at no point at all — the process had not restarted (so boot resume had nothing to resume) and no row existed (so the sweeper had nothing to retry).

The fix is deliberately small and stays inside the rule that a cronjob must not wake the agent on its own: the outcome is **announced at the beginning of the next run of the owning persona**, before the user's message.

- Bookkeeping lives on the task row itself (`tasks.agent_notified_at`), not in a second queue. A completed feed-only task with `agent_notified_at IS NULL` is *owed* an announcement.
- `AgentCore.processUserMessage` consumes what is owed (`consumePendingTaskNotices`) and prepends a `<background_task_results>` block to the model input — the same mechanism the fact injection already uses, and like it, the block is **not persisted** in the transcript.
- Exactly once per task, per persona (an outcome of `bob` never surfaces in a `main` turn), `silent` results excluded, at most 5 outcomes and ~1200 characters each, and nothing older than `heuristics.taskDelivery.maxAgeHours` (stale outcomes are marked as announced instead of replayed).
- Adding the column backfills every existing row as "already announced", so the deploy that ships this does not replay a day of cronjobs into the next turn.

This closes the gap without a second scheduler: the announcement rides the next run, whatever starts it.


### Resuming a paused task

When the user replies after a `status="question"` injection, the agent calls `resume_task(task_id, message)` (`packages/core/src/task-tools.ts`) with the user's answer plus enough context for the task to continue (the original question, any conversation snippets that clarify, file paths that came up — the paused task has no chat history of its own).

`resume_task` validates that:

1. The task exists and is in status `paused`.
2. The agent is still in memory (`pausedTasks` map). If it's been garbage-collected, the call fails with *"agent is no longer in memory. The task may have timed out."*

If both checks pass, the task transitions back to `running` and the next `<task_injection>` arrives when it's done or has another question.

### Provider, model, and duration

`create_task` accepts optional `provider`, `model`, and `max_duration_minutes`:

- **`provider` + `model`** flow through the same resolver used for chat (`resolveProviderModelInput`). A bare `model: "kimi-k2.6"` auto-detects the provider when there's a unique match. When neither is set, the configured task default applies. The tool descriptions for `create_task` and `create_cronjob` instruct the agent to **autonomously choose** an appropriate model based on the descriptions in the system prompt's [`<available_providers>` block](./system-prompt#_8-available_providers-configured-llm-providers) — preferring cost-effective models for simple work and stronger models for complex coding or research. The agent only needs to pass these parameters when it has a specific reason to deviate from the default task model.
- **`max_duration_minutes`** is hard-capped at the system maximum from Settings → Tasks → [Max duration](./../settings/tasks#max-duration). At ~80 % of it the task gets a wrap-up signal (see below); hitting the cap aborts the task as `failed`, not `paused`.

The flag `is_default_model` records whether the resulting `(provider, model)` pair came from the system default or was explicitly pinned — useful when you change the default later and want to know which historical tasks were on the old default.

### Time budget: wrap-up before the hard deadline

`max_duration_minutes` used to have exactly one effect: at 100 % the runner aborted the agent and the task died mid-sentence — work half-applied, nothing written down, and a `failed` row whose summary said nothing about where it got to.

The budget is now two events:

- At **80 % of the budget** (`heuristics.taskWrapUp.budgetFraction`, default `0.8`) the runner injects a single `<time_budget_warning>` message into the running task's own conversation: stop starting new work, make what you started consistent, report gate status honestly, write a `HANDOFF:` section if work stays open, then produce STATUS/SUMMARY. It is a steering message, not a kill — the task keeps its tools and its remaining fifth of the budget.
- At **100 %** the hard abort still fires, unchanged, as the fallback for a task that ignores the signal.

The signal is sent once per run, and it is skipped when it would leave less than `heuristics.taskWrapUp.minLeadSeconds` (default 60 s) to act on — a wrap-up that arrives 20 seconds before the axe only burns a turn. Setting `budgetFraction` to `0` disables it.

The task-side counterpart is the `<budget_and_honesty>` block in every task system prompt: the budget in minutes, what to do when the warning arrives, and the honesty rules that make the whole thing worth anything — never report a check as green that did not run or failed, never weaken or skip tests to get green, report partial success as partial success, and document a handoff instead of implying success.

### Handoff and `continuation_of`

A run that ends with unfinished work leaves a **handoff** on its own task row (`tasks.handoff`), written by the runner — not by the agent's goodwill. It is filled for every ending that is not a clean success: wrap-up-completed-with-open-work, hard timeout, progress-guard or loop-detection abort, user kill, crash, and an honest `STATUS: failed`. It records the reason, how much of the budget and how many tool calls were spent, and the agent's own `HANDOFF:` section (or, failing that, its final summary), capped at 8000 characters.

A successor picks it up through the optional `continuation_of` parameter of `create_task`:

```
create_task(name: "W5 part two", prompt: "finish the wrap-up timer", continuation_of: "<predecessor task id>")
```

The predecessor's handoff (or summary) is prepended to the new task's prompt as a clearly marked `<continuation_of task_id="…" status="…">` block, capped at 8000 characters, with the instruction to verify claims rather than trust them. The block is stored as part of the task prompt, so the chain is visible on the Tasks page afterwards. An unknown id is an error: the task is not created, because a successor that silently lost its context is worse than a failed tool call.

`create_task` also accepts [`attached_skills`](#attached-skills) — the same mechanism cronjobs use, applied once at spawn time. Because a one-off task has no schedule row to persist the selection in, the resolved `SKILL.md` contents are injected when the task starts and are not stored on the `tasks` row; restarting a task from the Tasks page therefore starts it without attached skills.

### Loop detection, status updates, killing

These are operational safeguards documented in detail under [Settings → Tasks](./../settings/tasks). Briefly:

- **Loop detection** (`systematic` / `smart` / `auto`) terminates a task that's calling the same tool with the same args in circles, or repeatedly failing. On detection, the runner aborts the agent, marks the task `failed`, and emits a `<task_injection>` with a `Hint: Use /kill_task <id>` line.
- **Periodic status updates** are opt-in `<task_status type="periodic_update">` messages emitted every N minutes while a task runs. They're persisted as `system`-role rows with a `task_status_update` metadata tag so they don't count as conversational turns, and they're broadcast over WebSocket and (optionally) Telegram. They never invoke the LLM.
- **Killing** a task — from the Tasks page, the API (`POST /api/tasks/:id/kill`), the chat (`/stop` / `/kill`), or the Telegram `/stop` / `/kill` commands — aborts the agent and marks the task `failed`.

## Cronjobs

A **cronjob** is a recurring scheduled entry in the `scheduled_tasks` table. Two flavors, distinguished by `action_type`:

- **`action_type: "task"`** *(default)* — on each tick, spawns a full task agent with the configured prompt. Use this whenever the action needs to think, fetch fresh data, use tools/skills, or produce a fresh result.
- **`action_type: "injection"`** — on each tick, delivers the configured prompt verbatim into the parent chat as a system message. No agent runs. Use this only for genuinely static periodic notifications.

Internally, a `create_reminder` is just a cronjob with `action_type: "injection"` (see [Reminders](#reminders) below).

### The scheduler

The `TaskScheduler` (`packages/core/src/task-scheduler.ts`) holds the loop. On `start()` it loads every enabled row from `scheduled_tasks` and arms a `setTimeout` for each one's next firing time. There are three subtleties worth knowing about:

- **24-hour wake-up cap.** Node's `setTimeout` overflows at ~24.8 days and fires immediately. The scheduler caps each timer at 24h and re-evaluates from disk on wake-up — so a cronjob set to fire in 90 days actually arms 90 short timers in sequence, each one re-reading the row in case it was disabled or edited in between.
- **55-second deduplication cooldown.** If the scheduler fires a job whose `last_run_at` is less than 55 seconds ago — typically because the server restarted within the same cron minute — the firing is skipped. Without this, `nodemon`-style watch reloads or container restarts would double-fire jobs that had just run.
- **5-second past-due grace.** If the calculated next-run time is more than 5 seconds in the past at startup (e.g. the host was offline through a scheduled tick), that tick is *skipped*, not fired retroactively. Cronjobs are best-effort; missed runs do not stack up.

When a `task`-type cronjob fires, the scheduler creates a `tasks` row with `trigger_type: 'cronjob'` and `trigger_source_id: <cronjob id>`, then hands it to the same `TaskRunner` that handles user/agent-initiated tasks. `last_run_at`, `last_run_task_id`, and `last_run_status` on the `scheduled_tasks` row are updated as the task progresses, so the UI and `list_cronjobs` always show the most recent run.

### Cron expressions

Standard 5-field cron format: `minute hour day-of-month month day-of-week`. Day-of-week: `0` or `7` = Sunday, `1` = Monday … `6` = Saturday. Steps (`*/15`), ranges (`1-5`), and lists (`8,20`) are all supported. The full grammar is in `packages/core/src/cron-parser.ts`.

| Natural language | Cron |
|---|---|
| Every day at 9:00 | `0 9 * * *` |
| Every weekday at 14:30 | `30 14 * * 1-5` |
| Every Monday at 8:00 | `0 8 * * 1` |
| Every 15 minutes | `*/15 * * * *` |
| Every hour on the hour | `0 * * * *` |
| First of the month at midnight | `0 0 1 * *` |
| Twice a day (8 and 20) | `0 8,20 * * *` |
| March 30 at 11:30 | `30 11 30 3 *` |

Schedules are evaluated in the configured `timezone` (see `<current_datetime>` in the system prompt, set via Settings → Agent). If you change the timezone, all enabled cronjobs are reinterpreted on the next tick — there is no per-cronjob timezone override.

### Auto-disable for one-shot patterns

A specific date/time cron like `30 11 30 3 *` ("March 30 at 11:30") fires every year. To prevent recurring "one-time" reminders, the scheduler applies a heuristic after every `injection` firing: if the next computed run time is more than 364 days away, the row is auto-disabled. Same logic on a cron that has no future run at all (e.g. a date that never matches). `task`-type cronjobs are *not* auto-disabled — they're assumed to be intentional.

### `attached_skills`

`create_task`, `create_cronjob`, and `edit_cronjob` accept an optional `attached_skills` array — names of agent skills under `/data/skills_agent/<name>/` (or installed user skills as `owner/name`). Before the task agent starts, the runner reads each `SKILL.md` and concatenates them into the task's system prompt under an `<attached_skills>` block. For cronjobs this happens on every firing; for a one-off task it happens once, at `create_task` time.

All three tools go through the same helpers in `packages/core/src/attached-skills.ts`, so resolution, normalization (trim, de-duplicate, drop empties), and error handling are identical.

This is the deterministic alternative to relying on the agent's routing decision. Use it when:

- The run's reliability depends on a skill (e.g. a daily Nitter scrape that needs the `nitter` skill's URL conventions). Without `attached_skills`, the task agent might or might not route to the skill on a given run; with it, the skill rules are guaranteed to be in the prompt.
- You want skill rules baked in at *authoring time*, so future edits to the cronjob don't drift from what the user originally agreed to.

Missing `SKILL.md` files are skipped with a console warning — the task still runs. Pass `attached_skills: []` to `edit_cronjob` to clear a cronjob's list.

One difference between the two: a cronjob stores its list in `scheduled_tasks.attached_skills`, so every firing re-reads the current `SKILL.md`. A one-off task resolves the list at spawn time only and does not persist it.

### Persistent state across runs (continuity)

Every `task`-type cronjob firing spawns a fresh, isolated task agent with no chat history and no memory of previous runs (see [Isolation](#isolation)). Run N+1 knows nothing about what run N did. For digest, monitor, and watch jobs this is a problem: without any shared state the job re-reports the same items on every tick.

Offtangent does not solve this with a platform feature. There is no run-result injection or dedupe flag on `scheduled_tasks`. Instead, continuity is a prompt-level pattern that reuses tools the task agent already has. The cronjob prompt names a fixed "brain" file that the task reads at the start of the run (what is already known or reported) and updates at the end (new facts, last-seen markers). The job dedupes against its own state.

There are two places to keep that state, and the choice matters:

- **`/data/memory/state/<job-name>.json` or `.md`** holds compact, machine-readable job state such as last-seen IDs, timestamps, or cursors. This is the right place for pure dedupe markers.
- **A wiki page** (`/data/memory/wiki/<topic>.md`) holds curated, human-readable knowledge that the job enriches over time. The daily social-media digest that appends facts to a wiki page is an example of this pattern already in use.

This approach needs no code, follows the same file conventions as the rest of the [memory system](./memory), and composes with `attached_skills`: attached skills bake in the rules a run must follow, while the brain file carries the state from one run to the next.

#### Keeping the brain file bounded

A state file that a cronjob writes to on every run grows unnoticed, and that growth has a sharp failure mode. A single `read_file` on an oversized file can silently exhaust the run's token budget and terminate it. In one real incident a hub page grew to 756 KB and killed the run on a low token budget at high cost. Three habits keep this safe:

1. **Set a size budget** for the file, on the order of 60 KB. When it outgrows the budget, move raw material into monthly archives or sub-pages and keep only a compact summary or the current state in the main file.
2. **Do not blindly load a large state file.** Instead of `read_file` on the whole file, `grep` for the specific marker you need and append new entries with a shell redirect (`>>`).
3. **Keep the split clean.** Compact machine state belongs in `/data/memory/state/`; curated knowledge belongs in the wiki.

### Editing, listing, removing

The agent (or the user) operates on cronjobs through five tools, all in `packages/core/src/cronjob-tools.ts`:

- **`list_cronjobs`** — overview with id, name, schedule, status, last run, and the next N upcoming run times.
- **`get_cronjob`** — full configuration of one cronjob *including the complete prompt*. The agent is required to call this before editing — never edit a prompt blind.
- **`edit_cronjob`** — partial update. Only the fields you pass are changed. Re-registers the timer with the scheduler.
- **`remove_cronjob`** — deletes the row and cancels the timer.
- **`create_cronjob`** — the constructor.

The web UI (Cronjobs page) is a thin wrapper around the same operations on the `scheduled_tasks` table, so an agent edit and a UI edit are interchangeable.

## Reminders

A **reminder** is the friendly shortcut for *"deliver this static text at this time"*. Internally it's a `scheduled_tasks` row with `action_type: "injection"` — the same machinery as a cronjob — but exposed as a separate tool (`create_reminder`) with a tighter contract.

### Why a separate tool?

Two reasons:

- **Vocabulary.** When the user says *"remind me at 17:30 to leave for the train"*, calling `create_cronjob` with a buried `action_type: "injection"` would be the wrong shape. A dedicated tool makes the intent explicit and the parameters smaller (`message` instead of `prompt`, no `provider` / `model` / `attached_skills`).
- **Anti-misuse enforcement.** `create_reminder` rejects requests that look dynamic.

### The anti-misuse heuristic

A reminder delivers static text *verbatim*. No agent runs, no tools execute, no skills load, no fresh data is fetched. So `create_reminder` runs every request through `looksLikeDynamicTaskRequest` (in `cronjob-tools.ts`), which scans the `name` and `message` for patterns like *"current"*, *"latest"*, *"check"*, *"verify"*, *"weather"*, *"forecast"*, *"summarize"*, *"use skill"*, etc. — both English and German. If any pattern matches, the call returns:

> Error: `create_reminder` only supports static reminder text delivered verbatim. This request looks dynamic (for example checking current data, using a skill/tool, or doing work at run time). Use `create_cronjob` with `action_type: "task"` instead.

The heuristic is deliberately blunt — false positives are fine because the alternative (a `task`-type cronjob) is strictly more capable. The contract is: *if you genuinely just want a string delivered later, use `create_reminder`; otherwise use `create_cronjob`*.

### One-shot semantics

There's no separate "fires once" mode in cron. To get a one-shot reminder, use a cron expression that matches a single point in time:

```text
30 11 30 3 *   # March 30 at 11:30
0  9  *  *  4  # Every Thursday at 9 (cron has no "tomorrow")
```

For exact-once delivery on a non-recurring date, the standard pattern is `<minute> <hour> <day> <month> *`. Because the next match after firing is more than 364 days away, the [auto-disable heuristic](#auto-disable-for-one-shot-patterns) kicks in and disables the row after the first run — no manual cleanup needed.

### Delivery

When a reminder fires, the `onInjection` callback (wired up by the runtime composer) inserts the `message` into the parent session as a system message and broadcasts to all connected channels — web chat and Telegram. The reminder row's `last_run_at` and `last_run_status` are updated to `completed`. Unlike a `task`-type firing, no `tasks` row is created and no agent is invoked.

## Safety: never use OS-level schedulers

A hard rule, also enforced inline in the system prompt's `<task_system>` block:

> **Never use OS-level schedulers.** No `crontab`, no `launchd`, no `at`, no shell-spawned long-running processes (`nohup`, `&`, background loops). Always use the built-in tools.

OS-level schedulers don't survive container restarts, can't be inspected from the UI, bypass the scheduler's deduplication and timezone handling, escape provider routing entirely, and produce no audit trail in the `tasks` / `scheduled_tasks` tables. The temptation to fall back to `crontab` when a cron expression looks awkward is real — resist it. Anything you can't express with the 5-field grammar above almost certainly belongs in a `task`-type cronjob whose prompt does the conditional logic.

## See also

- [System Prompt → `<task_system>`](./system-prompt#_14-task-system-task-and-cronjob-pointer) — where the task/cronjob pointer and the OS-scheduler safety rule are injected.
- [Skills](./skills) — the skill registry, including the `tasks-and-cronjobs` built-in skill that carries the agent-facing usage guide.
- [Settings → Tasks](./../settings/tasks) — defaults for provider, max duration, telegram delivery, loop detection, status updates, and background thinking level.
- [Built-in Tools → Tasks, cronjobs & reminders](./tools#tasks-cronjobs-reminders) — short description of every task/cronjob/reminder tool.
- [Memory System](./memory) — the parent session and chat history that task results are written into.
