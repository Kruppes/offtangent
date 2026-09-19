import fs from 'node:fs'
import path from 'node:path'
import { loadMultiPersonaSettings } from './config.js'

/**
 * Loaded persona context for a specific agent.
 * Each file is optional — null means "use global fallback".
 */
export interface PersonaContext {
  agentId: string
  /** Content of IDENTITY.md (name, vibe, emoji) */
  identity: string | null
  /** Content of SOUL.md (personality/system prompt override) */
  soul: string | null
  /** Content of USER.md (per-agent user profile) */
  user: string | null
  /** Content of TOOLS.md (tool hints) */
  tools: string | null
  /** Content of MEMORY.md (agent-specific memory) */
  memory: string | null
  /** Content of AGENTS.md (agent rules override) */
  agents: string | null
  /** Content of HEARTBEAT.md (agent heartbeat tasks) */
  heartbeat: string | null
  /** Whether persona files were found on disk */
  hasPersonaDir: boolean
}

/** Cache entry with mtime tracking */
interface CacheEntry {
  context: PersonaContext
  mtimes: Map<string, number>
  loadedAt: number
}

const PERSONA_FILES = [
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'AGENTS.md',
  'HEARTBEAT.md',
] as const

type PersonaFile = typeof PERSONA_FILES[number]

const FILE_TO_KEY: Record<PersonaFile, keyof PersonaContext> = {
  'IDENTITY.md': 'identity',
  'SOUL.md': 'soul',
  'USER.md': 'user',
  'TOOLS.md': 'tools',
  'MEMORY.md': 'memory',
  'AGENTS.md': 'agents',
  'HEARTBEAT.md': 'heartbeat',
}

/** In-process cache, invalidated on mtime changes */
const cache = new Map<string, CacheEntry>()

/** Maximum age of cache entry before re-checking mtimes (10 seconds) */
const CACHE_MAX_AGE_MS = 10_000

/**
 * Get the base directory for persona files.
 * Default: /data/agents/<agentId>/
 */
export function getPersonaDir(agentId: string, baseDir?: string): string {
  const dataDir = baseDir ?? path.join(process.env.DATA_DIR ?? '/data', 'agents')
  return path.join(dataDir, agentId)
}

/**
 * List all persona agent IDs found under the agents base directory
 * (default: /data/agents/). Excludes 'main' — main is the orchestrator and
 * always uses the global memory/config files. Returns [] when the directory
 * does not exist or is unreadable.
 */
export function listPersonaIds(baseDir?: string): string[] {
  const dir = baseDir ?? path.join(process.env.DATA_DIR ?? '/data', 'agents')
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'main')
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Read a single persona file from disk. Returns null if not found.
 */
function readPersonaFile(personaDir: string, filename: string): string | null {
  const filePath = path.join(personaDir, filename)
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Get file mtimes for cache invalidation.
 */
function getFileMtimes(personaDir: string): Map<string, number> {
  const mtimes = new Map<string, number>()
  for (const file of PERSONA_FILES) {
    const filePath = path.join(personaDir, file)
    try {
      const stat = fs.statSync(filePath)
      mtimes.set(file, stat.mtimeMs)
    } catch {
      mtimes.set(file, 0)
    }
  }
  return mtimes
}

/**
 * Check if cached mtimes match current disk state.
 */
function isCacheValid(cached: CacheEntry, personaDir: string): boolean {
  // Don't check disk more than once per CACHE_MAX_AGE_MS
  if (Date.now() - cached.loadedAt < CACHE_MAX_AGE_MS) {
    return true
  }

  const currentMtimes = getFileMtimes(personaDir)
  for (const [file, mtime] of currentMtimes) {
    if (cached.mtimes.get(file) !== mtime) {
      return false
    }
  }
  return true
}

/**
 * Load persona files for a specific agent.
 *
 * Behavior:
 * - If multiPersona is disabled OR agentId is 'main': returns empty context
 *   (all fields null, hasPersonaDir false) → caller uses global files
 * - If persona directory doesn't exist: returns empty context
 * - If persona directory exists: loads all available files, returns them
 *
 * Results are cached per process and invalidated on file mtime changes.
 *
 * @param agentId - The agent ID to load persona for
 * @param options - Optional overrides for testing
 */
export function loadPersona(
  agentId: string,
  options?: { baseDir?: string; skipFeatureCheck?: boolean },
): PersonaContext {
  // If feature is off and not explicitly bypassed, return empty context
  if (!options?.skipFeatureCheck) {
    const settings = loadMultiPersonaSettings()
    if (!settings.enabled) {
      return createEmptyContext(agentId)
    }
  }

  // 'main' agent always uses global files
  if (agentId === 'main') {
    return createEmptyContext(agentId)
  }

  const personaDir = getPersonaDir(agentId, options?.baseDir)

  // Check cache
  const cached = cache.get(agentId)
  if (cached && isCacheValid(cached, personaDir)) {
    return cached.context
  }

  // Check if directory exists
  if (!fs.existsSync(personaDir)) {
    const emptyContext = createEmptyContext(agentId)
    cache.set(agentId, {
      context: emptyContext,
      mtimes: new Map(),
      loadedAt: Date.now(),
    })
    return emptyContext
  }

  // Load all persona files
  const context: PersonaContext = {
    agentId,
    identity: null,
    soul: null,
    user: null,
    tools: null,
    memory: null,
    agents: null,
    heartbeat: null,
    hasPersonaDir: true,
  }

  for (const file of PERSONA_FILES) {
    const key = FILE_TO_KEY[file]
    const content = readPersonaFile(personaDir, file)
    if (content !== null) {
      ;(context as unknown as Record<string, unknown>)[key] = content
    }
  }

  // Cache result
  cache.set(agentId, {
    context,
    mtimes: getFileMtimes(personaDir),
    loadedAt: Date.now(),
  })

  return context
}

/**
 * Create an empty persona context (no persona files, use global fallback).
 */
function createEmptyContext(agentId: string): PersonaContext {
  return {
    agentId,
    identity: null,
    soul: null,
    user: null,
    tools: null,
    memory: null,
    agents: null,
    heartbeat: null,
    hasPersonaDir: false,
  }
}

/**
 * Clear the persona cache. Used when settings change or for testing.
 */
export function clearPersonaCache(): void {
  cache.clear()
}

/**
 * Invalidate the persona cache for a specific agentId.
 * Call this after any write operation (create/update/delete) to ensure
 * the next loadPersona() call re-reads from disk.
 */
export function invalidatePersonaCache(agentId: string): void {
  cache.delete(agentId)
}

/**
 * Seed persona files from a source directory to the target agent directory.
 * Only copies files that don't already exist in the target (never overwrites).
 *
 * @param agentId - Agent ID (determines target directory)
 * @param sourceDir - Directory containing seed files
 * @param targetBaseDir - Optional base directory override (default: /data/agents/)
 * @returns List of files that were copied
 */
export function seedPersonaFiles(
  agentId: string,
  sourceDir: string,
  targetBaseDir?: string,
): string[] {
  const targetDir = getPersonaDir(agentId, targetBaseDir)
  const copiedFiles: string[] = []

  if (!fs.existsSync(sourceDir)) {
    return copiedFiles
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  const files = fs.readdirSync(sourceDir)
  for (const file of files) {
    const sourcePath = path.join(sourceDir, file)
    const targetPath = path.join(targetDir, file)

    // Only copy if target doesn't exist (never overwrite user edits)
    if (!fs.existsSync(targetPath)) {
      const stat = fs.statSync(sourcePath)
      if (stat.isFile()) {
        fs.copyFileSync(sourcePath, targetPath)
        copiedFiles.push(file)
      }
    }
  }

  // Clear cache for this agent since files changed
  cache.delete(agentId)

  return copiedFiles
}
