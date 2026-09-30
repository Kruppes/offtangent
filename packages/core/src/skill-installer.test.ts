import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseSkillSource, downloadSkillDirectory, installSkill, type FetchFn } from './skill-installer.js'

describe('skill-installer', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    delete process.env.DATA_DIR
  })

  function makeTmpDir(): string {
    tmpDir = path.join(os.tmpdir(), `axiom-skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    return tmpDir
  }

  describe('parseSkillSource', () => {
    it('parses OpenClaw shorthand', () => {
      const source = parseSkillSource('zats/perplexity')
      expect(source.type).toBe('openclaw')
      expect(source.owner).toBe('zats')
      expect(source.name).toBe('perplexity')
      expect(source.apiUrl).toBe('https://api.github.com/repos/openclaw/skills/contents/skills/zats/perplexity')
      expect(source.sourceUrl).toBe('https://github.com/openclaw/skills/tree/main/skills/zats/perplexity')
    })

    it('parses GitHub URL', () => {
      const source = parseSkillSource('https://github.com/anthropics/courses/tree/master/skills/computer-use')
      expect(source.type).toBe('github')
      expect(source.owner).toBe('anthropics')
      expect(source.name).toBe('computer-use')
      expect(source.apiUrl).toBe('https://api.github.com/repos/anthropics/courses/contents/skills/computer-use?ref=master')
      expect(source.sourceUrl).toBe('https://github.com/anthropics/courses/tree/master/skills/computer-use')
    })

    it('handles trimming whitespace', () => {
      const source = parseSkillSource('  zats/perplexity  ')
      expect(source.type).toBe('openclaw')
      expect(source.owner).toBe('zats')
    })

    it('normalizes GitHub /blob/ URL to /tree/', () => {
      const source = parseSkillSource('https://github.com/openclaw/openclaw/blob/main/skills/weather')
      expect(source.type).toBe('github')
      expect(source.owner).toBe('openclaw')
      expect(source.name).toBe('weather')
      expect(source.apiUrl).toBe('https://api.github.com/repos/openclaw/openclaw/contents/skills/weather?ref=main')
      expect(source.sourceUrl).toBe('https://github.com/openclaw/openclaw/tree/main/skills/weather')
    })

    it('throws on invalid input', () => {
      expect(() => parseSkillSource('invalid')).toThrow('Invalid skill source')
      expect(() => parseSkillSource('a/b/c')).toThrow('Invalid skill source')
    })

    it('throws on GitHub URL without branch/path', () => {
      expect(() => parseSkillSource('https://github.com/owner/repo')).toThrow('must include branch and directory path')
    })
  })

  describe('downloadSkillDirectory', () => {
    it('downloads files and subdirectories recursively', async () => {
      const destDir = path.join(makeTmpDir(), 'skill')

      const mockFetch: FetchFn = async (url: string) => {
        if (url === 'https://api.github.com/repos/openclaw/skills/contents/skills/test') {
          // Root directory listing
          return new Response(JSON.stringify([
            { name: 'SKILL.md', path: 'skills/test/SKILL.md', type: 'file', download_url: 'https://raw.example.com/SKILL.md', url: '' },
            { name: 'scripts', path: 'skills/test/scripts', type: 'dir', download_url: null, url: 'https://api.github.com/repos/x/y/contents/skills/test/scripts' },
          ]), { status: 200 })
        }
        if (url === 'https://api.github.com/repos/x/y/contents/skills/test/scripts') {
          // Subdirectory listing
          return new Response(JSON.stringify([
            { name: 'setup.sh', path: 'skills/test/scripts/setup.sh', type: 'file', download_url: 'https://raw.example.com/setup.sh', url: '' },
          ]), { status: 200 })
        }
        if (url.includes('SKILL.md')) {
          return new Response('---\nname: test\ndescription: Test\n---\n# Test', { status: 200 })
        }
        if (url.includes('setup.sh')) {
          return new Response('#!/bin/bash\necho hello', { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      }

      const count = await downloadSkillDirectory(
        'https://api.github.com/repos/openclaw/skills/contents/skills/test',
        destDir,
        mockFetch,
      )

      expect(count).toBe(2)
      expect(fs.existsSync(path.join(destDir, 'SKILL.md'))).toBe(true)
      expect(fs.existsSync(path.join(destDir, 'scripts', 'setup.sh'))).toBe(true)
      expect(fs.readFileSync(path.join(destDir, 'scripts', 'setup.sh'), 'utf-8')).toBe('#!/bin/bash\necho hello')
    })

    it('throws on API error', async () => {
      const destDir = path.join(makeTmpDir(), 'skill')
      const mockFetch: FetchFn = async () => new Response('{"message": "Not Found"}', { status: 404 })

      await expect(downloadSkillDirectory('https://api.github.com/repos/x/y/contents/z', destDir, mockFetch))
        .rejects.toThrow('GitHub API error (404)')
    })

    it('throws on non-directory response', async () => {
      const destDir = path.join(makeTmpDir(), 'skill')
      const mockFetch: FetchFn = async () => new Response('{"type": "file"}', { status: 200 })

      await expect(downloadSkillDirectory('https://api.github.com/repos/x/y/contents/z', destDir, mockFetch))
        .rejects.toThrow('did not return a directory listing')
    })
  })

  describe('installSkill', () => {
    it('installs a skill from OpenClaw shorthand', async () => {
      const dir = makeTmpDir()
      process.env.DATA_DIR = dir

      const skillMdContent = `---
name: test-skill
description: A test skill
metadata:
  clawdbot:
    emoji: "🧪"
    env:
      TEST_KEY: "A test key"
---
# Test Skill`

      const mockFetch: FetchFn = async (url: string) => {
        if (url.includes('/contents/')) {
          return new Response(JSON.stringify([
            { name: 'SKILL.md', path: 'skills/owner/test-skill/SKILL.md', type: 'file', download_url: 'https://raw.example.com/SKILL.md', url: '' },
          ]), { status: 200 })
        }
        if (url.includes('SKILL.md')) {
          return new Response(skillMdContent, { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      }

      const result = await installSkill('owner/test-skill', mockFetch)

      expect(result.source.type).toBe('openclaw')
      expect(result.source.owner).toBe('owner')
      expect(result.source.name).toBe('test-skill')
      expect(result.parsed.name).toBe('test-skill')
      expect(result.parsed.description).toBe('A test skill')
      expect(result.parsed.emoji).toBe('🧪')
      expect(result.parsed.envKeys).toEqual(['TEST_KEY'])
      expect(result.filesDownloaded).toBe(1)
      expect(result.installPath).toBe(path.join(dir, 'skills', 'owner', 'test-skill'))
      expect(fs.existsSync(path.join(result.installPath, 'SKILL.md'))).toBe(true)
    })

    it('throws if SKILL.md is missing after download', async () => {
      const dir = makeTmpDir()
      process.env.DATA_DIR = dir

      const mockFetch: FetchFn = async (url: string) => {
        if (url.includes('/contents/')) {
          return new Response(JSON.stringify([
            { name: 'README.md', path: 'x/README.md', type: 'file', download_url: 'https://raw.example.com/README.md', url: '' },
          ]), { status: 200 })
        }
        if (url.includes('README.md')) {
          return new Response('# Readme', { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      }

      await expect(installSkill('owner/bad-skill', mockFetch))
        .rejects.toThrow('does not contain a SKILL.md file')

      // Should clean up on failure
      expect(fs.existsSync(path.join(dir, 'skills', 'owner', 'bad-skill'))).toBe(false)
    })
  })
})
