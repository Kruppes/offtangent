import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import process from 'node:process'

const rootDir = process.cwd()

for (const file of ['.env', '.env.local']) {
  const filePath = path.join(rootDir, file)
  if (fs.existsSync(filePath)) {
    process.loadEnvFile(filePath)
  }
}

const resolvedDataDir = path.resolve(rootDir, process.env.DATA_DIR || '.data')
process.env.DATA_DIR = resolvedDataDir
process.env.PORT ||= '3000'
process.env.HOST ||= '0.0.0.0'
process.env.NUXT_PUBLIC_API_BASE ||= 'http://localhost:3000'
process.env.ADMIN_USERNAME ||= 'admin'
process.env.ADMIN_PASSWORD ||= 'admin'
process.env.JWT_SECRET ||= 'axiom-dev-secret-change-me'

fs.mkdirSync(resolvedDataDir, { recursive: true })

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// Self-healing guard: native modules (e.g. better-sqlite3) are compiled against a
// specific Node.js ABI (NODE_MODULE_VERSION). If they were installed under a different
// Node version than the one running dev, loading them throws ERR_DLOPEN_FAILED.
// Detect that up-front and rebuild automatically instead of crashing on first DB access.
//
// NOTE: better-sqlite3 loads its .node binary lazily on first `new Database()`, so just
// requiring the package is not enough to surface an ABI mismatch — we must instantiate it.
function ensureNativeModules() {
  const require = createRequire(import.meta.url)
  const probes = [
    { mod: 'better-sqlite3', exercise: (m) => new m(':memory:').close() },
  ]
  for (const { mod, exercise } of probes) {
    try {
      exercise(require(mod))
    } catch (err) {
      const abiMismatch =
        err?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(err?.message ?? '')
      if (!abiMismatch) continue
      console.log(
        `[axiom] '${mod}' was built for a different Node.js version (running ${process.version}). Rebuilding...`,
      )
      const res = spawnSync(npmCmd, ['rebuild', mod], {
        cwd: rootDir,
        env: process.env,
        stdio: 'inherit',
      })
      if (res.status !== 0) {
        console.error(`[axiom] Failed to rebuild '${mod}'. Run: npm rebuild ${mod}`)
        process.exit(res.status ?? 1)
      }
    }
  }
}

ensureNativeModules()

// Children are spawned detached (own process groups); if a previous dev run was
// killed hard (SIGKILL, terminal crash), orphans can survive and keep holding
// the ports — the next start then fails with confusing EADDRINUSE errors deep
// inside backend/Nuxt. Fail fast with an actionable message instead.
function checkPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', () => resolve(false))
    // Bind 0.0.0.0 like the real services do — a 127.0.0.1 probe misses
    // listeners bound to all interfaces.
    probe.listen({ port, host: '0.0.0.0' }, () => {
      probe.close(() => resolve(true))
    })
  })
}

const requiredPorts = [
  { port: Number(process.env.PORT), name: 'backend' },
  { port: 3001, name: 'frontend' },
]
for (const { port, name } of requiredPorts) {
  if (await checkPortFree(port)) continue
  console.error(`[axiom] Port ${port} (${name}) is already in use — probably a leftover dev process.`)
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`], { encoding: 'utf8' })
  if (lsof.stdout?.trim()) {
    console.error(lsof.stdout.trim())
    console.error(`[axiom] Kill it with: kill $(lsof -t -iTCP:${port})`)
  }
  process.exit(1)
}

console.log('[axiom] Starting local dev environment...')
console.log(`[axiom] DATA_DIR=${process.env.DATA_DIR}`)
console.log(`[axiom] Backend:  http://localhost:${process.env.PORT}`)
console.log('[axiom] Frontend: http://localhost:3001')

const baseOpts = {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
}

const backendSrc = path.join(rootDir, 'packages', 'web-backend', 'src')
const coreDist = path.join(rootDir, 'packages', 'core', 'dist')
const telegramDist = path.join(rootDir, 'packages', 'telegram', 'dist')

// Ensure dist directories exist before anything tries to watch them.
// node --watch --watch-path=<dir> crashes with ENOENT if the directory is missing
// (e.g. after `npm run clean` or a fresh checkout).
fs.mkdirSync(coreDist, { recursive: true })
fs.mkdirSync(telegramDist, { recursive: true })

// Initial build of core + telegram so the backend has something to import on first start.
// Subsequent changes are handled by tsc --watch below.
const distHasJs = (dir) => {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.js'))
  } catch {
    return false
  }
}

for (const pkg of ['packages/core', 'packages/telegram']) {
  const pkgDist = path.join(rootDir, pkg, 'dist')
  if (distHasJs(pkgDist)) continue

  // A stale .tsbuildinfo with an empty dist/ (e.g. after `npm run clean`) makes
  // tsc believe everything is up to date and emit nothing — the "build" then
  // succeeds but dist/ stays empty and the backend crashes on import.
  for (const entry of fs.readdirSync(path.join(rootDir, pkg))) {
    if (entry.endsWith('.tsbuildinfo')) {
      fs.rmSync(path.join(rootDir, pkg, entry), { force: true })
      console.log(`[axiom] Removed stale ${pkg}/${entry}`)
    }
  }

  console.log(`[axiom] Initial build: ${pkg}`)
  const res = spawnSync(npmCmd, ['run', 'build', `--workspace=${pkg}`], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    console.error(`[axiom] Initial build failed for ${pkg}`)
    process.exit(res.status ?? 1)
  }
  if (!distHasJs(pkgDist)) {
    console.error(`[axiom] Build of ${pkg} produced no JS in dist/. Try: npm run clean && npm run dev`)
    process.exit(1)
  }
}

console.log('[axiom] Core:     watching for changes (tsc --watch)')

const children = [
  // 1. Core: tsc --watch recompiles on source changes → outputs to dist/
  spawn(npmCmd, ['run', 'dev', '--workspace=packages/core'], { ...baseOpts, detached: true }),
  // 1b. Telegram: tsc --watch recompiles on source changes → outputs to dist/
  spawn(npmCmd, ['run', 'dev', '--workspace=packages/telegram'], { ...baseOpts, detached: true }),
  // 2. Backend: --watch restarts when backend src/ or core/telegram dist/ changes
  //    Not detached — node --watch manages its own child; we just need to kill this tree.
  spawn('node', [
    '--watch',
    `--watch-path=${backendSrc}`,
    `--watch-path=${coreDist}`,
    `--watch-path=${telegramDist}`,
    '--import', 'tsx',
    path.join(backendSrc, 'server.ts'),
  ], { ...baseOpts, detached: true }),
  // 3. Frontend: Nuxt dev server with HMR
  spawn(npmCmd, ['run', 'dev:frontend'], { ...baseOpts, detached: true }),
]

let shuttingDown = false
let exitCode = 0

function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[axiom] Shutting down dev environment...`)

  // Send signal to each process group
  for (const child of children) {
    try { process.kill(-child.pid, signal) } catch {}
  }

  // Force kill after timeout
  const forceTimer = setTimeout(() => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
    // Final fallback: exit ourselves
    setTimeout(() => process.exit(exitCode), 500).unref()
  }, 4000)
  forceTimer.unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal))
}

let exitedChildren = 0
for (const child of children) {
  child.on('exit', (code, signal) => {
    exitedChildren += 1

    if (signal || (code && code !== 0)) {
      exitCode = code ?? 1
    }

    if (!shuttingDown && exitedChildren < children.length) {
      shutdown('SIGTERM')
    }

    if (exitedChildren === children.length) {
      process.exit(exitCode)
    }
  })
}
