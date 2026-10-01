# Tasks

Defaults and safety rails for **background tasks and cronjobs** — the long-running jobs Offtangent kicks off without a user sitting in front of a chat window. For what tasks _are_ and how to create them, see [Tasks & Cronjobs](../concepts/tasks-and-cronjobs).

**URL:** `/settings?tab=tasks`

## General Task Settings

### Default provider

Provider + model used for task execution when the task itself doesn't specify one. Defaults to the currently active chat provider; override if you want background jobs to use a different model than your interactive chat.

Tasks are built for **hard work** — long-running, tool-heavy jobs without a human waiting on the other end. Feel free to pick a stronger, slower model here than you'd tolerate in chat (e.g. a top-tier reasoning model). Latency barely matters; quality of the end result does.

```json
{ "tasks": { "defaultProvider": "openai:gpt-5.4" } }
```

### Max duration

Hard upper bound on a single task run, in minutes. Any task hitting this limit is killed. Default: `30`. Range: 1 – 1440.

Use this to protect your wallet against runaway agents in an infinite tool loop.

Offtangent has no built-in hard spend cap. Max duration and loop detection bound how long a task runs and catch runaway loops, but they do not limit absolute cost. The hard cost ceiling is set at the provider: for subscription/OAuth providers it is your plan allowance (shown as the [subscriber usage quota](../web-ui/providers#subscriber-usage-quota-oauth-plans) on the Providers page), and for pay-per-token API keys it is a spend limit you configure with the provider.

```json
{ "tasks": { "maxDurationMinutes": 30 } }
```

### Max concurrent tasks

How many background tasks may run **at the same time**. There are two limits, and a task starts only when both have room:

| Key | Default | Meaning |
|---|---|---|
| `tasks.maxConcurrentPerProvider` | `5` | Tasks **one provider** may run at the same time. Range 0 – 64, `0` = no limit. |
| `tasks.maxConcurrentByProvider` | `{}` | Optional override per provider id, e.g. `{ "<provider-id>": 2 }`. Values 0 – 64, `0` = no limit for that provider. |
| `tasks.maxConcurrent` | `12` | **Global cap** across all providers — a safety net for the host. Range 0 – 64, `0` = no cap. |

The slot of a task is counted against the provider it was started with (task pin, persona default, or the default task provider above). A model or provider fallback during the run does not move the slot. Tasks whose provider cannot be resolved share one `unknown` bucket.

Everything above a limit waits in a **FIFO queue** and starts automatically as soon as a slot frees up. The queue does not block across providers: when a slot frees up, the **oldest waiting task that can start** gets it, so a task waiting for a busy provider never holds up a task of another provider. Within one provider the order is strictly first in, first out. The tool result of `create_task` says whether the provider limit or the global cap keeps a task waiting. A waiting task is already a real task row (status `running`, but without a start time), so it survives a restart and shows up as _queued_ in the UI. Its time budget (max duration, wrap-up warning) only starts ticking when the task really starts — waiting is free.

What the limits are for: the per-provider limit keeps one provider's rate limits and subscription quota from being hammered. The global cap exists because a task can be expensive locally, not just at the provider (builds, test suites, browsers) — CPU and RAM are shared no matter which provider drives a task. Seven of those in parallel are enough to push a small host into swap. Size the global cap by RAM, not by patience.

Details worth knowing:

- **Who waits:** tasks with trigger `user` or `agent`.
- **Who skips the queue:** `cronjob` and `heartbeat` runs (short, time-critical) and a task that is *resumed* after a question — someone is waiting for that answer. They still occupy a slot (in their provider and globally), so they count towards both limits.
- **Paused tasks are free:** a task waiting for your answer holds no slot.
- **After a restart:** recovered tasks all go through the queue instead of starting at once.
- **Changing a value** takes effect on the next queue decision — no restart needed.

```json
{ "tasks": { "maxConcurrent": 12, "maxConcurrentPerProvider": 5, "maxConcurrentByProvider": { "<provider-id>": 2 } } }
```

### Telegram delivery

How task results are pushed to the user who owns them (if Telegram is configured).

| Value | Behavior |
|---|---|
| `auto` | Deliver via Telegram only when the user isn't actively using the web UI. |
| `always` | Deliver via Telegram every time, even if they're online in the web UI. |

```json
{ "tasks": { "telegramDelivery": "auto" } }
```

### Background thinking level

Reasoning level for tasks and other internal background jobs (heartbeat, consolidation-side work). Separate from the main [chat thinking level](./agent#thinking-level) so you can keep chat snappy and background jobs thoughtful (or vice versa).

Values: `off`, `minimal`, `low`, `medium`, `high`.

```json
{ "tasks": { "backgroundThinkingLevel": "minimal" } }
```

## Loop detection

Tasks can get stuck — calling the same tool with the same args in a loop, or looping over a tool that keeps failing. Loop detection catches this and terminates the task.

### Enable loop detection

Master toggle. Default: `true`. Leave it on unless you're debugging an agent that actively needs to retry the same tool hundreds of times.

```json
{ "tasks": { "loopDetection": { "enabled": true } } }
```

### Detection method

| Value | How it works |
|---|---|
| `systematic` | Pure rule-based. Counts consecutive failing tool calls against `maxConsecutiveFailures`. Fast, zero extra tokens. |
| `smart` | Periodically asks a small LLM "is this agent making progress?". Slower, costs tokens, catches subtle loops. |
| `auto` | Start with `systematic`; escalate to `smart` if the rule-based signal is ambiguous. A good all-round choice, though the built-in default is `systematic`. |

```json
{ "tasks": { "loopDetection": { "method": "auto" } } }
```

### Max consecutive failures

How many back-to-back failing tool calls count as a loop. Default: `3`. Range: 1 – 20.

```json
{ "tasks": { "loopDetection": { "maxConsecutiveFailures": 5 } } }
```

### Smart provider

Only shown for `smart` / `auto`. Which LLM judges "is the agent making progress?". Pick something small (`gpt-5.4-mini`, `claude-haiku`, etc.).

```json
{ "tasks": { "loopDetection": { "smartProvider": "openai:gpt-5.4-mini" } } }
```

### Smart check interval

Only shown for `smart` / `auto`. How often (every _N_ tool calls) the smart check runs. Default: `5`. Range: 1 – 50. Lower = more sensitive, more tokens; higher = cheaper, slower to react.

```json
{ "tasks": { "loopDetection": { "smartCheckInterval": 10 } } }
```

## Status updates

While a task runs, Offtangent can push periodic progress signals into the parent chat (the session that triggered the task) and, when Telegram delivery is configured, into that user's Telegram DM. Each signal is a short `<task_status type="periodic_update">` line with the task's runtime, tool-call count and token estimate plus the `/kill_task <id>` hint.

### Enable periodic status updates

Master toggle. Default: `false` — opt-in to avoid noisy chats out of the box. Turn it on if you want a visible heartbeat for long-running background tasks.

```json
{ "tasks": { "statusUpdates": { "enabled": true } } }
```

### Status update interval

How often to emit a status update, in minutes. Default: `10`. Range: 1 – 120. Set higher for long, quiet tasks; lower if you want a more responsive heartbeat.

```json
{ "tasks": { "statusUpdates": { "intervalMinutes": 10 } } }
```
