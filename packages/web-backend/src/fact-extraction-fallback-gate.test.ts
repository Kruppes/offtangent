/**
 * F3 (review triage 19:25): fact extraction has no own role model in the
 * default config, so it falls back to the ACTIVE chat provider. That fallback
 * never passed the data-policy gate — pointing the chat at a cloud model that
 * trains shipped the whole conversation there for fact extraction too.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listModelGateAudit, resetModelGateAudit } from '@axiom/core'
import type { ProviderConfig } from '@axiom/core'
import { resolveFactExtractionExecutionContext } from './fact-extraction-session-end.js'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

const activeProvider = {
  id: 'cloud-1',
  name: 'CloudCo',
  providerType: 'openai',
  baseUrl: 'https://api.cloudco.example/v1',
  enabledModels: ['cloud-model-1'],
  models: [{ id: 'cloud-model-1' }],
} as unknown as ProviderConfig

function writeSettings(mode: string): void {
  fs.writeFileSync(
    path.join(tmpDir, 'config', 'settings.json'),
    JSON.stringify({ privacy: { modelGate: mode } }),
  )
}

function deps(warnings: string[]) {
  return {
    getActiveProvider: () => activeProvider,
    loadProvidersDecrypted: () => ({ providers: [activeProvider] }) as never,
    buildModel: () => ({ id: 'cloud-model-1' }) as never,
    getApiKeyForProvider: async () => 'key',
    console: { log: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} },
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-gate-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR }
  process.env.DATA_DIR = tmpDir
  resetModelGateAudit()
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  resetModelGateAudit()
})

describe('F3: the fact-extraction fallback to the active provider is gated', () => {
  it('skips the job in mode enforce and records an audit entry', async () => {
    writeSettings('enforce')
    const warnings: string[] = []
    const context = await resolveFactExtractionExecutionContext(
      { enabled: true, providerId: '', minSessionMessages: 3 },
      deps(warnings) as never,
    )
    expect(context).toBeNull()
    expect(warnings.join('\n')).toContain('blocked by the data policy')
    const audit = listModelGateAudit()
    expect(audit[0]?.role).toBe('factExtraction:fallback:active_provider')
    expect(audit[0]?.blocked).toBe(true)
  })

  it('allows and records the same fallback in mode audit', async () => {
    writeSettings('audit')
    const warnings: string[] = []
    const context = await resolveFactExtractionExecutionContext(
      { enabled: true, providerId: '', minSessionMessages: 3 },
      deps(warnings) as never,
    )
    expect(context).not.toBeNull()
    const audit = listModelGateAudit()
    expect(audit[0]?.role).toBe('factExtraction:fallback:active_provider')
    expect(audit[0]?.blocked).toBe(false)
  })

  it('runs without an audit entry when the gate is off', async () => {
    writeSettings('off')
    const context = await resolveFactExtractionExecutionContext(
      { enabled: true, providerId: '', minSessionMessages: 3 },
      deps([]) as never,
    )
    expect(context).not.toBeNull()
    expect(listModelGateAudit()).toEqual([])
  })
})
