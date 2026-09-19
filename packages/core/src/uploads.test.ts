import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getUploadRetentionDays } from './uploads.js'

describe('getUploadRetentionDays', () => {
  let tmpDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uploads-test-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = prevDataDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeSettings(value: object): void {
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'settings.json'),
      JSON.stringify(value, null, 2),
      'utf-8',
    )
  }

  it('reads the new uploads.retentionDays nested field', () => {
    writeSettings({ uploads: { retentionDays: 7 } })
    expect(getUploadRetentionDays()).toBe(7)
  })

  it('falls back to the legacy top-level uploadRetentionDays when the new field is absent', () => {
    // Simulates an upgraded install: the user customised the old top-level
    // field and never opened the Uploads panel after the upgrade.
    writeSettings({ uploadRetentionDays: 14 })
    expect(getUploadRetentionDays()).toBe(14)
  })

  it('prefers the new uploads.retentionDays over the legacy field when both are present', () => {
    writeSettings({ uploads: { retentionDays: 7 }, uploadRetentionDays: 14 })
    expect(getUploadRetentionDays()).toBe(7)
  })

  it('returns the 30-day default when neither field is present', () => {
    writeSettings({})
    expect(getUploadRetentionDays()).toBe(30)
  })

  it('ignores invalid values and falls back to the default', () => {
    writeSettings({ uploads: { retentionDays: -1 }, uploadRetentionDays: 'nope' })
    expect(getUploadRetentionDays()).toBe(30)
  })

  it('ignores an invalid new field but still honors a valid legacy field', () => {
    writeSettings({ uploads: { retentionDays: -5 }, uploadRetentionDays: 21 })
    expect(getUploadRetentionDays()).toBe(21)
  })
})
