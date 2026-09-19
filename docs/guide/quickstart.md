# Quickstart

Get your own Offtangent agent running with Docker. The image is built locally, so the first start takes a few minutes.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) (Docker Desktop on macOS/Windows already includes both). Running on a Mac, or without Docker at all? See [Deployment](./deployment) for the available routes.
- An LLM API key or OAuth (OpenAI, Anthropic, or many other provider). You can also point at a local [Ollama](https://ollama.com) instance.

## 1. Get the repository

Offtangent has no published image. The image is built from this repository, together with the `docker-compose.yml` that wires up the data volumes and the required environment variables.

```bash
git clone https://github.com/Kruppes/offtangent.git offtangent
cd offtangent
cp .env.example .env
```

## 2. Set the required secrets

Edit `.env` and set at least these three values:

```bash
ADMIN_PASSWORD=choose-a-strong-password
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
```

| Variable         | Purpose                                                                                                                                  |
|------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `ADMIN_PASSWORD` | Login password for the web UI (username defaults to `admin`).                                                                            |
| `JWT_SECRET`     | Signs session tokens. Anything random and long.                                                                                          |
| `ENCRYPTION_KEY` | Encrypts API keys and provider secrets at rest in `secrets.json`. **If you lose this, stored secrets become unrecoverable.** Back it up. |

For the full list of supported variables, see [Environment Variables](../reference/env-vars).

## 3. Start the container

```bash
docker compose up -d --build
```

The image is built on the first run (a few minutes) and the container starts. Check the logs:

```bash
docker compose logs -f axiom
```

You should see `[axiom] Starting server as agent user…` and shortly after, the server listening on port 3000.

## 4. Open the web UI

Visit [http://localhost:3000](http://localhost:3000) and log in with:

- **Username:** `admin`
- **Password:** the value of `ADMIN_PASSWORD` you set above

## 5. Add an LLM provider

In the web UI, go to **Providers** and add at least one provider. The minimum you need:

- A **name** (free-form, e.g. `OpenAI Pro`)
- A **type**, which could be a Subscription (OAuth) provider like `OpenAI Plus/Pro (Codes)` or `Anthropic`, or an API
  Key provider like Ollama or many OpenAI-compatible API
- The **API key** (encrypted with `ENCRYPTION_KEY` before being stored) or click the `Login & Connect` button if it's a
  subscription provider
- At least one **enabled model** (e.g. `GPT-5.4` or `Claude Opus 4.7`)
- Select the **default model** to use for this provider with clicking the 3-dot menu next to the model name and choosing
  "Set Active". You can also set a fallback provider/model here

For details on each provider type, see [Providers](../web-ui/providers).

## 6. Talk to the agent

Open the **Chat** page in the web UI and send your first message. The agent will use the provider you configured.


## Additional configuration and features

From here, explore:

- [Telegram Bot](./telegram) — Talk to your agent from your phone.
- [Agent Instructions](../concepts/instructions) — Customize the agent's behavior rules (`AGENTS.md`), heartbeat tasks, and consolidation rules.
- [Memory System](../concepts/memory) — Shape the agent's personality (`SOUL.md`) and what it remembers (`MEMORY.md`).

## Pinning a specific version

There is no image registry to pull a tag from: the version you run is the revision you have checked out. To pin one, check out that revision and rebuild.

```bash
git checkout <tag-or-commit>
docker compose up -d --build
```

The Compose file builds a local image named `${IMAGE_NAME:-offtangent}:local` and names the container `${CONTAINER_NAME:-offtangent}`. Both variables are read from `.env` if you set them there; without them the defaults apply.

## Updating

```bash
git pull
docker compose up -d --build
```

Your data is preserved in the `axiom-data` and `axiom-workspace` Docker volumes — see [File Paths](../reference/file-paths) for the layout.

## Troubleshooting

**`ADMIN_PASSWORD must be set`** — `.env` is missing or not loaded. Make sure you are in the directory containing both `.env` and `docker-compose.yml` when running `docker compose up`.

**Cannot reach `http://localhost:3000`** — Check `docker compose ps` to confirm the container is `Up (healthy)`. If you changed `HOST_PORT` in `.env`, use that port instead.

**LLM calls fail** — Verify your provider's API key in **Settings → Providers**. Failed keys show a red warning indicator.

**Encryption errors after upgrade** — If you regenerated `ENCRYPTION_KEY`, all previously stored secrets become undecryptable. Re-enter your provider API keys in the UI.
