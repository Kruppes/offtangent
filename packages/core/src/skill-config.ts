import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'
import { encrypt, decrypt, isEncrypted } from './encryption.js'

/**
 * A single installed skill configuration
 */
export interface SkillConfig {
  id: string
  owner: string
  name: string
  description: string
  source: 'openclaw' | 'github' | 'upload'
  sourceUrl: string
  path: string
  enabled: boolean
  envKeys: string[]
  envValues: Record<string, string> // Values are encrypted at rest
  emoji?: string
  installedAt: string
}

/**
 * The skills.json file structure
 */
export interface SkillsFile {
  skills: SkillConfig[]
}

const SKILLS_FILENAME = 'skills.json'

/**
 * Load skills.json from config directory
 */
export function loadSkills(): SkillsFile {
  const configDir = getConfigDir()
  const filePath = path.join(configDir, SKILLS_FILENAME)

  if (!fs.existsSync(filePath)) {
    return { skills: [] }
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as SkillsFile
}

/**
 * Save skills.json to config directory
 */
export function saveSkills(data: SkillsFile): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  const filePath = path.join(configDir, SKILLS_FILENAME)
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/**
 * Get a single skill by ID
 */
export function getSkill(id: string): SkillConfig | null {
  const file = loadSkills()
  return file.skills.find(s => s.id === id) ?? null
}

/**
 * Get a skill by ID with env values decrypted
 */
export function getSkillDecrypted(id: string): SkillConfig | null {
  const skill = getSkill(id)
  if (!skill) return null
  return {
    ...skill,
    envValues: decryptEnvValues(skill.envValues),
  }
}

/**
 * Add a new skill to skills.json
 */
export function addSkill(input: {
  id: string
  owner: string
  name: string
  description: string
  source: 'openclaw' | 'github' | 'upload'
  sourceUrl: string
  path: string
  envKeys: string[]
  emoji?: string
}): SkillConfig {
  const file = loadSkills()

  // Check for duplicate ID
  if (file.skills.some(s => s.id === input.id)) {
    throw new Error(`Skill with ID "${input.id}" already exists`)
  }

  const skill: SkillConfig = {
    id: input.id,
    owner: input.owner,
    name: input.name,
    description: input.description,
    source: input.source,
    sourceUrl: input.sourceUrl,
    path: input.path,
    enabled: true,
    envKeys: input.envKeys,
    envValues: {},
    emoji: input.emoji,
    installedAt: new Date().toISOString(),
  }

  file.skills.push(skill)
  saveSkills(file)
  return skill
}

/**
 * Update an existing skill's settings
 */
export function updateSkill(id: string, input: {
  enabled?: boolean
  envValues?: Record<string, string>
  description?: string
  envKeys?: string[]
  emoji?: string
}): SkillConfig {
  const file = loadSkills()
  const index = file.skills.findIndex(s => s.id === id)
  if (index === -1) {
    throw new Error(`Skill not found: ${id}`)
  }

  const skill = file.skills[index]

  if (input.enabled !== undefined) skill.enabled = input.enabled
  if (input.description !== undefined) skill.description = input.description
  if (input.envKeys !== undefined) skill.envKeys = input.envKeys
  if (input.emoji !== undefined) skill.emoji = input.emoji

  // Encrypt env values before storing
  if (input.envValues !== undefined) {
    const encrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(input.envValues)) {
      encrypted[key] = value ? encrypt(value) : ''
    }
    skill.envValues = encrypted
  }

  file.skills[index] = skill
  saveSkills(file)
  return skill
}

/**
 * Delete a skill from skills.json
 */
export function deleteSkill(id: string): void {
  const file = loadSkills()
  const index = file.skills.findIndex(s => s.id === id)
  if (index === -1) {
    throw new Error(`Skill not found: ${id}`)
  }

  file.skills.splice(index, 1)
  saveSkills(file)
}

/**
 * Decrypt env values from a skill config
 */
function decryptEnvValues(envValues: Record<string, string>): Record<string, string> {
  const decrypted: Record<string, string> = {}
  for (const [key, value] of Object.entries(envValues)) {
    if (value && isEncrypted(value)) {
      decrypted[key] = decrypt(value)
    } else {
      decrypted[key] = value
    }
  }
  return decrypted
}

/**
 * Load all skills with env values decrypted (for runtime use)
 */
export function loadSkillsDecrypted(): SkillsFile {
  const file = loadSkills()
  return {
    skills: file.skills.map(s => ({
      ...s,
      envValues: decryptEnvValues(s.envValues),
    })),
  }
}
