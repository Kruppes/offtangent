import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { contextMemoryDir, type ContextScope } from './context-scope.js'
import { getMemoryDir, resolveAgentMemoryDir } from './memory.js'
import { getAgentSkillsDir, scopedAgentSkillsDir } from './agent-skills.js'
import { loadSkills } from './skill-config.js'
import { getConfigDir } from './config.js'
import { getWorkspaceDir } from './workspace.js'

// Resolve existing ancestors, including symlinks, before checking a new path.
// This is an application tool guard, NOT an OS sandbox (shell remains capable).
function canonical(target: string): string {
  let parent = path.resolve(target)
  const suffix: string[] = []
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent)
    if (next === parent) break
    suffix.unshift(path.basename(parent)); parent = next
  }
  return path.join(fs.realpathSync(parent), ...suffix)
}
const inside = (base: string, target: string) => target === base || target.startsWith(base + path.sep)

export function guardScopedWrites(tools: AgentTool[], getScope: () => ContextScope | null, memoryRoot?: string): AgentTool[] {
  return tools.map(tool => !['write_file', 'edit_file'].includes(tool.name) ? tool : {
    ...tool,
    execute: async (id, args, signal, onUpdate) => {
      const input = args as { path?: string }
      const target = canonical(path.resolve(getWorkspaceDir(), input.path ?? ''))
      const scope = getScope()
      const root = (scope ? resolveAgentMemoryDir(scope.agentId, { fallbackMemoryDir: memoryRoot }) : memoryRoot) ?? getMemoryDir()
      const allowed = scope ? [contextMemoryDir(root, scope), scopedAgentSkillsDir(scope)].map(canonical) : []
      const skillsRoot = canonical(getAgentSkillsDir())
      const roots = [...new Set([root, getMemoryDir()])].map(canonical)
      const legacyMemory = roots.some(base => inside(base, target))
      // Installed skills may live outside skills_agent; global/legacy grants
      // are read grants, not permission for project work to overwrite them.
      const installedSkill = loadSkills().skills.some(s => s.path && inside(canonical(s.path), target))
      const otherPersonaMemory = /\/agents\/[^/]+\/memory(?:\/|$)/.test(target)
      if ((target === canonical(path.join(getConfigDir(), 'skills.json')) || target.split(path.sep).includes('scoped-v1') || inside(skillsRoot, target) || legacyMemory || otherPersonaMemory || installedSkill)
        && !allowed.some(base => inside(base, target))) {
        throw new Error('Write outside current memory/skill scope. Project assignment does not authorize promoting retained history. Explicit retrieval is read-only; global publication requires operator approval.')
      }
      return tool.execute(id, args, signal, onUpdate)
    },
  })
}
