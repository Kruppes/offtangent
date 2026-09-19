import yaml from 'js-yaml'

/**
 * Parsed skill metadata from a SKILL.md file
 */
export interface ParsedSkill {
  name: string
  description: string
  license?: string
  compatibility?: string[]
  allowedTools?: string[]
  envKeys: string[]
  envDescriptions: Record<string, string>
  emoji?: string
  rawMetadata?: Record<string, unknown>
  /**
   * Optional top-level `required_env_vars` frontmatter field.
   * Env variables that must be set for the skill to function.
   * When missing, the skill is still listed in the system prompt but marked as
   * `⚠ requires: VAR_NAME` so the agent can warn the user instead of failing silently.
   */
  requiredEnvVars?: string[]
  /**
   * Optional top-level `platforms` frontmatter field (e.g. ["linux", "macos"]).
   * When present, the skill is only surfaced on matching platforms.
   */
  platforms?: string[]
  /**
   * Optional top-level `requires_toolsets` frontmatter field (e.g. ["web_fetch", "shell"]).
   * When any required tool is not part of the active toolset, the skill is hidden
   * from the system prompt listing to avoid noise.
   */
  requiresToolsets?: string[]
}

/**
 * Skill name validation per Agent Skills Standard:
 * lowercase, hyphens only, 1-64 chars, must start/end with alphanumeric
 */
const SKILL_NAME_REGEX = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/

export function isValidSkillName(name: string): boolean {
  if (!name || name.length > 64) return false
  return SKILL_NAME_REGEX.test(name)
}

/**
 * Convert a freeform name to a valid skill slug.
 * "Agent Browser" → "agent-browser"
 */
export function slugifySkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // replace non-alphanumeric runs with a hyphen
    .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
    .slice(0, 64)
}

/**
 * Extract YAML frontmatter from a markdown file.
 * Returns the parsed object and the remaining body content.
 */
export function extractFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, body: content }
  }

  // Find the closing ---
  const endIndex = trimmed.indexOf('\n---', 3)
  if (endIndex === -1) {
    return { frontmatter: null, body: content }
  }

  const yamlStr = trimmed.slice(3, endIndex).trim()
  const body = trimmed.slice(endIndex + 4).trim()

  try {
    const parsed = yaml.load(yamlStr)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { frontmatter: null, body: content }
    }
    return { frontmatter: parsed as Record<string, unknown>, body }
  } catch {
    return { frontmatter: null, body: content }
  }
}

/**
 * Extract env var requirements from OpenClaw metadata.
 *
 * Format 1: metadata.clawdbot.env as Object {"KEY": "description"}
 * Format 2: metadata.clawdbot.requires.env as Array ["KEY"]
 */
function extractEnvVars(metadata: Record<string, unknown> | undefined): { envKeys: string[]; envDescriptions: Record<string, string> } {
  const envKeys: string[] = []
  const envDescriptions: Record<string, string> = {}

  if (!metadata) return { envKeys, envDescriptions }

  const clawdbot = metadata.clawdbot as Record<string, unknown> | undefined
  if (!clawdbot || typeof clawdbot !== 'object') return { envKeys, envDescriptions }

  // Format 1: metadata.clawdbot.env as Object {"KEY": "description"}
  const envObj = clawdbot.env
  if (envObj && typeof envObj === 'object' && !Array.isArray(envObj)) {
    for (const [key, desc] of Object.entries(envObj as Record<string, unknown>)) {
      envKeys.push(key)
      if (typeof desc === 'string') {
        envDescriptions[key] = desc
      }
    }
  }

  // Format 2: metadata.clawdbot.requires.env as Array ["KEY"]
  const requires = clawdbot.requires as Record<string, unknown> | undefined
  if (requires && typeof requires === 'object') {
    const reqEnv = requires.env
    if (Array.isArray(reqEnv)) {
      for (const key of reqEnv) {
        if (typeof key === 'string' && !envKeys.includes(key)) {
          envKeys.push(key)
        }
      }
    }
  }

  return { envKeys, envDescriptions }
}

/**
 * Extract emoji from metadata.clawdbot.emoji
 */
function extractEmoji(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined
  const clawdbot = metadata.clawdbot as Record<string, unknown> | undefined
  if (!clawdbot || typeof clawdbot !== 'object') return undefined
  const emoji = clawdbot.emoji
  return typeof emoji === 'string' ? emoji : undefined
}

/**
 * Parse a SKILL.md file content and extract structured skill metadata.
 */
export function parseSkillMd(content: string): ParsedSkill {
  const { frontmatter } = extractFrontmatter(content)

  if (!frontmatter) {
    throw new Error('SKILL.md has no valid YAML frontmatter')
  }

  const name = frontmatter.name
  if (typeof name !== 'string' || !name) {
    throw new Error('SKILL.md frontmatter missing required "name" field')
  }

  const normalizedName = isValidSkillName(name) ? name : slugifySkillName(name)
  if (!normalizedName) {
    throw new Error(
      `Invalid skill name "${name}": cannot be converted to a valid slug (1-64 chars, lowercase alphanumeric and hyphens)`
    )
  }

  const description = frontmatter.description
  if (typeof description !== 'string' || !description) {
    throw new Error('SKILL.md frontmatter missing required "description" field')
  }

  const metadata = frontmatter.metadata as Record<string, unknown> | undefined
  const { envKeys, envDescriptions } = extractEnvVars(metadata)
  const emoji = extractEmoji(metadata)

  // Parse compatibility
  let compatibility: string[] | undefined
  if (Array.isArray(frontmatter.compatibility)) {
    compatibility = frontmatter.compatibility.filter((v: unknown) => typeof v === 'string')
  }

  // Parse allowed-tools
  let allowedTools: string[] | undefined
  const at = frontmatter['allowed-tools']
  if (Array.isArray(at)) {
    allowedTools = at.filter((v: unknown) => typeof v === 'string')
  }

  // Parse optional gating fields (string arrays, top-level frontmatter)
  const requiredEnvVars = parseStringArray(frontmatter.required_env_vars)
  const platforms = parseStringArray(frontmatter.platforms)
  const requiresToolsets = parseStringArray(frontmatter.requires_toolsets)

  return {
    name: normalizedName,
    description,
    license: typeof frontmatter.license === 'string' ? frontmatter.license : undefined,
    compatibility,
    allowedTools,
    envKeys,
    envDescriptions,
    emoji,
    rawMetadata: metadata,
    requiredEnvVars,
    platforms,
    requiresToolsets,
  }
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const arr = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return arr.length > 0 ? arr : undefined
}
