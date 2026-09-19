# Deployment

Offtangent is a self-hosted single-container application: one Node.js backend that serves the
API, the WebSockets and the prebuilt web frontend, plus a SQLite database on a persistent
volume. There is no published image and no hosted service — you run it on your own box.

This page lists the routes that actually work, with their trade-offs. If you only want to get
started, use the [Quickstart](./quickstart) and come back here when you decide where the thing
should live permanently.

| Route | Effort | Isolation | Recommended for |
|---|---|---|---|
| [Linux server + Docker Compose](#linux-server-with-docker-compose) | low | container (agent user, sudo, apt inside) | the reference deployment |
| [macOS + Docker Desktop / OrbStack / Colima](#macos-with-a-container-runtime) | low | container, same as Linux | a Mac Mini / Mac Studio used as a home server |
| [macOS without Docker](#macos-without-docker-native-node) | medium | none — runs as your user | a Mac where you cannot or will not run a container runtime |

## Linux server with Docker Compose

The reference path, and the one the repository is built around. Follow the
[Quickstart](./quickstart): clone the repo, put `ADMIN_PASSWORD`, `JWT_SECRET` and
`ENCRYPTION_KEY` into `.env`, then

```bash
docker compose up -d --build
```

The Compose file builds the image locally, publishes port 3000 and mounts two named volumes,
`axiom-data` → `/data` and `axiom-workspace` → `/workspace`. Those names are upstream
identifiers and are kept deliberately (see the note on naming in the repository README).

What the container gives you beyond "a running server":

- A dedicated non-root `agent` user with passwordless `sudo` **inside the container**, so the
  agent's shell tool can install packages without touching your host.
- `apt` package persistence: packages the agent installs are tracked and reinstalled after an
  image rebuild (`/data/agent-packages.txt`, plus a manual `/data/packages.txt`).
- First-run seeding of the built-in agent skills (`/data/skills_agent`) and the persona seed
  files (`/data/agents/<id>`), done by `entrypoint.sh`.
- `tini` as PID 1, so orphaned tool processes get reaped instead of piling up as zombies.

Restart-on-boot is handled by `restart: unless-stopped` plus a Docker daemon that starts with
the system — nothing else to configure.

## macOS with a container runtime

A Mac Mini or Mac Studio makes a good always-on home server, and the container route works the
same way there. Pick one runtime:

- **[Docker Desktop](https://docs.docker.com/desktop/install/mac-install/)** — the simplest
  option. Enable *Settings → General → Start Docker Desktop when you sign in* so the stack comes
  back after a reboot (the machine must actually log in — a Mac that sits at the login screen
  starts nothing).
- **[OrbStack](https://orbstack.dev/)** — lighter and faster on Apple Silicon, ships a
  `docker` CLI and starts at login by default.
- **[Colima](https://github.com/abiosoft/colima)** — CLI only, no GUI:
  ```bash
  brew install colima docker docker-compose
  colima start --cpu 4 --memory 8
  brew services start colima   # start the VM at boot
  ```

With any of the three, the commands from the [Quickstart](./quickstart) are unchanged:

```bash
docker compose up -d --build
docker compose logs -f axiom
```

Notes specific to macOS:

- Give the VM enough memory. The image build runs the full test suite; 8 GB is comfortable,
  4 GB is tight.
- Bind mounts into the VM are slower than named volumes. Stay with the named volumes from
  `docker-compose.yml`.
- Port 3000 is a popular port on developer Macs. If something else already owns it, set
  `HOST_PORT` in `.env` instead of editing the Compose file.

## macOS without Docker (native Node)

This works — it was verified end to end on macOS 26.3 / Apple Silicon with a fresh clone — but
you give up everything the container provides: the agent runs as **your** macOS user with your
permissions and your files. Only choose this if you accept that.

### Requirements

- **Node.js 22.x.** This is not advisory: `package.json` declares `"engines": { "node": "22.x" }`
  and `npm ci` aborts on a newer runtime with
  `npm error notsup Not compatible with your version of node/npm`. Homebrew's plain `node`
  formula is far ahead of 22, so install the pinned one:
  ```bash
  brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
  ```
  (`nvm`, `fnm` or a downloaded tarball work just as well.)
- **Xcode Command Line Tools** (`xcode-select --install`) for the native `better-sqlite3` module.

### Install and build

```bash
git clone https://github.com/Kruppes/offtangent.git offtangent
cd offtangent
npm ci
npm run build
```

`npm run build` compiles the three TypeScript packages and prerenders the Nuxt frontend into
`packages/web-frontend/.output/public`, which the backend then serves itself. No extra web
server is needed.

### Run

The container sets its environment through Compose; natively you set it yourself. `DATA_DIR`
and `WORKSPACE_DIR` are mandatory, because the defaults (`/data`, `/workspace`) are container
paths that do not exist on macOS.

```bash
mkdir -p "$HOME/offtangent/data" "$HOME/offtangent/workspace"

export DATA_DIR="$HOME/offtangent/data"
export WORKSPACE_DIR="$HOME/offtangent/workspace"
export PORT=3000
export HOST=127.0.0.1          # 0.0.0.0 only if you really want it on the LAN
export NODE_ENV=production
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD='choose-a-strong-password'
export JWT_SECRET="$(openssl rand -hex 32)"
export ENCRYPTION_KEY="$(openssl rand -hex 32)"

npm run start --workspace=packages/web-backend
```

Keep `JWT_SECRET` and `ENCRYPTION_KEY` stable across restarts — generate them once and store
them in a file you `source`, not inline. A new `ENCRYPTION_KEY` makes every stored provider
secret unreadable. See [Environment Variables](../reference/env-vars) for the full list.

On first start the server creates the database, the config templates, the memory structure and
the admin user, then logs the URL it listens on. Log in at `http://127.0.0.1:3000` with
`admin` and your `ADMIN_PASSWORD`.

### Seed the extras the entrypoint would have done

`entrypoint.sh` only runs inside the container, so two first-run steps are missing natively.
Both are plain file copies, done once, before or after the first start:

```bash
mkdir -p "$DATA_DIR/skills_agent" "$DATA_DIR/agents"
cp -R data/skills_agent/*  "$DATA_DIR/skills_agent/"   # built-in agent skills
cp -R agents-seed/*        "$DATA_DIR/agents/"         # persona seed files
```

Without the first copy the agent starts with no built-in skills; without the second, the seeded
personas do not appear on the Personas page. Nothing else in the entrypoint is required on
macOS — the ownership fixes, `gosu` and the apt logic are Linux-container concerns.

### Autostart with launchd

Create `~/Library/LaunchAgents/xyz.offtangent.server.plist`. A LaunchAgent runs after you log
in; if the Mac should serve without anyone logged in, use a LaunchDaemon in
`/Library/LaunchDaemons/` instead and set `UserName` explicitly.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>              <string>xyz.offtangent.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@22/bin/node</string>
    <string>/Users/you/offtangent/packages/web-backend/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key>   <string>/Users/you/offtangent</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATA_DIR</key>         <string>/Users/you/offtangent/data</string>
    <key>WORKSPACE_DIR</key>    <string>/Users/you/offtangent/workspace</string>
    <key>PORT</key>             <string>3000</string>
    <key>HOST</key>             <string>127.0.0.1</string>
    <key>NODE_ENV</key>         <string>production</string>
    <key>ADMIN_PASSWORD</key>   <string>choose-a-strong-password</string>
    <key>JWT_SECRET</key>       <string>...</string>
    <key>ENCRYPTION_KEY</key>   <string>...</string>
  </dict>
  <key>RunAtLoad</key>          <true/>
  <key>KeepAlive</key>          <true/>
  <key>StandardOutPath</key>    <string>/Users/you/offtangent/server.log</string>
  <key>StandardErrorPath</key>  <string>/Users/you/offtangent/server.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/xyz.offtangent.server.plist
launchctl list | grep offtangent
```

The plist stores secrets in plain text — `chmod 600` it, or load the values from a file the
program reads itself.

### Limitations you are signing up for

- **No isolation.** The shell tool runs as your macOS user. Everything you can read, delete or
  publish, the agent can too. In the container that blast radius stops at the volumes.
- **`sudo` / `apt` skills do not apply.** macOS has no `apt`, and the package tracking and
  restore logic in `entrypoint.sh` is Linux-only. Skills that install Debian packages have to be
  translated to `brew` by hand.
- **No package persistence.** Whatever the agent installs lives in your normal user
  environment, with no per-deployment record of it.
- **Updates are manual.** `git pull && npm ci && npm run build && <restart>`; there is no image
  rebuild that re-runs the test gate for you.
- **Optional side services are on you.** The commented-out `whisper` and `ollama` services in
  `docker-compose.yml` are Compose-only. Natively you install or point at them yourself and set
  the matching settings.
- **Node version drift.** Every runtime upgrade past 22.x breaks `npm ci` until the engines
  field is raised, and native modules must be rebuilt after a Node upgrade
  (`npm rebuild better-sqlite3`).

## Reverse proxy and TLS

The backend speaks plain HTTP and has no built-in TLS. Anything beyond `localhost` belongs
behind a reverse proxy that terminates TLS and forwards WebSockets — `/ws/chat`, `/ws/logs` and
`/ws/task/:id` are load-bearing, a proxy that drops `Upgrade` headers gives you a UI that loads
but never streams.

[Caddy](https://caddyserver.com/) is the shortest path, because it handles certificates by
itself and proxies WebSockets without extra configuration:

```text
agent.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

nginx, Traefik or Cloudflare Tunnel work equally well; with nginx remember
`proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`.

Bind the app itself to `127.0.0.1` when a proxy sits in front of it, so the unencrypted port is
not reachable from the network.

## Backups

Everything worth keeping is under one root:

- **Docker:** the `axiom-data` volume (mounted at `/data`).
- **Native:** whatever you set `DATA_DIR` to.

That directory holds the SQLite database (`db/axiom.db`), the config and the encrypted secrets
(`config/`), and all memory tiers (`memory/`). The `axiom-workspace` volume / `WORKSPACE_DIR`
holds the agent's scratch files — useful to keep, not critical. See
[File Paths](../reference/file-paths) for the full layout.

Stop the container (or the process) before copying, so SQLite is not mid-write:

```bash
# Docker
docker compose stop
docker run --rm -v axiom-data:/data -v "$PWD:/backup" ubuntu:24.04 \
  tar czf /backup/offtangent-data-$(date +%F).tar.gz -C /data .
docker compose start

# Native
tar czf "offtangent-data-$(date +%F).tar.gz" -C "$DATA_DIR" .
```

Store `ENCRYPTION_KEY` somewhere separate from the backup. Without it the provider secrets in
the archive are unreadable, and with it in the same place the encryption buys you nothing.
