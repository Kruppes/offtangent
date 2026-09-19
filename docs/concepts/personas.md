# Personas

A persona is a second agent on the same instance: its own character, its own memory, its own strands, its own tasks. You run several when you want distinct professional roles — a quality reviewer, a frontend reviewer, a backend reviewer, a support specialist — instead of one generalist that you re-prompt every time.

## What a persona is

Concretely, a persona is:

- a directory of Markdown files under `/data/agents/<id>/`, read by the agent runtime on every turn (`packages/core/src/persona-loader.ts`),
- a row in the `personas` table holding display name, colour, badge, `is_default` and `archived` (`packages/core/src/persona-store.ts`),
- an `agent_id` value that appears on sessions, chat messages, tasks, cronjobs, facts and captures.

The files are the source of truth for *behaviour*. The record exists so a client can render a persona it does not ship code for, and so "the default persona" is a flag rather than a hardcoded string.

Multi-persona is a feature flag: `multiPersona.enabled` in `settings.json`, default `false`. With it off, `loadPersona()` returns an empty context and every turn uses the global files.

## What a persona is not

- **Not a user account.** Users live in the auth system and have roles (`admin`, `user`). A persona has no login and no permissions of its own.
- **Not a permission boundary for humans.** Everyone who can reach the instance can talk to every persona.
- **Not a sandbox.** All personas run in the same container, against the same `/workspace`, with the same shell. A persona is a *character and a memory scope*, not an isolation mechanism. See [Tools: honesty section](#tools-a-hint-not-a-boundary).

The persona id is immutable by contract: it appears in sessions, facts, tasks and file paths, so renaming changes the display name only. The id must match `^[a-z][a-z0-9-]{0,48}[a-z0-9]$`.

## The files

Six files are editable through the API and the Web UI (`PERSONA_FILE_NAMES` in `packages/core/src/contracts/personas.ts`), each capped at 256 KB:

| File | Goes into the prompt as | Effect |
|---|---|---|
| `IDENTITY.md` | `<identity>` | Persona-only block. Carries the structured fields (name, badge, colour, role, tone, model, subjects). |
| `SOUL.md` | `<personality>` | **Replaces** the global `memory/SOUL.md` for this persona. Character, voice, principles. |
| `USER.md` | `<user_profile>` | **Replaces** the per-user profile block for this persona — what this persona knows about the person it works for. |
| `TOOLS.md` | `<tool_hints>` | Persona-only block. Free text about which tools to reach for. A hint, not a gate — see below. |
| `AGENTS.md` | `<agent_rules>` | **Replaces** the global `config/AGENTS.md` for this persona. Concrete do/don't rules. |
| `HEARTBEAT.md` | — | Editable, stored, loaded into the persona context. Not currently consumed by the heartbeat runner (see [Open points](#open-points)). |

A seventh file is loaded but not exposed in the editor: `MEMORY.md` in the persona directory is appended as `<agent_memory>`, **in addition to** the global `<core_memory>` rather than replacing it.

The precedence rules come from `assembleSystemPrompt()` in `packages/core/src/memory.ts`:

- `SOUL.md`, `AGENTS.md`, `USER.md`: persona file wins if present, global file otherwise.
- `IDENTITY.md`, `TOOLS.md`: persona-only additions — there is no global equivalent.
- `MEMORY.md`: additive. Both blocks are emitted.

Every file is optional. A missing file means "fall back to the global one" — a persona with only `SOUL.md` is valid.

Files are re-read on every turn, cached in-process with a 10-second mtime check, so an edit takes effect on the next message without a restart. Writes through the API invalidate the cache immediately.

For the full layout of the resulting prompt, see [System Prompt](./system-prompt).

## Where they live

```
/data/agents/
  <persona-id>/
    IDENTITY.md
    SOUL.md
    USER.md
    TOOLS.md
    AGENTS.md
    HEARTBEAT.md
    MEMORY.md          # optional, additive <agent_memory>
    memory/            # scoped memory root, see below
```

The base directory follows `DATA_DIR` (default `/data`). The directory name *is* the persona id.

### Scoped memory

With `multiPersona.scopedMemory` enabled (default `true`), every non-default persona gets its own memory root at `/data/agents/<id>/memory` — daily notes, session summaries and consolidated memory land there instead of in the shared `/data/memory`. That is what keeps one persona's notes out of another's prompt. Facts in the SQLite store are scoped by `agent_id` on the row.

## Structured fields

Nobody edits a 200-line `SOUL.md` on a phone, so the editor offers fields. The fields are parsed out of the Markdown and written back line-by-line — `packages/core/src/persona-fields.ts` never rewrites a file wholesale, so hand-written prose survives a round trip.

| Field | Lives in | Limit | Notes |
|---|---|---|---|
| Name | `IDENTITY.md`, `- **Name:**` | 80 chars | Also mirrored into the persona record. |
| Badge | `IDENTITY.md`, `- **Emoji:**` | 8 chars | One character or emoji; rendered as the avatar. |
| Colour | `IDENTITY.md`, `- **Color:**` | `#rrggbb` | Validated against `/^#[0-9a-fA-F]{6}$/`, stored lowercase. |
| Role | `IDENTITY.md`, `- **Role:**` | 280 chars | One sentence. The load-bearing field: it is what the list shows and what a handover reads. |
| Tone | `IDENTITY.md`, `- **Tone:**` | 280 chars | Free text, e.g. "short, no small talk". |
| Model | `IDENTITY.md`, `- **Model:**` | 120 chars | Model preference. Empty means the global default. |
| Subjects | `IDENTITY.md`, fenced block | 30 × 80 chars | What this persona owns. Short phrases. |
| Tools | `TOOLS.md`, fenced block | 60 × 80 chars | See the honesty section below. |

Label aliases are recognised, so files that use `Creature:`/`Vibe:` or the German `Wesen:`/`Stil:` keep parsing. Placeholder values (`—`, `-`, `n/a`, `none`, `tbd`) read as "not set". List fields own an HTML-comment-fenced block (`<!-- offtangent:subjects:start -->`), so a second write replaces the block instead of appending a copy.

### Model preference

The `Model` field is text in `IDENTITY.md`. The mechanism that actually pins a persona to a provider/model at runtime is the setting `multiPersona.perAgentProvider[<agentId>]`, applied by the composition layer at startup (`packages/web-backend/src/bootstrap/runtime-composition.ts`) and consulted in model selection (`packages/web-backend/src/model-selection.ts`). If a pin cannot be resolved, it is logged and skipped, and the persona falls back to the global model. Set the field for documentation; set `perAgentProvider` to make it binding.

## Tools: a hint, not a boundary

The **Tools** field in the persona editor writes a Markdown list into `TOOLS.md`. `TOOLS.md` is injected into the system prompt as `<tool_hints>`. That is the entire mechanism.

Nothing filters the tool registry by persona. A persona whose `TOOLS.md` lists only `read_file` still has `shell`, `write_file`, `web_fetch` and everything else in its tool list, and will use them if the conversation leads there. Treat the field as a hint to the model, not a permission boundary. Do not use it to contain a persona you would not trust with a shell.

The one place where tool access is actually enforced today is per scheduled job. `scheduled_tasks` carries `toolsOverride` and `skillsOverride`; the task runner reads `toolsOverride` as a JSON array of tool names and **removes** those tools from the agent before the run starts:

```ts
// packages/core/src/task-runner.ts
let effectiveTools = this.options.tools
if (overrides?.toolsOverride) {
  const disabledTools: string[] = JSON.parse(overrides.toolsOverride)
  if (Array.isArray(disabledTools) && disabledTools.length > 0) {
    effectiveTools = effectiveTools.filter(t => !disabledTools.includes(t.name))
  }
}
```

Two properties worth knowing: it is a **deny list** (you name what to remove, not what to allow), and invalid JSON fails open — the run gets all tools. So if you need a recurring job that genuinely cannot touch the shell, express it as a cronjob with a `toolsOverride`, not as a persona with a short `TOOLS.md`. See [Tasks & Cronjobs](./tasks-and-cronjobs).

For the same reason the persona write API is deliberately *not* exposed as an agent tool: an agent that can rewrite its own persona files could widen its own instructions after reading a web page.

## Cross-persona: `ask_agent`

One persona can ask another for its perspective with the `ask_agent` tool (`packages/core/src/ask-agent-tool.ts`).

**When it is offered.** Only when `multiPersona.enabled` is true. The runtime then adds the tool and appends a `<cross_persona>` block to the system prompt listing the other persona ids found under `/data/agents/` (plus `main`).

**What happens on a call.** `ask_agent { agent_id, question }` builds a system prompt for the target from *its* `SOUL.md`, `IDENTITY.md` and `AGENTS.md`, plus a note that this is a one-shot query from another agent, and makes a single stateless completion. Consequences:

- No session is created, no messages are stored, no facts are extracted.
- The target has **no conversation history** — everything it needs must be in the question.
- The target's `MEMORY.md`, `USER.md` and `TOOLS.md` are *not* part of that prompt.
- Extended thinking is explicitly disabled for the call.
- The answer comes back as `[Response from <id>] …`.

**Guards.** Asking yourself is refused. The call chain is tracked: maximum depth is 3, and a target already in the chain is refused as circular. A target without a persona directory returns a `not_found` error. Provider errors are surfaced verbatim instead of being masked as an empty answer.

### A review pattern

Because `ask_agent` is stateless and in-character, it composes into a simple two-role review loop:

1. A builder persona does the work and writes down the result (a diff, a decision, a plan).
2. It calls `ask_agent` on a reviewer persona whose `SOUL.md` and `AGENTS.md` say: find problems, do not be agreeable, name the concrete risk, answer in a fixed structure.
3. The builder either fixes what came back or records why it disagrees.

What makes this work is the reviewer's files, not the tool. Put the standard into `AGENTS.md` ("always state the worst failure mode first", "no praise") — the reviewer sees that block and nothing of the builder's context, so it cannot be dragged into agreeing.

The one-shot nature is a real constraint: paste the artifact into the question. "What do you think of the change we discussed" reaches a persona that has never heard of it.

For deeper work, delegate a background task to the reviewer persona instead (tasks carry `agent_id` and get the full persona runtime, including tools and memory).

## Personas, tasks and cronjobs

Tasks and scheduled jobs carry an `agent_id`:

- A task started by a persona runs under that persona: `<memory_reference>` points at *its* memory root, not the global one.
- `scheduled_tasks.agent_id` decides which persona a cronjob runs as — and `toolsOverride`/`skillsOverride` on the same row is the only per-run tool gate that exists.
- `personas.hasLiveTaskForPersona()` blocks archiving or deleting a persona while one of its tasks is `running` or `paused`.

## When to use what

| Situation | Use |
|---|---|
| A distinct voice, its own memory, its own strands; you want to *talk to it* as someone else | A persona |
| A repeatable procedure with fixed steps, available to every persona | A [skill](./skills) |
| One topic, same agent, same standards | A [strand](./captures-and-strands) |
| A recurring job that must run with reduced tool access | A cronjob with `toolsOverride` |
| A second opinion inside one answer | `ask_agent` |
| A second opinion that needs tools, files and time | A task with the reviewer's `agent_id` |

Rules of thumb: if the only difference is *what it does*, a skill is cheaper — it costs no memory scope and no extra configuration. If the difference is *what it cares about and how it judges*, it needs a persona, because that lives in `SOUL.md` and `AGENTS.md`. And if you only need to keep two conversations apart, a strand already does that.

Cost side: every persona is a separate memory scope to maintain. Four abandoned personas produce four sets of stale daily notes.

## Lifecycle

- **Create** (`POST /api/personas`): writes a template set of the six files into a fresh `/data/agents/<id>/`, creates the record, then applies whatever files or fields came with the request. Fails with `409 persona_exists` when the id is taken. Note that the shipped templates are written in German; overwrite them with your own text.
- **Update** (`PUT /api/personas/:id`): one endpoint for raw files, structured fields, `archived` and `isDefault`. Fields win over files when both are in the same request. Writes are atomic (temp file + rename).
- **Archive**: the normal removal. The persona stops appearing in the default list; nothing is deleted. The default persona cannot be archived, and promoting an archived persona to default un-archives it.
- **Delete** (`DELETE /api/personas/:id?confirm=1`): removes the directory and the record. Refused for the default persona (`403 persona_is_default`), while a turn or delegated task is running (`409 persona_busy`), and while a Telegram bot is bound to it (`409 telegram_bound`). Rows keyed by `agent_id` — strands, messages, tasks, cronjobs, facts, captures — are **not** cascaded; they outlive the persona. `GET /api/personas/:id/delete-preview` counts them first.

Exactly one persona carries `is_default`, enforced by a partial unique index; promoting another moves the flag inside one transaction.

## Open points

- `HEARTBEAT.md` in a persona directory is editable, stored and loaded into the persona context, but the heartbeat runner reads the global `/data/config/HEARTBEAT.md` (`packages/core/src/agent-heartbeat.ts`) and no consumer of the persona `heartbeat` field exists in the current code. Treat per-persona heartbeat content as documentation of intent, not as something that runs.

## See also

- [Personas API](../reference/personas-api) — request and response shapes.
- [Personas (Web UI)](../web-ui/personas) — the `/personas` page.
- [System Prompt](./system-prompt) — where each persona file lands in the prompt.
- [Captures & Strands](./captures-and-strands) — `agent_id` on a capture picks the persona.
- [Tasks & Cronjobs](./tasks-and-cronjobs) — `agent_id`, `toolsOverride`, `skillsOverride`.
