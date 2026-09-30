import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadSkills, addSkill, updateSkill, deleteSkill, getSkill, getSkillDecrypted, loadSkillsDecrypted } from './skill-config.js'
import { ensureConfigTemplates } from './config.js'
import { decrypt } from './encryption.js'

describe('skill-config', () => {
  let tmpDir: string
  let originalDataDir: string | undefined

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR
    tmpDir = path.join(os.tmpdir(), `axiom-skill-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir
    } else {
      delete process.env.DATA_DIR
    }
  })

  it('loadSkills returns empty array when file does not exist', () => {
    const result = loadSkills()
    expect(result.skills).toEqual([])
  })

  it('skills.json template is created by ensureConfigTemplates', () => {
    const configDir = path.join(tmpDir, 'config')
    ensureConfigTemplates(configDir)
    const filePath = path.join(configDir, 'skills.json')
    expect(fs.existsSync(filePath)).toBe(true)
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(content).toEqual({ skills: [] })
  })

  it('addSkill creates a new skill entry', () => {
    const skill = addSkill({
      id: 'zats-perplexity',
      owner: 'zats',
      name: 'perplexity',
      description: 'Search with Perplexity',
      source: 'openclaw',
      sourceUrl: 'https://github.com/openclaw/skills/tree/main/skills/zats/perplexity',
      path: '/data/skills/zats/perplexity',
      envKeys: ['PERPLEXITY_API_KEY'],
      emoji: '🔍',
    })

    expect(skill.id).toBe('zats-perplexity')
    expect(skill.enabled).toBe(true)
    expect(skill.envValues).toEqual({})
    expect(skill.installedAt).toBeTruthy()

    // Verify it was persisted
    const loaded = loadSkills()
    expect(loaded.skills).toHaveLength(1)
    expect(loaded.skills[0].id).toBe('zats-perplexity')
  })

  it('addSkill throws on duplicate ID', () => {
    addSkill({
      id: 'test-id',
      owner: 'test',
      name: 'skill',
      description: 'Test',
      source: 'openclaw',
      sourceUrl: '',
      path: '/data/skills/test/skill',
      envKeys: [],
    })

    expect(() => addSkill({
      id: 'test-id',
      owner: 'test',
      name: 'skill2',
      description: 'Test 2',
      source: 'openclaw',
      sourceUrl: '',
      path: '/data/skills/test/skill2',
      envKeys: [],
    })).toThrow('already exists')
  })

  it('getSkill returns skill by ID', () => {
    addSkill({
      id: 'my-skill',
      owner: 'me',
      name: 'my-skill',
      description: 'My skill',
      source: 'github',
      sourceUrl: '',
      path: '/data/skills/me/my-skill',
      envKeys: [],
    })

    const skill = getSkill('my-skill')
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('my-skill')

    expect(getSkill('nonexistent')).toBeNull()
  })

  it('updateSkill toggles enabled', () => {
    addSkill({
      id: 'toggle-test',
      owner: 'x',
      name: 'toggle',
      description: 'Toggle test',
      source: 'openclaw',
      sourceUrl: '',
      path: '/data/skills/x/toggle',
      envKeys: [],
    })

    const updated = updateSkill('toggle-test', { enabled: false })
    expect(updated.enabled).toBe(false)

    const loaded = getSkill('toggle-test')
    expect(loaded!.enabled).toBe(false)
  })

  it('updateSkill encrypts env values', () => {
    addSkill({
      id: 'env-test',
      owner: 'x',
      name: 'env-skill',
      description: 'Env test',
      source: 'openclaw',
      sourceUrl: '',
      path: '/data/skills/x/env-skill',
      envKeys: ['API_KEY', 'SECRET'],
    })

    updateSkill('env-test', {
      envValues: { API_KEY: 'my-api-key-123', SECRET: 'super-secret' },
    })

    // Raw stored values should be encrypted
    const raw = getSkill('env-test')!
    expect(raw.envValues.API_KEY).not.toBe('my-api-key-123')
    expect(raw.envValues.SECRET).not.toBe('super-secret')

    // Decrypted should match originals
    expect(decrypt(raw.envValues.API_KEY)).toBe('my-api-key-123')
    expect(decrypt(raw.envValues.SECRET)).toBe('super-secret')
  })

  it('getSkillDecrypted returns decrypted env values', () => {
    addSkill({
      id: 'dec-test',
      owner: 'x',
      name: 'dec-skill',
      description: 'Dec test',
      source: 'openclaw',
      sourceUrl: '',
      path: '/data/skills/x/dec-skill',
      envKeys: ['MY_KEY'],
    })

    updateSkill('dec-test', { envValues: { MY_KEY: 'plain-value' } })

    const decrypted = getSkillDecrypted('dec-test')
    expect(decrypted).not.toBeNull()
    expect(decrypted!.envValues.MY_KEY).toBe('plain-value')
  })

  it('loadSkillsDecrypted returns all skills with decrypted env values', () => {
    addSkill({
      id: 'bulk-1',
      owner: 'x',
      name: 'bulk1',
      description: 'Bulk 1',
      source: 'openclaw',
      sourceUrl: '',
      path: '/data/skills/x/bulk1',
      envKeys: ['KEY1'],
    })

    updateSkill('bulk-1', { envValues: { KEY1: 'value1' } })

    const result = loadSkillsDecrypted()
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].envValues.KEY1).toBe('value1')
  })

  it('deleteSkill removes a skill', () => {
    addSkill({
      id: 'delete-me',
      owner: 'x',
      name: 'delete-skill',
      description: 'Delete test',
      source: 'openclaw',
      sourceUrl: '',
      path: '/data/skills/x/delete-skill',
      envKeys: [],
    })

    expect(loadSkills().skills).toHaveLength(1)
    deleteSkill('delete-me')
    expect(loadSkills().skills).toHaveLength(0)
  })

  it('deleteSkill throws on nonexistent ID', () => {
    expect(() => deleteSkill('nonexistent')).toThrow('Skill not found')
  })

  it('updateSkill throws on nonexistent ID', () => {
    expect(() => updateSkill('nonexistent', { enabled: false })).toThrow('Skill not found')
  })

  it('handles empty env values gracefully', () => {
    addSkill({
      id: 'empty-env',
      owner: 'x',
      name: 'empty-env',
      description: 'Test',
      source: 'openclaw',
      sourceUrl: '',
      path: '/data/skills/x/empty-env',
      envKeys: ['KEY1'],
    })

    updateSkill('empty-env', { envValues: { KEY1: '' } })
    const skill = getSkill('empty-env')!
    expect(skill.envValues.KEY1).toBe('')

    const decrypted = getSkillDecrypted('empty-env')!
    expect(decrypted.envValues.KEY1).toBe('')
  })
})
