import { describe, it, expect } from 'vitest'
import { parseSkillMd, extractFrontmatter, isValidSkillName, slugifySkillName } from './skill-parser.js'

describe('skill-parser', () => {
  describe('isValidSkillName', () => {
    it('accepts valid names', () => {
      expect(isValidSkillName('perplexity')).toBe(true)
      expect(isValidSkillName('web-search')).toBe(true)
      expect(isValidSkillName('a')).toBe(true)
      expect(isValidSkillName('my-cool-skill-2')).toBe(true)
      expect(isValidSkillName('a1')).toBe(true)
    })

    it('rejects invalid names', () => {
      expect(isValidSkillName('')).toBe(false)
      expect(isValidSkillName('My-Skill')).toBe(false) // uppercase
      expect(isValidSkillName('-starts-with-dash')).toBe(false)
      expect(isValidSkillName('ends-with-dash-')).toBe(false)
      expect(isValidSkillName('has spaces')).toBe(false)
      expect(isValidSkillName('has_underscores')).toBe(false)
      expect(isValidSkillName('a'.repeat(65))).toBe(false) // too long
    })
  })

  describe('slugifySkillName', () => {
    it('converts display names to valid slugs', () => {
      expect(slugifySkillName('Agent Browser')).toBe('agent-browser')
      expect(slugifySkillName('My-Skill')).toBe('my-skill')
      expect(slugifySkillName('has_underscores')).toBe('has-underscores')
      expect(slugifySkillName('  Extra  Spaces  ')).toBe('extra-spaces')
      expect(slugifySkillName('ALLCAPS')).toBe('allcaps')
    })

    it('trims leading/trailing hyphens', () => {
      expect(slugifySkillName('-starts-with-dash')).toBe('starts-with-dash')
      expect(slugifySkillName('ends-with-dash-')).toBe('ends-with-dash')
    })

    it('truncates to 64 chars', () => {
      const long = 'a'.repeat(100)
      expect(slugifySkillName(long).length).toBe(64)
    })
  })

  describe('extractFrontmatter', () => {
    it('extracts YAML frontmatter', () => {
      const content = `---
name: test-skill
description: A test skill
---

# Body content`

      const result = extractFrontmatter(content)
      expect(result.frontmatter).toEqual({ name: 'test-skill', description: 'A test skill' })
      expect(result.body).toBe('# Body content')
    })

    it('returns null for content without frontmatter', () => {
      const result = extractFrontmatter('# Just markdown')
      expect(result.frontmatter).toBeNull()
      expect(result.body).toBe('# Just markdown')
    })

    it('returns null for invalid YAML', () => {
      const content = `---
: invalid: yaml: [
---

body`
      const result = extractFrontmatter(content)
      expect(result.frontmatter).toBeNull()
    })

    it('handles leading whitespace', () => {
      const content = `  \n---
name: test
---

body`
      const result = extractFrontmatter(content)
      expect(result.frontmatter).toEqual({ name: 'test' })
    })
  })

  describe('parseSkillMd', () => {
    it('parses a complete SKILL.md', () => {
      const content = `---
name: perplexity
description: Search the web with AI-powered answers
license: MIT
compatibility:
  - claude
  - openai
allowed-tools:
  - web_search
  - shell
metadata:
  clawdbot:
    emoji: "🔍"
    env:
      PERPLEXITY_API_KEY: "Your Perplexity API key"
---

# Perplexity Skill

Use this skill to search the web.`

      const result = parseSkillMd(content)
      expect(result.name).toBe('perplexity')
      expect(result.description).toBe('Search the web with AI-powered answers')
      expect(result.license).toBe('MIT')
      expect(result.compatibility).toEqual(['claude', 'openai'])
      expect(result.allowedTools).toEqual(['web_search', 'shell'])
      expect(result.emoji).toBe('🔍')
      expect(result.envKeys).toEqual(['PERPLEXITY_API_KEY'])
      expect(result.envDescriptions).toEqual({ PERPLEXITY_API_KEY: 'Your Perplexity API key' })
    })

    it('parses env vars from format 1 (metadata.clawdbot.env as Object)', () => {
      const content = `---
name: test-skill
description: Test
metadata:
  clawdbot:
    env:
      API_KEY: "The API key"
      SECRET: "The secret"
---
body`

      const result = parseSkillMd(content)
      expect(result.envKeys).toEqual(['API_KEY', 'SECRET'])
      expect(result.envDescriptions).toEqual({
        API_KEY: 'The API key',
        SECRET: 'The secret',
      })
    })

    it('parses env vars from format 2 (metadata.clawdbot.requires.env as Array)', () => {
      const content = `---
name: test-skill
description: Test
metadata:
  clawdbot:
    requires:
      env:
        - API_KEY
        - SECRET
---
body`

      const result = parseSkillMd(content)
      expect(result.envKeys).toEqual(['API_KEY', 'SECRET'])
      expect(result.envDescriptions).toEqual({})
    })

    it('merges both env var formats without duplicates', () => {
      const content = `---
name: test-skill
description: Test
metadata:
  clawdbot:
    env:
      API_KEY: "The API key"
    requires:
      env:
        - API_KEY
        - EXTRA_KEY
---
body`

      const result = parseSkillMd(content)
      expect(result.envKeys).toEqual(['API_KEY', 'EXTRA_KEY'])
      expect(result.envDescriptions).toEqual({ API_KEY: 'The API key' })
    })

    it('extracts emoji from metadata', () => {
      const content = `---
name: test-skill
description: Test
metadata:
  clawdbot:
    emoji: "🚀"
---
body`

      const result = parseSkillMd(content)
      expect(result.emoji).toBe('🚀')
    })

    it('handles missing metadata gracefully', () => {
      const content = `---
name: simple-skill
description: A simple skill
---
body`

      const result = parseSkillMd(content)
      expect(result.envKeys).toEqual([])
      expect(result.envDescriptions).toEqual({})
      expect(result.emoji).toBeUndefined()
      expect(result.rawMetadata).toBeUndefined()
    })

    it('throws on missing frontmatter', () => {
      expect(() => parseSkillMd('# No frontmatter')).toThrow('no valid YAML frontmatter')
    })

    it('throws on missing name', () => {
      const content = `---
description: No name
---
body`
      expect(() => parseSkillMd(content)).toThrow('missing required "name"')
    })

    it('auto-slugifies invalid names', () => {
      const content = `---
name: Agent Browser
description: A browser skill
---
body`
      const result = parseSkillMd(content)
      expect(result.name).toBe('agent-browser')
    })

    it('auto-slugifies names with underscores', () => {
      const content = `---
name: Invalid_Name
description: Bad name
---
body`
      const result = parseSkillMd(content)
      expect(result.name).toBe('invalid-name')
    })

    it('throws on missing description', () => {
      const content = `---
name: test-skill
---
body`
      expect(() => parseSkillMd(content)).toThrow('missing required "description"')
    })

    it('parses optional required_env_vars / platforms / requires_toolsets', () => {
      const content = `---
name: gated-skill
description: Gated
required_env_vars:
  - BRAVE_API_KEY
  - OTHER_KEY
platforms:
  - linux
  - macos
requires_toolsets:
  - web_fetch
  - shell
---
body`
      const result = parseSkillMd(content)
      expect(result.requiredEnvVars).toEqual(['BRAVE_API_KEY', 'OTHER_KEY'])
      expect(result.platforms).toEqual(['linux', 'macos'])
      expect(result.requiresToolsets).toEqual(['web_fetch', 'shell'])
    })

    it('leaves gating fields undefined when absent (backward compat)', () => {
      const content = `---
name: plain-skill
description: Plain
---
body`
      const result = parseSkillMd(content)
      expect(result.requiredEnvVars).toBeUndefined()
      expect(result.platforms).toBeUndefined()
      expect(result.requiresToolsets).toBeUndefined()
    })

    it('ignores non-string entries in gating arrays', () => {
      const content = `---
name: mixed-skill
description: Mixed
platforms:
  - linux
  - 42
  - null
required_env_vars: "not-an-array"
---
body`
      const result = parseSkillMd(content)
      expect(result.platforms).toEqual(['linux'])
      expect(result.requiredEnvVars).toBeUndefined()
    })
  })
})
