import { describe, it, expect, afterEach } from 'vitest'
import { ensureConfigTemplates, loadConfig } from './config.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('config', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // The returned directory is nested one level below the tracked root so that
  // a test deriving DATA_DIR from path.dirname() stays inside the sandbox —
  // deriving it from os.tmpdir() directly made the suite write to the shared
  // /tmp/config, which fails with EACCES once another user owns it.
  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-config-test-'))
    const dir = path.join(tmpDir, 'data')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  it('creates template config files', () => {
    const dir = makeTmpDir()
    ensureConfigTemplates(dir)

    expect(fs.existsSync(path.join(dir, 'providers.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'telegram.json'))).toBe(true)
  })

  it('settings.json has correct defaults', () => {
    const dir = makeTmpDir()
    ensureConfigTemplates(dir)

    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'))
    expect(settings.sessionTimeoutMinutes).toBe(30)
    expect(settings.language).toBe('en')
    expect(settings.batchingDelayMs).toBeUndefined()
    expect(settings.tokenPriceTable['gpt-4o'].input).toBe(2.5)
    expect(settings.tokenPriceTable['gpt-4o'].output).toBe(10)

    // heartbeat namespace
    expect(settings.heartbeat).toBeDefined()
    expect(settings.heartbeat.intervalMinutes).toBe(5)
    expect(settings.heartbeat.fallbackTrigger).toBe('down')
    expect(settings.heartbeat.failuresBeforeFallback).toBe(1)
    expect(settings.heartbeat.recoveryCheckIntervalMinutes).toBe(1)
    expect(settings.heartbeat.successesBeforeRecovery).toBe(3)
    expect(settings.heartbeat.notifications).toBeDefined()
    expect(settings.heartbeat.notifications.healthyToDown).toBe(true)
    expect(settings.heartbeat.notifications.downToFallback).toBe(true)
    expect(settings.heartbeat.notifications.fallbackToHealthy).toBe(true)
    expect(settings.heartbeat.notifications.healthyToDegraded).toBe(false)
    expect(settings.heartbeat.notifications.degradedToHealthy).toBe(false)
    expect(settings.heartbeat.notifications.degradedToDown).toBe(true)

    expect(settings.factExtraction).toEqual({
      enabled: true,
      providerId: '',
      minSessionMessages: 3,
    })

    // top-level heartbeatIntervalMinutes should NOT exist
    expect(settings.heartbeatIntervalMinutes).toBeUndefined()
  })

  it('does not overwrite existing config files', () => {
    const dir = makeTmpDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"custom": true}', 'utf-8')

    ensureConfigTemplates(dir)

    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'))
    expect(settings.custom).toBe(true)
  })

  it('loadConfig reads and parses JSON', () => {
    const dir = makeTmpDir()
    process.env.DATA_DIR = path.dirname(dir)

    // We need config dir to be under DATA_DIR/config
    const configDir = path.join(path.dirname(dir), 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'test.json'), '{"hello": "world"}', 'utf-8')

    const data = loadConfig<{ hello: string }>('test.json')
    expect(data.hello).toBe('world')

    delete process.env.DATA_DIR
  })
})
