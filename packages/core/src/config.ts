import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve the default timezone for new installs and runtime fallbacks.
 *
 * Seeds from the `TZ` environment variable (e.g. Docker
 * `environment: - TZ=Europe/Vienna`) so the agent, memory and heartbeat
 * scheduling inherit the deployment timezone out of the box. Falls back to
 * `UTC` when `TZ` is unset or not a valid IANA zone. The in-app
 * `Settings → Agent → timezone` always overrides this.
 */
export function getDefaultTimezone(): string {
  const tz = process.env.TZ?.trim()
  if (!tz) return 'UTC'
  try {
    // Throws RangeError for invalid IANA zone identifiers.
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

const TEMPLATES: Record<string, object> = {
  'providers.json': {
    providers: [],
    _comment: 'Add LLM provider configurations here. Each provider needs: name, type, baseUrl, apiKey, enabledModels',
  },
  'settings.json': {
    sessionTimeoutMinutes: 30,
    sessionSummaryProviderId: '',
    language: 'en',
    timezone: getDefaultTimezone(),
    thinkingLevel: 'off',
    heartbeat: {
      intervalMinutes: 5,
      fallbackTrigger: 'down',
      failuresBeforeFallback: 1,
      recoveryCheckIntervalMinutes: 1,
      successesBeforeRecovery: 3,
      notifications: {
        healthyToDegraded: false,
        degradedToHealthy: false,
        degradedToDown: true,
        healthyToDown: true,
        downToFallback: true,
        fallbackToHealthy: true,
      },
    },
    uploads: {
      retentionDays: 30,
    },
    watchdog: {
      stallWarnMs: 30000,
      stallAbortMs: 90000,
    },
    retry: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
    },
    tokenPriceTable: {
      'gpt-4o': { input: 2.5, output: 10 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
      'claude-sonnet-4-20250514': { input: 3, output: 15 }
    },
    memoryConsolidation: {
      enabled: true,
      runAtHour: 3,
      lookbackDays: 3,
      providerId: '',
    },
    factExtraction: {
      enabled: true,
      providerId: '',
      minSessionMessages: 3,
    },
    projectAssignment: {
      enabled: true,
    },
    agentHeartbeat: {
      enabled: false,
      intervalMinutes: 60,
      nightMode: {
        enabled: true,
        startHour: 23,
        endHour: 8,
      },
    },
    builtinTools: {
      webSearch: {
        enabled: true,
        provider: 'duckduckgo',
        braveSearchApiKey: '',
        searxngUrl: '',
        tavilyApiKey: '',
      },
      webFetch: { enabled: true },
    },
    tasks: {
      defaultProvider: '',
      maxDurationMinutes: 60,
      telegramDelivery: 'auto',
      loopDetection: {
        enabled: true,
        method: 'systematic',
        maxConsecutiveFailures: 3,
        smartProvider: '',
        smartCheckInterval: 5,
      },
      statusUpdates: {
        enabled: false,
        intervalMinutes: 10,
      },
      backgroundThinkingLevel: 'off',
    },
  },
  'skills.json': {
    skills: [],
  },
  'telegram.json': {
    enabled: false,
    botToken: '',
    adminUserIds: [],
    pollingMode: true,
    webhookUrl: '',
    batchingDelayMs: 2500,
    sendVoiceReply: false,
    sendStallWarnings: false,
  },
}

export function getConfigDir(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'config')
}

// =============================================================================
// Project asset paths (shipped with the source tree / Docker image)
//
// In Docker: WORKDIR /app + `COPY . .` → README.md / docs/ / agent_docs/ live
//   under /app/.
// In dev (tsx, tests): we walk up from this file's directory until we find a
//   package.json that declares `workspaces` — that's the monorepo root.
// Override via env var AXIOM_PROJECT_DIR for unusual deployments.
// =============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let _cachedProjectRoot: string | undefined

/**
 * Resolve the Axiom monorepo root directory.
 *
 * Resolution order:
 *   1. `process.env.AXIOM_PROJECT_DIR` (with `~` / `~/` expansion)
 *   2. Walk up from this module's directory looking for a `package.json`
 *      that has a `workspaces` field (the monorepo root)
 *   3. Fall back to `process.cwd()` (last resort, dev shells)
 *
 * Result is cached for the process lifetime.
 */
export function getProjectRootDir(): string {
  if (_cachedProjectRoot) return _cachedProjectRoot

  const envDir = process.env.AXIOM_PROJECT_DIR
  if (envDir) {
    let resolved = envDir
    if (envDir === '~') resolved = process.env.HOME ?? envDir
    else if (envDir.startsWith('~/')) resolved = path.join(process.env.HOME ?? '', envDir.slice(2))
    _cachedProjectRoot = resolved
    return resolved
  }

  let dir = __dirname
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { workspaces?: unknown }
        if (pkg.workspaces) {
          _cachedProjectRoot = dir
          return dir
        }
      } catch {
        // ignore unreadable / invalid package.json and keep walking up
      }
    }
    dir = path.dirname(dir)
  }

  _cachedProjectRoot = process.cwd()
  return _cachedProjectRoot
}

/** Absolute path to the repo's main README.md. */
export function getReadmePath(): string {
  return path.join(getProjectRootDir(), 'README.md')
}

/** Absolute path to the user-facing `docs/` directory (VitePress source). */
export function getDocsPath(): string {
  return path.join(getProjectRootDir(), 'docs')
}

/** Absolute path to the contributor-facing `agent_docs/` directory. */
export function getAgentDocsPath(): string {
  return path.join(getProjectRootDir(), 'agent_docs')
}

export function loadConfig<T = unknown>(filename: string): T {
  const configDir = getConfigDir()
  const filePath = path.join(configDir, filename)

  if (!fs.existsSync(filePath)) {
    ensureConfigTemplates(configDir)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as T
}

export interface MultiPersonaSettings {
  enabled: boolean
  defaultAgentId: string
  /**
   * Per-persona memory roots (RC5, multi-persona bleeding 2026-07-24).
   * When true (default) and multi-persona is enabled, each non-main persona
   * gets its own memory root under /data/agents/<id>/memory/ (own MEMORY.md,
   * daily/, users/, wiki/) instead of sharing the global /data/memory/.
   * Only effective when `enabled` is true, so upstream single-agent installs
   * are unaffected.
   */
  scopedMemory: boolean
  /**
   * Per-persona default provider/model (C4, per-agent model selection).
   * Maps an agent/persona id to a `providerId` or `providerId:modelId` string
   * (the same format `tasks.defaultProvider` and `create_task` accept). When a
   * task attributed to persona <id> is created WITHOUT an explicit model, this
   * is consulted before the global task default — so main/warren/gekko/bob can
   * each run on their own model. Absent id = fall through to the global chain.
   */
  perAgentProvider?: Record<string, string>
}

/**
 * Load multi-persona settings from settings.json.
 * Returns safe defaults (disabled) if not configured.
 */
export function loadMultiPersonaSettings(): MultiPersonaSettings {
  try {
    const settings = loadConfig<{ multiPersona?: Partial<MultiPersonaSettings> }>('settings.json')
    return {
      enabled: settings.multiPersona?.enabled ?? false,
      defaultAgentId: settings.multiPersona?.defaultAgentId ?? 'main',
      scopedMemory: settings.multiPersona?.scopedMemory ?? true,
      perAgentProvider: settings.multiPersona?.perAgentProvider ?? undefined,
    }
  } catch {
    return { enabled: false, defaultAgentId: 'main', scopedMemory: true }
  }
}

const reportedConfigFailures = new Set<string>()

/**
 * Report a config file that could not be read or parsed, for callers that fall
 * back to defaults instead of failing the operation. Deduplicated per process:
 * these run per turn, and a corrupt `settings.json` must be visible in the log
 * without flooding it.
 */
export function warnConfigReadFailed(filename: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  const key = `${filename}:${message}`
  if (reportedConfigFailures.has(key)) return
  reportedConfigFailures.add(key)
  console.warn(`[config] Failed to read ${filename}, using defaults: ${message}`)
}

export function ensureConfigTemplates(configDir?: string): void {
  const dir = configDir ?? getConfigDir()

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  for (const [filename, template] of Object.entries(TEMPLATES)) {
    const filePath = path.join(dir, filename)
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(template, null, 2) + '\n', 'utf-8')
    }
  }
}
