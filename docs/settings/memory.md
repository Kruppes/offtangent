# Memory

Session lifetime, fact extraction, and nightly memory consolidation. For the broader picture (files, layers, templates) see [Memory System](../concepts/memory).

**URL:** `/settings?tab=memory`

The panel is grouped into three sections in pipeline order: **Sessions** → **Fact extraction** (per session) → **Memory consolidation** (nightly). File-based upload retention lives on the [Agent](./agent#upload-retention) tab.

## Sessions

### Session timeout

How many minutes of inactivity end a session. When a session ends, Offtangent may summarize it into the current daily note (see below). Default: `30`.

Range: 1 – 1440 (up to 24h).

```json
{ "sessionTimeoutMinutes": 30 }
```

When a session ends, the agent generates a short activity-log entry and appends it to `memory/daily/<date>.md`.

### Session Summary Provider

Which provider writes the end-of-session summary into `memory/daily/<date>.md`.

- **Use active provider** (default) — whatever is selected under [Agent → Provider](./agent#provider).
- **Explicit override** — pick a cheap, fast model here to avoid summarizing with your most expensive reasoning model.

```json
{ "sessionSummaryProviderId": "openai:gpt-5.4-mini" }
```

## Fact extraction

After a session ends with at least _N_ messages, run the transcript through a small LLM and write durable facts into the `memories` table. The agent retrieves these via the `search_memories` tool — useful once memory grows past what fits in a single prompt.

### Enable fact extraction

Master toggle for the per-session extraction job. Default: `true`.

```json
{ "factExtraction": { "enabled": true } }
```

### Fact extraction provider

Dedicated provider (defaults to the active chat provider). Use something small and fast — this runs after every non-trivial session.

```json
{ "factExtraction": { "providerId": "openai:gpt-5.4-mini" } }
```

### Minimum session messages

Sessions shorter than this are skipped (no useful facts to extract). Default: `3`. Range: 1 – 100.

```json
{ "factExtraction": { "minSessionMessages": 3 } }
```

## Memory consolidation

Scheduled job that condenses the last _N_ daily notes into durable entries in `MEMORY.md` and trims the daily files. Keeps the prompt small without losing context.

### Enable consolidation

Master toggle for the nightly job. Default: `true`.

```json
{ "memoryConsolidation": { "enabled": true } }
```

### Run at hour

Hour of the day (0 – 23, in your configured [timezone](./agent#timezone)) to run the consolidation. Default: `3` (i.e. 3 AM local time).

```json
{ "memoryConsolidation": { "runAtHour": 3 } }
```

### Lookback days

How many days of daily notes the job reads and condenses on each run. Default: `3`. Range: 1 – 30.

```json
{ "memoryConsolidation": { "lookbackDays": 3 } }
```

### Consolidation provider

Dedicated provider for consolidation. Defaults to the active chat provider; set something cheaper if consolidation runs often.

```json
{ "memoryConsolidation": { "providerId": "openai:gpt-5.4-mini" } }
```

### Consolidation rules

A card at the bottom of this section links to `/data/config/CONSOLIDATION.md` — the prompt that tells the consolidator _how_ to condense (what to keep, what to drop, how to name entries).

Click **Open editor** to jump to the [Agent Instructions](../concepts/instructions#consolidation-md) page. See that page for the default template and tuning tips.
