import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConfigDir } from './config.js'
import { checkAutomaticModelFor, listModelGateAudit, resetModelGateAudit } from './data-policy.js'
import { checkConfiguredModelFor, confirmModelConsents, hasModelConsent, modelConsentSelection } from './model-consent.js'
import { loadTtsSettings, resolveGeminiTtsCredentials, synthesizeTts, ttsConsentRequirement, TTS_FALLBACK_MODEL, TtsPolicyBlockedError, TtsUnconfiguredError } from './tts.js'

const provider = { id: 'google-test', name: 'Test Google', providerType: 'google' as const,
  baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'test-only',
  enabledModels: ['gemini-3.8-flash-lite-tts'], dataPolicy: { region: 'us' as const, training: 'yes' as const } }
const options = { mode: 'enforce' as const, log: false }

function configure(overrides: Record<string, unknown> = {}, providerOverrides: Record<string, unknown> = {}) {
  const dir = getConfigDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [{ ...provider, ...providerOverrides }] }))
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ privacy: { modelGate: 'enforce' }, tts: {
    enabled: true, provider: 'gemini', providerId: provider.id,
    geminiModel: 'gemini-3.8-flash-lite-tts', geminiVoice: 'Charon', responseFormat: 'wav', ...overrides,
  } }))
}

beforeEach(() => {
  resetModelGateAudit()
  fs.rmSync(path.join(getConfigDir(), 'model-consents.json'), { force: true })
  configure()
})
afterEach(() => { vi.restoreAllMocks() })

describe('persistent explicit consent (configuration alone is not consent)', () => {
  it('fails closed before consent; persists only one scope without changing policy', () => {
    const selection = modelConsentSelection(provider, 'model-a', 'tts', 'voice-a')
    expect(checkConfiguredModelFor(provider, 'model-a', 'tts', true, 'voice-a', options).allowed).toBe(false)
    confirmModelConsents([selection])
    expect(hasModelConsent(selection)).toBe(true)
    expect(checkConfiguredModelFor(provider, 'model-a', 'tts', true, 'voice-a', options)).toMatchObject({ allowed: true, policyAllows: false, policy: { training: 'yes' } })
    expect(fs.statSync(path.join(getConfigDir(), 'model-consents.json')).mode & 0o777).toBe(0o600)
    confirmModelConsents([selection])
    expect(JSON.parse(fs.readFileSync(path.join(getConfigDir(), 'model-consents.json'), 'utf8')).consents).toHaveLength(1)
    expect(provider.dataPolicy.training).toBe('yes')
  })

  it.each(['off', 'audit', 'enforce'] as const)('cannot approve hard China/family prohibitions in %s mode', mode => {
    const china = { ...provider, dataPolicy: { region: 'cn' as const, training: 'no' as const } }
    confirmModelConsents([modelConsentSelection(china, 'model-a', 'tts', 'voice-a')])
    expect(checkConfiguredModelFor(china, 'model-a', 'tts', true, 'voice-a', { mode, log: false })).toMatchObject({ allowed: false, reason: 'blocked:region_cn' })
    confirmModelConsents([modelConsentSelection(provider, 'model-a', 'tts', 'voice-a')])
    expect(checkConfiguredModelFor(provider, 'model-a', 'tts', true, 'voice-a', { mode, log: false, blockedFamilies: ['model-'] })).toMatchObject({ allowed: false, reason: 'blocked:family:model-' })
  })

  it('does not authorize automatic routing or fallback, even for the exact confirmed model', () => {
    confirmModelConsents([modelConsentSelection(provider, 'model-a', 'tts', 'voice-a')])
    expect(checkConfiguredModelFor(provider, 'model-a', 'tts', false, 'voice-a', options).allowed).toBe(false)
    expect(checkAutomaticModelFor(provider, 'model-a', 'tts', options).allowed).toBe(false)
    expect(checkAutomaticModelFor(provider, 'model-a', 'tts-fallback', options).allowed).toBe(false)
  })

  it.each([
    [{ ...provider, id: 'another' }, 'model-a', 'tts', 'voice-a'],
    [{ ...provider, baseUrl: 'https://other.example' }, 'model-a', 'tts', 'voice-a'],
    [{ ...provider, providerType: 'openai' as const }, 'model-a', 'tts', 'voice-a'],
    [{ ...provider, dataPolicy: { region: 'eu' as const, training: 'yes' as const } }, 'model-a', 'tts', 'voice-a'],
    [provider, 'model-b', 'tts', 'voice-a'], [provider, 'model-a', 'summary', 'voice-a'], [provider, 'model-a', 'tts', 'voice-b'],
  ] as const)('requires new consent for changed selection %j / %s / %s / %s', (p, model, role, variant) => {
    confirmModelConsents([modelConsentSelection(provider, 'model-a', 'tts', 'voice-a')])
    expect(checkConfiguredModelFor(p, model, role, true, variant, options).allowed).toBe(false)
  })

  it('ignores malformed or unversioned approval records (fail closed)', () => {
    const selection = modelConsentSelection(provider, 'model-a', 'tts')
    for (const ledger of [
      { consents: [{ ...selection, confirmedAt: new Date().toISOString() }] },
      { version: 1, consents: [{ ...selection }] },
      { version: 1, consents: [{ ...selection, confirmedAt: 'invalid-date' }] },
      { version: 1, consents: [null, { ...selection, fingerprint: 'invalid', confirmedAt: new Date().toISOString() }] },
    ]) {
      fs.writeFileSync(path.join(getConfigDir(), 'model-consents.json'), JSON.stringify(ledger))
      expect(hasModelConsent(selection)).toBe(false)
    }
  })

  it('ignores an unreadable consent file (fail closed)', () => {
    fs.writeFileSync(path.join(getConfigDir(), 'model-consents.json'), '{broken')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(hasModelConsent(modelConsentSelection(provider, 'model-a', 'tts'))).toBe(false)
    warn.mockRestore()
  })
})

describe('real Gemini credential and synthesis paths', () => {
  it('does not offer consent to hard-blocked routes and honors a later family prohibition', async () => {
    confirmModelConsents([ttsConsentRequirement(loadTtsSettings())!])
    const file = path.join(getConfigDir(), 'settings.json')
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    settings.privacy.blockedModelFamilies = ['gemini']
    fs.writeFileSync(file, JSON.stringify(settings))
    expect(ttsConsentRequirement(loadTtsSettings())).toBeNull()
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(synthesizeTts('Synthetic text.', { format: 'wav' })).rejects.toMatchObject({ reason: 'blocked:family:gemini' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redacts URL credentials and query strings in the confirmation destination', () => {
    configure({}, { providerType: 'custom', baseUrl: 'https://url-user:url-pass@custom.example?api_key=url-query' })
    const destination = ttsConsentRequirement(loadTtsSettings())!.destination
    expect(destination).toContain('https://custom.example')
    expect(destination).not.toMatch(/url-user|url-pass|url-query|api_key/)
  })

  it('rejects configured-but-unconfirmed Google before network access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(resolveGeminiTtsCredentials()).rejects.toBeInstanceOf(TtsPolicyBlockedError)
    await expect(synthesizeTts('Hello.', { format: 'wav' })).rejects.toBeInstanceOf(TtsPolicyBlockedError)
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
    expect(listModelGateAudit()[0]).toMatchObject({ role: 'tts', blocked: true, reason: 'blocked:training_yes' })
  })

  it('permits confirmed Gemini/Charon and synthesizes through the actual dispatcher', async () => {
    const selection = ttsConsentRequirement(loadTtsSettings())!
    expect(selection).toMatchObject({ explicitlySelected: true, policy: { training: 'yes' } })
    confirmModelConsents([selection])
    expect(ttsConsentRequirement(loadTtsSettings())).toBeNull()
    await expect(resolveGeminiTtsCredentials()).resolves.toMatchObject({ apiKey: 'test-only' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ steps: [{ content: [
      { type: 'audio', data: Buffer.alloc(480).toString('base64'), mime_type: 'audio/l16;rate=24000' },
    ] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const audio = await synthesizeTts('Hello.', { format: 'wav' })
    expect(audio.audio.subarray(0, 4).toString()).toBe('RIFF')
    const payload = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string)
    expect(payload).toMatchObject({ model: 'gemini-3.8-flash-lite-tts', generation_config: { speech_config: [{ voice: 'Charon' }] } })
    fetch.mockRestore()
    expect(listModelGateAudit()[0]).toMatchObject({ kind: 'explicit', blocked: false, policy: { training: 'yes' } })
  })

  it.each([
    ['https://custom.example/gemini', 'https://custom.example/gemini/interactions'],
    ['', 'https://generativelanguage.googleapis.com/v1beta/interactions'],
  ])('confirms and uses the same real Gemini destination for %s', async (baseUrl, destination) => {
    // An editable account can be selected explicitly even with the Gemini engine.
    configure({}, { baseUrl, providerType: 'openai-compatible' })
    const selection = ttsConsentRequirement(loadTtsSettings())!
    expect(selection).toMatchObject({ destination, policy: { training: 'yes' } })
    confirmModelConsents([selection])
    const credentials = await resolveGeminiTtsCredentials()
    expect(credentials?.apiKey).toBe('test-only')
    expect(credentials?.baseUrl).toBe(baseUrl || undefined)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ steps: [{ content: [
      { type: 'audio', data: Buffer.alloc(480).toString('base64'), mime_type: 'audio/l16;rate=24000' },
    ] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await synthesizeTts('Hello.', { format: 'wav' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![0]).toBe(destination)
    configure({}, { baseUrl: 'https://changed.example/gemini', providerType: 'openai-compatible' })
    expect(ttsConsentRequirement(loadTtsSettings())).not.toBeNull()
    await expect(synthesizeTts('Hello.', { format: 'wav' })).rejects.toBeInstanceOf(TtsPolicyBlockedError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps implicit Google lookup blocked despite prior explicit consent', async () => {
    confirmModelConsents([ttsConsentRequirement(loadTtsSettings())!])
    configure({ providerId: '' })
    expect(ttsConsentRequirement(loadTtsSettings())).toMatchObject({ explicitlySelected: false })
    await expect(resolveGeminiTtsCredentials()).rejects.toBeInstanceOf(TtsPolicyBlockedError)
  })

  it('requires a new confirmation when the model or voice changes', async () => {
    confirmModelConsents([ttsConsentRequirement(loadTtsSettings())!])
    for (const changed of [{ geminiVoice: 'Kore' }, { geminiModel: 'gemini-new-tts' }]) {
      configure(changed)
      expect(ttsConsentRequirement(loadTtsSettings())).not.toBeNull()
      await expect(resolveGeminiTtsCredentials()).rejects.toBeInstanceOf(TtsPolicyBlockedError)
    }
  })

  it('rejects a per-request voice override without borrowing the stored voice approval', async () => {
    confirmModelConsents([ttsConsentRequirement(loadTtsSettings())!])
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(synthesizeTts('Hello.', { format: 'wav', voice: 'Kore' })).rejects.toBeInstanceOf(TtsPolicyBlockedError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not use consent on the actual hosted OpenAI fallback path', async () => {
    const primary = { ...provider, id: 'primary', name: 'Primary', providerType: 'openai-compatible',
      baseUrl: 'https://primary.example/v1', dataPolicy: { region: 'us', training: 'no' }, enabledModels: ['custom-tts'] }
    const fallback = { ...provider, id: 'hosted-fallback', name: 'Hosted fallback', providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1', enabledModels: [TTS_FALLBACK_MODEL] }
    configure({ provider: 'openai', providerId: primary.id, openaiModel: 'custom-tts', openaiVoice: 'nova' })
    fs.writeFileSync(path.join(getConfigDir(), 'providers.json'), JSON.stringify({ providers: [primary, fallback] }))
    confirmModelConsents([modelConsentSelection(fallback, TTS_FALLBACK_MODEL, 'tts', JSON.stringify(['openai', 'nova']))])
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'))
    await expect(synthesizeTts('Hello.', { format: 'wav' })).rejects.toThrow('ECONNREFUSED')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(listModelGateAudit()).toContainEqual(expect.objectContaining({
      role: 'tts-fallback', providerId: fallback.id, kind: 'automatic', blocked: true,
    }))
  })

  it('missing key remains unconfigured, even with a matching saved consent', async () => {
    confirmModelConsents([ttsConsentRequirement(loadTtsSettings())!])
    configure({}, { apiKey: '' })
    expect(ttsConsentRequirement(loadTtsSettings())).toBeNull()
    await expect(resolveGeminiTtsCredentials()).resolves.toBeNull()
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(synthesizeTts('Hello.')).rejects.toBeInstanceOf(TtsUnconfiguredError)
    expect(fetch).not.toHaveBeenCalled()
  })
})
