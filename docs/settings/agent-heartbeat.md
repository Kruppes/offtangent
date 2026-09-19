# Agent Heartbeat

The heartbeat is the agent's **background reflection loop**. On a fixed interval — always, not at a specific clock time — the agent wakes itself up with no user message, reads `HEARTBEAT.md`, and runs a short self-driven turn. It's the same idea Letta calls [sleep-time agents](https://docs.letta.com/guides/agents/sleep-time-agents): the subconscious that runs while the main agent is idle, keeping memory organized and catching things the foreground never gets around to.

**URL:** `/settings?tab=agentHeartbeat`

## Typical uses

Good heartbeat jobs are **interval-based**, **idempotent**, and **safe to no-op** when there's nothing to do:

- **Pending-work triage** — look at open tasks / cronjobs, flag anything overdue, surface stale TODOs.
- **External polling** — check a connected inbox (email, GitHub, calendar) for new items since last tick, summarize urgent ones.
- **Proactive context** — if a scheduled meeting or cronjob is coming up within the next interval, pre-load the relevant wiki pages or draft talking points.
- **Threshold alerts** — watch a metric or external state (server down, deploy stuck, quota nearly hit) and notify when it crosses a boundary.

### Heartbeat vs. cronjob

If your task starts with "every morning at 7…" or "on Mondays…", it's a **cronjob**, not a heartbeat job — use [Tasks & Cronjobs](../concepts/tasks-and-cronjobs) for that. Rule of thumb:

| | Heartbeat | Cronjob |
|---|---|---|
| Fires when | Every `intervalMinutes`, always | At a specific cron expression |
| Good for | Reflection, polling, maintenance | One-shot scheduled actions |
| Prompt source | `HEARTBEAT.md` (shared across ticks) | Per-cronjob definition |
| Duration limit | Short, every line runs every tick | Up to `tasks.maxDurationMinutes` |
| Idempotent? | **Required** — runs constantly | Not required |

## Enabled

Master toggle. When off, no heartbeat ever fires — all settings below are inert.

```json
{ "agentHeartbeat": { "enabled": false } }
```

## Heartbeat tasks

A card linking to `/data/config/HEARTBEAT.md` — the prompt the agent receives on every heartbeat tick.

Click **Open editor** to jump to the [Agent Instructions](../concepts/instructions#heartbeat-md) page. Keep it tight: this text runs every `intervalMinutes`, so every line is a recurring cost.

For the default template, what belongs here, and what doesn't, see [Agent Instructions → `HEARTBEAT.md`](../concepts/instructions#heartbeat-md).

## Interval

How often the heartbeat runs, in minutes (1 – 1440). Default: `30`.

```json
{ "agentHeartbeat": { "intervalMinutes": 30 } }
```

## Night mode

Pause the heartbeat during a sleep window. Uses your configured [timezone](./agent#timezone).

### Enable night mode

Toggle the pause window on/off.

### Start hour / End hour

Hour of day (0 – 23) when the window starts and ends. Crosses midnight correctly — `startHour: 23`, `endHour: 7` means "pause from 23:00 to 07:00".

### Example config with night mode enabled

```json
{
  "agentHeartbeat": {
    "nightMode": {
      "enabled": true,
      "startHour": 23,
      "endHour": 7
    }
  }
}
```
