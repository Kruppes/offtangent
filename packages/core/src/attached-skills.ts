import fs from 'node:fs'
import path from 'node:path'

import { getAgentSkillsDir } from './agent-skills.js'
import { getSkill } from './skill-config.js'

/**
 * Read a skill's SKILL.md and return its content, or null if not found / unreadable.
 * Logs a warning but never throws — missing skills must not crash a task.
 *
 * Supports two identifier shapes:
 *  - `"<name>"` (no slash): an agent skill under `<skillsDir>/<name>/SKILL.md`
 *  - `"<owner>/<name>"`: an installed skill, resolved via `getSkill(id)` so its
 *    actual on-disk `path` (set by the skill installer) is used regardless of
 *    where the file lives. This lets cronjobs and tasks attach the instructions
 *    of normal installed skills — not only self-created agent skills.
 */
export function loadAttachedSkillContent(skillName: string, skillsDir: string = getAgentSkillsDir()): string | null {
  if (!skillName) return null

  // Reject obvious traversal / absolute paths regardless of shape.
  if (skillName.includes('\\') || skillName.includes('..') || path.isAbsolute(skillName)) {
    console.warn(`[attached-skills]: ignoring invalid skill name "${skillName}"`)
    return null
  }

  // Installed skill identifier `owner/name` — exactly one slash, both sides non-empty.
  const slashIdx = skillName.indexOf('/')
  if (slashIdx !== -1) {
    const owner = skillName.slice(0, slashIdx)
    const name = skillName.slice(slashIdx + 1)
    if (!owner || !name || name.includes('/')) {
      console.warn(`[attached-skills]: invalid installed-skill id "${skillName}"`)
      return null
    }
    try {
      const skill = getSkill(skillName)
      if (!skill) {
        console.warn(`[attached-skills]: installed skill "${skillName}" not found in skills.json`)
        return null
      }
      if (!skill.path) {
        console.warn(`[attached-skills]: installed skill "${skillName}" has no path`)
        return null
      }
      const skillPath = path.join(skill.path, 'SKILL.md')
      return fs.readFileSync(skillPath, 'utf-8')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[attached-skills]: could not read installed skill "${skillName}": ${reason}`)
      return null
    }
  }

  // Agent skill — plain directory name under the agent skills dir.
  if (skillName === '.' || skillName === '..') {
    console.warn(`[attached-skills]: ignoring invalid skill name "${skillName}"`)
    return null
  }
  const skillPath = path.join(skillsDir, skillName, 'SKILL.md')
  try {
    return fs.readFileSync(skillPath, 'utf-8')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[attached-skills]: could not read ${skillPath}: ${reason}`)
    return null
  }
}

/**
 * Render an `<attached_skills>` XML-ish block for injection into a task prompt.
 * Returns an empty string if no skills were loaded successfully so callers can
 * unconditionally concatenate the result.
 */
export function renderAttachedSkillsBlock(
  skillNames: readonly string[] | null | undefined,
  skillsDir: string = getAgentSkillsDir(),
): string {
  if (!skillNames || skillNames.length === 0) return ''

  const parts: string[] = []
  for (const name of skillNames) {
    const content = loadAttachedSkillContent(name, skillsDir)
    if (content === null) continue
    parts.push(renderSkillBlock(name, content))
  }

  return wrapAttachedSkills(parts)
}

export function renderSkillBlock(name: string, content: string): string {
  // Escape any closing tag in the content so the block stays well-formed.
  const safe = content.replace(/<\/skill>/gi, '</ skill>')
  return `<skill name="${name}">\n${safe.trim()}\n</skill>`
}

export function wrapAttachedSkills(blocks: readonly string[]): string {
  if (blocks.length === 0) return ''
  return `<attached_skills>\n${blocks.join('\n\n')}\n</attached_skills>`
}

/**
 * Normalize a raw `attached_skills` tool argument into the storage/override
 * shape: trimmed, de-duplicated, non-empty names — or `null` when nothing
 * usable remains, so callers can treat "no skills" uniformly.
 */
export function normalizeAttachedSkills(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null

  const names = Array.from(new Set(
    value
      .filter((v): v is string => typeof v === 'string')
      .map(v => v.trim())
      .filter(v => v.length > 0),
  ))

  return names.length > 0 ? names : null
}
