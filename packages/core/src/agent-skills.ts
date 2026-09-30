import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { parseSkillMd } from './skill-parser.js'
import type { SkillPromptEntry } from './memory.js'

/**
 * Usage tracking entry: skill name → last used ISO timestamp
 */
export interface AgentSkillUsage {
  [skillName: string]: string // ISO timestamp
}

/**
 * Agent skill entry returned by listing functions
 */
export interface AgentSkillEntry {
  name: string
  description: string
  location: string
  lastUsed?: string // ISO timestamp
  /** Optional `required_env_vars` from the skill's frontmatter. */
  requiredEnvVars?: string[]
  /** Optional `platforms` from the skill's frontmatter. */
  platforms?: string[]
  /** Optional `requires_toolsets` from the skill's frontmatter. */
  requiresToolsets?: string[]
}

/**
 * Context for filtering/annotating skills when rendering into the system prompt.
 */
export interface SkillPromptContext {
  /** Current platform name: "linux" | "macos" | "windows" | other. */
  platform: string
  /** Names of tools currently registered in the active toolset. */
  activeTools: Set<string>
  /** Returns the value of an env var (or undefined if unset). */
  getEnv?: (name: string) => string | undefined
}

/**
 * Map Node's `process.platform` to the canonical names used in skill frontmatter.
 */
export function currentPlatform(): string {
  switch (process.platform) {
    case 'darwin': return 'macos'
    case 'win32': return 'windows'
    default: return process.platform // 'linux', 'freebsd', etc.
  }
}

const USAGE_FILENAME = '.usage.json'

/**
 * Get the agent skills directory path.
 * Uses DATA_DIR env var, falling back to /data.
 */
export function getAgentSkillsDir(): string {
  const dataDir = process.env.DATA_DIR ?? '/data'
  return path.join(dataDir, 'skills_agent')
}

/**
 * Ensure the agent skills directory exists, creating it if missing.
 * Returns the directory path, or null if it cannot be created.
 */
function ensureAgentSkillsDir(): string | null {
  const dir = getAgentSkillsDir()
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  } catch {
    return null
  }
}

/**
 * Read the usage tracking JSON file.
 * Returns empty object if file doesn't exist or is invalid.
 */
function readUsageFile(): AgentSkillUsage {
  const dir = getAgentSkillsDir()
  const usagePath = path.join(dir, USAGE_FILENAME)
  try {
    if (fs.existsSync(usagePath)) {
      const content = fs.readFileSync(usagePath, 'utf-8')
      const parsed = JSON.parse(content)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as AgentSkillUsage
      }
    }
  } catch {
    // Corrupted file, return empty
  }
  return {}
}

/**
 * Write the usage tracking JSON file.
 */
function writeUsageFile(usage: AgentSkillUsage): void {
  const dir = ensureAgentSkillsDir()
  if (!dir) return
  const usagePath = path.join(dir, USAGE_FILENAME)
  // Atomic write: write to temp file then rename for concurrent access safety
  const tmpPath = usagePath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(usage, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmpPath, usagePath)
}

/**
 * List all agent-managed skills by scanning the skills_agent directory.
 * Creates the directory if it doesn't exist.
 * Returns entries with name, description, location, and optional lastUsed timestamp.
 */
export function listAgentSkills(): AgentSkillEntry[] {
  const dir = ensureAgentSkillsDir()
  if (!dir) return []
  const usage = readUsageFile()
  const entries: AgentSkillEntry[] = []

  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue

    const skillMdPath = path.join(dir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillMdPath)) continue

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8')
      const parsed = parseSkillMd(content)
      entries.push({
        name: parsed.name,
        description: parsed.description,
        location: path.join(dir, entry.name),
        lastUsed: usage[parsed.name] ?? usage[entry.name],
        requiredEnvVars: parsed.requiredEnvVars,
        platforms: parsed.platforms,
        requiresToolsets: parsed.requiresToolsets,
      })
    } catch {
      // Skip skills with invalid SKILL.md
    }
  }

  return entries
}

/**
 * Track usage of an agent skill by updating the timestamp in .usage.json.
 */
export function trackAgentSkillUsage(skillName: string): void {
  try {
    const usage = readUsageFile()
    usage[skillName] = new Date().toISOString()
    writeUsageFile(usage)
  } catch {
    // Silently fail if directory is not writable
  }
}

/**
 * Get the N most recently used agent skills, sorted by lastUsed descending.
 */
export function getRecentAgentSkills(limit: number = 10): AgentSkillEntry[] {
  const allSkills = listAgentSkills()

  // Separate skills with usage data from those without
  const withUsage = allSkills.filter(s => s.lastUsed)
  const withoutUsage = allSkills.filter(s => !s.lastUsed)

  // Sort by lastUsed descending
  withUsage.sort((a, b) => {
    const timeA = new Date(a.lastUsed!).getTime()
    const timeB = new Date(b.lastUsed!).getTime()
    return timeB - timeA
  })

  // Combine: recently used first, then unused
  const combined = [...withUsage, ...withoutUsage]
  return combined.slice(0, limit)
}

/**
 * Apply platform/toolset/env-var gating rules to agent skills for the system prompt.
 *
 * Semantics (backward-compatible — skills without the new fields are unaffected):
 *   - `platforms`: if set and current platform is not included, the skill is hidden.
 *   - `requires_toolsets`: if any required tool is missing from the active toolset,
 *     the skill is hidden (avoids prompt noise for unusable skills).
 *   - `required_env_vars`: if any required env var is missing, the skill is kept in
 *     the listing but marked with "⚠ requires: VAR_NAME" so the agent can warn the
 *     user instead of failing silently.
 */
export function filterAndAnnotateAgentSkills(
  skills: AgentSkillEntry[],
  ctx: SkillPromptContext,
): SkillPromptEntry[] {
  const getEnv = ctx.getEnv ?? ((name: string) => process.env[name])
  const result: SkillPromptEntry[] = []

  for (const s of skills) {
    // Platform gate
    if (s.platforms && s.platforms.length > 0 && !s.platforms.includes(ctx.platform)) {
      continue
    }

    // Toolset gate
    if (s.requiresToolsets && s.requiresToolsets.length > 0) {
      const missing = s.requiresToolsets.filter(t => !ctx.activeTools.has(t))
      if (missing.length > 0) continue
    }

    // Env-var annotation (not a hard filter)
    let warning: string | undefined
    if (s.requiredEnvVars && s.requiredEnvVars.length > 0) {
      const missing = s.requiredEnvVars.filter(v => !getEnv(v))
      if (missing.length > 0) {
        warning = `⚠ requires: ${missing.join(', ')}`
      }
    }

    result.push({
      name: s.name,
      description: s.description,
      location: s.location,
      ...(warning ? { warning } : {}),
    })
  }

  return result
}

/**
 * Get agent skills formatted for system prompt injection.
 * Returns the 10 most recently used skills as SkillPromptEntry[].
 *
 * Accepts an optional context to filter by platform/toolset and mark skills with
 * missing required env vars. Without context, no gating is applied (backward compat).
 */
export function getAgentSkillsForPrompt(ctx?: SkillPromptContext): SkillPromptEntry[] {
  const recent = getRecentAgentSkills(10)
  if (!ctx) {
    return recent.map(s => ({
      name: s.name,
      description: s.description,
      location: s.location,
    }))
  }
  return filterAndAnnotateAgentSkills(recent, ctx)
}

/**
 * Get the total count of agent skills (for overflow note).
 */
export function getAgentSkillsCount(): number {
  const dir = getAgentSkillsDir()
  if (!fs.existsSync(dir)) return 0

  let count = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skillMdPath = path.join(dir, entry.name, 'SKILL.md')
      if (fs.existsSync(skillMdPath)) count++
    }
  } catch {
    // Directory read failed
  }
  return count
}

/**
 * Create the list_agent_skills tool for agent discovery.
 */
export function createAgentSkillTools(): AgentTool[] {
  const listTool: AgentTool = {
    name: 'list_agent_skills',
    label: 'List Agent Skills',
    description:
      'List all self-created agent skills with their descriptions and file locations. ' +
      'Use this when you need a skill you haven\'t used recently or want to browse all available agent skills.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const skills = listAgentSkills()
        if (skills.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No agent skills found. You can create skills by writing SKILL.md files to the agent skills directory.' }],
            details: { count: 0 },
          }
        }

        const lines = skills.map(s => {
          const lastUsedStr = s.lastUsed ? ` (last used: ${s.lastUsed})` : ''
          const missingEnv = (s.requiredEnvVars ?? []).filter(v => !process.env[v])
          const warnStr = missingEnv.length > 0 ? `\n  ⚠ requires env: ${missingEnv.join(', ')} (not set)` : ''
          return `- **${s.name}**: ${s.description}\n  Location: ${s.location}${lastUsedStr}${warnStr}`
        })

        const dir = getAgentSkillsDir()
        const text = `Found ${skills.length} agent skill(s):\n\n${lines.join('\n\n')}\n\nSkills directory: ${dir}`

        return {
          content: [{ type: 'text' as const, text }],
          details: { count: skills.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error listing agent skills: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  return [listTool]
}
