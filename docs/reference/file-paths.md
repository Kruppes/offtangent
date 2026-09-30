# File Paths

Authoritative layout of the directories Offtangent uses at runtime. **This page is written for the runtime agent**: when you need to locate a file, look it up here. For *user-facing* details (how to edit a file, what each setting does, how to back things up), follow the links into [Web UI](../web-ui/) and [Settings](../settings/) — those pages are the source of truth for behavior.

Two rules to remember:

1. Every path on this page is resolved through a helper in `packages/core/src/`. **Never hardcode `/data/...`** in new code — import the helper instead. The helper column points you at the right one.
2. `/data/...` is the persistent volume. `/app/...` is the read-only image. `/workspace/...` is your home for free-form files.

## Storage roots

The two environment variables `DATA_DIR` and `WORKSPACE_DIR` are the only knobs. Everything else is derived. See [`reference/env-vars`](./env-vars) for the full env-var list.

| Root | Env var | Default | Helper | Notes |
|---|---|---|---|---|
| Persistent app state | `DATA_DIR` | `/data` | `getDataDir()` (`uploads.ts`) | Mounted from `axiom-data` volume. **Back this up.** |
| Agent home / scratch | `WORKSPACE_DIR` | `/workspace` (falls back to `<DATA_DIR>/workspace`) | `getWorkspaceDir()` (`workspace.ts`) | Mounted from `axiom-workspace` volume. |
| Source tree | `AXIOM_PROJECT_DIR` | walk-up from `core/src/` to monorepo root | `getProjectRootDir()` (`config.ts`) | Read-only. README, `docs/`, `agent_docs/` live here. |

## `/data/` — persistent state

```text
/data/
├── db/              ← SQLite database
├── config/          ← JSON config + agent contract files
├── memory/          ← all memory tiers (SOUL, MEMORY, daily, users, wiki, sources)
├── skills/          ← user-installed skills
├── skills_agent/    ← built-in + agent-created skills
├── uploads/         ← user-uploaded files
└── npm-global/      ← npm global prefix (survives container upgrades)
```

### `/data/db/` — SQLite

| File | Purpose | Helper |
|---|---|---|
| `/data/db/axiom.db` | Single SQLite database: sessions, chat_messages, tasks, scheduled_tasks, token_usage, tool_calls, telegram_users, memories (atomic facts). WAL mode + FK on. | `initDatabase()` in `packages/core/src/database.ts` |

Schema is defined inline in `database.ts` (`SCHEMA` const). Migrations are idempotent and run on startup. Session-ID conventions: see `agent_docs/session-id-architecture.md` and `agent_docs/architecture-conventions.md` §8.

### `/data/config/` — runtime config

Resolved by `getConfigDir()` in `packages/core/src/config.ts`. Default templates live in the `TEMPLATES` map at the top of the same file and are written on first read via `ensureConfigTemplates()` / `ensureConfigStructure()` (in `memory.ts`).

| File | Schema source | Written by | User-facing doc |
|---|---|---|---|
| `providers.json` | `provider-config.ts` (`ProviderConfig`, `OAuthCredentials` — encrypted with `ENCRYPTION_KEY`) | Web UI Providers page | [Web UI → Providers](../web-ui/providers) |
| `settings.json` | `contracts/settings.ts` (full schema) + defaults in `config.ts` `TEMPLATES['settings.json']` | Web UI Settings pages | [`reference/settings`](./settings) for the schema; [Settings](../settings/) for per-section meaning |
| `secrets.json` | AES-256-GCM-encrypted blob (Brave key, OAuth tokens, etc.) | Secrets API | [Settings → Secrets](../settings/secrets) |
| `skills.json` | `{ skills: [{ source, enabled, env }] }` | Web UI Skills page | [Web UI → Skills](../web-ui/skills) |
| `telegram.json` | Stored separately from `settings.json` (see comment in `contracts/settings.ts:150`) | Web UI Telegram settings | [Settings → Telegram](../settings/telegram) |
| `AGENTS.md` | `AGENTS_TEMPLATE` in `memory.ts` | User (Web UI Instructions); migrated from legacy `/data/memory/AGENTS.md` if present | [Web UI → Instructions](../web-ui/instructions) |
| `HEARTBEAT.md` | `HEARTBEAT_TEMPLATE` in `memory.ts` | User; read pre-flight by `agent-heartbeat.ts` (skipped if empty) | [Settings → Agent Heartbeat](../settings/agent-heartbeat) |
| `CONSOLIDATION.md` | `CONSOLIDATION_TEMPLATE` in `memory.ts` | User; read by `memory-consolidation.ts` for nightly consolidation rules | [Settings → Memory](../settings/memory) |
| `TASKS.md` | `TASKS_TEMPLATE` in `memory.ts` | User; read on every background task start by `task-runner.ts` and injected as `<task_guidelines>` | [Web UI → Instructions](../web-ui/instructions) |

**Important — historical migrations** (handled in `ensureConfigStructure()`): `AGENTS.md` and `HEARTBEAT.md` used to live under `/data/memory/`; on first start they are moved to `/data/config/`. Do not write back to the legacy paths.

### `/data/memory/` — memory tiers

Resolved by `getMemoryDir()` in `packages/core/src/memory.ts`. Structure created by `ensureMemoryStructure()` (top-level) and `ensureSourcesDir()` (immutable layer). User-facing overview: [`concepts/memory`](../concepts/memory) and [Web UI → Memory](../web-ui/memory).

```text
/data/memory/
├── SOUL.md              ← personality (rarely edited)
├── MEMORY.md            ← long-term curated memory (in every prompt — keep short)
├── daily/
│   └── YYYY-MM-DD.md    ← session summaries, append-only
├── users/
│   └── <username>.md    ← per-user profile
├── wiki/                ← agent-maintained knowledge base (was projects/, auto-migrated)
│   └── *.md
└── sources/             ← immutable raw material the wiki cites
    ├── README.md        ← layout + filename + frontmatter conventions
    ├── articles/
    ├── youtube/
    ├── podcasts/
    ├── papers/
    └── notes/
```

| Path | Helper / generator | Mutability rule |
|---|---|---|
| `SOUL.md` | `SOUL_TEMPLATE` in `memory.ts` | User-owned. Agent should not rewrite without confirmation. |
| `MEMORY.md` | `MEMORY_TEMPLATE` in `memory.ts`; legacy `AGENTS.md` migrated here on first start | Agent writes via `edit_file` / `write_file` for durable lessons. Nightly consolidation may rewrite. |
| `daily/<date>.md` | `appendToDailyFile()` in `memory.ts` (called from `session-manager.ts:306`) | **Append-only.** Never edit existing daily files. |
| `users/<username>.md` | `ensureUserProfile()` / `readUserProfile()` in `memory.ts`, template `USER_PROFILE_TEMPLATE` | Agent updates per user. Do **not** duplicate language/timezone here — those live in `settings.json`. |
| `wiki/*.md` | `ensureWikiDir()` in `memory.ts`; managed by the `wiki` skill | Agent edits freely; cite source files in a `## Sources` / `## Quellen` section. |
| `sources/**/*.md` | `ensureSourcesDir()` in `memory.ts`; conventions in `SOURCES_README_TEMPLATE` | **Immutable.** Add new files only — never rewrite. Filename: `<yyyy-mm-dd>-<slug>.md`. |

The SQLite `memories` table (atomic facts the agent searches on demand) is **not** in this directory — it lives in `/data/db/axiom.db`.

### `/data/skills/` — user-installed skills

Resolved by `getSkillsDir()` in `packages/core/src/skill-installer.ts`.

```text
/data/skills/<owner>/<name>/
└── SKILL.md   (+ helper files)
```

Layout mirrors GitHub `owner/repo`. Tracked in `/data/config/skills.json` (enabled flag + per-skill env). Installed via the [Web UI → Skills](../web-ui/skills) page.

### `/data/skills_agent/` — built-in + agent-created skills

Resolved by `getAgentSkillsDir()` in `packages/core/src/agent-skills.ts`.

```text
/data/skills_agent/<name>/
└── SKILL.md
```

Two flavors share this directory and are indistinguishable at runtime:

- **Built-in** — seeded from `/app/skills_agent_defaults/` on container start by `entrypoint.sh`. Auto-updated when the shipped `version` (semver in frontmatter) is newer, unless the skill has `managed: false`. See `agent_docs/skill-versioning.md`.
- **Agent-created** — written by the agent at runtime when it spots a reusable workflow. Persistent.

Concept overview: [`concepts/skills`](../concepts/skills).

### `/data/uploads/` — user uploads

Resolved by `getUploadsDir()` in `packages/core/src/uploads.ts`. Contains files the user attached in chat (web or Telegram). Cleaned on a schedule per `settings.uploads.retentionDays` (default 30). See [Settings → Memory](../settings/memory) for retention controls (it's grouped there).

### `/data/npm-global/`

npm global prefix configured in the image so `npm install -g …` survives container upgrades. Not touched by application code.

## `/workspace/` — agent home

Resolved by `getWorkspaceDir()` in `packages/core/src/workspace.ts`. This is the agent's home directory and the cwd for `shell` invocations. Anything written via `write_file` / `edit_file` outside of `/data/...` lands here.

Resolution order:
1. `WORKSPACE_DIR` env var (explicit override)
2. `<DATA_DIR>/workspace` (auto-created if missing)
3. `/workspace` (Docker default)

`send_file_tool` and `stt_tool` resolve relative paths against this directory.

## `/app/` — read-only image

Source tree shipped in the Docker image. Mostly relevant when surfacing docs into the prompt or when the agent reads its own source for self-reflection. **Read-only at runtime** — never write here.

| Path | Helper | Purpose |
|---|---|---|
| `/app/` | `getProjectRootDir()` (`config.ts`) | Monorepo root inside the image (also resolved correctly in dev via workspaces walk-up). |
| `/app/README.md` | `getReadmePath()` | Main project README. Surfaced to the agent in `<axiom_docs>`. |
| `/app/docs/` | `getDocsPath()` | User-facing documentation (this site). Surfaced to the agent in `<axiom_docs>`. Authoritative for runtime behavior. |
| `/app/agent_docs/` | `getAgentDocsPath()` | Contributor / internals docs (architecture conventions, session-id design, skill versioning). **Not** surfaced in the runtime prompt. |
| `/app/skills_agent_defaults/` | _(no helper — only used in `entrypoint.sh`)_ | Source of truth for built-in skills. Copied into `/data/skills_agent/` on container start. |

## On the host

The two named volumes live wherever Docker keeps them — usually:

```text
/var/lib/docker/volumes/axiom-data/_data/
/var/lib/docker/volumes/axiom-workspace/_data/
```

Browse them as your host user via `sudo` or a temporary bind-mount. Backup recipes: snapshot `/data` while the container is paused.

## Quick lookup: "where is X stored?"

| Question | Answer |
|---|---|
| Where do I read/write user preferences? | `/data/memory/users/<username>.md` — **not** `MEMORY.md`, **not** `settings.json`. |
| Where do I store a learned, durable lesson? | `/data/memory/MEMORY.md` (curated, short). |
| Where do I append today's session notes? | `/data/memory/daily/<date>.md` via `appendToDailyFile()`. |
| Where do I add a new wiki page? | `/data/memory/wiki/<slug>.md` (load the `wiki` skill for conventions). |
| Where do I archive a captured article / transcript? | `/data/memory/sources/articles/<yyyy-mm-dd>-<slug>.md` (or `youtube/`, `podcasts/`, `papers/`, `notes/`). Immutable. |
| Where are LLM provider configs? | `/data/config/providers.json` (managed via [Web UI → Providers](../web-ui/providers)). |
| Where are global settings? | `/data/config/settings.json` (schema in [`reference/settings`](./settings)). |
| Where is the agent contract / behavior rules? | `/data/config/AGENTS.md` (edited via [Web UI → Instructions](../web-ui/instructions)). |
| Where do heartbeat tasks live? | `/data/config/HEARTBEAT.md`. |
| Where do nightly consolidation rules live? | `/data/config/CONSOLIDATION.md`. |
| Where do background task guidelines live? | `/data/config/TASKS.md` (injected into every background task system prompt). |
| Where are encrypted secrets (API keys, OAuth)? | `/data/config/secrets.json` (AES-256-GCM with `ENCRYPTION_KEY`). |
| Where are user-installed skills? | `/data/skills/<owner>/<name>/SKILL.md`. |
| Where are built-in / agent-created skills? | `/data/skills_agent/<name>/SKILL.md`. |
| Where do uploaded chat files land? | `/data/uploads/`. |
| Where should I put a free-form scratch file? | `/workspace/` (this is your home). |
