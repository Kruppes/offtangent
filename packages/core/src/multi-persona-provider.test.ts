import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadMultiPersonaSettings } from './config.js'

/**
 * C4 (per-agent/persona default model): the `multiPersona.perAgentProvider`
 * map is read from settings.json and surfaced on MultiPersonaSettings so the
 * task default-provider chain can route each persona to its own model.
 */
describe('multiPersona.perAgentProvider (C4)', () => {
  let tmpDir: string
  let prevDataDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-persona-provider-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = prevDataDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeSettings(obj: unknown): void {
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'settings.json'),
      JSON.stringify(obj, null, 2),
      'utf-8',
    )
  }

  it('parses a per-agent provider map when present', () => {
    writeSettings({
      multiPersona: {
        enabled: true,
        defaultAgentId: 'main',
        perAgentProvider: {
          warren: 'kimi:kimi-k2.6',
          gekko: 'openai:gpt-5',
        },
      },
    })
    const settings = loadMultiPersonaSettings()
    expect(settings.enabled).toBe(true)
    expect(settings.perAgentProvider).toEqual({
      warren: 'kimi:kimi-k2.6',
      gekko: 'openai:gpt-5',
    })
  })

  it('leaves perAgentProvider undefined when not configured', () => {
    writeSettings({ multiPersona: { enabled: true, defaultAgentId: 'main' } })
    const settings = loadMultiPersonaSettings()
    expect(settings.perAgentProvider).toBeUndefined()
  })

  it('returns safe defaults (no perAgentProvider) when settings are absent', () => {
    // No settings.json written.
    const settings = loadMultiPersonaSettings()
    expect(settings.enabled).toBe(false)
    expect(settings.perAgentProvider).toBeUndefined()
  })
})
