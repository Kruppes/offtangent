/**
 * Fix 2026-10-19: `create_task` / `create_cronjob` resolve a model against
 * every enabled model (not only the described ones) and accept a user-facing
 * name such as "Opus 4.6". Errors name the available ids.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveProviderModelInput } from './provider-config.js'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

function writeProviders(): void {
  fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify({
    providers: [
      {
        id: 'anth', name: 'Anthropic', type: 'anthropic-messages', provider: 'anthropic',
        enabledModels: ['claude-opus-5-5', 'claude-opus-4-6', 'claude-opus-4-8', 'claude-sonnet-5-5', 'claude-sonnet-5'],
        // only one model has a description — the rest must still resolve
        models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'strong' }],
      },
      {
        id: 'oai', name: 'OpenAI', type: 'openai-codex-responses', provider: 'openai-codex',
        enabledModels: ['gpt-5.5', 'gpt-5.5-mini'],
      },
      {
        id: 'kimi', name: 'Kimi_Subscription', type: 'anthropic-messages', provider: 'anthropic',
        enabledModels: ['kimi-for-coding'],
        models: [{ id: 'kimi-for-coding', name: 'Sonnet 5' }],
      },
    ],
  }))
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-model-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-resolve-model'
  writeProviders()
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('resolveProviderModelInput', () => {
  it('resolves an enabled model without a description by exact id', () => {
    const r = resolveProviderModelInput({ model: 'claude-opus-4-6' })
    expect(r).toMatchObject({ ok: true, providerId: 'anth', modelId: 'claude-opus-4-6', composite: 'anth:claude-opus-4-6' })
  })

  it('maps a user-facing name to the id', () => {
    for (const name of ['Opus 4.6', 'opus-4.6', 'OPUS_4_6', 'claude opus 4.6']) {
      expect(resolveProviderModelInput({ model: name })).toMatchObject({ ok: true, modelId: 'claude-opus-4-6' })
    }
    expect(resolveProviderModelInput({ provider: 'Anthropic', model: 'Opus 4.6' })).toMatchObject({ ok: true, modelId: 'claude-opus-4-6' })
  })

  it('matches a display name from models[]', () => {
    expect(resolveProviderModelInput({ provider: 'Anthropic', model: 'Opus 5.5' })).toMatchObject({ ok: true, modelId: 'claude-opus-5-5' })
  })

  it('does not let a suffix match over-reach', () => {
    // "opus 5" must not pick claude-opus-5-5
    const r = resolveProviderModelInput({ provider: 'Anthropic', model: 'Opus 5' })
    expect(r.ok).toBe(false)
  })

  it('prefers an exact id over a lenient name match', () => {
    expect(resolveProviderModelInput({ model: 'gpt-5.5' })).toMatchObject({ ok: true, modelId: 'gpt-5.5' })
  })

  it('reports ambiguity across providers with the candidate ids', () => {
    const r = resolveProviderModelInput({ model: 'Sonnet 5' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('ambiguous')
      expect(r.error).toContain('Anthropic: claude-sonnet-5')
      expect(r.error).toContain('Kimi_Subscription: kimi-for-coding')
    }
  })

  it('names every enabled id when a model is unknown', () => {
    const r = resolveProviderModelInput({ provider: 'Anthropic', model: 'claude-opus-9' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('claude-opus-5-5, claude-opus-4-6, claude-opus-4-8, claude-sonnet-5-5, claude-sonnet-5')

    const r2 = resolveProviderModelInput({ model: 'nope' })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toContain('OpenAI (gpt-5.5, gpt-5.5-mini)')
  })
})
