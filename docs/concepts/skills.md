# Skills

A **skill** is a self-contained capability package the agent loads on demand. It lives on disk as a folder with a single `SKILL.md` file at the top and any helper scripts, templates, or sub-docs it needs alongside. The agent doesn't load every skill into every prompt — it sees a short *index* of installed skills (name + description + path) and only reads the full `SKILL.md` when the current request matches.

This page covers what skills are, the three flavors Offtangent supports (user-installed, agent-created, built-in), how a skill is structured, how it gets discovered and loaded at runtime, and how built-in skills are shipped and auto-updated.

## Skills vs. tools

It's worth nailing this down up front because it confuses people:

| | **Tools** | **Skills** |
|---|---|---|
| Form | TypeScript functions registered in code | Markdown files on disk |
| Invocation | The model emits a tool call | The agent reads `SKILL.md` and follows the instructions inside |
| Purpose | Atomic operations (`read_file`, `web_fetch`, `shell`, …) | Workflows, conventions, recipes that *use* tools |
| Update | Ship a new image | Drop in a new SKILL.md; effective on the next message |

Tools are what the agent *can do*. Skills are what the agent *knows how to do well*. A skill like `wiki` doesn't add new operations — it ties together `list_files`, `read_file`, `edit_file`, and `web_fetch` into the canonical "ingest a source, distill it, cross-link it" workflow with all the project-specific conventions baked in.

See [Built-in Tools](./tools) for the tool side of the house.

## Why skills exist

Two reasons.

**Progressive disclosure.** Stuffing every workflow the agent might ever need into the system prompt would be wasteful — most of it is dead weight on most turns. Skills let the agent carry only a one-line *signpost* per capability and load the full instructions on demand. The trade-off is one extra `read_file` call when a skill is actually needed; the upside is that adding capabilities doesn't grow per-turn token cost.

**Extensibility without a code change.** Anyone — the user, the community, the agent itself — can add a new skill by writing a Markdown file. No build step, no restart, no fork of Offtangent. The next message picks it up.

## The three flavors

Offtangent recognizes three kinds of skills, distinguished by *who owns them* and *where they live*:

| Flavor | Directory | Owner | Lifecycle |
|---|---|---|---|
| **User-installed** | `/data/skills/<owner>/<name>/` | You — installed via the web UI | Persistent. Tracked in `skills.json` with enabled toggle and per-skill env values. |
| **Agent-created** | `/data/skills_agent/<name>/` | The agent — written at runtime when it spots a reusable workflow | Persistent. Listed read-only in the UI; usage is tracked. |
| **Built-in** | `/data/skills_agent/<name>/` (seeded from the image) | The Offtangent project — shipped as part of the Docker image | Auto-updated on container start via a semver field in the frontmatter. |

Built-in skills sit in the *same directory* as agent-created skills on purpose — once seeded they're indistinguishable from any other agent skill at runtime. The difference is only at startup, where the entrypoint may overwrite them with a newer shipped version. See [Built-in skills](#built-in-skills) below.

All three flavors appear in the same `<available_skills>` block of the system prompt. The agent doesn't care who wrote them; it cares whether the description matches the user's request.

## Anatomy of a SKILL.md

Every skill has the same shape: YAML frontmatter, then a Markdown body. The frontmatter is the *contract* with the runtime; the body is what the agent reads when the skill gets activated.

```markdown
---
name: wiki
version: 1.0.0
description: Maintain and search the personal LLM-Wiki (knowledge base of Markdown pages). Use this skill for ingesting new sources, querying the wiki, and wiki maintenance/linting.
# Optional gating fields (see "Gating" below):
# platforms: [linux, macos]
# required_env_vars: [BRAVE_API_KEY]
# requires_toolsets: [web_fetch]
# Optional: opt out of built-in auto-update
# managed: false
---

# Wiki Skill

The wiki lives at `/data/memory/wiki/`. …
```

### Required frontmatter fields

- **`name`** — lowercase slug (`[a-z0-9-]`, 1–64 chars). This is what the agent uses to refer to the skill. Invalid names are auto-slugified by the parser.
- **`description`** — one or two sentences explaining *when to use this skill*. This is the routing signal — the agent only sees the description in the prompt index, so make it specific. Bad: *"Stuff about wikis."* Good: *"Maintain and search the personal LLM-Wiki — ingest sources, query pages, run lint passes."*

### Optional frontmatter fields

- **`version`** — semver string (`1.2.0`). Used by the entrypoint to decide whether to update a built-in skill on container start. Missing/empty is treated as `0.0.0`. See `agent_docs/skill-versioning.md` in this repository.
- **`managed: false`** — opt-out flag. When present on a built-in skill, the entrypoint never overwrites it on startup, regardless of versions. Use this if you've forked the shipped wiki skill and want to keep your fork.
- **`required_env_vars`** — array of env-var names. Missing vars don't hide the skill — they annotate it with `⚠ requires: VAR_NAME` so the agent can surface a clear error to you instead of failing silently.
- **`requires_toolsets`** — array of tool names. If any required tool is disabled (e.g. you turned off `web_fetch`), the skill is hidden from the prompt to avoid noise.
- **`platforms`** — array of `linux` / `macos` / `windows`. Inherited from the broader skill standard but rarely relevant in Offtangent: the production runtime is always Linux (the Docker image), so this only matters when you run the backend directly on macOS or Windows in dev mode. If set and the current platform doesn't match, the skill is hidden.

The full parser lives in `packages/core/src/skill-parser.ts`.

### The body

Anything goes — but the agent treats the body as *instructions*, not prose. The strongest skills:

- Open with a one-line statement of what the skill does and what `/data` paths it operates on.
- Break the workflow into named *operations* (`Ingest`, `Query`, `Lint`, …) with explicit step lists.
- Show the exact tool sequence (`web_fetch → write_file → list_files → edit_file`), so the agent doesn't have to invent a workflow.
- Use absolute paths (`/data/memory/wiki/`) — never relative.
- End with conventions, edge cases, and "when *not* to use this skill".

If your skill ships its own scripts, reference them as `{baseDir}/scripts/run.sh`. The runtime substitutes `{baseDir}` for the skill's actual directory when injecting paths into the prompt.

## How a skill is loaded

The lifecycle of a skill on a given turn is:

1. **Index injection.** When the system prompt is built, `getAgentSkillsForPrompt` (`packages/core/src/agent-skills.ts`) scans the skills directory, reads every `SKILL.md`'s frontmatter, applies platform/toolset gating, sorts by `lastUsed` (most recent first), and emits the top 10 as `<available_skills>` entries — name, description, location, optional warning. See [System Prompt → layer 13](./system-prompt#_13-available-skills-installed-skills-listing).

2. **Routing.** The agent reads the user's request, scans the descriptions, and decides whether any skill materially matches. The system prompt explicitly tells it *"Treat this as a strong routing rule: do not answer from memory when a matching skill should be used first."*

3. **Activation.** If a skill matches, the agent calls `read_file` on the `<location>/SKILL.md` path. The `read_file` tool has special handling for `SKILL.md` paths under `/data/skills/` and `/data/skills_agent/` — it auto-injects the `{baseDir}` placeholder and writes the activation timestamp into `/data/skills_agent/.usage.json`.

4. **Execution.** The agent follows the instructions in the body, calling whatever tools the skill prescribes.

5. **Overflow.** If you have more than 10 skills installed, only the 10 most recently used appear in the prompt index. The agent gets a `list_agent_skills` tool to browse the rest on demand. See [Built-in Tools → `list_agent_skills`](./tools#memory-history).

The "most recent first" ordering matters: skills you actually use stay top-of-mind in the prompt, while one-offs you installed and forgot about get demoted automatically.

## Built-in skills

Built-in skills are agent skills the Offtangent project ships *with the Docker image*. They live in the image at `/app/skills_agent_defaults/<name>/`, get seeded into the persistent volume on first startup, and are auto-updated on subsequent startups when a newer version ships.

### Why ship skills with the image at all?

Some workflows are too foundational to leave to user configuration:

- The agent maintains a curated **wiki** under `/data/memory/wiki/`. Without a clear, project-defined contract for *what counts as a wiki page*, *when to archive a source*, and *how to format the `## Sources` section*, every instance would drift into its own incompatible convention. The agent on instance A would not be able to read the wiki on instance B without re-learning the rules.
- These workflows need to evolve. When the project refines the wiki contract (better cross-link rules, a new lint check, a smarter ingest flow), every instance should pick up the improvement automatically — without the user having to manually re-install a skill.
- They're not *user features* — they're *internal conventions for how the agent uses its own memory*. Asking the user to install them via the UI would be confusing.

So built-in skills fill the gap between "hardcoded in TypeScript" (too rigid, requires a release for every wording tweak) and "user installs from a registry" (too fragile, every instance ends up different).

### The seeding & auto-update mechanism

Container startup is handled by `entrypoint.sh`. For each skill directory under `/app/skills_agent_defaults/`:

1. **Not installed yet** (`/data/skills_agent/<name>/` is missing) → copy the default in. Logged as `[axiom] Seeded agent skill: <name>`.
2. **Installed, `managed: false`** → skipped. Your fork is safe.
3. **Installed, default version > installed version** → back the installed copy up to `/data/skills_agent/.backups/<name>-v<old>-<timestamp>/`, then overwrite with the shipped version. Logged as `Updated agent skill: <name> <old> → <new>`.
4. **Installed, versions equal or installed newer** → nothing happens.

Backups are never garbage-collected automatically — prune `/data/skills_agent/.backups/` manually if the directory grows.

The full version-bump workflow for project maintainers is documented in `agent_docs/skill-versioning.md`.

### Pinning a local fork

If you've customized a built-in skill on your instance and don't want it overwritten, add `managed: false` to its frontmatter:

```yaml
---
name: wiki
version: 1.0.0
managed: false
description: …
---
```

Remove the flag later to opt back into auto-updates — the next startup will back up your fork and install the shipped version.

### Currently shipped

| Skill | Purpose |
|---|---|
| `wiki` | Ingest, query, and lint the personal wiki under `/data/memory/wiki/` — file naming, frontmatter aliases, the `## Sources` convention, and the full Karpathy-style ingest/query/lint operations. The system prompt explicitly tells the agent to load this skill before non-trivial wiki work. |
| `skill-creator` | Create or update an agent skill under `/data/skills_agent/<name>/`. Carries the full format guide — frontmatter rules, naming regex, gating fields (`required_env_vars`, `requires_toolsets`, `platforms`), `{baseDir}` substitution, worked examples, common mistakes. The system prompt's `<agent_skills>` block is a thin pointer to this skill so the full guide is only paid for in tokens when the agent actually needs to create a skill. |
| `tasks-and-cronjobs` | Use the background-execution system — background tasks (`create_task`, `resume_task`), cronjobs (`create_cronjob` & friends), and static reminders (`create_reminder`). Carries the decision flow (task vs. cronjob vs. reminder), prompt-writing conventions, `<task_injection>` handling, cron-expression cheat sheet, `attached_skills` for tasks and cronjobs, and the reminder anti-misuse contract. The system prompt's `<task_system>` block is a thin pointer to this skill plus the hard "no OS-level scheduler" safety rule and a trigger note for incoming `<task_injection>` blocks. |
| `email` | Work a mailbox well — the triage loop (`email_list` metadata first, bodies only when needed), bulk-marking newsletters read instead of reading them one by one, leaving important mail unread for the human, archiving instead of deleting, read-only account behaviour ("report, don't act"), heartbeat mail checks with notification only for important mail, and the allowlist/approval semantics of `email_send`. Gated via `requires_toolsets`, so it only appears once an email account is configured. |

The list will grow. Anything that's a *project-defined convention for how the agent uses Offtangent's own filesystem* is a candidate.

## User-installed skills

Skills you install yourself live under `/data/skills/<owner>/<name>/` and are tracked in `/data/config/skills.json` (`packages/core/src/skill-config.ts`) with an enabled toggle and per-skill env values. Manage them at **Settings → Skills → Installed**.

### Three install methods

- **OpenClaw shorthand** — `owner/name`. Resolves to `https://github.com/openclaw/skills/tree/main/skills/<owner>/<name>`. The community registry for shareable skills.
- **GitHub URL** — paste any `https://github.com/<owner>/<repo>/tree/<branch>/<path>` and the installer downloads that subdirectory.
- **File upload** — drop a `.zip` or `.skill` archive containing a `SKILL.md` at the root. Useful for private or in-flight skills.

All three flow through `packages/core/src/skill-installer.ts`.

### Per-skill env values

If a skill declares `required_env_vars` (or a legacy `metadata.clawdbot.env`/`requires.env` block), the Settings dialog surfaces an input field per variable. Values are encrypted with the instance's [secrets key](../settings/secrets) and only injected into the runtime when that skill is active. You can also add custom env keys the skill author didn't declare.

### Enable / disable

The toggle on the Installed list controls whether the skill appears in the prompt index. Disabled skills stay on disk and keep their env values — you're just hiding them from the agent. Useful for parking experimental skills without uninstalling.

### Sandboxing, or rather the lack of it

Skills are Markdown — they don't execute on their own. But a skill *can* tell the agent to run shell commands, fetch URLs, or write files. The agent runs as an unprivileged user inside the container, but inside that boundary there is no per-skill confinement. **Treat skills like browser extensions: install ones you trust.** Read the `SKILL.md` before installing from a source you don't know.

## Agent-created skills

The system prompt explicitly invites the agent to write its own skills:

> *"You can create your own reusable skills to extend your capabilities. … When you notice a reusable pattern across conversations, suggest creating a skill for it — but ask the user first."*

When the agent agrees on a new skill with you, it calls `write_file` on `/data/skills_agent/<name>/SKILL.md` with the same frontmatter format described above. From the next message on, the new skill appears in `<available_skills>` like any other.

The Skills UI shows agent-created skills under a dedicated **Agent** tab — read-only, with usage timestamps and any "missing env var" warnings the runtime detected. You can't edit them through the UI; if you want to tweak one, edit the file directly via the Memory page or `/data/skills_agent/<name>/SKILL.md` on the host.

## Gating: when a skill is hidden

The frontmatter gating fields are evaluated every time the system prompt is built:

| Field | Behavior when condition not met | Practical relevance |
|---|---|---|
| `requires_toolsets` | Skill is **hidden** from the prompt. | High. You can disable `web_fetch` / `web_search` in settings, so this prevents prompt noise. |
| `required_env_vars` | Skill is **kept** in the prompt but **annotated** with `⚠ requires: VAR_NAME`. | High. Most skills that hit external APIs declare these. |
| `platforms` | Skill is **hidden** from the prompt. | Low. Production runs in Docker (Linux); only matters in dev mode on macOS/Windows. |

The asymmetry between hiding and annotating is deliberate: a skill that relies on a disabled tool is genuinely unusable, so showing it would only produce confusing failures. A skill missing an env var, by contrast, is *configurable* — the agent should still see it so it can tell you "I have a skill for this but it needs `BRAVE_API_KEY` to run".

The gating logic is in `filterAndAnnotateAgentSkills` (`packages/core/src/agent-skills.ts`).

## Where skills appear in the system prompt

Two layers:

- **`<agent_skills>`** (layer 12) — a thin pointer to where new skills live and to the built-in `skill-creator` skill that carries the full format guide. Always present as long as a skills directory is configured.
- **`<available_skills>`** (layer 13) — the *index* of currently installed skills, capped at the 10 most recent. The agent reads `SKILL.md` from `<location>` on demand.

Both are documented in [System Prompt → layer 12](./system-prompt#_12-agent-skills-skill-creation-pointer) and [layer 13](./system-prompt#_13-available-skills-installed-skills-listing).

If you have more than 10 skills, the prompt also enables the `list_agent_skills` tool so the agent can browse the rest. See [Built-in Tools → `list_agent_skills`](./tools#memory-history).

## See also

- [System Prompt](./system-prompt) — where the skill listing and creation guide sit in the prompt layout.
- [Built-in Tools](./tools) — the operations skills compose into workflows.
- [Memory System](./memory) — the wiki layer that the built-in `wiki` skill operates on.
- [Tasks & Cronjobs](./tasks-and-cronjobs) — cronjobs can pin specific agent skills into their prompt deterministically via the `agent_skills` parameter.
- `agent_docs/skill-versioning.md` — the seed/update contract for built-in skills, for project maintainers.
