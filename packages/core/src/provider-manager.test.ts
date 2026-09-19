import { describe, it, expect, vi } from 'vitest'
import { ProviderManager } from './provider-manager.js'
import type { ProviderConfig } from './provider-config.js'

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-primary',
    name: 'Primary',
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-primary',
    enabledModels: ['gpt-4o'],
    ...overrides,
  }
}

describe('ProviderManager', () => {
  it('starts in normal mode', () => {
    const pm = new ProviderManager(makeProvider())
    expect(pm.getOperatingMode()).toBe('normal')
  })

  it('getEffectiveProvider returns primary in normal mode', () => {
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'test-fallback', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    expect(pm.getEffectiveProvider()).toBe(primary)
  })

  it('swapToFallback changes mode and emits event', () => {
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'test-fallback', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)
    const listener = vi.fn()
    pm.on('mode:fallback', listener)

    pm.swapToFallback()

    expect(pm.getOperatingMode()).toBe('fallback')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('getEffectiveProvider returns fallback in fallback mode', () => {
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'test-fallback', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    pm.swapToFallback()

    expect(pm.getEffectiveProvider()).toBe(fallback)
  })

  it('swapToFallback is idempotent — second call is a no-op', () => {
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'test-fallback', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)
    const listener = vi.fn()
    pm.on('mode:fallback', listener)

    pm.swapToFallback()
    pm.swapToFallback()

    expect(pm.getOperatingMode()).toBe('fallback')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('swapToFallback is a no-op when no fallback configured', () => {
    const pm = new ProviderManager(makeProvider(), null)
    const listener = vi.fn()
    pm.on('mode:fallback', listener)

    pm.swapToFallback()

    expect(pm.getOperatingMode()).toBe('normal')
    expect(listener).not.toHaveBeenCalled()
  })

  it('swapToPrimary changes mode back and emits event', () => {
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'test-fallback', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)
    const listener = vi.fn()
    pm.on('mode:normal', listener)

    pm.swapToFallback()
    pm.swapToPrimary()

    expect(pm.getOperatingMode()).toBe('normal')
    expect(pm.getEffectiveProvider()).toBe(primary)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('swapToPrimary is idempotent — calling in normal mode is a no-op', () => {
    const pm = new ProviderManager(makeProvider())
    const listener = vi.fn()
    pm.on('mode:normal', listener)

    pm.swapToPrimary()

    expect(pm.getOperatingMode()).toBe('normal')
    expect(listener).not.toHaveBeenCalled()
  })

  it('reset clears mode and counters', () => {
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'test-fallback', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    pm.swapToFallback()
    pm.incrementFailures()
    pm.incrementFailures()
    pm.incrementSuccesses()

    pm.reset()

    expect(pm.getOperatingMode()).toBe('normal')
    expect(pm.getConsecutiveFailures()).toBe(0)
    expect(pm.getConsecutiveSuccesses()).toBe(0)
  })

  it('getPrimaryProvider returns the primary', () => {
    const primary = makeProvider()
    const pm = new ProviderManager(primary)
    expect(pm.getPrimaryProvider()).toBe(primary)
  })

  it('getFallbackProvider returns fallback or null', () => {
    const fallback = makeProvider({ id: 'test-fallback' })
    const pm1 = new ProviderManager(makeProvider(), fallback)
    expect(pm1.getFallbackProvider()).toBe(fallback)

    const pm2 = new ProviderManager(makeProvider(), null)
    expect(pm2.getFallbackProvider()).toBeNull()
  })

  it('incrementFailures increments failures and resets successes', () => {
    const pm = new ProviderManager(makeProvider())
    pm.incrementSuccesses()
    pm.incrementSuccesses()
    expect(pm.getConsecutiveSuccesses()).toBe(2)

    pm.incrementFailures()
    expect(pm.getConsecutiveFailures()).toBe(1)
    expect(pm.getConsecutiveSuccesses()).toBe(0)
  })

  it('incrementSuccesses increments successes and resets failures', () => {
    const pm = new ProviderManager(makeProvider())
    pm.incrementFailures()
    pm.incrementFailures()
    expect(pm.getConsecutiveFailures()).toBe(2)

    pm.incrementSuccesses()
    expect(pm.getConsecutiveSuccesses()).toBe(1)
    expect(pm.getConsecutiveFailures()).toBe(0)
  })

  it('setPrimaryProvider updates the primary reference', () => {
    const pm = new ProviderManager(makeProvider())
    const newPrimary = makeProvider({ id: 'new-primary', name: 'New Primary' })
    pm.setPrimaryProvider(newPrimary)
    expect(pm.getPrimaryProvider()).toBe(newPrimary)
  })

  it('setFallbackProvider updates the fallback reference', () => {
    const pm = new ProviderManager(makeProvider())
    expect(pm.getFallbackProvider()).toBeNull()

    const fallback = makeProvider({ id: 'fb', name: 'FB' })
    pm.setFallbackProvider(fallback)
    expect(pm.getFallbackProvider()).toBe(fallback)
  })

  it('getEffectiveProvider returns primary when fallback is null even in fallback mode attempt', () => {
    const primary = makeProvider()
    const pm = new ProviderManager(primary, null)
    // Can't actually enter fallback mode without a fallback provider
    pm.swapToFallback()
    expect(pm.getOperatingMode()).toBe('normal')
    expect(pm.getEffectiveProvider()).toBe(primary)
  })
})
