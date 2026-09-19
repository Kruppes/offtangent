import { describe, it, expect, afterEach } from 'vitest'
import {
  ensureMemoryStructure,
  ensureConfigStructure,
  readSoulFile,
  readMemoryFile,
  writeMemoryFile,
  readAgentsRulesFile,
  readHeartbeatFile,
  readTasksGuidelinesFile,
  writeTasksGuidelinesFile,
  getDefaultTasksGuidelinesContent,
  ensureDailyFile,
  readDailyFile,
  appendToDailyFile,
  readRecentDailyFiles,
  assembleSystemPrompt,
  formatRuntimeInstanceBlock,
  getUserProfileDir,
  ensureUserProfile,
  readUserProfile,
  ensureWikiDir,
  ensureSourcesDir,
  ensureProjectsDir,
  parseProjectAliases,
  listWikiPages,
  listProjectNotes,
  getAgentMemoryDir,
  resolveAgentMemoryDir,
  ensurePersonaMemoryRoots,
} from './memory.js'
import { clearPersonaCache } from './persona-loader.js'
import { SYSTEM_PROMPT_CACHE_MARKER, splitSystemPromptAtCacheMarker } from './prompt-cache.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('memory', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    tmpDir = path.join(os.tmpdir(), `axiom-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return tmpDir
  }

  describe('ensureMemoryStructure', () => {
    it('creates memory directory structure including users/ and wiki/', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      expect(fs.existsSync(dir)).toBe(true)
      expect(fs.existsSync(path.join(dir, 'daily'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'users'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'SOUL.md'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true)
      // AGENTS.md and HEARTBEAT.md are now in config dir, not memory dir
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'HEARTBEAT.md'))).toBe(false)
    })

    it('creates sources/ directory with README on first run', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const sourcesDir = path.join(dir, 'sources')
      expect(fs.existsSync(sourcesDir)).toBe(true)

      const readmePath = path.join(sourcesDir, 'README.md')
      expect(fs.existsSync(readmePath)).toBe(true)
      const readme = fs.readFileSync(readmePath, 'utf-8')
      expect(readme).toContain('# Sources')
      expect(readme).toContain('Immutable')

      // Subfolders (articles/, youtube/, ...) should NOT be auto-created
      expect(fs.existsSync(path.join(sourcesDir, 'articles'))).toBe(false)
      expect(fs.existsSync(path.join(sourcesDir, 'youtube'))).toBe(false)
    })

    it('migrates projects/ to wiki/ on first run', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      // Create a legacy projects/ directory with a file
      const projectsDir = path.join(dir, 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(path.join(projectsDir, 'myproject.md'), '# My Project\n', 'utf-8')

      ensureMemoryStructure(dir)

      // projects/ should be gone, wiki/ should exist with the migrated file
      expect(fs.existsSync(path.join(dir, 'projects'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'wiki', 'myproject.md'))).toBe(true)
    })

    it('does not overwrite existing files', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Custom Soul', 'utf-8')

      ensureMemoryStructure(dir)

      const content = fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf-8')
      expect(content).toBe('# Custom Soul')
    })
  })

  describe('ensureSourcesDir', () => {
    it('is idempotent and does not overwrite an existing README', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      const sourcesDir = ensureSourcesDir(dir)
      expect(sourcesDir).toBe(path.join(dir, 'sources'))

      // User edits the README
      const readmePath = path.join(sourcesDir, 'README.md')
      fs.writeFileSync(readmePath, '# My Custom Sources Index\n', 'utf-8')

      // Second call must not overwrite user edits
      ensureSourcesDir(dir)
      const content = fs.readFileSync(readmePath, 'utf-8')
      expect(content).toBe('# My Custom Sources Index\n')
    })
  })

  describe('readSoulFile', () => {
    it('reads SOUL.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readSoulFile(dir)
      expect(content).toContain('# Soul')
      expect(content).toContain('Personality')
    })

    it('creates SOUL.md if missing', () => {
      const dir = makeTmpDir()
      // Don't call ensureMemoryStructure first
      const content = readSoulFile(dir)
      expect(content).toContain('# Soul')
    })
  })

  describe('readMemoryFile / writeMemoryFile', () => {
    it('reads MEMORY.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readMemoryFile(dir)
      expect(content).toContain('# Agent Memory')
      expect(content).toContain('Learned Lessons')
    })

    it('writes and reads back MEMORY.md', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const newContent = '# Agent Memory\n\n## Learned: Testing works!\n'
      writeMemoryFile(newContent, dir)

      const content = readMemoryFile(dir)
      expect(content).toBe(newContent)
    })

    it('migrates legacy AGENTS.md to MEMORY.md when no MEMORY.md exists', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.mkdirSync(path.join(dir, 'daily'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Soul', 'utf-8')
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Legacy Content\n', 'utf-8')

      ensureMemoryStructure(dir)

      expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true)
      const content = readMemoryFile(dir)
      expect(content).toBe('# Legacy Content\n')
      // After migration, AGENTS.md was renamed to MEMORY.md and no longer exists in memory dir
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false)
    })
  })

  describe('daily memory files', () => {
    it('auto-creates daily file with header', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const filePath = ensureDailyFile(undefined, dir)

      expect(fs.existsSync(filePath)).toBe(true)
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('# Daily Memory')

      const today = new Date().toISOString().split('T')[0]
      expect(filePath).toContain(`${today}.md`)
    })

    it('creates daily file at correct path', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const date = new Date('2025-06-15T12:00:00Z')
      const filePath = ensureDailyFile(date, dir)

      expect(filePath).toContain(path.join('daily', '2025-06-15.md'))
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('2025-06-15')
    })

    it('reads daily file', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readDailyFile(undefined, dir)
      expect(content).toContain('# Daily Memory')
    })

    it('appends to daily file', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      appendToDailyFile('\n## Test Entry\n\nSome content\n', undefined, dir)

      const content = readDailyFile(undefined, dir)
      expect(content).toContain('## Test Entry')
      expect(content).toContain('Some content')
    })

    it('appends multiple entries to daily file', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      appendToDailyFile('\n## Entry 1\n\nFirst\n', undefined, dir)
      appendToDailyFile('\n## Entry 2\n\nSecond\n', undefined, dir)

      const content = readDailyFile(undefined, dir)
      expect(content).toContain('## Entry 1')
      expect(content).toContain('## Entry 2')
      expect(content).toContain('First')
      expect(content).toContain('Second')
    })
  })

  describe('readRecentDailyFiles', () => {
    it('returns empty string when no daily files exist', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readRecentDailyFiles(3, dir)
      expect(content).toBe('')
    })

    it('reads recent daily files with content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      // Write to today's daily file with some content beyond the header
      appendToDailyFile('\n## Session\n\nDid something today\n', undefined, dir)

      const content = readRecentDailyFiles(3, dir)
      expect(content).toContain('Did something today')
    })
  })

  describe('readAgentsRulesFile', () => {
    it('reads AGENTS.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readAgentsRulesFile(dir)
      expect(content).toContain('# Agent Contract')
      expect(content).toContain('Communication Rules')
    })

    it('creates AGENTS.md if missing', () => {
      const dir = makeTmpDir()
      const content = readAgentsRulesFile(dir)
      expect(content).toContain('# Agent Contract')
    })
  })

  describe('readHeartbeatFile', () => {
    it('reads HEARTBEAT.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readHeartbeatFile(dir)
      expect(content).toContain('# Heartbeat Tasks')
      expect(content).not.toContain('Daily Memory Update')
    })

    it('creates HEARTBEAT.md if missing', () => {
      const dir = makeTmpDir()
      const content = readHeartbeatFile(dir)
      expect(content).toContain('# Heartbeat Tasks')
    })
  })

  describe('TASKS.md (background task guidelines)', () => {
    it('ensureConfigStructure creates TASKS.md from the default template', () => {
      const dir = makeTmpDir()
      ensureConfigStructure(dir)

      const tasksPath = path.join(dir, 'TASKS.md')
      expect(fs.existsSync(tasksPath)).toBe(true)
      const content = fs.readFileSync(tasksPath, 'utf-8')
      expect(content).toBe(getDefaultTasksGuidelinesContent())
      expect(content).toContain('# Background Task Guidelines')
      expect(content).toContain('Work independently for as long as possible')
      expect(content).toContain('Do NOT just describe what you did')
    })

    it('readTasksGuidelinesFile creates TASKS.md if missing and returns content', () => {
      const dir = makeTmpDir()
      const content = readTasksGuidelinesFile(dir)
      expect(content).toContain('# Background Task Guidelines')
      expect(fs.existsSync(path.join(dir, 'TASKS.md'))).toBe(true)
    })

    it('readTasksGuidelinesFile reads existing custom content unchanged', () => {
      const dir = makeTmpDir()
      ensureConfigStructure(dir)
      const custom = '# Background Task Guidelines\n\n- Be brief.\n'
      fs.writeFileSync(path.join(dir, 'TASKS.md'), custom, 'utf-8')

      const content = readTasksGuidelinesFile(dir)
      expect(content).toBe(custom)
    })

    it('writeTasksGuidelinesFile persists user edits', () => {
      const dir = makeTmpDir()
      writeTasksGuidelinesFile('# Custom\n- one rule\n', dir)

      const onDisk = fs.readFileSync(path.join(dir, 'TASKS.md'), 'utf-8')
      expect(onDisk).toBe('# Custom\n- one rule\n')
      expect(readTasksGuidelinesFile(dir)).toBe('# Custom\n- one rule\n')
    })

    it('ensureConfigStructure does not overwrite existing TASKS.md', () => {
      const dir = makeTmpDir()
      ensureConfigStructure(dir)
      fs.writeFileSync(path.join(dir, 'TASKS.md'), '# Mine\n', 'utf-8')

      ensureConfigStructure(dir)
      expect(fs.readFileSync(path.join(dir, 'TASKS.md'), 'utf-8')).toBe('# Mine\n')
    })
  })

  describe('ensureConfigStructure legacy migration scope', () => {
    // Regression: ensureConfigStructure() takes an explicit configDir, but the
    // legacy source path came from getMemoryDir(), which resolves from DATA_DIR
    // and ignores that argument. Calling it with an injected directory would
    // therefore renameSync() the *live* /data/memory files into that directory.
    // On a separate filesystem that failed with EXDEV (masking the bug); on a
    // shared filesystem it silently moved real user files away.
    it('never moves files out of the live memory dir when given an explicit configDir', () => {
      const prevDataDir = process.env.DATA_DIR
      const dataDir = makeTmpDir()
      const liveMemoryDir = path.join(dataDir, 'memory')
      fs.mkdirSync(liveMemoryDir, { recursive: true })

      // Legacy files present in the live memory dir, on the SAME filesystem as
      // the target dir - so a stray renameSync would succeed instead of EXDEV.
      const liveAgents = path.join(liveMemoryDir, 'AGENTS.md')
      const liveHeartbeat = path.join(liveMemoryDir, 'HEARTBEAT.md')
      fs.writeFileSync(liveAgents, '# Live agent rules\n', 'utf-8')
      fs.writeFileSync(liveHeartbeat, '# Live heartbeat\n', 'utf-8')

      process.env.DATA_DIR = dataDir
      try {
        const injectedConfigDir = path.join(dataDir, 'injected-config')
        ensureConfigStructure(injectedConfigDir)

        // The live files must still be there, with their original content.
        expect(fs.existsSync(liveAgents)).toBe(true)
        expect(fs.existsSync(liveHeartbeat)).toBe(true)
        expect(fs.readFileSync(liveAgents, 'utf-8')).toBe('# Live agent rules\n')
        expect(fs.readFileSync(liveHeartbeat, 'utf-8')).toBe('# Live heartbeat\n')

        // The injected dir gets fresh templates, not the migrated live content.
        const injectedAgents = fs.readFileSync(path.join(injectedConfigDir, 'AGENTS.md'), 'utf-8')
        expect(injectedAgents).not.toBe('# Live agent rules\n')
        expect(injectedAgents).toContain('# Agent Contract')
      } finally {
        if (prevDataDir === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = prevDataDir
      }
    })

    it('still migrates legacy files when operating on the real config dir', () => {
      const prevDataDir = process.env.DATA_DIR
      const dataDir = makeTmpDir()
      const liveMemoryDir = path.join(dataDir, 'memory')
      fs.mkdirSync(liveMemoryDir, { recursive: true })
      fs.writeFileSync(path.join(liveMemoryDir, 'AGENTS.md'), '# Legacy rules\n', 'utf-8')

      process.env.DATA_DIR = dataDir
      try {
        // No configDir argument: the real config dir under DATA_DIR is used.
        ensureConfigStructure()

        const migrated = path.join(dataDir, 'config', 'AGENTS.md')
        expect(fs.readFileSync(migrated, 'utf-8')).toBe('# Legacy rules\n')
        expect(fs.existsSync(path.join(liveMemoryDir, 'AGENTS.md'))).toBe(false)
      } finally {
        if (prevDataDir === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = prevDataDir
      }
    })
  })

  describe('assembleSystemPrompt', () => {
    it('combines all memory tiers into a coherent prompt', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      // Should contain personality block
      expect(prompt).toContain('<personality>')
      expect(prompt).toContain('# Soul')
      expect(prompt).toContain('</personality>')

      // Should contain core memory block
      expect(prompt).toContain('<core_memory>')
      expect(prompt).toContain('# Agent Memory')
      expect(prompt).toContain('</core_memory>')
    })

    it('keeps the stable prefix before the dynamic tail (SPEC 11.5 prompt cache)', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      fs.writeFileSync(path.join(dir, 'daily', `${new Date().toISOString().slice(0, 10)}.md`), '# Daily\n\n## 10:00\n\nSomething happened today.\n')

      const prompt = assembleSystemPrompt({ memoryDir: dir, currentUser: { username: 'nico' } })

      const at = (tag: string) => {
        const i = prompt.indexOf(tag)
        expect(i, tag).toBeGreaterThanOrEqual(0)
        return i
      }
      // Constant blocks first...
      expect(at('<personality>')).toBeLessThan(at('<agent_rules>'))
      expect(at('<agent_rules>')).toBeLessThan(at('<available_tools>'))
      expect(at('<available_tools>')).toBeLessThan(at('<memory_paths>'))
      expect(at('<memory_paths>')).toBeLessThan(at('<task_system>'))
      expect(at('<task_system>')).toBeLessThan(at('<workspace>'))
      // ...then everything that changes daily or on consolidation...
      expect(at('<workspace>')).toBeLessThan(at('<core_memory>'))
      expect(at('<core_memory>')).toBeLessThan(at('<recent_memory>'))
      expect(at('<recent_memory>')).toBeLessThan(at('<user_profile>'))
      // ...and the date stays last.
      expect(at('<user_profile>')).toBeLessThan(at('<current_date>'))
    })

    it('puts the cache breakpoint marker exactly between the stable prefix and the volatile tail', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      appendToDailyFile('\n## Session\n\nToday: shipped the cache fix\n', undefined, dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir, currentUser: { username: 'nico' } })
      const marker = prompt.indexOf(SYSTEM_PROMPT_CACHE_MARKER)

      expect(marker).toBeGreaterThan(0)
      expect(prompt.indexOf(SYSTEM_PROMPT_CACHE_MARKER, marker + 1)).toBe(-1)
      // Stable blocks are in front of it...
      for (const tag of ['<personality>', '<agent_rules>', '<available_tools>', '<memory_paths>', '<task_system>', '<workspace>']) {
        expect(prompt.indexOf(tag), tag).toBeLessThan(marker)
      }
      // ...volatile ones behind it.
      for (const tag of ['<core_memory>', '<recent_memory>', '<user_profile>', '<current_date>']) {
        expect(prompt.indexOf(tag), tag).toBeGreaterThan(marker)
      }

      // The split is byte-neutral: stripping the marker yields exactly the
      // prompt an assembly without a marker would produce.
      const { text, prefixChars } = splitSystemPromptAtCacheMarker(prompt)
      expect(text).not.toContain(SYSTEM_PROMPT_CACHE_MARKER)
      expect(prefixChars).not.toBeNull()
      expect(text.slice(0, prefixChars!)).toContain('<workspace>')
      expect(text.slice(prefixChars!)).toContain('<core_memory>')
      expect(text.slice(prefixChars!)).not.toContain('<workspace>')
    })

    it('names today\'s daily file in the volatile tail, not in the stable prefix', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })
      const today = new Date().toISOString().split('T')[0]
      const todayPath = path.join(dir, 'daily', `${today}.md`)

      expect(prompt).toContain(todayPath)
      const { text, prefixChars } = splitSystemPromptAtCacheMarker(prompt)
      // A date-bearing path inside the cached prefix would rotate it daily.
      expect(text.slice(0, prefixChars!)).not.toContain(todayPath)
      expect(text.slice(prefixChars!)).toContain(todayPath)
      // The directory pointer stays available in <memory_paths>.
      expect(text.slice(0, prefixChars!)).toContain(path.join(dir, 'daily/'))
    })

    it('keeps the stable prefix byte-identical across two assemblies while the tail changes', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      appendToDailyFile('\n## Session\n\nFirst note\n', undefined, dir)

      const first = splitSystemPromptAtCacheMarker(assembleSystemPrompt({ memoryDir: dir, currentUser: { username: 'nico' } }))

      // The agent writes to its own memory mid-session — exactly the event that
      // used to invalidate the whole system prompt.
      appendToDailyFile('\n## Session\n\nSecond note written mid-session\n', undefined, dir)
      writeMemoryFile('# Agent Memory\n\nA new lesson.\n', dir)

      const second = splitSystemPromptAtCacheMarker(assembleSystemPrompt({ memoryDir: dir, currentUser: { username: 'nico' } }))

      expect(second.prefixChars).toBe(first.prefixChars)
      expect(second.text.slice(0, second.prefixChars!)).toBe(first.text.slice(0, first.prefixChars!))
      // ...and the tail really did change, otherwise the test proves nothing.
      expect(second.text.slice(second.prefixChars!)).not.toBe(first.text.slice(first.prefixChars!))
      expect(second.text).toContain('Second note written mid-session')
    })

    it('caps the recent_memory block at the configured character budget', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      appendToDailyFile(`\n## Session\n\nYESTERDAY-HEAD\n${'y'.repeat(6000)}\nYESTERDAY-TAIL\n`, yesterday, dir)
      appendToDailyFile(`\n## Session\n\nTODAY-HEAD\n${'t'.repeat(6000)}\nTODAY-TAIL\n`, undefined, dir)

      setHeuristicsOverrideForTests({ recentMemory: { maxChars: 8000, days: 3, warnFactor: 0 } })
      try {
        const prompt = assembleSystemPrompt({ memoryDir: dir })
        const block = prompt.slice(prompt.indexOf('<recent_memory>'), prompt.indexOf('</recent_memory>'))

        expect(block.length).toBeLessThan(8500)
        // Newest day survives in full, the older one is cut back to its tail.
        expect(block).toContain('TODAY-HEAD')
        expect(block).toContain('TODAY-TAIL')
        expect(block).not.toContain('YESTERDAY-HEAD')
        // ...and the cut is declared with the file to read for the rest.
        expect(block).toContain('[truncated:')
        expect(block).toContain(path.join(dir, 'daily'))
      } finally {
        setHeuristicsOverrideForTests(null)
      }
    })

    it('leaves a small recent_memory block untouched', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      appendToDailyFile('\n## Session\n\nToday: debugged the webhook\n', undefined, dir)

      setHeuristicsOverrideForTests({ recentMemory: { maxChars: 8000, days: 3, warnFactor: 3 } })
      try {
        const prompt = assembleSystemPrompt({ memoryDir: dir })
        expect(prompt).toContain('Today: debugged the webhook')
        expect(prompt).not.toContain('[truncated:')
        expect(prompt).not.toContain('[omitted:')
      } finally {
        setHeuristicsOverrideForTests(null)
      }
    })

    it('includes base instructions when provided', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        baseInstructions: 'Always respond in German.',
      })

      expect(prompt).toContain('<instructions>')
      expect(prompt).toContain('Always respond in German.')
      expect(prompt).toContain('</instructions>')
    })

    it('includes recent daily context when available', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      // Add content to today's daily
      appendToDailyFile('\n## Session\n\nUser asked about deployment\n', undefined, dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<recent_memory>')
      expect(prompt).toContain('User asked about deployment')
      expect(prompt).toContain('</recent_memory>')
    })

    it('excludes recent_memory block when no daily content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).not.toContain('<recent_memory>')
    })

    it('uses custom SOUL.md content in personality block', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Custom Personality\n\nI am a pirate!\n', 'utf-8')
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('I am a pirate!')
    })

    it('includes agent_rules section with AGENTS.md content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<agent_rules>')
      expect(prompt).toContain('# Agent Contract')
      expect(prompt).toContain('</agent_rules>')
    })

    it('tells personas when to send a canvas artifact (SPEC 7.4b)', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<canvas>')
      expect(prompt).toContain('```html')
      // The decision rule from the SPEC, verbatim in substance.
      expect(prompt).toContain('visual, tabular beyond four columns, interactive')
      expect(prompt).toContain('one or two sentence text summary')
      // …and the constraints that follow from the sandbox, so a model does not
      // ship a page that silently breaks behind the CSP.
      expect(prompt).toContain('No <script src>')
      expect(prompt).toContain('2 MB')
      expect(prompt).toContain('</canvas>')
    })

    it('includes search_memories in the available tools section', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<available_tools>')
      expect(prompt).toContain('search_memories')
      expect(prompt).toContain('fact memory')
    })

    it('includes memory_paths section with all file paths including wiki/', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<memory_paths>')
      expect(prompt).toContain('SOUL.md')
      expect(prompt).toContain('MEMORY.md')
      expect(prompt).toContain('AGENTS.md')
      expect(prompt).toContain('HEARTBEAT.md')
      expect(prompt).toContain('daily/')
      expect(prompt).toContain('wiki/')
      expect(prompt).toContain('read_file, write_file, and edit_file')
      expect(prompt).toContain('</memory_paths>')
    })

    it('includes Sources directory reference in memory_paths', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<memory_paths>')
      expect(prompt).toContain('Sources directory')
      expect(prompt).toContain(path.join(dir, 'sources'))
    })

    it('includes axiom_docs section pointing at README and the three docs subdirectories', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      // Block markers + the three top-level docs dirs the agent can list_files on.
      // We deliberately do NOT assert on individual topic→file routes — the block
      // no longer carries them; the agent discovers files via list_files instead.
      expect(prompt).toContain('<axiom_docs>')
      expect(prompt).toContain('README.md')
      expect(prompt).toContain('docs/concepts/')
      expect(prompt).toContain('docs/guide/')
      expect(prompt).toContain('docs/reference/')
      expect(prompt).toContain('Do not write to these files')
      expect(prompt).toContain('</axiom_docs>')
    })

    it('includes wiki_pages section when wiki pages exist', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      // Create a wiki page
      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'axiom.md'), '---\naliases: [Axiom, the-axiom]\n---\n# Project: Axiom\n', 'utf-8')

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<wiki_pages>')
      expect(prompt).toContain('axiom.md')
      expect(prompt).toContain('Axiom')
      expect(prompt).toContain('the-axiom')
      expect(prompt).toContain('load it with read_file')
      expect(prompt).toContain('Maintain and organize it autonomously')
      expect(prompt).toContain('wiki/SKILL.md')
      expect(prompt).toContain('genuine contradiction')
      expect(prompt).toContain('</wiki_pages>')
    })

    it('excludes wiki_pages section when no wiki pages exist', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).not.toContain('<wiki_pages>')
    })

    it('default options produce a byte-identical prompt to the explicit full profile', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      appendToDailyFile('\n## Session\n\nWorked on deployment\n', undefined, dir)
      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'axiom.md'), '# Project: Axiom\n', 'utf-8')

      // No profile options at all ≡ explicit full-profile values. Guards the
      // guarantee that providers without `promptProfile` keep today's prompt.
      const implicitDefault = assembleSystemPrompt({ memoryDir: dir })
      const explicitFull = assembleSystemPrompt({
        memoryDir: dir,
        recentDays: 3,
        includeWikiPages: true,
        includeAxiomDocs: true,
      })

      expect(explicitFull).toBe(implicitDefault)
    })

    it('includeWikiPages: false drops the wiki_pages block even when pages exist', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'axiom.md'), '# Project: Axiom\n', 'utf-8')

      const prompt = assembleSystemPrompt({ memoryDir: dir, includeWikiPages: false })

      expect(prompt).not.toContain('<wiki_pages>')
      // The wiki directory path must still be listed in memory_paths so the
      // agent can read/write wiki files on demand.
      expect(prompt).toContain('Wiki pages directory')
    })

    it('includeAxiomDocs: false drops the axiom_docs block', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir, includeAxiomDocs: false })

      expect(prompt).not.toContain('<axiom_docs>')
    })

    it('recentDays: 1 injects only today\'s daily file', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      appendToDailyFile('\n## Session\n\nYesterday: reviewed the backup strategy\n', yesterday, dir)
      appendToDailyFile('\n## Session\n\nToday: debugged the webhook\n', undefined, dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir, recentDays: 1 })

      expect(prompt).toContain('<recent_memory>')
      expect(prompt).toContain('Today: debugged the webhook')
      expect(prompt).not.toContain('Yesterday: reviewed')
    })

    it('recentDays: 0 drops the recent_memory block entirely', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      appendToDailyFile('\n## Session\n\nToday: debugged the webhook\n', undefined, dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir, recentDays: 0 })

      expect(prompt).not.toContain('<recent_memory>')
    })

    it('slim-profile options keep all core sections intact', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      appendToDailyFile('\n## Session\n\nToday: debugged the webhook\n', undefined, dir)

      // Mirrors resolvePromptProfileOptions('slim') in provider-config.ts.
      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        recentDays: 1,
        includeWikiPages: false,
        includeAxiomDocs: false,
      })

      // Core knowledge must survive every profile.
      expect(prompt).toContain('<personality>')
      expect(prompt).toContain('<agent_rules>')
      expect(prompt).toContain('<core_memory>')
      expect(prompt).toContain('<available_tools>')
      expect(prompt).toContain('<memory_paths>')
      expect(prompt).toContain('<task_system>')
      expect(prompt).toContain('<recent_memory>')
      // Trimmed blocks
      expect(prompt).not.toContain('<axiom_docs>')
      expect(prompt).not.toContain('<wiki_pages>')
    })

    describe('runtime_instance (instanceIdentity setting)', () => {
      const identity = {
        name: 'Offtangent',
        notes: 'The neighbour container named axiom is the LEGACY instance.',
      }

      it('renders name and notes as the first block of the prompt', () => {
        const dir = makeTmpDir()
        ensureMemoryStructure(dir)

        const prompt = assembleSystemPrompt({ memoryDir: dir, instanceIdentity: identity })

        expect(prompt.startsWith(
          '<runtime_instance>\n'
          + 'You are running inside the "Offtangent" instance. '
          + 'The neighbour container named axiom is the LEGACY instance.\n'
          + '</runtime_instance>',
        )).toBe(true)
        // Placed before the personality so identity is settled before persona text.
        expect(prompt.indexOf('<runtime_instance>')).toBeLessThan(prompt.indexOf('<personality>'))
      })

      it('renders the name alone when notes are missing or empty', () => {
        const dir = makeTmpDir()
        ensureMemoryStructure(dir)

        const prompt = assembleSystemPrompt({ memoryDir: dir, instanceIdentity: { name: 'Canary', notes: '  ' } })

        expect(prompt).toContain('<runtime_instance>\nYou are running inside the "Canary" instance.\n</runtime_instance>')
      })

      it('is absent when the setting is unset, null or has an empty name', () => {
        const dir = makeTmpDir()
        ensureMemoryStructure(dir)

        expect(assembleSystemPrompt({ memoryDir: dir })).not.toContain('<runtime_instance>')
        expect(assembleSystemPrompt({ memoryDir: dir, instanceIdentity: null })).not.toContain('<runtime_instance>')
        expect(assembleSystemPrompt({ memoryDir: dir, instanceIdentity: { name: '' } })).not.toContain('<runtime_instance>')
        // Notes without a name do not switch the block on either.
        expect(assembleSystemPrompt({ memoryDir: dir, instanceIdentity: { name: '   ', notes: 'x' } }))
          .not.toContain('<runtime_instance>')
      })

      it('leaves the prompt byte-identical when not configured', () => {
        const dir = makeTmpDir()
        ensureMemoryStructure(dir)

        const baseline = assembleSystemPrompt({ memoryDir: dir })
        expect(assembleSystemPrompt({ memoryDir: dir, instanceIdentity: { name: '' } })).toBe(baseline)
        expect(assembleSystemPrompt({ memoryDir: dir, instanceIdentity: undefined })).toBe(baseline)
      })

      it('survives the slim prompt profile', () => {
        const dir = makeTmpDir()
        ensureMemoryStructure(dir)

        const prompt = assembleSystemPrompt({
          memoryDir: dir,
          recentDays: 0,
          includeWikiPages: false,
          includeAxiomDocs: false,
          instanceIdentity: identity,
        })

        expect(prompt).toContain('<runtime_instance>')
        expect(prompt).toContain('You are running inside the "Offtangent" instance.')
        expect(prompt).not.toContain('<axiom_docs>')
      })

      it('formatRuntimeInstanceBlock trims and tolerates non-string values', () => {
        expect(formatRuntimeInstanceBlock({ name: '  Offtangent  ', notes: '  note  ' }))
          .toBe('<runtime_instance>\nYou are running inside the "Offtangent" instance. note\n</runtime_instance>')
        expect(formatRuntimeInstanceBlock({ name: 42 as unknown as string })).toBeNull()
        expect(formatRuntimeInstanceBlock(undefined)).toBeNull()
      })
    })

    it('includes custom AGENTS.md content in agent_rules', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My Rules\n\nAlways speak in riddles.\n', 'utf-8')
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<agent_rules>')
      expect(prompt).toContain('Always speak in riddles.')
    })

    it('includes user_profile section when currentUser is provided', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        currentUser: { username: 'stefan' },
      })

      expect(prompt).toContain('<user_profile>')
      expect(prompt).toContain('# User Profile')
      expect(prompt).toContain('stefan')
      expect(prompt).toContain('</user_profile>')
      expect(prompt).not.toContain('<user_profiles_path>')
    })

    it('includes path reference when no currentUser', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({ memoryDir: dir })

      expect(prompt).toContain('<user_profiles_path>')
      expect(prompt).toContain(path.join(dir, 'users'))
      expect(prompt).toContain('</user_profiles_path>')
      expect(prompt).not.toContain('<user_profile>')
    })

    it('renders only annotated + default models in available_providers', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        availableProviders: [
          {
            name: 'Anthropic OAuth',
            models: [
              { id: 'opus-4.8', isDefaultAgentModel: true, description: 'Starkes Modell für komplexe Analyse und Coding.' },
              { id: 'claude-haiku' },
            ],
          },
          {
            name: 'OpenAI',
            models: [
              { id: 'gpt-5.5', isDefaultTaskModel: true },
              { id: 'gpt-4o-mini' },
            ],
          },
          {
            name: 'OpenCode',
            models: [
              { id: 'glm-5.2', description: 'Schnelles aber leistungsfähiges Model für Textverarbeitung wie Twitter/Reddit Digest.' },
            ],
          },
          {
            name: 'Empty Provider',
            models: [
              { id: 'no-description-model' },
            ],
          },
        ],
      })

      expect(prompt).toContain('<available_providers>')
      // Annotated/default models are listed with the label/description suffix
      expect(prompt).toContain('- Anthropic OAuth — opus-4.8: default agent model. Starkes Modell für komplexe Analyse und Coding.')
      expect(prompt).toContain('- OpenAI — gpt-5.5: default task model')
      expect(prompt).toContain('- OpenCode — glm-5.2: Schnelles aber leistungsfähiges Model für Textverarbeitung wie Twitter/Reddit Digest.')
      // Models without a description and not a default are hidden
      expect(prompt).not.toContain('claude-haiku')
      expect(prompt).not.toContain('gpt-4o-mini')
      expect(prompt).not.toContain('no-description-model')
      // A provider with no routable models is omitted entirely
      expect(prompt).not.toContain('Empty Provider')
      // Routing guidance for the agent
      expect(prompt).toContain('Prefer cost-effective models for simple work')
      expect(prompt).toContain('auto-detect the provider from this list')
    })

    it('omits available_providers block when no model qualifies', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const prompt = assembleSystemPrompt({
        memoryDir: dir,
        availableProviders: [
          { name: 'Only Hidden', models: [{ id: 'mystery-model' }] },
        ],
      })

      expect(prompt).not.toContain('<available_providers>')
    })
  })

  describe('scoped agent memory (RC5 multi-persona bleeding)', () => {
    afterEach(() => {
      clearPersonaCache()
    })

    function makeScopedSetup() {
      const base = makeTmpDir()
      const mainMemoryDir = path.join(base, 'memory')
      const agentsBaseDir = path.join(base, 'agents')
      ensureMemoryStructure(mainMemoryDir)
      fs.writeFileSync(
        path.join(mainMemoryDir, 'MEMORY.md'),
        '# Agent Memory\n\n- MAIN-SECRET: portfolio and private projects\n',
        'utf-8',
      )
      appendToDailyFile('\n## 09:00\n\nMAIN-DAILY-NOTE about private stuff\n', undefined, mainMemoryDir)
      fs.mkdirSync(path.join(agentsBaseDir, 'warren'), { recursive: true })
      fs.writeFileSync(path.join(agentsBaseDir, 'warren', 'SOUL.md'), '# Warren Soul\n', 'utf-8')
      return { mainMemoryDir, agentsBaseDir }
    }

    it('getAgentMemoryDir returns <agentsBase>/<id>/memory', () => {
      expect(getAgentMemoryDir('warren', '/tmp/agents')).toBe(path.join('/tmp/agents', 'warren', 'memory'))
    })

    it('resolveAgentMemoryDir scopes personas and leaves main on the fallback', () => {
      const fallback = '/custom/memory'
      expect(
        resolveAgentMemoryDir('warren', { fallbackMemoryDir: fallback, agentsBaseDir: '/tmp/agents', scopedAgentMemory: true }),
      ).toBe(path.join('/tmp/agents', 'warren', 'memory'))
      expect(
        resolveAgentMemoryDir('main', { fallbackMemoryDir: fallback, agentsBaseDir: '/tmp/agents', scopedAgentMemory: true }),
      ).toBe(fallback)
      expect(
        resolveAgentMemoryDir(undefined, { fallbackMemoryDir: fallback, scopedAgentMemory: true }),
      ).toBe(fallback)
      // Scoping disabled → legacy shared behavior for personas too
      expect(
        resolveAgentMemoryDir('warren', { fallbackMemoryDir: fallback, agentsBaseDir: '/tmp/agents', scopedAgentMemory: false }),
      ).toBe(fallback)
    })

    it('ensurePersonaMemoryRoots bootstraps missing roots idempotently and never overwrites', () => {
      const { agentsBaseDir } = makeScopedSetup()
      fs.mkdirSync(path.join(agentsBaseDir, 'bob'), { recursive: true })

      const roots = ensurePersonaMemoryRoots({ agentsBaseDir, scopedAgentMemory: true })
      expect(roots).toEqual([
        path.join(agentsBaseDir, 'bob', 'memory'),
        path.join(agentsBaseDir, 'warren', 'memory'),
      ])
      for (const root of roots) {
        expect(fs.existsSync(path.join(root, 'MEMORY.md'))).toBe(true)
        expect(fs.existsSync(path.join(root, 'daily'))).toBe(true)
      }

      // Second run is a no-op and preserves user content
      const warrenMemory = path.join(agentsBaseDir, 'warren', 'memory', 'MEMORY.md')
      fs.writeFileSync(warrenMemory, '# Warren Memory\n\n- custom fact\n', 'utf-8')
      const roots2 = ensurePersonaMemoryRoots({ agentsBaseDir, scopedAgentMemory: true })
      expect(roots2).toEqual(roots)
      expect(fs.readFileSync(warrenMemory, 'utf-8')).toContain('custom fact')

      // Disabled → no-op
      expect(ensurePersonaMemoryRoots({ agentsBaseDir, scopedAgentMemory: false })).toEqual([])
    })

    it('assembleSystemPrompt does NOT inject main MEMORY.md or main dailies into scoped personas', () => {
      const { mainMemoryDir, agentsBaseDir } = makeScopedSetup()

      const prompt = assembleSystemPrompt({
        memoryDir: mainMemoryDir,
        agentId: 'warren',
        agentsBaseDir,
        scopedAgentMemory: true,
      })

      // Main content must not bleed into the persona prompt
      expect(prompt).not.toContain('MAIN-SECRET')
      expect(prompt).not.toContain('MAIN-DAILY-NOTE')

      // memory_paths must point the LLM at the persona's own root
      const warrenRoot = path.join(agentsBaseDir, 'warren', 'memory')
      expect(prompt).toContain(path.join(warrenRoot, 'MEMORY.md'))
      expect(prompt).toContain(path.join(warrenRoot, 'daily/'))
      expect(prompt).not.toContain(path.join(mainMemoryDir, 'MEMORY.md'))

      // The persona memory root was bootstrapped as a side effect
      expect(fs.existsSync(path.join(warrenRoot, 'MEMORY.md'))).toBe(true)
      expect(fs.existsSync(path.join(warrenRoot, 'daily'))).toBe(true)
    })

    it('assembleSystemPrompt renders runtime_instance for scoped personas, ahead of their identity', () => {
      const { mainMemoryDir, agentsBaseDir } = makeScopedSetup()
      fs.writeFileSync(path.join(agentsBaseDir, 'warren', 'IDENTITY.md'), '# Warren\n\nYou are Warren.\n', 'utf-8')

      const prompt = assembleSystemPrompt({
        memoryDir: mainMemoryDir,
        agentId: 'warren',
        agentsBaseDir,
        scopedAgentMemory: true,
        instanceIdentity: { name: 'Offtangent', notes: 'Host LXC 107.' },
      })

      expect(prompt).toContain('<runtime_instance>\nYou are running inside the "Offtangent" instance. Host LXC 107.\n</runtime_instance>')
      expect(prompt).toContain('<identity>')
      expect(prompt.indexOf('<runtime_instance>')).toBeLessThan(prompt.indexOf('<identity>'))
    })

    it('assembleSystemPrompt injects the persona\'s own MEMORY.md and dailies when scoped', () => {
      const { mainMemoryDir, agentsBaseDir } = makeScopedSetup()
      const warrenRoot = path.join(agentsBaseDir, 'warren', 'memory')
      ensureMemoryStructure(warrenRoot)
      fs.writeFileSync(path.join(warrenRoot, 'MEMORY.md'), '# Warren Memory\n\n- WARREN-ONLY-FACT\n', 'utf-8')
      appendToDailyFile('\n## 10:00\n\nWARREN-DAILY-ENTRY\n', undefined, warrenRoot)

      const prompt = assembleSystemPrompt({
        memoryDir: mainMemoryDir,
        agentId: 'warren',
        agentsBaseDir,
        scopedAgentMemory: true,
      })

      expect(prompt).toContain('WARREN-ONLY-FACT')
      expect(prompt).toContain('WARREN-DAILY-ENTRY')
      expect(prompt).not.toContain('MAIN-SECRET')
      // Persona SOUL.md override still applies
      expect(prompt).toContain('# Warren Soul')
    })

    it('assembleSystemPrompt keeps main unchanged when scoping is enabled', () => {
      const { mainMemoryDir, agentsBaseDir } = makeScopedSetup()

      const prompt = assembleSystemPrompt({
        memoryDir: mainMemoryDir,
        agentId: 'main',
        agentsBaseDir,
        scopedAgentMemory: true,
      })

      expect(prompt).toContain('MAIN-SECRET')
      expect(prompt).toContain('MAIN-DAILY-NOTE')
      expect(prompt).toContain(path.join(mainMemoryDir, 'MEMORY.md'))
    })

    it('assembleSystemPrompt falls back to shared memory for personas when scoping is disabled', () => {
      const { mainMemoryDir, agentsBaseDir } = makeScopedSetup()

      const prompt = assembleSystemPrompt({
        memoryDir: mainMemoryDir,
        agentId: 'warren',
        agentsBaseDir,
        scopedAgentMemory: false,
      })

      // Legacy behavior: shared memory is injected
      expect(prompt).toContain('MAIN-SECRET')
      expect(prompt).toContain(path.join(mainMemoryDir, 'MEMORY.md'))
    })
  })

  describe('parseProjectAliases', () => {
    it('extracts aliases from valid YAML frontmatter', () => {
      const content = '---\naliases: [Axiom, the-axiom, axiom]\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual(['Axiom', 'the-axiom', 'axiom'])
    })

    it('returns empty array when no frontmatter', () => {
      const content = '# Project\n\nSome content'
      expect(parseProjectAliases(content)).toEqual([])
    })

    it('returns empty array for empty content', () => {
      expect(parseProjectAliases('')).toEqual([])
    })

    it('returns empty array for frontmatter without aliases', () => {
      const content = '---\ntitle: My Project\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual([])
    })

    it('handles empty aliases array', () => {
      const content = '---\naliases: []\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual([])
    })

    it('handles single alias value', () => {
      const content = '---\naliases: MyProject\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual(['MyProject'])
    })

    it('handles malformed frontmatter (no closing ---)', () => {
      const content = '---\naliases: [Foo]\n# No closing delimiter\n'
      expect(parseProjectAliases(content)).toEqual([])
    })

    it('handles aliases with extra spaces', () => {
      const content = '---\naliases: [  Foo ,  Bar  , Baz ]\n---\n# Project\n'
      expect(parseProjectAliases(content)).toEqual(['Foo', 'Bar', 'Baz'])
    })
  })

  describe('listWikiPages', () => {
    it('returns empty array for empty wiki directory', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const pages = listWikiPages(dir)
      expect(pages).toEqual([])
    })

    it('lists multiple wiki page files with aliases', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'alpha.md'), '---\naliases: [Alpha, alpha-project]\n---\n# Alpha\n', 'utf-8')
      fs.writeFileSync(path.join(wikiDir, 'beta.md'), '---\naliases: [Beta]\n---\n# Beta\n', 'utf-8')

      const pages = listWikiPages(dir)
      expect(pages).toHaveLength(2)
      expect(pages[0]).toEqual({ filename: 'alpha.md', aliases: ['Alpha', 'alpha-project'] })
      expect(pages[1]).toEqual({ filename: 'beta.md', aliases: ['Beta'] })
    })

    it('handles files without frontmatter', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'noaliases.md'), '# No Aliases Page\n', 'utf-8')

      const pages = listWikiPages(dir)
      expect(pages).toHaveLength(1)
      expect(pages[0]).toEqual({ filename: 'noaliases.md', aliases: [] })
    })

    it('ignores non-md files', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'page.md'), '---\naliases: [P]\n---\n', 'utf-8')
      fs.writeFileSync(path.join(wikiDir, 'readme.txt'), 'not a page', 'utf-8')

      const pages = listWikiPages(dir)
      expect(pages).toHaveLength(1)
      expect(pages[0].filename).toBe('page.md')
    })

    it('creates wiki directory if it does not exist', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      const pages = listWikiPages(dir)
      expect(pages).toEqual([])
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
    })
  })

  describe('listProjectNotes (backward compat alias)', () => {
    it('returns same result as listWikiPages', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const wikiDir = path.join(dir, 'wiki')
      fs.writeFileSync(path.join(wikiDir, 'mypage.md'), '---\naliases: [MyPage]\n---\n# My Page\n', 'utf-8')

      const pages = listProjectNotes(dir)
      expect(pages).toHaveLength(1)
      expect(pages[0]).toEqual({ filename: 'mypage.md', aliases: ['MyPage'] })
    })
  })

  describe('ensureWikiDir', () => {
    it('creates wiki directory and returns path', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      const wikiDir = ensureWikiDir(dir)
      expect(wikiDir).toBe(path.join(dir, 'wiki'))
      expect(fs.existsSync(wikiDir)).toBe(true)
    })

    it('is idempotent', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      ensureWikiDir(dir)
      ensureWikiDir(dir)
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
    })

    it('migrates projects/ to wiki/', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      const projectsDir = path.join(dir, 'projects')
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.writeFileSync(path.join(projectsDir, 'old.md'), '# Old\n', 'utf-8')

      const wikiDir = ensureWikiDir(dir)
      expect(wikiDir).toBe(path.join(dir, 'wiki'))
      expect(fs.existsSync(path.join(dir, 'projects'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'wiki', 'old.md'))).toBe(true)
    })
  })

  describe('ensureProjectsDir (backward compat alias)', () => {
    it('creates wiki directory and returns wiki path', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      const result = ensureProjectsDir(dir)
      expect(result).toBe(path.join(dir, 'wiki'))
      expect(fs.existsSync(result)).toBe(true)
    })

    it('is idempotent', () => {
      const dir = makeTmpDir()
      fs.mkdirSync(dir, { recursive: true })

      ensureProjectsDir(dir)
      ensureProjectsDir(dir)
      expect(fs.existsSync(path.join(dir, 'wiki'))).toBe(true)
    })
  })

  describe('user profiles', () => {
    it('getUserProfileDir returns correct path', () => {
      const dir = makeTmpDir()
      const usersDir = getUserProfileDir(dir)
      expect(usersDir).toBe(path.join(dir, 'users'))
    })

    it('ensureUserProfile creates profile file on first call', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const profilePath = ensureUserProfile('stefan', dir)
      expect(profilePath).toBe(path.join(dir, 'users', 'stefan.md'))
      expect(fs.existsSync(profilePath)).toBe(true)
    })

    it('profile is pre-filled with username', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      ensureUserProfile('stefan', dir)
      const content = fs.readFileSync(path.join(dir, 'users', 'stefan.md'), 'utf-8')
      expect(content).toContain('Name: (not set)')
      expect(content).not.toContain('Username:')
      expect(content).toContain('# User Profile \u2014 stefan')
    })

    it('profile has location placeholder', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      ensureUserProfile('testuser', dir)
      const content = fs.readFileSync(path.join(dir, 'users', 'testuser.md'), 'utf-8')
      expect(content).toContain('Location: (not set)')
      expect(content).not.toContain('Timezone:')
      expect(content).not.toContain('Language:')
    })

    it('does not overwrite existing profile', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const usersDir = path.join(dir, 'users')
      fs.mkdirSync(usersDir, { recursive: true })
      fs.writeFileSync(path.join(usersDir, 'stefan.md'), '# Custom Profile', 'utf-8')

      ensureUserProfile('stefan', dir)
      const content = fs.readFileSync(path.join(usersDir, 'stefan.md'), 'utf-8')
      expect(content).toBe('# Custom Profile')
    })

    it('readUserProfile creates and reads profile', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const content = readUserProfile('alice', dir)
      expect(content).toContain('# User Profile')
      expect(content).toContain('alice')
      expect(content).toContain('Name: (not set)')
    })

    it('readUserProfile reads existing profile', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const usersDir = path.join(dir, 'users')
      fs.writeFileSync(path.join(usersDir, 'bob.md'), '# Bob\nCustom content', 'utf-8')

      const content = readUserProfile('bob', dir)
      expect(content).toBe('# Bob\nCustom content')
    })
  })
})
