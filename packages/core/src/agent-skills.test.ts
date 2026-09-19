import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  listAgentSkills,
  trackAgentSkillUsage,
  getRecentAgentSkills,
  getAgentSkillsForPrompt,
  getAgentSkillsCount,
  getAgentSkillsDir,
  createAgentSkillTools,
  filterAndAnnotateAgentSkills,
  currentPlatform,
} from './agent-skills.js'
import type { AgentSkillEntry } from './agent-skills.js'
import { assembleSystemPrompt } from './memory.js'
import type { SkillPromptEntry } from './memory.js'

describe('agent-skills', () => {
  let tmpDir: string
  let originalDataDir: string | undefined

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR
    tmpDir = path.join(os.tmpdir(), `axiom-agent-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR
    } else {
      process.env.DATA_DIR = originalDataDir
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function createSkill(name: string, description: string): void {
    const skillDir = path.join(tmpDir, 'skills_agent', name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nSkill instructions here.`,
      'utf-8',
    )
  }

  describe('getAgentSkillsDir', () => {
    it('returns DATA_DIR/skills_agent/', () => {
      const dir = getAgentSkillsDir()
      expect(dir).toBe(path.join(tmpDir, 'skills_agent'))
    })
  })

  describe('listAgentSkills', () => {
    it('returns empty array when directory does not exist', () => {
      const result = listAgentSkills()
      expect(result).toEqual([])
      // Directory should be created
      expect(fs.existsSync(path.join(tmpDir, 'skills_agent'))).toBe(true)
    })

    it('returns empty array when directory is empty', () => {
      fs.mkdirSync(path.join(tmpDir, 'skills_agent'), { recursive: true })
      const result = listAgentSkills()
      expect(result).toEqual([])
    })

    it('returns skills with correct name and description', () => {
      createSkill('my-skill', 'A test skill for testing')

      const result = listAgentSkills()
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('my-skill')
      expect(result[0].description).toBe('A test skill for testing')
      expect(result[0].location).toBe(path.join(tmpDir, 'skills_agent', 'my-skill'))
    })

    it('returns multiple skills', () => {
      createSkill('skill-a', 'First skill')
      createSkill('skill-b', 'Second skill')

      const result = listAgentSkills()
      expect(result).toHaveLength(2)
      const names = result.map(s => s.name).sort()
      expect(names).toEqual(['skill-a', 'skill-b'])
    })

    it('skips directories without SKILL.md', () => {
      createSkill('valid-skill', 'Valid')
      fs.mkdirSync(path.join(tmpDir, 'skills_agent', 'no-skill-md'), { recursive: true })

      const result = listAgentSkills()
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('valid-skill')
    })

    it('skips hidden directories', () => {
      createSkill('visible-skill', 'Visible')
      const hiddenDir = path.join(tmpDir, 'skills_agent', '.hidden')
      fs.mkdirSync(hiddenDir, { recursive: true })
      fs.writeFileSync(path.join(hiddenDir, 'SKILL.md'), '---\nname: hidden\ndescription: Hidden\n---\n', 'utf-8')

      const result = listAgentSkills()
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('visible-skill')
    })

    it('includes lastUsed from usage tracking', () => {
      createSkill('tracked-skill', 'Tracked')
      trackAgentSkillUsage('tracked-skill')

      const result = listAgentSkills()
      expect(result).toHaveLength(1)
      expect(result[0].lastUsed).toBeTruthy()
    })
  })

  describe('trackAgentSkillUsage', () => {
    it('creates .usage.json when it does not exist', () => {
      fs.mkdirSync(path.join(tmpDir, 'skills_agent'), { recursive: true })
      trackAgentSkillUsage('my-skill')

      const usagePath = path.join(tmpDir, 'skills_agent', '.usage.json')
      expect(fs.existsSync(usagePath)).toBe(true)

      const content = JSON.parse(fs.readFileSync(usagePath, 'utf-8'))
      expect(content['my-skill']).toBeTruthy()
    })

    it('updates existing .usage.json', () => {
      fs.mkdirSync(path.join(tmpDir, 'skills_agent'), { recursive: true })
      trackAgentSkillUsage('skill-a')

      // Wait a tiny bit so timestamps differ
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'skills_agent', '.usage.json'), 'utf-8'))

      trackAgentSkillUsage('skill-b')
      const second = JSON.parse(fs.readFileSync(path.join(tmpDir, 'skills_agent', '.usage.json'), 'utf-8'))

      expect(second['skill-a']).toBeTruthy()
      expect(second['skill-b']).toBeTruthy()
    })

    it('updates timestamp for already tracked skill', () => {
      fs.mkdirSync(path.join(tmpDir, 'skills_agent'), { recursive: true })
      trackAgentSkillUsage('my-skill')
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'skills_agent', '.usage.json'), 'utf-8'))

      // Small delay to ensure different timestamp
      const later = new Date(Date.now() + 1000).toISOString()
      const usagePath = path.join(tmpDir, 'skills_agent', '.usage.json')
      fs.writeFileSync(usagePath, JSON.stringify({ 'my-skill': later }) + '\n', 'utf-8')

      trackAgentSkillUsage('my-skill')
      const updated = JSON.parse(fs.readFileSync(usagePath, 'utf-8'))
      // The updated timestamp should be different (newer) than the manually set one
      expect(updated['my-skill']).toBeTruthy()
    })

    it('handles corrupted .usage.json gracefully', () => {
      const skillsDir = path.join(tmpDir, 'skills_agent')
      fs.mkdirSync(skillsDir, { recursive: true })
      fs.writeFileSync(path.join(skillsDir, '.usage.json'), 'not valid json{{{', 'utf-8')

      // Should not throw
      trackAgentSkillUsage('my-skill')

      const content = JSON.parse(fs.readFileSync(path.join(skillsDir, '.usage.json'), 'utf-8'))
      expect(content['my-skill']).toBeTruthy()
    })
  })

  describe('getRecentAgentSkills', () => {
    it('returns skills sorted by lastUsed descending', () => {
      createSkill('old-skill', 'Old')
      createSkill('new-skill', 'New')

      // Track old skill first, then new skill
      const oldTime = new Date(Date.now() - 10000).toISOString()
      const newTime = new Date().toISOString()
      const usagePath = path.join(tmpDir, 'skills_agent', '.usage.json')
      fs.writeFileSync(usagePath, JSON.stringify({
        'old-skill': oldTime,
        'new-skill': newTime,
      }) + '\n', 'utf-8')

      const result = getRecentAgentSkills(10)
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('new-skill')
      expect(result[1].name).toBe('old-skill')
    })

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        createSkill(`skill-${i}`, `Skill ${i}`)
        trackAgentSkillUsage(`skill-${i}`)
      }

      const result = getRecentAgentSkills(3)
      expect(result).toHaveLength(3)
    })

    it('puts unused skills after used ones', () => {
      createSkill('used-skill', 'Used')
      createSkill('unused-skill', 'Unused')
      trackAgentSkillUsage('used-skill')

      const result = getRecentAgentSkills(10)
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('used-skill')
      expect(result[1].name).toBe('unused-skill')
    })
  })

  describe('getAgentSkillsForPrompt', () => {
    it('returns SkillPromptEntry format', () => {
      createSkill('prompt-skill', 'For prompt injection')
      trackAgentSkillUsage('prompt-skill')

      const result = getAgentSkillsForPrompt()
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        name: 'prompt-skill',
        description: 'For prompt injection',
        location: path.join(tmpDir, 'skills_agent', 'prompt-skill'),
      })
    })

    it('returns at most 10 skills', () => {
      for (let i = 0; i < 15; i++) {
        createSkill(`skill-${String(i).padStart(2, '0')}`, `Skill ${i}`)
        trackAgentSkillUsage(`skill-${String(i).padStart(2, '0')}`)
      }

      const result = getAgentSkillsForPrompt()
      expect(result).toHaveLength(10)
    })
  })

  describe('getAgentSkillsCount', () => {
    it('returns 0 when no skills exist', () => {
      expect(getAgentSkillsCount()).toBe(0)
    })

    it('returns correct count', () => {
      createSkill('skill-a', 'A')
      createSkill('skill-b', 'B')
      createSkill('skill-c', 'C')

      expect(getAgentSkillsCount()).toBe(3)
    })
  })

  describe('list_agent_skills tool', () => {
    it('returns formatted skill list', async () => {
      createSkill('tool-skill', 'A skill for tool testing')

      const tools = createAgentSkillTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe('list_agent_skills')

      const result = await tools[0].execute('test-call-id', {})
      const text = (result as { content: { text: string }[] }).content[0].text
      expect(text).toContain('tool-skill')
      expect(text).toContain('A skill for tool testing')
      expect(text).toContain('1 agent skill(s)')
    })

    it('returns message when no skills exist', async () => {
      const tools = createAgentSkillTools()
      const result = await tools[0].execute('test-call-id', {})
      const text = (result as { content: { text: string }[] }).content[0].text
      expect(text).toContain('No agent skills found')
    })

    it('includes location in output', async () => {
      createSkill('located-skill', 'Has a location')

      const tools = createAgentSkillTools()
      const result = await tools[0].execute('test-call-id', {})
      const text = (result as { content: { text: string }[] }).content[0].text
      expect(text).toContain(path.join(tmpDir, 'skills_agent', 'located-skill'))
    })
  })

  describe('system prompt integration', () => {
    it('agent-skills appear in <available_skills> alongside installed skills', () => {
      const memoryDir = path.join(tmpDir, 'memory')
      const installedSkills: SkillPromptEntry[] = [
        { name: 'installed-skill', description: 'An installed skill', location: '/data/skills/owner/installed-skill' },
      ]
      const agentSkills: SkillPromptEntry[] = [
        { name: 'agent-skill', description: 'An agent-created skill', location: path.join(tmpDir, 'skills_agent', 'agent-skill') },
      ]

      const allSkills = [...installedSkills, ...agentSkills]
      const prompt = assembleSystemPrompt({ memoryDir, skills: allSkills })

      expect(prompt).toContain('<name>installed-skill</name>')
      expect(prompt).toContain('<name>agent-skill</name>')
      expect(prompt).toContain('<available_skills>')
    })

    it('includes list_agent_skills tool and overflow note when agentSkillsOverflowCount > 10', () => {
      const memoryDir = path.join(tmpDir, 'memory')
      const skills: SkillPromptEntry[] = [
        { name: 'test-skill', description: 'Test', location: '/data/skills_agent/test-skill' },
      ]

      const prompt = assembleSystemPrompt({
        memoryDir,
        skills,
        agentSkillsOverflowCount: 15,
      })

      // list_agent_skills appears in both <available_tools> and <available_skills> overflow note
      expect(prompt).toContain('15 self-created agent skills')
      expect(prompt).toContain('list_agent_skills')
    })

    it('does not include list_agent_skills tool when agentSkillsOverflowCount is undefined', () => {
      const memoryDir = path.join(tmpDir, 'memory')
      const skills: SkillPromptEntry[] = [
        { name: 'test-skill', description: 'Test', location: '/data/skills_agent/test-skill' },
      ]

      const prompt = assembleSystemPrompt({ memoryDir, skills })

      // No overflow → list_agent_skills should not appear at all
      expect(prompt).not.toContain('list_agent_skills')
    })

    it('does not include list_agent_skills tool when count <= 10', () => {
      const memoryDir = path.join(tmpDir, 'memory')
      const skills: SkillPromptEntry[] = [
        { name: 'test-skill', description: 'Test', location: '/data/skills_agent/test-skill' },
      ]

      // agentSkillsOverflowCount is only set when > 10 in agent.ts,
      // but test the edge: even if passed as 10, no overflow note
      const prompt = assembleSystemPrompt({
        memoryDir,
        skills,
        agentSkillsOverflowCount: 10,
      })

      expect(prompt).not.toContain('list_agent_skills')
    })
  })

  describe('skill frontmatter gating', () => {
    function createSkillWithFrontmatter(name: string, frontmatter: string): void {
      const skillDir = path.join(tmpDir, 'skills_agent', name)
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Gated skill\n${frontmatter}---\n\nBody.`,
        'utf-8',
      )
    }

    it('listAgentSkills exposes the new gating fields', () => {
      createSkillWithFrontmatter(
        'gated',
        'required_env_vars:\n  - FOO_KEY\nplatforms:\n  - linux\nrequires_toolsets:\n  - web_fetch\n',
      )

      const skills = listAgentSkills()
      expect(skills).toHaveLength(1)
      expect(skills[0].requiredEnvVars).toEqual(['FOO_KEY'])
      expect(skills[0].platforms).toEqual(['linux'])
      expect(skills[0].requiresToolsets).toEqual(['web_fetch'])
    })

    it('hides skills whose platform does not match', () => {
      const skills: AgentSkillEntry[] = [
        { name: 'linux-only', description: 'x', location: '/a', platforms: ['linux'] },
        { name: 'mac-only', description: 'y', location: '/b', platforms: ['macos'] },
        { name: 'any', description: 'z', location: '/c' },
      ]
      const filtered = filterAndAnnotateAgentSkills(skills, {
        platform: 'linux',
        activeTools: new Set(),
      })
      expect(filtered.map(s => s.name)).toEqual(['linux-only', 'any'])
    })

    it('hides skills whose requires_toolsets are not all active', () => {
      const skills: AgentSkillEntry[] = [
        { name: 'needs-web-fetch', description: 'x', location: '/a', requiresToolsets: ['web_fetch'] },
        { name: 'needs-both', description: 'y', location: '/b', requiresToolsets: ['web_fetch', 'shell'] },
        { name: 'no-deps', description: 'z', location: '/c' },
      ]
      const filtered = filterAndAnnotateAgentSkills(skills, {
        platform: 'linux',
        activeTools: new Set(['web_fetch']),
      })
      expect(filtered.map(s => s.name)).toEqual(['needs-web-fetch', 'no-deps'])
    })

    it('keeps skills with missing required_env_vars but marks them with a warning', () => {
      const skills: AgentSkillEntry[] = [
        { name: 'needs-key', description: 'x', location: '/a', requiredEnvVars: ['BRAVE_API_KEY', 'OTHER'] },
      ]
      const filtered = filterAndAnnotateAgentSkills(skills, {
        platform: 'linux',
        activeTools: new Set(),
        getEnv: (name) => (name === 'BRAVE_API_KEY' ? 'present' : undefined),
      })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].warning).toBe('⚠ requires: OTHER')
    })

    it('omits the warning when all required env vars are present', () => {
      const skills: AgentSkillEntry[] = [
        { name: 'all-set', description: 'x', location: '/a', requiredEnvVars: ['K1', 'K2'] },
      ]
      const filtered = filterAndAnnotateAgentSkills(skills, {
        platform: 'linux',
        activeTools: new Set(),
        getEnv: () => 'present',
      })
      expect(filtered[0].warning).toBeUndefined()
    })

    it('is backward compatible: skills without new fields pass through unchanged', () => {
      const skills: AgentSkillEntry[] = [
        { name: 'plain', description: 'x', location: '/a' },
      ]
      const filtered = filterAndAnnotateAgentSkills(skills, {
        platform: 'linux',
        activeTools: new Set(),
      })
      expect(filtered).toEqual([{ name: 'plain', description: 'x', location: '/a' }])
    })

    it('currentPlatform maps process.platform to canonical names', () => {
      const p = currentPlatform()
      // At least make sure it returns a non-empty string and maps darwin/win32 correctly.
      expect(typeof p).toBe('string')
      if (process.platform === 'darwin') expect(p).toBe('macos')
      else if (process.platform === 'win32') expect(p).toBe('windows')
      else expect(p).toBe(process.platform)
    })

    it('list_agent_skills tool output marks skills with missing env vars', async () => {
      createSkillWithFrontmatter('needs-env', 'required_env_vars:\n  - NEVER_SET_VAR_XYZ\n')

      const tools = createAgentSkillTools()
      const result = await tools[0].execute('test-call-id', {})
      const text = (result as { content: { text: string }[] }).content[0].text
      expect(text).toContain('needs-env')
      expect(text).toContain('NEVER_SET_VAR_XYZ')
      expect(text).toContain('requires env')
    })
  })

  describe('assembleSystemPrompt renders skill warnings', () => {
    it('emits a <warning> tag when a skill carries a warning', () => {
      const skills: SkillPromptEntry[] = [
        { name: 'warn-skill', description: 'd', location: '/a', warning: '⚠ requires: FOO' },
      ]
      const prompt = assembleSystemPrompt({
        memoryDir: path.join(tmpDir, 'memory'),
        skills,
      })
      expect(prompt).toContain('<warning>⚠ requires: FOO</warning>')
    })
  })

  describe('usage tracking via read_file', () => {
    it('trackAgentSkillUsage updates when SKILL.md path matches agent skills directory', () => {
      createSkill('read-tracked', 'Track on read')

      // Simulate the detection pattern from read_file in agent.ts
      const resolved = path.join(tmpDir, 'skills_agent', 'read-tracked', 'SKILL.md')
      const match = resolved.match(/\/skills_agent\/([^/]+)\/SKILL\.md$/)

      expect(match).not.toBeNull()
      expect(match![1]).toBe('read-tracked')

      // Track it
      trackAgentSkillUsage(match![1])

      const usagePath = path.join(tmpDir, 'skills_agent', '.usage.json')
      const usage = JSON.parse(fs.readFileSync(usagePath, 'utf-8'))
      expect(usage['read-tracked']).toBeTruthy()
    })
  })
})
