import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadAttachedSkillContent, renderAttachedSkillsBlock } from './attached-skills.js'
import { ensureConfigTemplates, getConfigDir } from './config.js'
import { loadSkills, saveSkills } from './skill-config.js'

/**
 * Tests the two identifier shapes supported by `loadAttachedSkillContent`:
 *  - bare name  → agent skill under `<skillsDir>/<name>/SKILL.md`
 *  - `owner/name` → installed skill resolved via `skills.json`
 *
 * Each case uses a throwaway on-disk skills dir so the real user config
 * is never touched.
 */

let prevDataDir: string | undefined
let tempDataDir: string
let agentSkillsDir: string

beforeAll(() => {
  prevDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-attached-skills-'))
  process.env.DATA_DIR = tempDataDir

  // Initialise config templates so skills.json exists with default shape.
  ensureConfigTemplates()

  agentSkillsDir = path.join(tempDataDir, 'skills_agent')
  fs.mkdirSync(agentSkillsDir, { recursive: true })
})

afterAll(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (prevDataDir !== undefined) {
    process.env.DATA_DIR = prevDataDir
  } else {
    delete process.env.DATA_DIR
  }
})

describe('loadAttachedSkillContent', () => {
  it('reads an agent skill from <skillsDir>/<name>/SKILL.md', () => {
    const name = 'wiki'
    fs.mkdirSync(path.join(agentSkillsDir, name), { recursive: true })
    fs.writeFileSync(path.join(agentSkillsDir, name, 'SKILL.md'), '# wiki\nAgent content.')

    const content = loadAttachedSkillContent(name, agentSkillsDir)
    expect(content).toContain('Agent content.')
  })

  it('returns null for a missing agent skill and does not throw', () => {
    expect(loadAttachedSkillContent('does-not-exist', agentSkillsDir)).toBeNull()
  })

  it('rejects path traversal and absolute paths', () => {
    expect(loadAttachedSkillContent('..', agentSkillsDir)).toBeNull()
    expect(loadAttachedSkillContent('a/../b', agentSkillsDir)).toBeNull()
    expect(loadAttachedSkillContent('/etc/passwd', agentSkillsDir)).toBeNull()
    expect(loadAttachedSkillContent('a\\b', agentSkillsDir)).toBeNull()
  })

  it('reads an installed skill via "owner/name" id resolved through skills.json', () => {
    // Simulate an installed skill by writing its directory + registering it
    // in skills.json. Path must be stored exactly so the loader can find it.
    const installedSkillDir = path.join(tempDataDir, 'skills', 'owner', 'brave-search')
    fs.mkdirSync(installedSkillDir, { recursive: true })
    fs.writeFileSync(path.join(installedSkillDir, 'SKILL.md'), '# brave-search\nInstalled content.')

    const file = loadSkills()
    file.skills = [
      {
        id: 'owner/brave-search',
        owner: 'owner',
        name: 'brave-search',
        description: 'brave',
        source: 'github',
        sourceUrl: '',
        path: installedSkillDir,
        enabled: true,
        envKeys: [],
        envValues: {},
        installedAt: new Date(0).toISOString(),
      },
    ]
    saveSkills(file)

    const content = loadAttachedSkillContent('owner/brave-search', agentSkillsDir)
    expect(content).toContain('Installed content.')
  })

  it('returns null when installed-skill id is not in skills.json', () => {
    expect(loadAttachedSkillContent('unknown/skill', agentSkillsDir)).toBeNull()
  })

  it('rejects malformed installed-skill ids with extra slashes', () => {
    expect(loadAttachedSkillContent('a/b/c', agentSkillsDir)).toBeNull()
  })
})

describe('renderAttachedSkillsBlock', () => {
  it('wraps each resolved skill in a <skill name="..."> block', () => {
    // Ensure at least one agent skill exists from the earlier test run.
    void getConfigDir() // touch to keep import used
    fs.mkdirSync(path.join(agentSkillsDir, 'nitter'), { recursive: true })
    fs.writeFileSync(path.join(agentSkillsDir, 'nitter', 'SKILL.md'), '# nitter\nRun nitter.')

    const block = renderAttachedSkillsBlock(['nitter', 'owner/brave-search'], agentSkillsDir)
    expect(block).toContain('<attached_skills>')
    expect(block).toContain('<skill name="nitter">')
    expect(block).toContain('Run nitter.')
    expect(block).toContain('<skill name="owner/brave-search">')
    expect(block).toContain('Installed content.')
  })

  it('returns an empty string when no skills resolve', () => {
    const block = renderAttachedSkillsBlock(['does-not-exist'], agentSkillsDir)
    expect(block).toBe('')
  })

  it('returns an empty string for empty or null input', () => {
    expect(renderAttachedSkillsBlock([], agentSkillsDir)).toBe('')
    expect(renderAttachedSkillsBlock(null, agentSkillsDir)).toBe('')
    expect(renderAttachedSkillsBlock(undefined, agentSkillsDir)).toBe('')
  })
})
