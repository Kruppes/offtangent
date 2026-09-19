# Environment Variables

Reference for every environment variable Offtangent reads. Set these in `.env`, your Compose file, or your container orchestrator. They are evaluated **once at startup** — restart the container to apply changes.

For credentials that are added at runtime via the web UI (provider API keys, Brave Search key, etc.), see [Configuration → Secrets](../guide/configuration#secrets-data-config-secrets-json) instead.

## Required

These three must be set for any non-development deployment.

| Variable | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | _(none — required)_ | Login password for the web UI admin user. The Compose file enforces this with `${ADMIN_PASSWORD:?ADMIN_PASSWORD must be set}`. |
| `JWT_SECRET` | `axiom-dev-secret-change-me` (dev fallback) | HMAC secret used to sign JWT session tokens. **Change this in production.** Generate with `openssl rand -hex 32`. |
| `ENCRYPTION_KEY` | _(insecure dev key)_ | AES-256-GCM key used to encrypt `/data/config/secrets.json`. Accepts either a 64-char hex string (used as-is) or any other string (used to derive a key via `scrypt`). **If you change or lose it, all stored API keys become unrecoverable.** Generate with `openssl rand -hex 32`. |

## Networking

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface the backend binds to. Inside Docker, leave at `0.0.0.0`. |
| `PORT` | `3000` | Port the backend listens on inside the container. |
| `HOST_PORT` | `3000` | (Compose-only) Host-side port mapped to the container's `3000`. Set this if `3000` is already taken on the host. |

## Storage

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `/data` | Root directory for the database, config, memory, and skills. The Compose file maps the `axiom-data` volume here. |
| `WORKSPACE_DIR` | `/workspace` | Agent's home / working directory. The Compose file maps the `axiom-workspace` volume here. If unset, falls back to `<DATA_DIR>/workspace` then to `/workspace`. |

## Uploads / attachments

Any file type may be attached — there is no MIME whitelist. What is capped is only what protects the host. Uploads stream to `<DATA_DIR>/uploads/.tmp` and are moved into `<DATA_DIR>/uploads/YYYY/MM/DD` under a generated name; nothing is buffered in memory.

| Variable | Default | Description |
|---|---|---|
| `UPLOAD_MAX_FILE_SIZE_MB` | `500` | Maximum size of a single attachment. Over the limit the request is answered with `413`. Hard ceiling: `4096`. |
| `UPLOAD_MAX_FILES` | `20` | Maximum number of attachments per message (uploaded + already-stored combined). Over the limit: `400`. Hard ceiling: `100`. |
| `UPLOAD_MIN_FREE_DISK_MB` | `2048` | Free space that must remain on the uploads volume after the request. Below it the upload is refused with `507` instead of half-writing a file onto a full disk. |
| `AGENT_MAX_INLINE_IMAGE_MB` | `8` | Largest image handed to the model as image content. Bigger images are referenced by path instead. |
| `AGENT_MAX_INLINE_TEXT_MB` | `0.0625` (64 KB) | Amount of a text attachment inlined into the turn. The rest is truncated; the full file stays on disk and is referenced by path. |

## Optional features

| Variable | Default | Description |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Login username for the admin user. Rarely changed. |
| `TZ` | _(unset; container UTC)_ | Linux timezone for cron evaluation, daily-memory file naming, and log timestamps. The default Compose file sets `Europe/Vienna` — override per deployment. |
| `NODE_ENV` | _(unset)_ | Set to `production` in the default Compose file. Controls Nuxt/Express behavior; rarely needs changing. |
| `FRONTEND_DIR` | _(auto-detected)_ | Override the path where the backend looks for the built Nuxt frontend. Only useful for custom builds where `web-frontend/dist` isn't where the backend expects it. |
| `FCM_SERVICE_ACCOUNT_FILE` | `/data/secrets/firebase/service-account.json` | Firebase service account JSON used to send push doorbells to the companion app ([Push API](./push-api)). The path is read inside the container; the file belongs on the data volume or in a bind mount, never in the image or the repository. Unreadable or missing means push is off, nothing else changes, and the sender says so once at startup. |
| `PUSH_PREVIEW_CHARS` | `0` | Characters of the answer a `turn_done` doorbell may carry ([Push API](./push-api)). `0` keeps the ADR default: no message content on the wire, the app fetches the line through the tunnel. A positive value (capped at 300) adds a `preview` field and replaces the persona label with the strand title, both of which then pass through Google's servers. Task results, questions and failed turns never carry an excerpt. |
| `PUSH_SUPPRESS_WHEN_CLIENT_ONLINE` | `off` | Whether an open `/ws/chat` connection of the same user suppresses a doorbell. `off` always sends and leaves the decision to the app, which already stays silent while the strand is on screen. `turn` drops only `turn_done`, so an answer the user is watching in the web UI does not buzz the phone, while task results, questions and errors still ring. `all` drops every kind while a client is connected. An unrecognised value means `off`: a missing doorbell is invisible, a redundant one is only noisy. |
| `ARTIFACT_FRAME_ANCESTORS` | `'self'` | CSP `frame-ancestors` for canvas artifact content ([Artifacts API](./artifacts-api)). Space-separated origin list; set it when the web app runs on a different origin than the API. |
| `ARTIFACT_ORIGIN` | _(unset)_ | Absolute origin prefixed onto the artifact `contentUrl`. Set it when artifacts are served from a dedicated host, which adds a real cross-origin boundary on top of the opaque origin the CSP already enforces. |
| `ARTIFACT_TOKEN_SECRET` | _(falls back to `JWT_SECRET`)_ | Signing key for the short-lived artifact content capability tokens. Domain-separated from the JWT key, so an artifact token never verifies as an access token. |
| `GITHUB_TOKEN` | _(unset)_ | When set, used as `Authorization: token <value>` for skill downloads from GitHub (avoids unauthenticated rate limits when installing many skills from public repos). |
| `AXIOM_TURN_CONCURRENCY` | `3` | How many agent turns may run at the same time across all personas. Queues are per persona (2026-09-19), so this is the only global cap left; values below 1 or non-numeric fall back to the default. |
| `AXIOM_QUEUE_TURN_MAX_MS` | `1800000` (30 min) | Idle window of the queue watchdog: a turn that produces NO output for this long is abandoned and its queue slot (and concurrency slot) is released. Not a total-runtime cap. |
| `AXIOM_PROJECT_DIR` | _(auto-detected)_ | Overrides the resolved repo root for `getDocsPath()`/`getReadmePath()`/`getAgentDocsPath()`. Only needed for unusual deployments where source files don't live next to the running code (e.g. read-only image overlays). |

## Compose-file convention

The default `docker-compose.yml` reads environment variables from `.env` in the **current working directory** (where you run `docker compose up`). The pattern looks like:

```yaml
environment:
  - ADMIN_PASSWORD=${ADMIN_PASSWORD:?ADMIN_PASSWORD must be set}
  - JWT_SECRET=${JWT_SECRET:?JWT_SECRET must be set}
  - ENCRYPTION_KEY=${ENCRYPTION_KEY:-}
```

- `${VAR:?message}` — required; Compose refuses to start if missing.
- `${VAR:-default}` — optional with a default (empty string in the example for `ENCRYPTION_KEY`, which means "fall back to the insecure dev key" — fine for trying things out, **not for production**).

## Example `.env`

```bash
# --- Required ---
ADMIN_PASSWORD=$(openssl rand -base64 24)
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# --- Networking ---
HOST_PORT=3000

# --- Optional ---
TZ=Europe/Vienna
ADMIN_USERNAME=admin
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

> The `$(openssl rand …)` syntax is shown for clarity — `.env` files are **not** evaluated by a shell. Run the commands first and paste the literal values into the file.
