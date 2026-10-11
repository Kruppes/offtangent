import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  confirmModelConsents, getConfigDir, initDatabase, loadTtsSettings,
  ttsCacheScope, ttsConsentRequirement,
} from '@axiom/core'
import { createSpeechDiskCache } from './speech-cache.js'
import { clearSpeechSummaryCache, createSpeechService } from './service.js'

const account = {
  id: 'synthetic-google', name: 'Synthetic Google', providerType: 'custom',
  apiKey: 'synthetic-key', baseUrl: 'https://google.example',
  dataPolicy: { region: 'us', training: 'yes' },
}

function writeAccount(overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(getConfigDir(), 'providers.json'), JSON.stringify({ providers: [{ ...account, ...overrides }] }))
}

beforeEach(() => {
  fs.mkdirSync(getConfigDir(), { recursive: true })
  fs.writeFileSync(path.join(getConfigDir(), 'settings.json'), JSON.stringify({
    privacy: { modelGate: 'enforce' }, tts: {
      enabled: true, provider: 'gemini', providerId: account.id,
      geminiModel: 'synthetic-gemini-tts', geminiVoice: 'Charon', responseFormat: 'wav',
    },
  }))
  writeAccount()
  fs.rmSync(path.join(getConfigDir(), 'model-consents.json'), { force: true })
  confirmModelConsents([ttsConsentRequirement(loadTtsSettings())!])
  clearSpeechSummaryCache()
})
afterEach(() => vi.restoreAllMocks())

describe('cloud speech cache follows the current consent scope', () => {
  it.each([
    ['endpoint', () => writeAccount({ baseUrl: 'https://changed.example' }), 403, 'tts_policy_blocked'],
    ['policy', () => writeAccount({ dataPolicy: { region: 'eu', training: 'yes' } }), 403, 'tts_policy_blocked'],
    ['revocation', () => fs.unlinkSync(path.join(getConfigDir(), 'model-consents.json')), 403, 'tts_policy_blocked'],
    ['missing key', () => writeAccount({ apiKey: '' }), 503, 'tts_unconfigured'],
    ['family prohibition', () => {
      const file = path.join(getConfigDir(), 'settings.json')
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
      settings.privacy.blockedModelFamilies = ['synthetic-gemini']
      fs.writeFileSync(file, JSON.stringify(settings))
    }, 403, 'tts_policy_blocked'],
  ] as const)('does not serve an old hit after %s changes', async (_name, change, status, code) => {
    const db = initDatabase(':memory:')
    const cache = createSpeechDiskCache({ dir: path.join(getConfigDir(), 'speech-cache'), maxBytes: 1024 * 1024 })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ steps: [{ content: [
      { type: 'audio', data: Buffer.alloc(480).toString('base64'), mime_type: 'audio/l16;rate=24000' },
    ] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const service = createSpeechService({
      db, cache, summaryFingerprint: () => 'synthetic-summary-model',
      summarize: async () => ({ text: 'Synthetic summary.', language: 'en', sourceChars: 20, summaryChars: 18, model: 'test', passthrough: true }),
    })
    try {
      const body = { text: 'Synthetic text.', messageId: null, format: 'wav' as const }
      expect((await service.audio(1, body)).cache).toBe('miss')
      expect((await service.audio(1, body)).cache).toBe('hit')
      expect(fetch).toHaveBeenCalledTimes(1)
      change()
      await expect(service.audio(1, body)).rejects.toMatchObject({ status, code })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      db.close()
      cache.clear()
    }
  })

  it.each(['policy', 'missing key', 'deletion'] as const)('invalidates cached official OpenAI fallback after its %s changes', async change => {
    const primary = { id: 'primary', name: 'Primary', providerType: 'openai', apiKey: 'synthetic-primary',
      baseUrl: 'https://api.openai.com', dataPolicy: { region: 'us', training: 'no' } }
    const fallback = { ...primary, id: 'fallback', name: 'Fallback', apiKey: 'synthetic-fallback' }
    const file = path.join(getConfigDir(), 'providers.json')
    fs.writeFileSync(file, JSON.stringify({ providers: [primary, fallback] }))
    fs.writeFileSync(path.join(getConfigDir(), 'settings.json'), JSON.stringify({
      privacy: { modelGate: 'enforce' }, tts: { enabled: true, provider: 'openai', providerId: primary.id, responseFormat: 'wav' },
    }))
    const db = initDatabase(':memory:')
    const cache = createSpeechDiskCache({ dir: path.join(getConfigDir(), 'speech-cache'), maxBytes: 1024 * 1024 })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const authorization = (init?.headers as Record<string, string>).Authorization
      return authorization === `Bearer ${primary.apiKey}`
        ? new Response('synthetic primary failure', { status: 500 })
        : new Response('synthetic fallback bytes', { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    })
    const service = createSpeechService({ db, cache, summaryFingerprint: () => 'synthetic-summary-model',
      summarize: async () => ({ text: 'Synthetic summary.', language: 'en', sourceChars: 20, summaryChars: 18, model: 'test', passthrough: true }),
    })
    try {
      const body = { text: 'Synthetic fallback text.', messageId: null, format: 'wav' as const }
      const first = await service.audio(1, body)
      expect(first.source).toBe('fallback')
      expect(first.cache).toBe('miss')
      expect(first.stream).toBeDefined()
      for await (const chunk of first.stream!) expect(chunk.length).toBeGreaterThan(0)
      expect((await service.audio(1, body)).cache).toBe('hit')
      expect(fetch).toHaveBeenCalledTimes(2)
      const changed = change === 'deletion' ? [primary] : [primary, { ...fallback,
        ...(change === 'policy' ? { dataPolicy: { region: 'us', training: 'yes' } } : { apiKey: '' }),
      }]
      fs.writeFileSync(file, JSON.stringify({ providers: changed }))
      await expect(service.audio(1, body)).rejects.toMatchObject({ status: 502, code: 'upstream' })
      expect(fetch).toHaveBeenCalledTimes(3) // only the primary was retried; no call used the invalid fallback
    } finally {
      db.close()
      cache.clear()
    }
  })

  it('never embeds account credentials in the cache fingerprint', () => {
    const snapshot = JSON.stringify(ttsCacheScope())
    expect(snapshot).not.toContain(account.apiKey)
    expect(snapshot).toContain('credentialsPresent')
  })
})
