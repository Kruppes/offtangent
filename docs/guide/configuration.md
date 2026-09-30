# Configuration

**Almost everything in Offtangent is configured through the web UI.** Open `http://localhost:3000`, log in as admin, and head to **Settings** — that's the supported, validated, hot-reloaded path for changing how the agent behaves.

You only need to touch files or environment variables in two situations:

1. **Bootstrap.** A handful of secrets must exist *before* the container starts (login password, JWT signing key, encryption key). These live in `.env` / Compose `environment:`.
2. **Recovery & power use.** Offtangent won't start, you locked yourself out, or you'd rather edit JSON over SSH. Every UI setting maps to a file under `/data/config/` that you can edit by hand.

## The three layers

| Layer                     | Where                                      | When you touch it                                                |
|---------------------------|--------------------------------------------|------------------------------------------------------------------|
| **Environment variables** | `.env` / Compose `environment:`            | Once, at install time. Restart the container to apply.           |
| **Web UI (Settings)**     | Settings page in the browser               | **The default path for everything else.** Hot-reloaded.          |
| **Config files (JSON/MD)** | `/data/config/*` inside the container     | Recovery, scripted setups, or if the UI can't reach the backend. |

Memory and per-user state live in a separate tree under `/data/memory/` — see [Memory System](../concepts/memory).

## 1. Environment variables (bootstrap only)

Set these in `.env` (read by `docker compose`) or directly in the Compose file. They are read **once at startup** — restart the container to apply changes.

```bash
ADMIN_PASSWORD=...        # web UI login password
JWT_SECRET=...            # signs session tokens
ENCRYPTION_KEY=...        # encrypts secrets.json at rest
```

Optional ones (`HOST_PORT`, `TZ`, `WORKSPACE_DIR`, `DATA_DIR`, `FRONTEND_DIR`, `GITHUB_TOKEN`, …) are documented in [Environment Variables](../reference/env-vars).

### Why `ENCRYPTION_KEY` matters

Provider API keys, Telegram bot tokens, and any other sensitive value you enter in the web UI are written to `/data/config/secrets.json` **encrypted with `ENCRYPTION_KEY`** (AES-256-GCM).

- If `ENCRYPTION_KEY` is **not set**, Offtangent falls back to a built-in default key. **Do not run a real deployment that way** — anyone with read access to the volume could decrypt your keys.
- If you **change** `ENCRYPTION_KEY`, all previously encrypted secrets become unreadable on next startup. They are silently skipped (logged as `Failed to decrypt secret …`) and you need to re-enter them in the UI.

Generate a strong key with:

```bash
openssl rand -hex 32
```

Back it up out-of-band (password manager, secret store) so you can restore the volume on a different host without losing your provider keys.

## 2. The web UI (the default path)

Once the container is running, open `http://localhost:3000`, log in as admin, and use the sidebar. Almost every knob in Offtangent has a dedicated panel:

| What you want to change                              | Go to                                                   |
|------------------------------------------------------|---------------------------------------------------------|
| Add an LLM provider, set the active model            | [Providers](../web-ui/providers)                        |
| API keys, bot tokens, any sensitive value            | [Settings → Secrets](../settings/secrets)               |
| Language, timezone, default model, reasoning level   | [Settings → Agent](../settings/agent)                   |
| Telegram bot token, allowed users, batching          | [Settings → Telegram](../settings/telegram)             |
| Session timeout, memory consolidation, fact extraction | [Settings → Memory](../settings/memory)               |
| Speech-to-text and text-to-speech providers          | [Settings → Speech-to-Text](../settings/speech-to-text) / [Text-to-Speech](../settings/text-to-speech) |
| Provider health checks and fallback                  | [Settings → Health Monitor](../settings/health-monitor) |
| Background task defaults, loop detection             | [Settings → Tasks](../settings/tasks)                   |
| Recurring agent self-tasks                           | [Settings → Agent Heartbeat](../settings/agent-heartbeat) |
| `AGENTS.md`, `HEARTBEAT.md`, `CONSOLIDATION.md`, `TASKS.md` | [Instructions](../web-ui/instructions)            |
| `SOUL.md`, `MEMORY.md`, daily notes, user profiles, wiki | [Memory](../web-ui/memory)                          |
| Cronjobs and scheduled reminders                     | [Cronjobs](../web-ui/cronjobs)                          |
| Add or remove user accounts                          | [Users](../web-ui/users)                                |
| Install or remove skills                             | [Skills](../web-ui/skills)                              |

Changes take effect **immediately** — no container restart, no reload. The `Save` button in the page header writes the change to `/data/config/...` and the backend re-reads it on the next agent turn.

For a tour of the whole interface, see [Web Interface](../web-ui/).

## 3. Direct file edits (recovery & power users)

For Linux / Docker veterans — and for the case where Offtangent won't start and the UI is unreachable — every UI setting maps to a plain file under `/data/config/` inside the container. Edit them with whatever you like:

```bash
docker compose exec axiom vi /data/config/settings.json
# or, with the volume mounted on the host:
sudo vi /var/lib/docker/volumes/axiom-data/_data/config/settings.json
```

The backend hot-reloads JSON config on file change, so a save is enough — no restart required for most settings.

### What's in `/data/config/`

The entrypoint creates these on first startup with safe defaults:

| File               | Contents                                                                                                                                                   | UI equivalent                                              |
|--------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------|
| `providers.json`   | LLM provider definitions, models, default model per provider                                                                                               | [Providers](../web-ui/providers)                           |
| `settings.json`    | All non-secret runtime settings (timezone, language, scheduler, batching, token-price tables, …). See [`settings.json` reference](../reference/settings).  | [Settings](../settings/) (every panel except Secrets)      |
| `secrets.json`     | Encrypted env vars (created on first secret-write). Do not edit by hand — values are AES-256-GCM encrypted with `ENCRYPTION_KEY`.                          | [Settings → Secrets](../settings/secrets)                  |
| `telegram.json`    | Telegram bot config: token, admin user IDs, polling vs. webhook                                                                                            | [Settings → Telegram](../settings/telegram)                |
| `skills.json`      | Installed skill registry (managed by the skills subsystem)                                                                                                 | [Skills](../web-ui/skills)                                 |
| `AGENTS.md`        | User-editable agent rules (loaded into every chat system prompt)                                                                                           | [Instructions](../web-ui/instructions)                     |
| `HEARTBEAT.md`     | Recurring agent self-check tasks                                                                                                                           | [Instructions](../web-ui/instructions)                     |
| `CONSOLIDATION.md` | Memory-consolidation rules                                                                                                                                 | [Instructions](../web-ui/instructions)                     |
| `TASKS.md`         | Background-task guidelines (injected into every `create_task` / cronjob `task` run)                                                                        | [Instructions](../web-ui/instructions)                     |

> ⚠️ **`secrets.json` is the exception.** It contains AES-256-GCM ciphertext keyed by `ENCRYPTION_KEY`. Always edit secrets through the UI — manual edits will not decrypt. If the UI is unreachable, you can stage values via `.env` / Compose `environment:` instead; runtime env vars take precedence.

### When you actually need to edit files

- **Offtangent won't start** because of a malformed setting. Edit the offending JSON file directly to fix or remove it, then bring the container back up.
- **You're scripting deployments** and want to seed `providers.json` / `AGENTS.md` from your repo or Ansible role.
- **You're locked out of the UI** (forgot `ADMIN_PASSWORD`). Reset it via `.env` and restart.
- **You prefer `vi`.** Fair enough — the files are documented, schema-stable, and hot-reloaded.

For everyday changes, use the UI. It validates your input, shows you what changed before you save, and won't let you write a JSON file that breaks on the next startup.

## Volumes

The Compose file mounts two named volumes:

| Volume | Container path | Purpose |
|---|---|---|
| `axiom-data` | `/data` | Database, config, memory, skills, npm cache. **Back this up.** |
| `axiom-workspace` | `/workspace` | The agent's home directory. Anything the agent writes via the `shell` tool, downloads with `wget`/`yt-dlp`, or saves via `write_file` outside `/data` ends up here. |

If you lose `axiom-data` you lose the database, all memory, all configured providers, and all installed skills. If you lose `axiom-workspace` you lose whatever the agent has been working on — but the agent itself can rebuild that.

For the full directory layout inside both volumes, see [File Paths](../reference/file-paths).

## Hot-reload behavior

| Change                                            | Takes effect                                                                                |
|---------------------------------------------------|---------------------------------------------------------------------------------------------|
| `.env` / Compose env vars                         | After `docker compose up -d` (container restart)                                            |
| Anything in **Settings → …** in the UI            | Immediately (no restart)                                                                    |
| Manual edit of `/data/config/*.json`              | Immediately for most settings; restart to be safe                                           |
| Editing `AGENTS.md` / `SOUL.md` / `MEMORY.md`     | Picked up on the **next** message (system prompt is rebuilt per turn)                       |
| Adding/removing skills                            | Immediately for new skills; the agent sees the updated `<available_skills>` list next turn  |

## Next steps

- Add an [LLM Provider](../web-ui/providers) to actually talk to a model.
- Customize the [Memory System](../concepts/memory) so the agent learns about you.
- Hook up the [Telegram bot](./telegram) for mobile access.
