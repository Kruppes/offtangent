---
name: tasks-and-cronjobs
version: 1.1.1
description: Use Offtangent's background-execution system — one-off background tasks (create_task), recurring cronjobs (create_cronjob), and static scheduled reminders (create_reminder). Load this skill before creating any of them, and ALWAYS load it when you receive a <task_injection> message so you respond correctly.
---

# Tasks, Cronjobs & Reminders

Offtangent has three related but distinct ways to run work outside the current chat turn. Picking the right one is the most important decision — they look similar but behave very differently.

| Tool family | Lifecycle | Spawns an agent? | Typical use |
|---|---|---|---|
| **Tasks** (`create_task`, `resume_task`, `list_tasks`) | One-shot, async | **Yes** — full agent with all tools/skills, plus optional `attached_skills` | "Build this app." "Refactor X across the repo." "Research and write a report." |
| **Cronjobs** (`create_cronjob`, `edit_cronjob`, `list_cronjobs`, `get_cronjob`, `remove_cronjob`) | Recurring on a cron schedule | **Yes if `action_type: task`**, no if `action_type: injection` | "Every weekday at 9 summarize my GitHub notifications." "Daily sanity check on service X." |
| **Reminders** (`create_reminder`) | Scheduled, can be one-shot or recurring | **No — static text only** | "Remind me at 17:30 to leave for the train." "Every Monday morning ping me 'standup at 10'." |

## The decision flow (read this first)

When the user asks for "scheduled" or "background" work, choose like this:

```
Does the user want it to run AT A SPECIFIC TIME or ON A SCHEDULE?
├── No  → It's a Task. Use create_task. (Async one-shot.)
└── Yes → Does the action need to think, fetch fresh data, use tools/skills,
          analyze, or produce a fresh result at run time?
          ├── Yes → create_cronjob with action_type "task" (default).
          └── No, just deliver some static text → 
              ├── Recurring schedule? → create_cronjob with action_type "injection".
              └── One-shot at a future time? → create_reminder.
```

**Rule of thumb**: when in doubt, choose the more powerful option. `create_cronjob` with `action_type: "task"` can do anything `create_reminder` can; the reverse is not true. The reminder tool will refuse the request anyway if it detects dynamic intent (see [Reminder anti-misuse](#reminder-anti-misuse) below).

---

## Tasks

A task is a self-contained agent run that proceeds in the background. You hand off a prompt and continue helping the user; when the task finishes, fails, or has a question, you receive a `<task_injection>` message in the next turn (see [Handling task injections](#handling-task-injections)).

### When to spawn a task

- Complex coding work (building apps, multi-file refactors, new features).
- Long research or analysis where you'd otherwise stall the chat.
- Anything the user explicitly says to "do in the background" or "while we keep talking".
- Work that will outlive the current chat exchange.

### When NOT to spawn a task

- Simple questions you can answer directly.
- Small edits or checks you can finish in this turn.
- Anything that needs immediate back-and-forth — tasks run isolated, not in dialogue.
- "Just to be safe, I'll spawn a task" — no. The token and time cost is real.

### Writing a good task prompt

The task agent runs in **isolation** — no chat history, no recall of context, no follow-up unless it asks via `status: question`. Write the prompt so a fresh agent could execute it cold:

- **Goal in one sentence** at the top: *"Add a dark-mode toggle to the settings page."*
- **Constraints** the agent must respect: file boundaries, libraries to use/avoid, code style.
- **Concrete inputs**: file paths (absolute), URLs, tickets, IDs. Quote them inline.
- **Verification expectations**: how the agent should know it's done (tests pass, manual check, screenshot).
- **Final deliverable**: what the final report must contain (file diff summary, links, numbers).

If you'd need to say *"and remember from earlier we decided…"*, include that decision verbatim in the prompt. The task can't read the chat.

### Provider and model selection

Both `create_task` and `create_cronjob` accept optional `provider` and `model`. Defaults come from **Settings → Tasks**.

- Pass `model` only when the user **explicitly** names one ("run this with kimi-k2.6"). The provider is auto-detected from `<available_providers>` if unique.
- Pass `provider` + `model` together to pin both.
- Otherwise omit both — the default task provider is used.

### `max_duration_minutes`

Optional cap. Defaults to the system value, hard-capped at the system maximum (set in Settings → Tasks). Only set this when the user wants something different. Tasks that hit the cap are aborted, not paused.

### `attached_skills`

`create_task` takes an optional `attached_skills` array — names of agent skills under `/data/skills_agent/<name>/` (or installed skills as `owner/name`). Each `SKILL.md` is **injected directly into the task prompt** when the task starts, so the task agent doesn't have to discover and `read_file` the skill itself.

```
create_task(
  name: "Nitter scrape",
  prompt: "<self-contained instructions>",
  attached_skills: ["nitter"],
)
```

Use it whenever the task's work depends on a skill — it is more reliable than writing "read /data/skills_agent/nitter/SKILL.md first" into the prompt. Missing SKILL.md files are skipped with a warning; the task still runs. Omit the parameter when no skill is relevant.

### Resuming a paused task

When a task pauses with `status: question`, it's waiting for input via `resume_task`. See the next section.

---

## Handling task injections

When a background task completes, fails, or has a question, the next message you receive contains a `<task_injection>` block:

```xml
<task_injection task_id="..." task_name="..." status="completed|failed|question"
  trigger="user|agent|cronjob" duration_minutes="..." tokens_used="...">
Summary text from the task agent
</task_injection>
```

**Always reply naturally to the user.** Do not echo the raw block. Translate the content into a normal conversational message:

| Status | What to say |
|---|---|
| `completed` | Tell the user what got done. Include concrete details: files created/modified, verification performed, links, numbers. Don't bury the lede. |
| `failed` | Explain what went wrong in plain language. If actionable, suggest a next step (retry with different inputs, fix the missing dependency, …). Don't pretend it succeeded. |
| `question` | Relay the question to the user naturally. The task is **paused** waiting for an answer — do not start solving it yourself. |

### Routing follow-up answers to a paused task

When you've relayed a `question` to the user and they reply, you almost always need to forward that reply back into the paused task with `resume_task`:

1. **Decide whether the user's reply is for the paused task.** Usually yes (they're answering the question you just relayed). If clearly off-topic (new request, unrelated comment), handle it in chat instead.
2. **Call `resume_task`** with the `task_id` from the injection and a `message` containing the user's answer plus any context the task needs (e.g. the original question, conversation snippets that clarify, file paths that came up). Don't just forward the raw user text — the task has no chat history.
3. The task resumes in the background. The next `<task_injection>` arrives when it's done or has another question.

If multiple tasks are paused (rare), pick the one whose question matches the user's reply. When unclear, ask the user which task they're answering.

---

## Cronjobs

A cronjob runs on a recurring schedule. Two flavors:

- **`action_type: "task"`** (default) — spawns a full agent on each run, with access to all tools and skills. Use this for anything dynamic.
- **`action_type: "injection"`** — delivers a static prompt verbatim into the chat on each run, no agent spawned. Use this for periodic notifications/nudges with **no** computation.

If unsure → **task**. Injection is the lightweight optimization for the rare case where literally no thinking is needed.

### Cron expression cheat sheet

5 standard fields: `minute hour day-of-month month day-of-week`. Day-of-week: `0` or `7` = Sunday, `1` = Monday … `6` = Saturday.

| Natural language | Cron |
|---|---|
| Every day at 9:00 | `0 9 * * *` |
| Every weekday at 14:30 | `30 14 * * 1-5` |
| Every Monday at 8:00 | `0 8 * * 1` |
| Every 15 minutes | `*/15 * * * *` |
| Every hour on the hour | `0 * * * *` |
| First of the month at midnight | `0 0 1 * *` |
| Twice a day (8 and 20) | `0 8,20 * * *` |
| March 30 at 11:30 (one-shot) | `30 11 30 3 *` |

Schedules are evaluated in the configured timezone (`TZ`, see `<current_datetime>`). Confirm the user's intended timezone if it's unclear from context.

### `attached_skills`

`create_cronjob` (and `edit_cronjob`) take the same optional `attached_skills` array as `create_task`. The contents of each `SKILL.md` get **injected directly into the task prompt** on every run, so the spawned task agent doesn't have to discover and `read_file` the skill itself. Only relevant for `action_type: "task"`.

Use this when:
- The cronjob's reliability depends on a skill (e.g. a daily Nitter scrape that needs the `nitter` skill's URL conventions).
- You want the skill rules to be deterministic, not subject to routing decisions.

```
attached_skills: ["nitter", "summarizer"]
```

Missing SKILL.md files are skipped with a warning — the task still runs.

### Persistent state across runs (continuity)

Each cronjob run spawns a **fresh, isolated task agent**. Run N+1 remembers nothing from run N. For digest / monitor / watch jobs this means the same items get reported over and over. Fix it with a **brain file** the task owns:

1. At the **start** of the run, read the brain file to see what's already known/reported.
2. Do the work, dedupe against that state.
3. At the **end**, write the new facts / last-seen markers back.

This needs zero platform code — it's just `read_file` / `write_file` in the cronjob prompt. It composes with `attached_skills`: attached skills bake in *rules*, the brain file carries *run-to-run state*.

**Where to store:**

- **`/data/memory/state/<job-name>.json` or `.md`** — compact, machine-readable job state (last-seen IDs, timestamps, cursors). Prefer this for pure dedupe markers.
- **Wiki page (`/data/memory/wiki/<topic>.md`)** — curated, human-readable knowledge the job enriches over time.

**Guardrails (a brain a cronjob writes to on every run grows unnoticed):**

- **Set a size budget** (~60 KB). When the file outgrows it, move raw material into monthly archives / sub-pages and keep only a compact summary or current state in the main file.
- **Don't blindly `read_file` a large state file** — a single `read_file` on an overgrown file can silently blow up the run (a real incident: a hub page grew to 756 KB and killed the run on low token budget / high cost). Instead `grep` for the specific marker and append with shell `>>`.
- **Keep the split clean:** compact machine state → `/data/memory/state/`; curated knowledge → the wiki.

Example digest cronjob prompt using a brain file:

```
prompt: "Read /data/memory/state/hn-digest.md for the list of story IDs already sent.
         Fetch the current Hacker News front page. Report only stories whose ID is
         NOT in that file, as a 5-bullet digest. Then append the newly reported IDs
         to /data/memory/state/hn-digest.md (use grep + shell append, do not reload
         the whole file if it is large). Keep the file under ~60 KB."
```

### Editing, listing, removing

- `list_cronjobs` — overview of all cronjobs (id, name, schedule, status).
- `get_cronjob` — full configuration of one cronjob, **including the complete prompt**. Use this before editing — never edit a prompt blind.
- `edit_cronjob` — partial update; only fields you pass are changed. Pass `attached_skills: []` to clear all attached skills.
- `remove_cronjob` — deletes the cronjob. Confirm with the user first if the cronjob wasn't created in this conversation.

---

## Reminders

`create_reminder` schedules a **static text** to be delivered verbatim into the chat at a future time. No agent runs, no tools execute, no skills load, no fresh data is fetched. Just text.

Internally, a reminder is a cronjob with `action_type: "injection"` — but the dedicated tool is friendlier when the user says "remind me…".

### When to use it

- "Remind me at 17:30 to leave for the train."
- "Every weekday at 8:55 ping me: 'standup in 5'."
- "Tell me on March 30 at 11:30 that the package is being delivered."

The `message` is the literal text the user will see. Write it from the user's perspective ("Time to leave for the train", not "User wants to be reminded about the train").

### One-shot reminders

There's no separate "fires once" mode — use a cron expression that matches a single point in time:

| Natural language | Cron | Notes |
|---|---|---|
| March 30 at 11:30 | `30 11 30 3 *` | Will fire annually on March 30. For truly one-shot, remove it after the first run, or use a year-specific tool. |
| Tomorrow at 9 (assume today is Wed) | `0 9 * * 4` | Day-of-week is loose — fires every Thursday. Use day-of-month for precision. |

For exact-once delivery on a non-recurring date, the cleanest pattern is `<minute> <hour> <day> <month> *` — it fires once this year. If recurrence is unwanted, either remove the cronjob after firing or warn the user it will recur.

### Reminder anti-misuse {#reminder-anti-misuse}

`create_reminder` rejects requests that look dynamic — anything matching keywords like *"current"*, *"check"*, *"weather"*, *"latest"*, *"summarize"*, *"use skill"*, etc. The error message points you to `create_cronjob` with `action_type: "task"`. **Don't try to evade the check by rephrasing.** If the user wants the reminder text to be computed at run time, you genuinely need a task-type cronjob.

---

## Common patterns

### "Run this in the background"

```
create_task(
  name: "Refactor settings page",
  prompt: "<self-contained instructions>",
)
```

### "Run this in the background, following the wiki skill"

```
create_task(
  name: "Wiki cleanup",
  prompt: "<self-contained instructions>",
  attached_skills: ["wiki"],   // SKILL.md baked into the task prompt
)
```

### "Every weekday morning, summarize my GitHub notifications"

```
create_cronjob(
  name: "GitHub morning digest",
  schedule: "0 9 * * 1-5",
  action_type: "task",          // explicit, since this needs to fetch
  prompt: "Fetch GitHub notifications via the GitHub API and produce a 5-bullet digest. Group by repo. Highlight anything mentioning me. Deliver the digest as the final message.",
)
```

### "Ping me every hour with my todo list"

If the todo list lives somewhere static (file, URL) and never changes wording → use `action_type: "injection"`. If the digest needs to be regenerated each time → `action_type: "task"`.

### "Remind me at 17:30 to leave"

```
create_reminder(
  name: "Train reminder",
  schedule: "30 17 * * *",
  message: "Time to leave for the train.",
)
```

### "Daily Nitter scrape with the nitter skill rules"

```
create_cronjob(
  name: "Nitter daily scrape",
  schedule: "0 7 * * *",
  action_type: "task",
  prompt: "Scrape the configured Nitter accounts and append new posts to /data/memory/wiki/social.md following the conventions.",
  attached_skills: ["nitter"],   // SKILL.md baked into the prompt
)
```

### "A daily digest that doesn't repeat itself"

Give the cronjob a brain file so it dedupes across runs (see [Persistent state across runs](#persistent-state-across-runs-continuity)):

```
create_cronjob(
  name: "HN digest",
  schedule: "0 8 * * *",
  action_type: "task",
  prompt: "Read /data/memory/state/hn-digest.md for story IDs already sent. Fetch the HN front page, report only new stories, then append the new IDs back to that file (grep + shell append; keep it under ~60 KB).",
)
```

---

## Common mistakes to avoid

- **Spawning a task for a question you can answer directly.** Wastes tokens and time.
- **Reminder for dynamic content.** "Remind me each morning what the weather is" → that's a `create_cronjob` with `action_type: "task"`, not a reminder.
- **Editing a cronjob's prompt without first calling `get_cronjob`.** You'll either overwrite something important or repeat a typo. Read first, then `edit_cronjob`.
- **Forgetting timezone.** Cron schedules use the configured `TZ`. If the user is in a different timezone, ask before assuming.
- **Forwarding raw user text to `resume_task` without context.** The paused task has no chat history. Include the question + the user's answer + any relevant context in the `message`.
- **Promising fresh data from a `create_reminder`.** A reminder is static text. If you say "I'll remind you with the latest weather", you're lying. Use `create_cronjob` task-type instead.
- **Telling a task to `read_file` a skill instead of attaching it.** `create_task` accepts `attached_skills` — use it, the SKILL.md then ships inside the task prompt.
- **Attaching skills to a `create_reminder` or an `injection` cronjob.** No agent runs there, so `attached_skills` does not exist for them.
- **A digest/monitor cronjob with no brain file.** Each run is isolated, so it re-reports the same items forever. Give it a `/data/memory/state/` file to dedupe against.
- **Reloading an overgrown brain file with `read_file`.** A single `read_file` on a state/wiki file that grew into the hundreds of KB can kill the run. Budget its size and `grep` + append instead.

---

## Hard rules (also enforced in the system prompt)

- **NEVER use OS-level schedulers.** No `crontab`, no `launchd`, no `at`, no shell-spawned long-running processes (`nohup`, `&`, background loops). Always use the built-in tools above. The OS-level versions don't survive container restarts, can't be inspected from the UI, and bypass logging and provider routing entirely.
- **NEVER claim a reminder/cronjob will fetch fresh data unless its configured `action_type` actually supports it.**

---

## Tools reference

| Tool | What it does |
|---|---|
| `create_task` | Spawn a one-shot background agent with a self-contained prompt. Optional `attached_skills` bakes the listed SKILL.md files into the task prompt. |
| `resume_task` | Send a message to a paused task (used after a `status: question` injection). |
| `list_tasks` | List background tasks with their status. |
| `create_cronjob` | Schedule a recurring task or injection. |
| `edit_cronjob` | Partial-update an existing cronjob (prompt, schedule, action_type, provider/model, enabled, attached_skills). |
| `remove_cronjob` | Delete a cronjob. |
| `list_cronjobs` | List all cronjobs (id, name, schedule, status). |
| `get_cronjob` | Full configuration of one cronjob, including the full prompt. Use before editing. |
| `create_reminder` | Schedule a static text delivery (internally an `injection`-type cronjob). |
