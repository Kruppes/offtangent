import { describe, it, expect, afterEach } from 'vitest'
import { readDailyFilesForConsolidation } from './memory-consolidation.js'
import { ensureMemoryStructure, appendToDailyFile } from './memory.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('memory-consolidation', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    tmpDir = path.join(os.tmpdir(), `axiom-consolidation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return tmpDir
  }

  describe('readDailyFilesForConsolidation', () => {
    it('returns empty array when no daily files exist', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      const files = readDailyFilesForConsolidation(3, dir)
      expect(files).toEqual([])
    })

    it('reads daily files with content', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      appendToDailyFile('\nUser prefers dark mode\n', undefined, dir)

      const files = readDailyFilesForConsolidation(3, dir)
      expect(files.length).toBe(1)
      expect(files[0].content).toContain('User prefers dark mode')
    })

    it('skips daily files with only the header', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)

      // Create a daily file with only the header
      const today = new Date().toISOString().split('T')[0]
      const dailyDir = path.join(dir, 'daily')
      fs.writeFileSync(path.join(dailyDir, `${today}.md`), `# Daily Memory — ${today}`, 'utf-8')

      const files = readDailyFilesForConsolidation(3, dir)
      expect(files.length).toBe(0)
    })

    it('returns files sorted oldest-first', () => {
      const dir = makeTmpDir()
      ensureMemoryStructure(dir)
      const dailyDir = path.join(dir, 'daily')

      const now = new Date()
      for (let i = 2; i >= 0; i--) {
        const d = new Date(now)
        d.setDate(d.getDate() - i)
        const dateStr = d.toISOString().split('T')[0]
        fs.writeFileSync(
          path.join(dailyDir, `${dateStr}.md`),
          `# Daily Memory — ${dateStr}\n\nEntry for day -${i}\n`,
          'utf-8',
        )
      }

      const files = readDailyFilesForConsolidation(3, dir)
      expect(files.length).toBe(3)
      // Oldest first
      expect(files[0].content).toContain('day -2')
      expect(files[2].content).toContain('day -0')
    })
  })
})
