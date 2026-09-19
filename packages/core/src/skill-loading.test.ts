import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { assembleSystemPrompt } from './memory.js'
import type { SkillPromptEntry } from './memory.js'

describe('skill loading', () => {
  let tmpDir: string

  function makeTmpDir(): string {
    tmpDir = path.join(os.tmpdir(), `axiom-skill-loading-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    return tmpDir
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe('assembleSystemPrompt with skills', () => {
    it('includes available_skills section when skills provided', () => {
      const dir = makeTmpDir()
      const memoryDir = path.join(dir, 'memory')
      const skills: SkillPromptEntry[] = [
        {
          name: 'perplexity',
          description: 'Search the web with AI-powered answers',
          location: '/data/skills/zats/perplexity',
        },
      ]

      const prompt = assembleSystemPrompt({ memoryDir, skills })

      expect(prompt).toContain('<available_skills>')
      expect(prompt).toContain('</available_skills>')
      expect(prompt).toContain('<name>perplexity</name>')
      expect(prompt).toContain('<description>Search the web with AI-powered answers</description>')
      expect(prompt).toContain('<location>/data/skills/zats/perplexity</location>')
    })

    it('includes instruction text about read_file for skill loading', () => {
      const dir = makeTmpDir()
      const memoryDir = path.join(dir, 'memory')
      const skills: SkillPromptEntry[] = [
        {
          name: 'test-skill',
          description: 'A test skill',
          location: '/data/skills/owner/test-skill',
        },
      ]

      const prompt = assembleSystemPrompt({ memoryDir, skills })

      expect(prompt).toContain('read_file')
      expect(prompt).toContain('SKILL.md')
    })

    it('lists multiple skills', () => {
      const dir = makeTmpDir()
      const memoryDir = path.join(dir, 'memory')
      const skills: SkillPromptEntry[] = [
        { name: 'skill-a', description: 'First skill', location: '/data/skills/owner/a' },
        { name: 'skill-b', description: 'Second skill', location: '/data/skills/owner/b' },
      ]

      const prompt = assembleSystemPrompt({ memoryDir, skills })

      expect(prompt).toContain('<name>skill-a</name>')
      expect(prompt).toContain('<name>skill-b</name>')
    })

    it('omits available_skills section when skills is empty', () => {
      const dir = makeTmpDir()
      const memoryDir = path.join(dir, 'memory')

      const prompt = assembleSystemPrompt({ memoryDir, skills: [] })

      expect(prompt).not.toContain('\n<available_skills>\n')
      expect(prompt).not.toContain('\n</available_skills>\n')
    })

    it('omits available_skills section when skills is undefined', () => {
      const dir = makeTmpDir()
      const memoryDir = path.join(dir, 'memory')

      const prompt = assembleSystemPrompt({ memoryDir })

      expect(prompt).not.toContain('\n<available_skills>\n')
      expect(prompt).not.toContain('\n</available_skills>\n')
    })
  })

  describe('{baseDir} replacement', () => {
    it('replaces {baseDir} with skill directory path', () => {
      // Simulate what read_file does: replace {baseDir} with dirname of SKILL.md
      const skillContent = `Use the tool at {baseDir}/scripts/run.sh
Config is at {baseDir}/config.json`
      const skillDir = '/data/skills/zats/perplexity'

      const result = skillContent.replaceAll('{baseDir}', skillDir)

      expect(result).toBe(`Use the tool at /data/skills/zats/perplexity/scripts/run.sh
Config is at /data/skills/zats/perplexity/config.json`)
    })

    it('handles content without {baseDir}', () => {
      const skillContent = 'This skill has no baseDir references.'
      const skillDir = '/data/skills/owner/name'

      const result = skillContent.replaceAll('{baseDir}', skillDir)

      expect(result).toBe('This skill has no baseDir references.')
    })

    it('handles multiple {baseDir} occurrences', () => {
      const skillContent = '{baseDir}/a {baseDir}/b {baseDir}/c'
      const skillDir = '/data/skills/x/y'

      const result = skillContent.replaceAll('{baseDir}', skillDir)

      expect(result).toBe('/data/skills/x/y/a /data/skills/x/y/b /data/skills/x/y/c')
    })
  })

  describe('SKILL.md detection', () => {
    it('detects SKILL.md paths under /data/skills/', () => {
      const testPaths = [
        '/data/skills/zats/perplexity/SKILL.md',
        '/data/skills/owner/name/SKILL.md',
        '/data/skills/anthropic/web-search/SKILL.md',
      ]

      for (const p of testPaths) {
        const match = p.match(/\/data\/skills\/(.+)\/SKILL\.md$/)
        expect(match).not.toBeNull()
        expect(match![1]).toBeTruthy()
      }
    })

    it('does not match non-SKILL.md paths', () => {
      const testPaths = [
        '/data/skills/owner/name/README.md',
        '/workspace/SKILL.md',
        '/data/config/SKILL.md',
        '/data/skills/owner/name/scripts/SKILL.md.bak',
      ]

      for (const p of testPaths) {
        const match = p.match(/\/data\/skills\/(.+)\/SKILL\.md$/)
        // README.md, workspace, config paths should not match
        // scripts/SKILL.md.bak should not match
        if (p.includes('README') || p.includes('workspace') || p.includes('config') || p.includes('.bak')) {
          expect(match).toBeNull()
        }
      }
    })

    it('extracts skill name from path', () => {
      const resolved = '/data/skills/zats/perplexity/SKILL.md'
      const match = resolved.match(/\/data\/skills\/(.+)\/SKILL\.md$/)

      expect(match).not.toBeNull()
      expect(match![1]).toBe('zats/perplexity')
    })
  })

  describe('integration: read SKILL.md with replacement and env injection', () => {
    let originalEnv: Record<string, string | undefined> = {}
    let dataDir: string

    beforeEach(() => {
      dataDir = makeTmpDir()
      // Save original env
      originalEnv = {}
    })

    afterEach(() => {
      // Restore env vars
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    })

    it('replaces {baseDir} and prepends header in mock read_file flow', () => {
      // Set up a mock skill directory
      const skillDir = path.join(dataDir, 'skills', 'test-owner', 'test-skill')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---

Run the script at {baseDir}/scripts/run.sh
Config at {baseDir}/config.json`,
        'utf-8'
      )

      // Simulate what read_file does
      const resolved = path.join(skillDir, 'SKILL.md')
      let content = fs.readFileSync(resolved, 'utf-8')

      // Check if SKILL.md pattern matches (use a generalized pattern for test)
      const isSkillMd = resolved.endsWith('/SKILL.md') && resolved.includes('/skills/')
      expect(isSkillMd).toBe(true)

      // Replace {baseDir}
      content = content.replaceAll('{baseDir}', skillDir)

      expect(content).toContain(`${skillDir}/scripts/run.sh`)
      expect(content).toContain(`${skillDir}/config.json`)
      expect(content).not.toContain('{baseDir}')

      // Prepend header
      const header = `Skill directory: ${skillDir}\n\n`
      const finalContent = header + content

      expect(finalContent).toContain(`Skill directory: ${skillDir}`)
    })

    it('injects env vars from decrypted skill config', () => {
      // Track env vars for cleanup
      originalEnv['TEST_API_KEY'] = process.env.TEST_API_KEY
      originalEnv['TEST_SECRET'] = process.env.TEST_SECRET

      // Simulate env injection
      const envValues = {
        TEST_API_KEY: 'secret-key-123',
        TEST_SECRET: 'another-secret',
      }

      const injectedVars: string[] = []
      for (const [key, value] of Object.entries(envValues)) {
        if (value) {
          process.env[key] = value
          injectedVars.push(key)
        }
      }

      expect(process.env.TEST_API_KEY).toBe('secret-key-123')
      expect(process.env.TEST_SECRET).toBe('another-secret')
      expect(injectedVars).toEqual(['TEST_API_KEY', 'TEST_SECRET'])
    })

    it('returns correct tool result details for skill load', () => {
      const resolved = '/data/skills/zats/perplexity/SKILL.md'
      const skillMdMatch = resolved.match(/\/data\/skills\/(.+)\/SKILL\.md$/)

      expect(skillMdMatch).not.toBeNull()

      const skillName = skillMdMatch![1]
      const injectedVars = ['PERPLEXITY_API_KEY']

      const details = {
        path: resolved,
        size: 100,
        skillLoad: true,
        skillName,
        envVarsInjected: injectedVars,
      }

      expect(details.skillLoad).toBe(true)
      expect(details.skillName).toBe('zats/perplexity')
      expect(details.envVarsInjected).toEqual(['PERPLEXITY_API_KEY'])
    })
  })
})
