# Built-in Tools

Every turn the agent receives a tool registry — the concrete list of functions it can call. Most tools are **always on** because they're load-bearing for how Offtangent works (memory, files, chat history, background tasks). A few are **opt-in** because they need an external service or a key.

The complete list below is what the agent sees in `<available_tools>` (see [System Prompt → Available Tools](./system-prompt#_7-available-tools-built-in-tool-registry)). When you toggle a tool off in the UI, its line literally disappears from the prompt — there is no out-of-band capability list.

## Filesystem & shell

These are the agent's hands. They run inside the workspace dir (`/workspace` in Docker) and are unrestricted — there is no allow-list, no per-command confirmation. Treat the agent as a non-root shell user.

| Tool | Notes |
|---|---|
| `shell` | Execute a shell command and return stdout/stderr. Honors `cwd = /workspace` and a 60s default timeout. Use `sudo` for privileged ops (`apt-get install`, `systemctl`, …). Output above `heuristics.toolOutput.shellMaxChars` (30.000) is cut to head + tail with a marker naming the full length. |
| `read_file` | Read a file by path, optionally a slice (`offset`, `limit`). Returns at most `heuristics.toolOutput.readFileMaxChars` (20.000) characters and says how to page on. Binary files (NUL bytes / non-UTF-8) and files above 64 MB return metadata (size, MIME guess) instead of content. Has special handling for `SKILL.md` files under `/data/skills/` and `/data/skills_agent/` — auto-injects `{baseDir}` and tracks usage. |
| `write_file` | Overwrite or create a file (creates parent dirs). Prefer `edit_file` for surgical changes — it diffs cleanly in the UI and is harder to misuse. |
| `edit_file` | Exact-text replacement: `{oldText, newText}` pairs. `oldText` must be unique and present in the file. Preferred over `write_file` for surgical changes. |
| `list_files` | List a directory's entries with a `[dir]` / `[file]` prefix. |

## Memory & history

The agent's read-side into its own past. These tools are what make the [Memory System](./memory) actually queryable instead of just static files in the prompt.

| Tool | Notes |
|---|---|
| `read_chat_history` | Full-text search over past chat messages with filters for datetime range, source (`web` / `telegram` / `task`), role (`user` / `assistant` / `tool` / `system`), and session id. Pagination via `limit` (default 100, max 500) and `offset`. |
| `search_memories` | Searches the atomic facts produced by [fact extraction](./memory#fact-extraction). Returns up to 50 facts per query. |
| `list_agent_skills` | Browse every self-created skill under `/data/skills_agent/` with its description, location, last-used date, and any missing required env vars. The 10 most recent are already injected into the prompt; this tool reaches the rest. See [Skills](./skills). |

## Tasks, cronjobs & reminders

The agent can spawn its own background workers and schedule recurring or one-shot work without touching the host's `cron`. Defaults (provider, max duration, loop detection, telegram delivery) live under [Settings → Tasks](../settings/tasks).

| Tool | Notes |
|---|---|
| `create_task` | Spawn a background agent with a self-contained prompt. Optional `provider` / `model` to pin a specific runtime, optional `attached_skills` to bake skill rules into the task prompt, optional `continuation_of` to hand the new task the handoff of a predecessor that ran out of time. See [Tasks & Cronjobs](./tasks-and-cronjobs). |
| `resume_task` | Send a follow-up answer back to a paused task (one that asked a question). |
| `list_tasks` | List background tasks with status filters. |
| `create_cronjob` | Create a recurring scheduled task. Standard 5-field cron expression, evaluated in the configured `timezone`. Two `action_type`s: `task` (full agent run) or `injection` (deliver a static message verbatim). Optional `attached_skills`. |
| `edit_cronjob` | Update a cronjob's prompt, name, schedule, action_type, provider, or enabled flag. |
| `remove_cronjob` | Permanently delete a cronjob. |
| `list_cronjobs` | List all cronjobs with schedules, status, and next run times. |
| `get_cronjob` | Fetch a single cronjob's full configuration including its complete prompt. |
| `create_reminder` | One-shot scheduled message delivered to the chat at a specific time. Lighter than a cronjob — no agent spawned, no recurrence. |

## Provider quota

| Tool | Notes |
|---|---|
| `provider_quota` | Returns the current subscriber usage quota for LLM providers (Anthropic Claude Pro/Max, ChatGPT Codex, OpenCode, z.ai, …). Accepts an optional `providerId` to scope to one provider and an optional `refresh` flag to force a live fetch (for the selected provider, or all of them when `providerId` is omitted). Without `refresh`, returns the cached snapshot from the [subscriber usage quota](../web-ui/providers#subscriber-usage-quota) monitor (polled in the background). Like the provider API, the tool answers **admin users only**; a provider refreshed less than a minute ago keeps serving cached data. |

## User delivery

| Tool | Notes |
|---|---|
| `send_file_to_user` | Deliver a file (≤ 50 MB) to the user. In a chat turn it lands on the assistant message of that turn (web chat, app, or Telegram). In a **background task** it lands in the strand that triggered the task: an assistant row carrying the file plus a live `attachment` frame. An optional `caption` travels with the file. A task with no strand at all (a legacy row without a session lineage) still cannot deliver and reports an error. |

---

## Optional built-in tools

These tools are part of Offtangent but *off* (or behind a config) by default — usually because they need an API key, an external service, or because not every install needs them. They show up in the prompt only when enabled.

### `transcribe_audio`

Whisper-compatible speech-to-text. **Disabled by default**, since it needs either an OpenAI key, a self-hosted Whisper server, or an Ollama provider with a Whisper model.

When enabled, the agent gets a `transcribe_audio` tool that takes an audio file path (relative to the workspace), an optional `language` hint, and an optional `cleanup` flag to strip filler words and fix punctuation via the configured rewrite provider.

**Where to configure:** [Settings → Speech-to-Text](../settings/speech-to-text) (`/settings?tab=stt`).

### `web_fetch`

Fetches a single URL and returns extracted readable text — scripts, styles, and HTML chrome are stripped, whitespace is normalized. **Enabled by default**, no provider choice and no key required.

Designed to pair with `web_search`: the agent searches first, picks a result, then fetches the full page. It also works standalone for any URL the user pastes into chat.

**Where to configure:** Web UI → **Skills → Built-in Tools** tab. Only one knob: enabled or not. Persisted to `settings.json`:

```json
{
  "builtinTools": { "webFetch": { "enabled": true } }
}
```

### `web_search`

Runs a search query and returns a list of `{title, url, snippet}` results. **Enabled by default** with the DuckDuckGo backend, which needs zero configuration.

Four backends are available — pick one in the UI:

| Provider | Setup | Notes |
|---|---|---|
| `duckduckgo` | nothing | Default. Zero config, no key, no external account. Rate-limited; fine for casual use. |
| `brave` | needs `braveSearchApiKey` | Enter the key in the same UI card. Stored encrypted in `builtinTools.webSearch.braveSearchApiKey`. Better quality and structured snippets; sign up at <https://api-dashboard.search.brave.com>. |
| `searxng` | needs `searxngUrl` | Point at your own SearXNG instance, e.g. `http://searxng:8080`. Best for self-hosted/private setups; no third-party calls. |
| `tavily` | needs `tavilyApiKey` | AI-optimized search API. Sign up at <https://app.tavily.com> (1,000 queries/month free). Stored encrypted in `builtinTools.webSearch.tavilyApiKey`. |

Switching the provider takes effect on the next prompt — no restart needed.

**Where to configure:** Web UI → **Skills → Built-in Tools** tab. Persisted to `settings.json` — the full shape with every key:

```json
{
  "builtinTools": {
    "webSearch": {
      "enabled": true,
      "provider": "duckduckgo",
      "braveSearchApiKey": "<encrypted>",
      "searxngUrl": "http://searxng:8080",
      "tavilyApiKey": "<encrypted>"
    }
  }
}
```

Only the keys relevant to the chosen `provider` are read — the others are ignored but kept around so you can switch back without re-entering them. `braveSearchApiKey` and `tavilyApiKey` are stored encrypted at rest.

## See also

- [System Prompt → Available Tools](./system-prompt#_7-available-tools-built-in-tool-registry) — how the active tool list is rendered into the prompt every turn.
- [Tasks & Cronjobs](./tasks-and-cronjobs) — the state machine behind `create_task` / `create_cronjob` / `create_reminder`.
- [Memory System](./memory) — what `read_chat_history` and `search_memories` actually search.
- [Provider Management → Subscriber usage quota](../web-ui/providers#subscriber-usage-quota) — how the quota monitor polls providers behind the scenes.
- [Skills](./skills) — how to extend the agent beyond the built-in tool list.
