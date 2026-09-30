/**
 * `isStrictlyLocalModel` — the one gate that decides whether a model may see
 * raw private connector data (plan 2026-09-26, P2).
 *
 * Every fixture is synthetic: made-up provider ids, made-up model ids, the
 * placeholder key `test-key`, written into a temp DATA_DIR per test.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStrictlyLocalModel, isStrictlyLocalModelFor } from './data-policy.js'
import { clearOllamaTagCache, recordOllamaTags } from './ollama-tag-cache.js'

interface FixtureProvider {
  id: string
  name: string
  providerType: string
  baseUrl?: string
  apiKey?: string
  enabledModels: string[]
  dataPolicy?: { region?: string; training?: string }
  models?: Array<{ id: string; dataPolicy?: { region?: string; training?: string } }>
}

let dataDir = ''

function writeProviders(providers: FixtureProvider[], tags = true): void {
  const configDir = path.join(dataDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(
    path.join(configDir, 'providers.json'),
    JSON.stringify({ providers, activeProvider: providers[0]?.id ?? '', activeModel: providers[0]?.enabledModels[0] ?? '' }, null, 2),
  )
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({}, null, 2))
  clearOllamaTagCache()
  if (!tags) return
  for (const provider of providers) {
    if (provider.providerType !== 'ollama' && provider.providerType !== 'ollama-local') continue
    recordOllamaTags(
      { providerId: provider.id, baseUrl: provider.baseUrl },
      {
        models: provider.enabledModels.map(name =>
          // A `:cloud` / `-cloud` entry is what a proxied model looks like on
          // the wire: Ollama reports it with a remote_host.
          /(?:-cloud|:cloud)$/.test(name)
            ? { name, remote_host: 'https://models.example.com:443' }
            : { name },
        ),
      },
    )
  }
}

const localBox: FixtureProvider = {
  id: 'prov-box',
  name: 'Local Box',
  providerType: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  enabledModels: ['model-local', 'model-local-cloud', 'model-local:cloud'],
}

const cloud: FixtureProvider = {
  id: 'prov-cloud',
  name: 'Cloud',
  providerType: 'anthropic',
  baseUrl: 'https://api.example.com',
  apiKey: 'test-key',
  enabledModels: ['model-cloud'],
  dataPolicy: { region: 'us', training: 'no' },
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-strict-local-'))
  process.env.DATA_DIR = dataDir
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DATA_DIR
  fs.rmSync(dataDir, { recursive: true, force: true })
  clearOllamaTagCache()
})

describe('isStrictlyLocalModel', () => {
  it('accepts a confirmed model on a box in the private network', () => {
    writeProviders([localBox, cloud])
    expect(isStrictlyLocalModel('prov-box', 'model-local')).toBe(true)
  })

  it('rejects the `-cloud` and `:cloud` suffixes of the same box', () => {
    writeProviders([localBox])
    expect(isStrictlyLocalModel('prov-box', 'model-local-cloud')).toBe(false)
    expect(isStrictlyLocalModel('prov-box', 'model-local:cloud')).toBe(false)
  })

  it('rejects a cloud provider even when it does not train', () => {
    writeProviders([localBox, cloud])
    expect(isStrictlyLocalModel('prov-cloud', 'model-cloud')).toBe(false)
  })

  it('rejects a public host, even for an ollama provider type', () => {
    writeProviders([{
      id: 'prov-public',
      name: 'Public Ollama',
      providerType: 'ollama',
      baseUrl: 'https://ollama.example.com',
      enabledModels: ['model-public'],
    }])
    expect(isStrictlyLocalModel('prov-public', 'model-public')).toBe(false)
  })

  it('rejects while the box never answered /api/tags (hosting unverified)', () => {
    writeProviders([localBox], false)
    expect(isStrictlyLocalModel('prov-box', 'model-local')).toBe(false)
  })

  it('refuses an explicit region override on a PUBLIC host (review A/H1)', () => {
    // Reversed on purpose (review 2026-09-26, H1): an operator statement may
    // describe their own network, but it must not be able to declare a public
    // endpoint "local" and thereby send raw mailbox content to it. A typo or a
    // copied config block would silently defeat the whole local-only design,
    // so the private host is checked structurally and cannot be configured away.
    writeProviders([{
      id: 'prov-declared',
      name: 'Declared Local',
      providerType: 'openai-completions',
      baseUrl: 'https://inference.example.com',
      apiKey: 'test-key',
      enabledModels: ['model-declared'],
      dataPolicy: { region: 'local', training: 'no' },
    }])
    expect(isStrictlyLocalModel('prov-declared', 'model-declared')).toBe(false)
  })

  it('still honours an explicit region override on a PRIVATE host', () => {
    writeProviders([{
      id: 'prov-declared-lan',
      name: 'Declared Local LAN',
      providerType: 'openai-completions',
      baseUrl: 'http://100.64.1.3:8080/v1',
      apiKey: 'test-key',
      enabledModels: ['model-declared'],
      dataPolicy: { region: 'local', training: 'no' },
    }])
    expect(isStrictlyLocalModel('prov-declared-lan', 'model-declared')).toBe(true)
  })

  it('refuses a provider without a base URL, override or not (review A/H1)', () => {
    // No base URL means the vendor default endpoint — remote by definition.
    writeProviders([{
      id: 'prov-nourl',
      name: 'No Base URL',
      providerType: 'openai-completions',
      apiKey: 'test-key',
      enabledModels: ['model-declared'],
      dataPolicy: { region: 'local', training: 'no' },
    }])
    expect(isStrictlyLocalModel('prov-nourl', 'model-declared')).toBe(false)
    expect(isStrictlyLocalModelFor(
      { id: 'prov-nourl', providerType: 'openai-completions', dataPolicy: { region: 'local', training: 'no' } },
      'model-declared',
    )).toBe(false)
  })

  it('keeps the live ollama box on the private network strictly local', () => {
    // The deployment's own box: http://127.0.0.1:11434/v1
    writeProviders([{
      id: 'prov-live-box',
      name: 'Live Box',
      providerType: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      enabledModels: ['model-live'],
    }])
    expect(isStrictlyLocalModel('prov-live-box', 'model-live')).toBe(true)
  })

  it('lets an explicit non-local override beat the private network', () => {
    writeProviders([{ ...localBox, dataPolicy: { region: 'us', training: 'no' } }])
    expect(isStrictlyLocalModel('prov-box', 'model-local')).toBe(false)
  })

  it('cannot be overridden into local for a remote-hosted model', () => {
    // Condition 2 wins over any configuration: a proxied model stays out.
    writeProviders([{ ...localBox, dataPolicy: { region: 'local', training: 'no' } }])
    expect(isStrictlyLocalModel('prov-box', 'model-local-cloud')).toBe(false)
  })

  it('fails closed for an unknown provider, an empty id and an empty model', () => {
    writeProviders([localBox])
    expect(isStrictlyLocalModel('prov-nope', 'model-local')).toBe(false)
    expect(isStrictlyLocalModel('', 'model-local')).toBe(false)
    expect(isStrictlyLocalModel('prov-box', '')).toBe(false)
  })

  it('answers the same question for an in-memory provider view', () => {
    writeProviders([localBox])
    expect(isStrictlyLocalModelFor(
      { id: 'prov-box', providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      'model-local',
    )).toBe(true)
    expect(isStrictlyLocalModelFor(
      { id: 'prov-box', providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      'model-local:cloud',
    )).toBe(false)
  })
})
