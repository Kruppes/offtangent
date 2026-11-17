import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsolidationBackup } from './memory-consolidation-backup.js'

let data: string
let scope: string
beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-fixture-'))
  scope = path.join(data, 'memory', 'scoped-v1', 'synthetic')
  fs.mkdirSync(scope, { recursive: true })
  fs.writeFileSync(path.join(scope, 'MEMORY.md'), Buffer.from([0, 1, 2, 255]), { mode: 0o600 })
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(data, { recursive: true, force: true })
})

describe('scoped consolidation backup', () => {
  it('restores byte-identical data without copying daily or unrelated files', () => {
    fs.mkdirSync(path.join(scope, 'daily'))
    fs.writeFileSync(path.join(scope, 'daily', 'fiction.md'), 'irrelevant')
    const result = createConsolidationBackup(scope, 7, data)
    const backup = path.join(data, result.relativeDir)
    expect(result.files).toBe(1)
    expect(fs.existsSync(path.join(backup, 'daily'))).toBe(false)
    fs.writeFileSync(path.join(scope, 'MEMORY.md'), 'changed')
    fs.copyFileSync(path.join(backup, 'MEMORY.md'), path.join(scope, 'MEMORY.md'))
    expect(fs.readFileSync(path.join(scope, 'MEMORY.md'))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(fs.statSync(path.join(backup, 'MEMORY.md')).mode & 0o777).toBe(0o600)
  })

  it('prunes separately for scopes and removes interrupted copies', () => {
    const other = path.join(data, 'memory', 'scoped-v1', 'other')
    fs.mkdirSync(other, { recursive: true })
    const first = createConsolidationBackup(scope, 1, data)
    fs.writeFileSync(path.join(other, 'MEMORY.md'), 'other')
    createConsolidationBackup(other, 1, data)
    const partition = path.dirname(path.join(data, first.relativeDir))
    fs.mkdirSync(path.join(partition, 'abandoned.partial'))
    fs.writeFileSync(path.join(scope, 'MEMORY.md'), 'changed')
    const second = createConsolidationBackup(scope, 1, data)
    expect(second.pruned).toBe(1)
    expect(fs.existsSync(path.join(partition, 'abandoned.partial'))).toBe(false)
    expect(fs.readdirSync(partition)).toHaveLength(1)
    expect(fs.readdirSync(path.dirname(path.join(data, createConsolidationBackup(other, 1, data).relativeDir)))).toHaveLength(1)
  })

  it('does not publish or count empty scopes', () => {
    fs.rmSync(path.join(scope, 'MEMORY.md'))
    const empty = createConsolidationBackup(scope, 1, data)
    expect(empty).toMatchObject({ files: 0, relativeDir: '', empty: true })
    const partition = path.join(data, 'memory-consolidation-backups')
    const [scopeHash] = fs.readdirSync(partition)
    expect(scopeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(fs.readdirSync(path.join(partition, scopeHash))).toEqual([])
  })

  it('reuses the latest backup for identical file lists and checksums without pruning', () => {
    const first = createConsolidationBackup(scope, 1, data)
    const second = createConsolidationBackup(scope, 1, data)
    expect(second).toMatchObject({ relativeDir: first.relativeDir, reused: true, pruned: 0 })
    expect(fs.readdirSync(path.dirname(path.join(data, first.relativeDir)))).toHaveLength(1)
    fs.writeFileSync(path.join(scope, 'MEMORY.md'), 'changed')
    const third = createConsolidationBackup(scope, 1, data)
    expect(third.relativeDir).not.toBe(first.relativeDir)
    expect(third.pruned).toBe(1)
  })

  it('rejects paths outside the data volume even for nonexistent descendants', () => {
    expect(() => createConsolidationBackup(path.join(data, '..', 'missing'), 7, data)).toThrow('outside_data')
    expect(() => createConsolidationBackup(scope, 7, path.join(data, 'missing'))).toThrow()
  })

  it('rejects a symlink at the backup destination', () => {
    fs.symlinkSync(os.tmpdir(), path.join(data, 'memory-consolidation-backups'))
    expect(() => createConsolidationBackup(scope, 7, data)).toThrow('symlink')
  })

  it('reports a cleanup failure without invalidating the complete backup', () => {
    const first = createConsolidationBackup(scope, 1, data)
    const original = fs.rmSync
    const mock = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === path.join(fs.realpathSync(data), first.relativeDir)) throw new Error('synthetic cleanup failure')
      return original(target, options)
    })
    try {
      fs.writeFileSync(path.join(scope, 'MEMORY.md'), 'changed')
      const second = createConsolidationBackup(scope, 1, data)
      expect(second.cleanupError).toBe('Backup cleanup failed')
      expect(fs.existsSync(path.join(data, second.relativeDir))).toBe(true)
    } finally {
      mock.mockRestore()
    }
  })


  it('exposes only fixed error codes, not filesystem messages', () => {
    expect(() => createConsolidationBackup(scope, 0, data)).toThrow('retention_invalid')
    expect(() => createConsolidationBackup(path.join(data, '..', 'outside'), 7, data)).toThrow('outside_data')
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw Object.assign(new Error('private filename'), { code: 'ENOSPC' }) })
    try { expect(() => createConsolidationBackup(scope, 7, data)).toThrow('no_space') }
    finally { spy.mockRestore() }
  })

  it('rejects known Linux network filesystem types before publishing a snapshot', () => {
    const statfs = vi.spyOn(fs, 'statfsSync')
    for (const type of [0x6969, 0xff534d42, 0xfe534d42, 0x517b, 0x01021997, 0x00c36400, 0x5346414f, 0x6b414653, 0x564c, 0x65735546]) {
      statfs.mockReturnValue({ type } as ReturnType<typeof fs.statfsSync>)
      expect(() => createConsolidationBackup(scope, 7, data)).toThrow('network_volume')
    }
    expect(fs.existsSync(path.join(data, 'memory-consolidation-backups'))).toBe(false)
  })

  it('rejects a symlink without a Markdown suffix in a writable tree', () => {
    fs.mkdirSync(path.join(scope, 'wiki'))
    fs.symlinkSync(os.tmpdir(), path.join(scope, 'wiki', 'shortcut'))
    expect(() => createConsolidationBackup(scope, 7, data)).toThrow('symlink')
  })

  it('rejects symlinks in sources, including those pointing outside', () => {
    fs.symlinkSync(os.tmpdir(), path.join(scope, 'wiki'))
    expect(() => createConsolidationBackup(scope, 7, data)).toThrow('symlink')
    expect(fs.readdirSync(path.join(data, 'memory-consolidation-backups'), { recursive: true }).some(name => String(name).endsWith('.partial'))).toBe(false)
  })
})
