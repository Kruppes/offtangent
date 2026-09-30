/**
 * `connectors.localModel` — the setting that names the strictly local model of
 * the sub-agent (plan 2026-09-26, P2). All fixtures are synthetic.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearOllamaTagCache, recordOllamaTags } from '../ollama-tag-cache.js'
import {
  ConnectorLocalModelRejected,
  DEFAULT_CONNECTOR_LOCAL_MODEL_ID,
  defaultConnectorLocalModel,
  getConnectorLocalModelStatus,
  isOllamaEndpointReachable,
  listStrictlyLocalModels,
  loadConnectorLocalModelSetting,
  resolveConnectorLocalModel,
  setConnectorLocalModel,
} from './local-model.js'

let dataDir = ''

interface FixtureProvider {
  id: string
  name: string
  providerType: string
  baseUrl?: string
  apiKey?: string
  enabledModels: string[]
}

const box: FixtureProvider = {
  id: 'prov-box',
  name: 'Local Box',
  providerType: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  enabledModels: [DEFAULT_CONNECTOR_LOCAL_MODEL_ID, 'model-small', `${DEFAULT_CONNECTOR_LOCAL_MODEL_ID}-cloud`],
}

const cloud: FixtureProvider = {
  id: 'prov-cloud',
  name: 'Cloud',
  providerType: 'anthropic',
  baseUrl: 'https://api.example.com',
  apiKey: 'test-key',
  enabledModels: ['model-cloud'],
}

function write(providers: FixtureProvider[], settings: Record<string, unknown> = {}, tags = true): void {
  const configDir = path.join(dataDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(
    path.join(configDir, 'providers.json'),
    JSON.stringify({ providers, activeProvider: providers[0]?.id ?? '', activeModel: providers[0]?.enabledModels[0] ?? '' }, null, 2),
  )
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2))
  clearOllamaTagCache()
  if (!tags) return
  for (const provider of providers) {
    if (provider.providerType !== 'ollama') continue
    recordOllamaTags(
      { providerId: provider.id, baseUrl: provider.baseUrl },
      {
        models: provider.enabledModels.map(name =>
          /(?:-cloud|:cloud)$/.test(name) ? { name, remote_host: 'https://models.example.com:443' } : { name },
        ),
      },
    )
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-local-model-'))
  process.env.DATA_DIR = dataDir
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DATA_DIR
  fs.rmSync(dataDir, { recursive: true, force: true })
  clearOllamaTagCache()
})

describe('connectors.localModel', () => {
  it('defaults to the first ollama provider offering the preferred model', () => {
    write([cloud, box])
    expect(defaultConnectorLocalModel()).toEqual({ providerId: box.id, modelId: DEFAULT_CONNECTOR_LOCAL_MODEL_ID })
    expect(resolveConnectorLocalModel()).toEqual({ providerId: box.id, modelId: DEFAULT_CONNECTOR_LOCAL_MODEL_ID })
  })

  it('stays unset when no provider offers the preferred model', () => {
    write([cloud, { ...box, enabledModels: ['model-small'] }])
    expect(defaultConnectorLocalModel()).toBeNull()
    expect(resolveConnectorLocalModel()).toBeNull()
  })

  it('prefers the configured setting over the default', () => {
    write([box], { connectors: { localModel: { providerId: box.id, modelId: 'model-small' } } })
    expect(loadConnectorLocalModelSetting()).toEqual({ providerId: box.id, modelId: 'model-small' })
    expect(resolveConnectorLocalModel()).toEqual({ providerId: box.id, modelId: 'model-small' })
  })

  it('ignores a malformed setting', () => {
    write([box], { connectors: { localModel: { providerId: '', modelId: 42 } } })
    expect(loadConnectorLocalModelSetting()).toBeNull()
    // Falls back to the derived default, not to some other model.
    expect(resolveConnectorLocalModel()).toEqual({ providerId: box.id, modelId: DEFAULT_CONNECTOR_LOCAL_MODEL_ID })
  })

  it('writes a strictly local pair and keeps unrelated settings', () => {
    write([box], { thinkingLevel: 'off' })
    setConnectorLocalModel({ providerId: box.id, modelId: 'model-small' })
    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf-8'))
    expect(written.connectors.localModel).toEqual({ providerId: box.id, modelId: 'model-small' })
    expect(written.thinkingLevel).toBe('off')
  })

  it('refuses a pair that is not strictly local', () => {
    write([box, cloud])
    expect(() => setConnectorLocalModel({ providerId: cloud.id, modelId: 'model-cloud' }))
      .toThrow(ConnectorLocalModelRejected)
    expect(() => setConnectorLocalModel({ providerId: box.id, modelId: `${DEFAULT_CONNECTOR_LOCAL_MODEL_ID}-cloud` }))
      .toThrow(ConnectorLocalModelRejected)
    expect(() => setConnectorLocalModel({ providerId: 'prov-nope', modelId: 'model-small' }))
      .toThrow(ConnectorLocalModelRejected)
    expect(loadConnectorLocalModelSetting()).toBeNull()
  })

  it('lists only strictly local pairs as options', () => {
    write([box, cloud])
    expect(listStrictlyLocalModels()).toEqual([
      { providerId: box.id, modelId: DEFAULT_CONNECTOR_LOCAL_MODEL_ID },
      { providerId: box.id, modelId: 'model-small' },
    ])
  })

  it('reports status with a cheap reachability probe', async () => {
    write([box])
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ models: [{ name: DEFAULT_CONNECTOR_LOCAL_MODEL_ID }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const status = await getConnectorLocalModelStatus({ fetchImpl })
    expect(status).toMatchObject({
      configured: true,
      fromSetting: false,
      providerId: box.id,
      modelId: DEFAULT_CONNECTOR_LOCAL_MODEL_ID,
      providerName: 'Local Box',
      strictlyLocal: true,
      reachable: true,
    })
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0])
      .toBe('http://127.0.0.1:11434/api/tags')
  })

  it('reports an unreachable box as reachable=false', async () => {
    write([box])
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const status = await getConnectorLocalModelStatus({ fetchImpl })
    expect(status.reachable).toBe(false)
    expect(await isOllamaEndpointReachable(
      { id: box.id, baseUrl: box.baseUrl ?? '', providerType: 'ollama' },
      { fetchImpl },
    )).toBe(false)
  })

  it('reports nothing configured when no local model exists', async () => {
    write([cloud])
    const status = await getConnectorLocalModelStatus({ probe: false })
    expect(status).toMatchObject({ configured: false, strictlyLocal: false, reachable: null })
  })
})
