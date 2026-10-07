import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { defaults } from './config.js'

const mock = vi.hoisted(() => ({ connects: [] as Array<{ url: string; options: unknown; client: unknown }> }))
vi.mock('mqtt', () => ({ default: { connect: (url: string, options: unknown) => {
  const client = new EventEmitter() as EventEmitter & { connected: boolean; options: { reconnectPeriod: number }; publish: (topic: string, payload: string, opts: unknown, cb?: (err?: Error) => void) => void; end: (force?: boolean, callback?: () => void) => void; sent: Array<[string, string]> }
  client.connected = false
  client.options = { reconnectPeriod: 1000 }
  client.sent = []
  client.publish = (topic, payload, _opts, cb) => { client.sent.push([topic, payload]); cb?.() }
  client.end = (_force, callback) => { client.connected = false; callback?.() }
  mock.connects.push({ url, options, client })
  return client
} } }))
import { HomeAssistantMqttService } from './service.js'
type Fake = EventEmitter & { end: (force?: boolean, callback?: () => void) => void; connected: boolean; sent: Array<[string, string]>; options: { reconnectPeriod: number } }
let dir: string
let db: Database
const old = process.env.DATA_DIR
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.cwd(), '.mqtt-test-'))
  process.env.DATA_DIR = dir
  db = initDatabase(path.join(dir, 'db.sqlite'))
  mock.connects.length = 0
})
afterEach(() => {
  db.close()
  if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old
  fs.rmSync(dir, { recursive: true, force: true })
})
const ready = async () => { await new Promise(resolve => setTimeout(resolve, 80)) }
describe('MQTT transport with in-process mock', () => {
  it('does not connect while off, publishes retained discovery and states after connect, deletes removed config on disable', async () => {
    const service = new HomeAssistantMqttService(db)
    service.start()
    expect(mock.connects).toHaveLength(0)
    service.apply({ ...defaults, enabled: true, host: 'example.invalid' })
    await ready()
    expect(mock.connects).toHaveLength(1)
    const client = mock.connects[0].client as Fake
    client.connected = true
    client.emit('connect')
    await ready()
    expect(client.sent).toContainEqual(['offtangent/status', 'online'])
    expect(client.sent.some(([topic, payload]) => topic === 'homeassistant/sensor/offtangent/version/config' && payload.includes('availability_topic'))).toBe(true)
    expect(client.sent.some(([topic]) => topic === 'offtangent/tokens_today_total/state')).toBe(true)
    service.apply({ ...defaults, enabled: false })
    await ready()
    expect(client.sent).toContainEqual(['homeassistant/sensor/offtangent/version/config', ''])
    expect(client.sent).toContainEqual(['offtangent/status', 'offline'])
    expect(service.getStatus()).toEqual({ status: 'off' })
    await service.stop()
  })
  it('publishes limits on quota event, removes missing windows and reacts to reconnect', async () => {
    const service = new HomeAssistantMqttService(db)
    service.apply({ ...defaults, enabled: true, host: 'example.invalid', groups: { limits: true, usage: false, activity: false, status: false } })
    await Promise.resolve()
    const client = mock.connects[0].client as Fake
    client.connected = true; client.emit('connect'); await ready()
    service.onQuota({ secretId: { kind: 'anthropic', fetchedAt: '2026-10-07T12:00:00Z', windows: [
      { key: 'five_hour', label: '5h', utilization: 75, resetsAt: null, resetDisplay: 'relative' },
    ] } })
    await ready()
    expect(client.sent).toContainEqual(['offtangent/limit_anthropic_five_hour/state', '75'])
    expect(client.sent).toContainEqual(['offtangent/limit_anthropic_five_hour/attributes', JSON.stringify({ resets_at: null, fetched_at: '2026-10-07T12:00:00Z' })])
    client.emit('reconnect'); expect(client.options.reconnectPeriod).toBe(2000)
    client.emit('connect'); await ready()
    service.onQuota({}); await ready()
    expect(client.sent).toContainEqual(['homeassistant/sensor/offtangent/limit_anthropic_five_hour/config', ''])
    await service.stop()
  })
  it('tests the broker on an isolated topic, never taking the live device offline', async () => {
    const service = new HomeAssistantMqttService(db)
    const settings = { ...defaults, enabled: true, host: 'example.invalid' }
    service.apply(settings); await ready()
    const active = mock.connects[0].client as Fake
    active.connected = true; active.emit('connect'); await ready()
    const promise = service.test(settings)
    const testClient = mock.connects[1].client as Fake
    testClient.connected = true; testClient.emit('connect')
    expect(await promise).toBe(true)
    expect(testClient.sent).toHaveLength(2)
    expect(testClient.sent[0][0]).toMatch(/^offtangent\/test\/[a-z0-9]+\/status$/)
    expect(testClient.sent[0][1]).toBe('online')
    expect(testClient.sent[1]).toEqual([testClient.sent[0][0], ''])
    expect(active.sent).toContainEqual(['offtangent/status', 'online'])
    expect(testClient.sent).not.toContainEqual(['offtangent/status', 'offline'])
    await service.stop()
  })
  it('keeps discovery on shutdown and on saving unchanged settings', async () => {
    const service = new HomeAssistantMqttService(db)
    const settings = { ...defaults, enabled: true, host: 'example.invalid' }
    service.apply(settings); await ready()
    const first = mock.connects[0].client as Fake
    first.connected = true; first.emit('connect'); await ready()
    service.apply({ ...settings }); await ready()
    expect(first.sent.filter(([topic, payload]) => topic.endsWith('/config') && payload === '')).toEqual([])
    const second = mock.connects[1].client as Fake
    second.connected = true; second.emit('connect'); await ready()
    await service.stop()
    expect(second.sent).toContainEqual(['offtangent/status', 'offline'])
    expect(second.sent.filter(([topic, payload]) => topic.endsWith('/config') && payload === '')).toEqual([])
    expect(service.getStatus()).toEqual({ status: 'off' })
  })
  it('does not remove retained limit discovery before receiving a quota snapshot', async () => {
    const settings = { ...defaults, enabled: true, host: 'example.invalid', groups: { limits: true, usage: false, activity: false, status: false } }
    const first = new HomeAssistantMqttService(db)
    first.apply(settings); await ready()
    const oldClient = mock.connects[0].client as Fake
    oldClient.connected = true; oldClient.emit('connect')
    first.onQuota({ account: { kind: 'anthropic', fetchedAt: '2026-10-07T12:00:00Z', windows: [
      { key: 'five_hour', label: '5h', utilization: 75, resetsAt: null, resetDisplay: 'relative' },
    ] } }); await ready()
    await first.stop()
    const restarted = new HomeAssistantMqttService(db)
    restarted.apply(settings); await ready()
    const client = mock.connects[1].client as Fake
    client.connected = true; client.emit('connect'); await ready()
    expect(client.sent.filter(([topic, payload]) => topic.includes('/limit_') && payload === '')).toEqual([])
    restarted.onQuota({}); await ready()
    expect(client.sent).toContainEqual(['homeassistant/sensor/offtangent/limit_anthropic_five_hour/config', ''])
    await restarted.stop()
  })
  it('serializes rapid applies and never runs two clients with the same ID', async () => {
    const service = new HomeAssistantMqttService(db)
    const settings = { ...defaults, enabled: true, host: 'example.invalid' }
    service.apply(settings); await ready()
    const first = mock.connects[0].client as Fake
    first.connected = true; first.emit('connect'); await ready()
    let completeEnd: (() => void) | undefined
    first.end = (_force, cb) => { completeEnd = () => { first.connected = false; cb?.() } }
    service.apply(settings)
    service.apply(settings)
    await ready()
    expect(mock.connects).toHaveLength(1)
    expect(first.connected).toBe(true)
    completeEnd?.()
    await ready()
    expect(mock.connects).toHaveLength(2)
    expect(first.connected).toBe(false)
    const second = mock.connects[1].client as Fake
    second.connected = true; second.emit('connect'); await ready()
    await service.stop()
  })
  it('handles repeated main-client and test-client errors without throwing', async () => {
    const service = new HomeAssistantMqttService(db)
    const settings = { ...defaults, enabled: true, host: 'example.invalid' }
    service.apply(settings); await ready()
    const active = mock.connects[0].client as Fake
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      active.emit('error', new Error('broker unavailable'))
      active.emit('error', new Error('still unavailable'))
      expect(service.getStatus()).toEqual({ status: 'error' })
      const promise = service.test(settings)
      const client = mock.connects[1].client as Fake
      client.emit('error', new Error('refused'))
      client.emit('error', new Error('refused again'))
      expect(await promise).toBe(false)
      await service.stop()
    } finally { warn.mockRestore() }
  })
  it('ends a timed-out test connection and ignores later repeated errors', async () => {
    const service = new HomeAssistantMqttService(db)
    vi.useFakeTimers()
    try {
      const promise = service.test({ ...defaults, host: 'example.invalid' })
      const client = mock.connects[0].client as Fake
      await vi.advanceTimersByTimeAsync(6001)
      expect(await promise).toBe(false)
      client.emit('error', new Error('late'))
      client.emit('error', new Error('later'))
      expect(client.connected).toBe(false)
    } finally { vi.useRealTimers() }
  })

})
