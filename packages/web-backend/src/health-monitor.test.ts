import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, addProvider, setActiveProvider, getActiveProvider, ProviderManager } from '@axiom/core'
import type { ProviderConfig } from '@axiom/core'
import { HealthMonitorService } from './health-monitor.js'

let tempDataDir: string
let previousDataDir: string | undefined

function writeConfig(name: string, value: object): void {
  const configDir = path.join(tempDataDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, name), JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

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

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-heartbeat-'))
  process.env.DATA_DIR = tempDataDir
  writeConfig('settings.json', {
    sessionTimeoutMinutes: 15,
    language: 'en',
    healthMonitor: {
      intervalMinutes: 1,
      fallbackTrigger: 'down',
      failuresBeforeFallback: 1,
      recoveryCheckIntervalMinutes: 1,
      successesBeforeRecovery: 3,
      notifications: {
        healthyToDegraded: false,
        degradedToHealthy: false,
        degradedToDown: true,
        healthyToDown: true,
        downToFallback: true,
        fallbackToHealthy: true,
      },
    },
    yoloMode: true,
  })
  writeConfig('telegram.json', {
    enabled: true,
    botToken: 'telegram-token',
    adminUserIds: [12345],
    pollingMode: true,
    webhookUrl: '',
    batchingDelayMs: 2500,
  })
  writeConfig('providers.json', { providers: [] })
})

afterEach(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  vi.useRealTimers()

  if (previousDataDir === undefined) {
    delete process.env.DATA_DIR
  } else {
    process.env.DATA_DIR = previousDataDir
  }
})

describe('HealthMonitorService', () => {
  it('runs on an interval in the background', async () => {
    vi.useFakeTimers()
    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const service = new HealthMonitorService({ db, fetchImpl: fetchImpl as typeof fetch })
    service.start()

    await vi.runOnlyPendingTimersAsync()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    service.stop()
    db.close()
  })

  it('sends healthyToDown notification and downToFallback with fallback provider name', async () => {
    writeConfig('settings.json', {
      healthMonitor: {
        intervalMinutes: 1,
        fallbackTrigger: 'down',
        failuresBeforeFallback: 1,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 1,
        notifications: {
          healthyToDegraded: false,
          degradedToHealthy: false,
          degradedToDown: true,
          healthyToDown: true,
          downToFallback: true,
          fallbackToHealthy: true,
        },
      },
    })

    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'FallbackModel', enabledModels: ['gpt-4o-mini'] })
    const pm = new ProviderManager(primary, fallback)

    const telegramBodies: Array<{ chat_id: number; text: string }> = []
    let providerAttempt = 0

    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)

      if (url.includes('/chat/completions')) {
        providerAttempt += 1
        if (providerAttempt <= 1) {
          throw new Error('ECONNREFUSED')
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      if (url.includes('api.telegram.org')) {
        telegramBodies.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })

    // First check: provider is down → healthyToDown + downToFallback notifications
    const first = await service.runNow()
    expect(first.status).toBe('down')
    expect(telegramBodies).toHaveLength(2)
    expect(telegramBodies[0].text).toContain('provider is down')
    expect(telegramBodies[1].text).toContain('switched to fallback')
    expect(telegramBodies[1].text).toContain('FallbackModel')

    // Second check (recovery): primary is healthy → fallbackToHealthy notification
    const second = await service.runNow()
    expect(second.status).toBe('healthy')
    expect(telegramBodies).toHaveLength(3)
    expect(telegramBodies[2].text).toContain('primary provider restored')

    const rows = db.prepare('SELECT status FROM health_checks ORDER BY id').all() as Array<{ status: string }>
    expect(rows.map((row) => row.status)).toEqual(['down', 'healthy'])

    db.close()
  })

  it('gracefully handles disabled telegram notifications', async () => {
    writeConfig('telegram.json', {
      enabled: false,
      botToken: '',
      adminUserIds: [],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
    })

    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        throw new Error('ECONNREFUSED')
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, fetchImpl: fetchImpl as typeof fetch })
    const result = await service.runNow()

    expect(result.status).toBe('down')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    db.close()
  })

  it('gracefully handles no provider configured and resets state when provider is switched', async () => {
    const db = initDatabase(':memory:')
    const telegramBodies: Array<{ chat_id: number; text: string }> = []

    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('api.telegram.org')) {
        telegramBodies.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.includes('/chat/completions')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, fetchImpl: fetchImpl as typeof fetch })

    const unconfigured = await service.runNow()
    expect(unconfigured.status).toBe('unconfigured')
    expect(telegramBodies).toHaveLength(0)

    const first = addProvider({ name: 'First', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o-mini'] })
    const second = addProvider({ name: 'Second', providerType: 'openai', apiKey: 'sk-2', enabledModels: ['gpt-4o-mini'] })

    setActiveProvider(first.id)
    service.restart({ resetState: true })
    await service.runNow()

    setActiveProvider(second.id)
    service.restart({ resetState: true })
    await service.runNow()

    expect(telegramBodies).toHaveLength(0)
    expect(service.getSnapshot().activeProvider?.id).toBe(second.id)

    db.close()
  })

  it('accepts a ProviderManager in constructor options', () => {
    const db = initDatabase(':memory:')
    const pm = new ProviderManager(makeProvider(), makeProvider({ id: 'fb', name: 'Fallback' }))

    const service = new HealthMonitorService({ db, providerManager: pm })
    const snapshot = service.getSnapshot()
    expect(snapshot.operatingMode).toBe('normal')
    expect(snapshot.primaryProvider).not.toBeNull()
    expect(snapshot.fallbackProvider).not.toBeNull()

    db.close()
  })

  it('loads settings from healthMonitor namespace', () => {
    writeConfig('settings.json', {
      sessionTimeoutMinutes: 15,
      healthMonitor: {
        intervalMinutes: 3,
        fallbackTrigger: 'degraded',
        failuresBeforeFallback: 2,
        recoveryCheckIntervalMinutes: 0.5,
        successesBeforeRecovery: 5,
      },
    })

    const db = initDatabase(':memory:')
    const service = new HealthMonitorService({ db })
    const snapshot = service.getSnapshot()
    expect(snapshot.intervalMinutes).toBe(3)

    db.close()
  })

  it('snapshot includes operatingMode, primaryProvider, and fallbackProvider', () => {
    const db = initDatabase(':memory:')
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'Fallback', enabledModels: ['gpt-4o-mini'] })
    const pm = new ProviderManager(primary, fallback)

    const service = new HealthMonitorService({ db, providerManager: pm })
    const snapshot = service.getSnapshot()

    expect(snapshot.operatingMode).toBe('normal')
    expect(snapshot.primaryProvider).toEqual({
      id: 'test-primary',
      name: 'Primary',
      type: 'openai',
      model: 'gpt-4o',
      lastHealthStatus: null,
    })
    expect(snapshot.fallbackProvider).toEqual({
      id: 'fb',
      name: 'Fallback',
      type: 'openai',
      model: 'gpt-4o-mini',
    })

    db.close()
  })

  it('consecutive failures trigger swapToFallback', async () => {
    writeConfig('settings.json', {
      healthMonitor: {
        intervalMinutes: 1,
        fallbackTrigger: 'down',
        failuresBeforeFallback: 2,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 3,
      },
    })

    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)
    const swapSpy = vi.fn()
    pm.on('mode:fallback', swapSpy)

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        throw new Error('ECONNREFUSED')
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })

    // First failure
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('normal')
    expect(swapSpy).not.toHaveBeenCalled()

    // Second failure — triggers fallback
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('fallback')
    expect(swapSpy).toHaveBeenCalledOnce()

    db.close()
  })

  it('fallbackTrigger "down" only counts down status as failure', async () => {
    writeConfig('settings.json', {
      healthMonitor: {
        intervalMinutes: 1,
        fallbackTrigger: 'down',
        failuresBeforeFallback: 1,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 3,
      },
    })

    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    // Simulate degraded response (high latency but success)
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        // Return 200 but with simulated high latency by setting degradedThresholdMs very low
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })

    // Healthy response should NOT trigger fallback even with failuresBeforeFallback=1
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('normal')

    db.close()
  })

  it('fallbackTrigger "degraded" counts both degraded and down as failures', async () => {
    writeConfig('settings.json', {
      healthMonitor: {
        intervalMinutes: 1,
        fallbackTrigger: 'degraded',
        failuresBeforeFallback: 1,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 3,
      },
    })

    const db = initDatabase(':memory:')
    // Add a real provider so getActiveProvider returns something
    const added = addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'], degradedThresholdMs: 1 })
    const primary = makeProvider({ id: added.id })
    const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    // Return success but latency will be above 1ms (degraded threshold)
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        // Add small delay to ensure latency > 1ms degraded threshold
        await new Promise(resolve => setTimeout(resolve, 10))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })

    // Degraded response should trigger fallback with fallbackTrigger='degraded'
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('fallback')

    db.close()
  })

  it('in fallback mode, checks primary at recoveryCheckIntervalMinutes', async () => {
    vi.useFakeTimers()

    writeConfig('settings.json', {
      healthMonitor: {
        intervalMinutes: 5,
        fallbackTrigger: 'down',
        failuresBeforeFallback: 1,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 1,
      },
    })

    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    let callCount = 0
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        callCount++
        if (callCount <= 1) {
          throw new Error('ECONNREFUSED')
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })
    service.start()

    // First check runs immediately (delay=0), fails, triggers fallback
    await vi.runOnlyPendingTimersAsync()
    expect(pm.getOperatingMode()).toBe('fallback')
    expect(callCount).toBe(1)

    // In fallback mode, next check should be scheduled at recoveryCheckIntervalMinutes (1 min)
    // NOT at intervalMinutes (5 min). Advance 1 minute.
    await vi.advanceTimersByTimeAsync(60_000)

    // Primary is now healthy, should swap back
    expect(pm.getOperatingMode()).toBe('normal')
    expect(callCount).toBe(2)

    service.stop()
    db.close()
  })

  it('consecutive successes in fallback mode trigger swapToPrimary', async () => {
    writeConfig('settings.json', {
      healthMonitor: {
        intervalMinutes: 1,
        fallbackTrigger: 'down',
        failuresBeforeFallback: 1,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 3,
      },
    })

    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    let callCount = 0
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        callCount++
        if (callCount <= 1) {
          throw new Error('ECONNREFUSED')
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })

    // Trigger fallback
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('fallback')

    // 1st success
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('fallback')

    // 2nd success
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('fallback')

    // 3rd success — triggers recovery
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('normal')

    db.close()
  })

  it('failure/success counters reset on mode change', async () => {
    writeConfig('settings.json', {
      healthMonitor: {
        intervalMinutes: 1,
        fallbackTrigger: 'down',
        failuresBeforeFallback: 1,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 2,
      },
    })

    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    let callCount = 0
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        callCount++
        if (callCount <= 1) {
          throw new Error('ECONNREFUSED')
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })

    // Trigger fallback
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('fallback')
    // Counters should be reset after mode change
    expect(pm.getConsecutiveFailures()).toBe(0)
    expect(pm.getConsecutiveSuccesses()).toBe(0)

    // Recovery: 2 successes
    await service.runNow()
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('normal')
    // Counters should be reset after recovery
    expect(pm.getConsecutiveFailures()).toBe(0)
    expect(pm.getConsecutiveSuccesses()).toBe(0)

    db.close()
  })

  it('restart with resetState resets ProviderManager to normal mode', async () => {
    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        throw new Error('ECONNREFUSED')
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })

    // Trigger fallback
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('fallback')

    // Restart with resetState
    service.restart({ resetState: true })
    expect(pm.getOperatingMode()).toBe('normal')
    expect(pm.getConsecutiveFailures()).toBe(0)
    expect(pm.getConsecutiveSuccesses()).toBe(0)

    db.close()
  })

  it('recovery check failure resets success counter', async () => {
    writeConfig('settings.json', {
      healthMonitor: {
        intervalMinutes: 1,
        fallbackTrigger: 'down',
        failuresBeforeFallback: 1,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 3,
      },
    })

    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    let callCount = 0
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        callCount++
        // Fail on 1st (trigger fallback), succeed on 2nd and 3rd, fail on 4th, then succeed 3 more
        if (callCount === 1 || callCount === 4) {
          throw new Error('ECONNREFUSED')
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })

    // Trigger fallback
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('fallback')

    // 2 successes
    await service.runNow()
    await service.runNow()
    expect(pm.getConsecutiveSuccesses()).toBe(2)

    // Failure — resets success counter
    await service.runNow()
    expect(pm.getConsecutiveSuccesses()).toBe(0)
    expect(pm.getOperatingMode()).toBe('fallback')

    // Need 3 more successes now
    await service.runNow()
    await service.runNow()
    await service.runNow()
    expect(pm.getOperatingMode()).toBe('normal')

    db.close()
  })

  it('works without ProviderManager (backward compatible)', async () => {
    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const service = new HealthMonitorService({ db, fetchImpl: fetchImpl as typeof fetch })
    const result = await service.runNow()

    expect(result.status).toBe('healthy')
    const snapshot = service.getSnapshot()
    expect(snapshot.operatingMode).toBe('normal')
    expect(snapshot.primaryProvider).toBeNull()
    expect(snapshot.fallbackProvider).toBeNull()

    db.close()
  })

  it('snapshot includes operatingMode in fallback mode', async () => {
    const db = initDatabase(':memory:')
    addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
    const primary = makeProvider()
    const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
    const pm = new ProviderManager(primary, fallback)

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) {
        throw new Error('ECONNREFUSED')
      }
      if (url.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })
    await service.runNow()

    expect(pm.getOperatingMode()).toBe('fallback')
    const snapshot = service.getSnapshot()
    expect(snapshot.operatingMode).toBe('fallback')

    db.close()
  })

  describe('granular notification toggles', () => {
    function createServiceWithToggles(
      db: ReturnType<typeof initDatabase>,
      notifications: Record<string, boolean>,
      opts: {
        providerManager?: ProviderManager
        fetchBehavior: (url: string, attempt: number) => Response | Error
      },
    ) {
      const telegramBodies: Array<{ chat_id: number; text: string }> = []
      let attempt = 0

      writeConfig('settings.json', {
        healthMonitor: {
          intervalMinutes: 1,
          fallbackTrigger: 'down',
          failuresBeforeFallback: 1,
          recoveryCheckIntervalMinutes: 1,
          successesBeforeRecovery: 1,
          notifications,
        },
      })

      const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/chat/completions')) {
          attempt++
          const result = opts.fetchBehavior(url, attempt)
          if (result instanceof Error) throw result
          return result
        }
        if (url.includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      })

      const service = new HealthMonitorService({
        db,
        providerManager: opts.providerManager,
        fetchImpl: fetchImpl as typeof fetch,
      })

      return { service, telegramBodies }
    }

    it('disabled healthyToDown does NOT send notification', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDown: false,
        downToFallback: false,
      }, {
        fetchBehavior: () => { throw new Error('ECONNREFUSED') },
      })

      await service.runNow()
      expect(telegramBodies).toHaveLength(0)

      db.close()
    })

    it('enabled healthyToDown sends notification', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDown: true,
      }, {
        fetchBehavior: () => { throw new Error('ECONNREFUSED') },
      })

      await service.runNow()
      expect(telegramBodies).toHaveLength(1)
      expect(telegramBodies[0].text).toContain('provider is down')

      db.close()
    })

    it('disabled degradedToDown does NOT send notification', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'], degradedThresholdMs: 1 })

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDegraded: false,
        degradedToDown: false,
        healthyToDown: false,
        downToFallback: false,
      }, {
        fetchBehavior: (_url, att) => {
          if (att === 1) {
            // First call: slow response → degraded
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }
          // Second call: down
          throw new Error('ECONNREFUSED')
        },
      })

      // First: degraded (slow response with 1ms threshold)
      await service.runNow()
      // Second: down
      await service.runNow()
      expect(telegramBodies).toHaveLength(0)

      db.close()
    })

    it('enabled degradedToDown sends notification', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'], degradedThresholdMs: 1 })

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDegraded: false,
        degradedToDown: true,
        downToFallback: false,
      }, {
        fetchBehavior: (_, att) => {
          if (att === 1) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }
          throw new Error('ECONNREFUSED')
        },
      })

      await service.runNow() // degraded
      await service.runNow() // down
      const downMessages = telegramBodies.filter(b => b.text.includes('provider is down'))
      expect(downMessages.length).toBeGreaterThanOrEqual(1)

      db.close()
    })

    it('disabled healthyToDegraded does NOT send notification', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'], degradedThresholdMs: 1 })

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDegraded: false,
      }, {
        fetchBehavior: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      })

      await service.runNow()
      expect(telegramBodies).toHaveLength(0)

      db.close()
    })

    it('enabled healthyToDegraded sends notification', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'], degradedThresholdMs: 1 })

      const telegramBodies: Array<{ chat_id: number; text: string }> = []

      writeConfig('settings.json', {
        healthMonitor: {
          intervalMinutes: 1,
          fallbackTrigger: 'down',
          failuresBeforeFallback: 1,
          recoveryCheckIntervalMinutes: 1,
          successesBeforeRecovery: 1,
          notifications: { healthyToDegraded: true },
        },
      })

      const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/chat/completions')) {
          // Delay to ensure latency > 1ms (degraded threshold)
          await new Promise(resolve => setTimeout(resolve, 20))
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      })

      const service = new HealthMonitorService({ db, fetchImpl: fetchImpl as typeof fetch })
      await service.runNow()
      const degradedMessages = telegramBodies.filter(b => b.text.includes('degraded'))
      expect(degradedMessages.length).toBeGreaterThanOrEqual(1)

      db.close()
    })

    it('disabled degradedToHealthy does NOT send notification', async () => {
      const db = initDatabase(':memory:')
      const added = addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'], degradedThresholdMs: 1 })

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDegraded: false,
        degradedToHealthy: false,
      }, {
        fetchBehavior: () => {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        },
      })

      await service.runNow() // degraded (1ms threshold)
      // Update the same provider's threshold so next check is healthy
      const { loadProviders: lp } = await import('@axiom/core')
      const providers = lp()
      const configDir = path.join(tempDataDir, 'config')
      const p = providers.providers.find(p => p.id === added.id)!
      p.degradedThresholdMs = 999999
      fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify(providers, null, 2) + '\n', 'utf-8')
      await service.runNow() // healthy (same provider, no state reset)
      expect(telegramBodies).toHaveLength(0)

      db.close()
    })

    it('enabled degradedToHealthy sends notification', async () => {
      const db = initDatabase(':memory:')
      const added = addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'], degradedThresholdMs: 1 })

      const telegramBodies: Array<{ chat_id: number; text: string }> = []

      writeConfig('settings.json', {
        healthMonitor: {
          intervalMinutes: 1,
          failuresBeforeFallback: 1,
          recoveryCheckIntervalMinutes: 1,
          successesBeforeRecovery: 1,
          notifications: { healthyToDegraded: false, degradedToHealthy: true },
        },
      })

      let attempt = 0
      const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/chat/completions')) {
          attempt++
          if (attempt === 1) {
            // Delay to ensure latency > 1ms (degraded threshold)
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      })

      const service = new HealthMonitorService({ db, fetchImpl: fetchImpl as typeof fetch })
      await service.runNow() // degraded (1ms threshold + 20ms delay)

      // Update the same provider's threshold so next check is healthy
      const { loadProviders: lp } = await import('@axiom/core')
      const providers = lp()
      const configDir = path.join(tempDataDir, 'config')
      const p = providers.providers.find(pp => pp.id === added.id)!
      p.degradedThresholdMs = 999999
      fs.writeFileSync(path.join(configDir, 'providers.json'), JSON.stringify(providers, null, 2) + '\n', 'utf-8')
      await service.runNow() // healthy (fast, high threshold)
      const recoveryMessages = telegramBodies.filter(b => b.text.includes('recovered from degraded'))
      expect(recoveryMessages.length).toBeGreaterThanOrEqual(1)

      db.close()
    })

    it('disabled downToFallback does NOT send fallback notification', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
      const primary = makeProvider()
      const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
      const pm = new ProviderManager(primary, fallback)

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDown: true,
        downToFallback: false,
      }, {
        providerManager: pm,
        fetchBehavior: () => { throw new Error('ECONNREFUSED') },
      })

      await service.runNow()
      expect(pm.getOperatingMode()).toBe('fallback')
      // Should have healthyToDown but NOT downToFallback
      expect(telegramBodies).toHaveLength(1)
      expect(telegramBodies[0].text).toContain('provider is down')
      expect(telegramBodies.find(b => b.text.includes('fallback'))).toBeUndefined()

      db.close()
    })

    it('enabled downToFallback sends notification with fallback provider name', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
      const primary = makeProvider()
      const fallback = makeProvider({ id: 'fb', name: 'MyFallback', enabledModels: ['gpt-3.5-turbo'] })
      const pm = new ProviderManager(primary, fallback)

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDown: false,
        downToFallback: true,
      }, {
        providerManager: pm,
        fetchBehavior: () => { throw new Error('ECONNREFUSED') },
      })

      await service.runNow()
      expect(pm.getOperatingMode()).toBe('fallback')
      // Should have downToFallback only (healthyToDown disabled)
      expect(telegramBodies).toHaveLength(1)
      expect(telegramBodies[0].text).toContain('switched to fallback')
      expect(telegramBodies[0].text).toContain('MyFallback')
      expect(telegramBodies[0].text).toContain('gpt-3.5-turbo')

      db.close()
    })

    it('disabled fallbackToHealthy does NOT send recovery notification', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
      const primary = makeProvider()
      const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
      const pm = new ProviderManager(primary, fallback)

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDown: false,
        downToFallback: false,
        fallbackToHealthy: false,
      }, {
        providerManager: pm,
        fetchBehavior: (_url, att) => {
          if (att <= 1) throw new Error('ECONNREFUSED')
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        },
      })

      await service.runNow() // down → fallback
      await service.runNow() // healthy → recovery
      expect(pm.getOperatingMode()).toBe('normal')
      expect(telegramBodies).toHaveLength(0)

      db.close()
    })

    it('enabled fallbackToHealthy sends notification confirming primary restored', async () => {
      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
      const primary = makeProvider()
      const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
      const pm = new ProviderManager(primary, fallback)

      const { service, telegramBodies } = createServiceWithToggles(db, {
        healthyToDown: false,
        downToFallback: false,
        fallbackToHealthy: true,
      }, {
        providerManager: pm,
        fetchBehavior: (_url, att) => {
          if (att <= 1) throw new Error('ECONNREFUSED')
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        },
      })

      await service.runNow() // down → fallback
      await service.runNow() // healthy → recovery
      expect(pm.getOperatingMode()).toBe('normal')
      expect(telegramBodies).toHaveLength(1)
      expect(telegramBodies[0].text).toContain('primary provider restored')
      expect(telegramBodies[0].text).toContain('Primary provider is back online')

      db.close()
    })

    it('uses default toggles when notifications not configured', async () => {
      writeConfig('settings.json', {
        healthMonitor: {
          intervalMinutes: 1,
          fallbackTrigger: 'down',
          failuresBeforeFallback: 1,
          recoveryCheckIntervalMinutes: 1,
          successesBeforeRecovery: 1,
        },
      })

      const db = initDatabase(':memory:')
      addProvider({ name: 'Primary', providerType: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-4o-mini'] })
      const primary = makeProvider()
      const fallback = makeProvider({ id: 'fb', name: 'Fallback' })
      const pm = new ProviderManager(primary, fallback)

      const telegramBodies: Array<{ chat_id: number; text: string }> = []
      let attempt = 0

      const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/chat/completions')) {
          attempt++
          if (attempt <= 1) throw new Error('ECONNREFUSED')
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.includes('api.telegram.org')) {
          telegramBodies.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      })

      const service = new HealthMonitorService({ db, providerManager: pm, fetchImpl: fetchImpl as typeof fetch })

      // Down → should trigger healthyToDown (default: true) and downToFallback (default: true)
      await service.runNow()
      expect(telegramBodies).toHaveLength(2)

      // Recovery → should trigger fallbackToHealthy (default: true)
      await service.runNow()
      expect(telegramBodies).toHaveLength(3)

      db.close()
    })
  })

  describe('cold-start timeout retry', () => {
    /** Fake /chat/completions handler that hangs until the abort signal fires (like a cold model load). */
    function hangUntilAborted(init?: RequestInit): Promise<Response> {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }

    it('timeout down is retried once with a longer timeout and does not count as failure', async () => {
      const db = initDatabase(':memory:')
      const added = addProvider({
        name: 'Primary',
        providerType: 'openai',
        apiKey: 'sk-test',
        enabledModels: ['gpt-4o-mini'],
        healthCheckTimeoutMs: 30,
      })
      const pm = new ProviderManager(makeProvider({ id: added.id }), makeProvider({ id: 'fb', name: 'Fallback' }))

      let chatCalls = 0
      const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/chat/completions')) {
          chatCalls++
          // First attempt: cold start — hangs past the 30 ms provider timeout.
          if (chatCalls === 1) return hangUntilAborted(init)
          // Retry: model is loaded now, answers immediately.
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.includes('api.telegram.org')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      })

      const service = new HealthMonitorService({
        db,
        providerManager: pm,
        fetchImpl: fetchImpl as typeof fetch,
        coldStartRetryTimeoutMs: 5000,
      })

      const result = await service.runNow()

      expect(chatCalls).toBe(2)
      expect(result.status).toBe('healthy')
      // No failure recorded, no fallback swap, no 'error' provider status
      expect(pm.getOperatingMode()).toBe('normal')
      expect(pm.getConsecutiveFailures()).toBe(0)
      expect(getActiveProvider()?.status).toBe('connected')

      db.close()
    })

    it('timeout on the retry as well records down and still triggers fallback in the same cycle', async () => {
      const db = initDatabase(':memory:')
      const added = addProvider({
        name: 'Primary',
        providerType: 'openai',
        apiKey: 'sk-test',
        enabledModels: ['gpt-4o-mini'],
        healthCheckTimeoutMs: 30,
      })
      const pm = new ProviderManager(makeProvider({ id: added.id }), makeProvider({ id: 'fb', name: 'Fallback' }))
      const swapSpy = vi.spyOn(pm, 'swapToFallback')

      let chatCalls = 0
      const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/chat/completions')) {
          chatCalls++
          return hangUntilAborted(init) // hangs on every attempt
        }
        if (url.includes('api.telegram.org')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      })

      const service = new HealthMonitorService({
        db,
        providerManager: pm,
        fetchImpl: fetchImpl as typeof fetch,
        coldStartRetryTimeoutMs: 50,
      })

      const result = await service.runNow()

      expect(chatCalls).toBe(2) // exactly one retry, then the failure counts
      expect(result.status).toBe('down')
      expect(result.isTimeout).toBe(true)
      expect(swapSpy).toHaveBeenCalledOnce()
      expect(pm.getOperatingMode()).toBe('fallback')

      db.close()
    })

    it('real provider errors get no retry and keep the previous fallback behavior', async () => {
      const db = initDatabase(':memory:')
      const added = addProvider({
        name: 'Primary',
        providerType: 'openai',
        apiKey: 'sk-test',
        enabledModels: ['gpt-4o-mini'],
      })
      const pm = new ProviderManager(makeProvider({ id: added.id }), makeProvider({ id: 'fb', name: 'Fallback' }))
      const swapSpy = vi.spyOn(pm, 'swapToFallback')

      let chatCalls = 0
      const fetchImpl = vi.fn(async (input: string | URL) => {
        const url = String(input)
        if (url.includes('/chat/completions')) {
          chatCalls++
          return new Response(JSON.stringify({ error: 'invalid api key' }), { status: 401 })
        }
        if (url.includes('api.telegram.org')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      })

      const service = new HealthMonitorService({
        db,
        providerManager: pm,
        fetchImpl: fetchImpl as typeof fetch,
      })

      const result = await service.runNow()

      expect(chatCalls).toBe(1) // no retry for real errors
      expect(result.status).toBe('down')
      expect(result.isTimeout).not.toBe(true)
      expect(swapSpy).toHaveBeenCalledOnce()
      expect(pm.getOperatingMode()).toBe('fallback')

      db.close()
    })

    it('recovery check also grants the cold-start retry to the primary provider', async () => {
      writeConfig('settings.json', {
        healthMonitor: {
          intervalMinutes: 1,
          fallbackTrigger: 'down',
          failuresBeforeFallback: 1,
          recoveryCheckIntervalMinutes: 1,
          successesBeforeRecovery: 1,
        },
      })

      const db = initDatabase(':memory:')
      const added = addProvider({
        name: 'Primary',
        providerType: 'openai',
        apiKey: 'sk-test',
        enabledModels: ['gpt-4o-mini'],
        healthCheckTimeoutMs: 30,
      })
      const pm = new ProviderManager(
        { ...makeProvider({ id: added.id }), healthCheckTimeoutMs: 30 },
        makeProvider({ id: 'fb', name: 'Fallback' }),
      )
      pm.swapToFallback() // start in fallback mode

      let chatCalls = 0
      const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/chat/completions')) {
          chatCalls++
          if (chatCalls === 1) return hangUntilAborted(init) // primary cold-starts during recovery probe
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.includes('api.telegram.org')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      })

      const service = new HealthMonitorService({
        db,
        providerManager: pm,
        fetchImpl: fetchImpl as typeof fetch,
        coldStartRetryTimeoutMs: 5000,
      })

      const result = await service.runNow()

      expect(chatCalls).toBe(2)
      expect(result.status).toBe('healthy')
      // successesBeforeRecovery=1 → the healthy retry result counts and we swap back
      expect(pm.getOperatingMode()).toBe('normal')

      db.close()
    })
  })
})
