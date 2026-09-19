<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img src="docs/assets/logo-dark.svg" alt="Offtangent" width="160" height="160">
  </picture>
</p>

<h1 align="center">Offtangent</h1>

<p align="center"><strong>Talk first, the system sorts.</strong></p>

Offtangent is a self-hosted agent backend for people whose thoughts do not arrive in order. Linear chat asks you to know which thread a thought belongs to before you say it. Offtangent turns that around: every input is a **Capture**, accepted without a destination. A small model, the **Router**, proposes where it belongs, either appending it to an existing **Strand** (a thread of thought that lives over time) or opening a new one. Filing is visible and reversible with one tap, and a capture is never lost, even when nothing fits. Several parallel strands are the normal case, and the system keeps them, not your head.

The full product contract (`docs/offtangent/SPEC.md`) is still being merged into `main` chapter by chapter and is not part of the published tree yet. Until it lands, [`docs/`](docs/) is the authoritative description of what the code does.

**New here?** [What it is for](docs/guide/use-cases.md) · [Models and providers](docs/guide/models.md) · [Android companion app](docs/guide/companion-app.md) · [Quickstart](#quickstart)

## Origin

Offtangent is a fork of [Axiom](https://github.com/meteyou/axiom) by Stefan Dej (meteyou), a self-hosted, file-first agent that was itself inspired by [pi.dev](https://pi.dev). The TypeScript core, the persona and memory model, the web UI, the Telegram bridge and most of the tooling come from there. Thank you for building it and for releasing it under MIT.

This repository is developed independently. Divergence from upstream is intended: the data model moves from "one linear session per persona" to captures, strands and a router, and the API grows with the native Android app (Offtangent Companion, a separate repository). Upstream changes are cherry-picked when they fit, not merged wholesale.

## What you can use it for

Offtangent is built for one person with several parallel, half-finished threads — not for a team and not for a linear chat log. Concretely:

- **Capture a thought while moving.** Speak it into the Android app, have it transcribed on your own server, and find it later in the strand it belongs to instead of in a scrollback you would have to search.
- **Several working roles on one instance.** A reviewing persona, a support persona, a research persona — each with its own SOUL, memory, skills and, if you want, its own model.
- **Recurring work as a cronjob.** A morning digest, a weekly feed check, a nightly memory consolidation.
- **Longer research as a background task.** `create_task` hands twenty tool calls and fifteen minutes to an isolated agent with its own budget and model, and reports back when it is done.
- **Knowledge that grows over weeks.** Old turns are compressed into digests that keep their message id, so the agent can reload the original with `recall_message` instead of having lost it.

It is explicitly **not** a team chat, not a ticket system, not multi-tenant SaaS and not an IDE replacement. The long version, including the boundaries: [`docs/guide/use-cases.md`](docs/guide/use-cases.md).

## Models and providers

Offtangent ships no model of its own. You connect an inference endpoint, and the keys stay on your instance, encrypted at rest. The code knows 16 API-key provider types plus three OAuth subscription paths, among them:

- **API key:** OpenAI, Anthropic, Google Gemini, Mistral, DeepSeek, xAI (Grok), Kimi / Moonshot, MiniMax, z.ai, OpenRouter, OpenCode Zen.
- **Subscription instead of API credit:** Anthropic Claude Pro/Max, ChatGPT Plus/Pro (Codex) and GitHub Copilot over OAuth, plus the flat-fee plans of Kimi Coding, z.ai GLM Coding and OpenCode Go. Remaining subscription quota is shown per provider in the UI.
- **Local and custom:** Ollama (with its own timeouts and an optional slim system prompt for slow hardware) and any OpenAI-compatible endpoint — LM Studio, vLLM, NVIDIA NIM, a gateway of your own.

One requirement is hard: **the model must support tool calling.** The agent loop is model → tool call → result → repeat; a model without function-calling support will describe what it would do and do nothing. Small helper models can take over the cheap roles (router decision, fact extraction, summaries, background tasks) while a larger one drives the agent.

Details, the full provider table and an honest account of what is well trodden versus merely implemented: [`docs/guide/models.md`](docs/guide/models.md).

## Companion app (Android)

A native Android client exists: captures on the move, voice recording with transcription on your own server, push doorbells, a tray for unsorted captures, and reading and answering strands. It runs against the same REST and WebSocket API as the web UI, so pointing it at your instance is a server URL plus a login.

The app's source is **not** public and it is in no app store; a build is provided on request — open an issue here to ask. Setup requirements and the API it uses: [`docs/guide/companion-app.md`](docs/guide/companion-app.md).

## What is inside

| Area | Where | Notes |
| --- | --- | --- |
| Personas | `packages/core`, `/data/agents/<id>/` | Several agents with their own SOUL, memory and skills on one instance. Every message and task carries an `agentId`. |
| Threads | `packages/web-backend/src/routes/threads.ts` | Named, parallel conversations per persona. `/api/threads` for list, create, rename, pin, archive, delete. `sessionId` on every WebSocket frame. The precursor of strands. |
| Projects | `packages/web-backend/src/routes/projects.ts` | Lightweight, persona-spanning grouping of threads. |
| Memory | `packages/core/src/memory*.ts`, `message-digest.ts`, `session-summary-*.ts`, `strand-context.ts` | Markdown files (SOUL, MEMORY, daily notes, wiki) plus a fact store with provenance. Older turns are compressed into digests that keep their message id, so the model can reload the original with `recall_message` instead of losing it. |
| Tasks and delegation | `packages/core/src/task-*.ts`, `delegation-context.ts` | Background tasks, cronjobs, heartbeat. `create_task` accepts an `output_schema` and a `context_mode` (clean, selected, fork) so a delegated task starts with a chosen slice of context, not the whole strand. |
| Heuristics | `settings.json` → `heuristics.*` | Every numeric threshold (topic shift, fact extraction, summary windows) is configuration. `scripts/heuristics-regression.mjs` runs them against a corpus of real strands before a default may change. |
| Auth | `packages/web-backend/src/routes/auth.ts` | JWT access tokens plus rotating refresh tokens with replay detection, `GET/DELETE /api/auth/sessions` for device management. |
| Interfaces | `packages/web-frontend` (Nuxt 4, Vue 3), `packages/telegram` | Web UI and Telegram bot. The Android app talks to the same REST and WebSocket API. |

Reference pages for the API and the configuration files are under [`docs/reference/`](docs/reference/), in particular [`threads-api.md`](docs/reference/threads-api.md), [`projects-api.md`](docs/reference/projects-api.md), [`auth-api.md`](docs/reference/auth-api.md) and [`settings.md`](docs/reference/settings.md).

## Quickstart

The image is built from this repository. The stack is meant to run behind a reverse proxy and, in the reference setup, is deployed through Komodo from `docker-compose.yml`.

```bash
git clone https://github.com/Kruppes/offtangent.git offtangent
cd offtangent
cp .env.example .env
```

Set the required values in `.env`:

```env
ADMIN_PASSWORD=choose-a-strong-password
JWT_SECRET=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -hex 32>   # encrypts provider keys at rest, back this up
HOST_PORT=3000                          # optional, default 3000
```

Then:

```bash
docker compose up -d --build
```

Log in as `admin`, add an LLM provider under **Settings → Providers**, and start with a first thread. Everything the instance needs lives in the `/data` volume: `config/settings.json` (all non-secret settings, hot-reloaded), `config/providers.json` and `config/secrets.json` (encrypted with `ENCRYPTION_KEY`), the SQLite database, and one directory per persona under `agents/`.

`docker-compose.override.yml` holds site-specific mounts for the reference deployment and can be deleted elsewhere.

Other ways to run it — Docker on macOS (Docker Desktop, OrbStack, Colima), a native start without Docker, reverse proxy and backups — are collected in [`docs/guide/deployment.md`](docs/guide/deployment.md).

## Development

Node.js 22 and npm.

```bash
npm install
npm run build
npm run dev          # backend on 3000, frontend dev server on 3001
```

| Script | What it does |
| --- | --- |
| `npm test` | vitest across all packages |
| `npm run lint` | ESLint |
| `npm run baseline:parity` | architecture guardrails and critical-flow tests |
| `npm run docs:dev` | VitePress docs site on port 5173 |

Read [`AGENTS.md`](AGENTS.md) before changing anything; it is the working contract for humans and coding agents alike. Package boundaries and layering rules are in [`agent_docs/architecture-conventions.md`](agent_docs/architecture-conventions.md).

## Documentation

- [`docs/`](docs/) is the user-facing documentation and is also shipped into the image, so the running agent can answer questions about its own configuration from the same pages. The pages were inherited from Axiom and now describe Offtangent; where an identifier still reads `axiom` (the `@axiom/core` package, `AXIOM_*` variables, the `axiom-data` volume, the `<axiom_docs>` prompt block) that is the name the running code uses, not a leftover in the prose.
- [`docs/offtangent/`](docs/offtangent/) (branch `feat/offtangent-spec`) holds the product spec, the gap analysis against the current code, the model policy and the transport ADRs.
- [`agent_docs/`](agent_docs/) is for contributors: architecture, session id design, skill versioning.

## License

MIT, see [LICENSE](LICENSE). The upstream copyright of Axiom is retained there.
