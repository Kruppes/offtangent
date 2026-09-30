import { describe, expect, it } from 'vitest'
import { detectMemoryFile, extractMemoryFileName, extractMemoryRelativePath } from './memoryFileDetection'

describe('detectMemoryFile', () => {
  it('detects SOUL.md read as memory file', () => {
    const result = detectMemoryFile('read_file', { path: '/data/memory/SOUL.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Personality')
    expect(result.icon).toBe('brain')
  })

  it('detects SOUL.md write as memory file', () => {
    const result = detectMemoryFile('write_file', { path: '/data/memory/SOUL.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Writing Personality')
    expect(result.icon).toBe('brain')
  })

  it('detects MEMORY.md as memory file', () => {
    const result = detectMemoryFile('read_file', { path: '/data/memory/MEMORY.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Memory')
  })

  it('detects AGENTS.md as memory file', () => {
    const result = detectMemoryFile('Read', { path: '/data/memory/AGENTS.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Agent Rules')
  })

  it('detects HEARTBEAT.md as memory file', () => {
    const result = detectMemoryFile('read_file', { path: '/data/memory/HEARTBEAT.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Heartbeat Tasks')
  })

  it('detects HEARTBEAT.md write', () => {
    const result = detectMemoryFile('Write', { path: '/data/memory/HEARTBEAT.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Writing Heartbeat Tasks')
  })

  it('detects daily notes', () => {
    const result = detectMemoryFile('read_file', { path: '/data/memory/daily/2026-04-01.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Daily Notes')
  })

  it('detects user profiles', () => {
    const result = detectMemoryFile('write_file', { path: '/data/memory/users/alice.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Writing User Profile')
  })

  it('detects wiki pages and drops the wiki folder from the display path', () => {
    const dev = detectMemoryFile('read_file', { path: '/Users/dev/project/.data/memory/wiki/karpathy-lernpfad.md' })
    expect(dev.isMemoryFile).toBe(true)
    expect(dev.label).toBe('Reading Wiki')
    expect(dev.displayPath).toBe('karpathy-lernpfad.md')

    const prod = detectMemoryFile('write_file', { path: '/data/memory/wiki/notes.md', content: 'x' })
    expect(prod.label).toBe('Writing Wiki')
    expect(prod.displayPath).toBe('notes.md')
  })

  it('falls back to a generic label for unknown memory subfolders', () => {
    const result = detectMemoryFile('read_file', { path: '/data/memory/projects/axiom.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Memory File')
    expect(result.displayPath).toBe('projects/axiom.md')
  })

  it('exposes display paths for core and folder-based memory files', () => {
    expect(detectMemoryFile('read_file', { path: '/data/memory/MEMORY.md' }).displayPath).toBe('MEMORY.md')
    expect(detectMemoryFile('read_file', { path: '/data/memory/daily/2026-04-05.md' }).displayPath).toBe('2026-04-05.md')
    expect(detectMemoryFile('read_file', { path: '/data/memory/users/admin.md' }).displayPath).toBe('admin.md')
  })

  it('returns default for non-memory file paths', () => {
    const result = detectMemoryFile('read_file', { path: '/workspace/src/index.ts' })
    expect(result.isMemoryFile).toBe(false)
    expect(result.icon).toBe('settings')
    expect(detectMemoryFile('read_file', { path: '/workspace/memory/notes.md' }).isMemoryFile).toBe(false)
  })

  it('returns default for non-file tools', () => {
    const result = detectMemoryFile('execute_command', { command: 'ls' })
    expect(result.isMemoryFile).toBe(false)
  })

  it('handles Edit tool name for memory files', () => {
    const result = detectMemoryFile('Edit', { path: '/data/memory/MEMORY.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Editing Memory')
  })

  it('handles edit_file tool name for memory files', () => {
    const result = detectMemoryFile('edit_file', { path: '/data/memory/SOUL.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Editing Personality')
  })

  it('handles null/undefined toolArgs', () => {
    expect(detectMemoryFile('read_file', null).isMemoryFile).toBe(false)
    expect(detectMemoryFile('read_file', undefined).isMemoryFile).toBe(false)
  })

  it('handles file_path arg key', () => {
    const result = detectMemoryFile('read_file', { file_path: '/data/memory/SOUL.md' })
    expect(result.isMemoryFile).toBe(true)
    expect(result.label).toBe('Reading Personality')
  })
})

describe('extractMemoryFileName', () => {
  it('returns canonical path for core memory files', () => {
    expect(extractMemoryFileName({ path: '/data/memory/SOUL.md' })).toBe('/data/memory/SOUL.md')
    expect(extractMemoryFileName({ path: '/data/memory/MEMORY.md' })).toBe('/data/memory/MEMORY.md')
    expect(extractMemoryFileName({ path: '/data/memory/AGENTS.md' })).toBe('/data/memory/AGENTS.md')
    expect(extractMemoryFileName({ path: '/data/memory/HEARTBEAT.md' })).toBe('/data/memory/HEARTBEAT.md')
  })

  it('normalizes dev paths to canonical /data/memory/ prefix', () => {
    expect(extractMemoryFileName({ path: '/Users/dev/project/.data/memory/users/admin.md' })).toBe('/data/memory/users/admin.md')
    expect(extractMemoryFileName({ path: '/home/user/axiom/.data/memory/SOUL.md' })).toBe('/data/memory/SOUL.md')
    expect(extractMemoryFileName({ path: '/Users/dev/project/.data/memory/daily/2026-04-05.md' })).toBe('/data/memory/daily/2026-04-05.md')
  })

  it('returns null for non-memory paths', () => {
    expect(extractMemoryFileName({ path: '/workspace/src/index.ts' })).toBeNull()
    expect(extractMemoryFileName(null)).toBeNull()
    expect(extractMemoryFileName(undefined)).toBeNull()
  })
})

describe('extractMemoryRelativePath', () => {
  it('strips everything up to the memory root', () => {
    expect(extractMemoryRelativePath({ path: '/Users/dev/project/.data/memory/MEMORY.md' })).toBe('MEMORY.md')
    expect(extractMemoryRelativePath({ path: '/data/memory/wiki/llm-systems.md' })).toBe('wiki/llm-systems.md')
    expect(extractMemoryRelativePath({ path: '/data/memory/daily/2026-04-05.md' })).toBe('daily/2026-04-05.md')
  })

  it('falls back to the file name for config files', () => {
    expect(extractMemoryRelativePath({ path: '/data/config/AGENTS.md' })).toBe('AGENTS.md')
  })

  it('returns null for non-memory paths', () => {
    expect(extractMemoryRelativePath({ path: '/workspace/src/index.ts' })).toBeNull()
    expect(extractMemoryRelativePath(null)).toBeNull()
  })
})
