import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { defaults } from './config.js'

const mock = vi.hoisted(() => ({ connects: [] as Array<{ url: string; options: unknown; client: unknown }> }))
vi.mock('mqtt', () => ({ default: { connect: (url: string, options: unknown) => {
  const client = new EventEmitter() as EventEmitter & { connected: boolean; options: { reconnectPeriod: number }; publish: (topic: string, payload: string, opts: unknown, cb?: (err?: Error) => void) => void; end: () => void; sent: Array<[string, string]> }
  client.connected = false
  client.options = { reconnectPeriod: 1000 }
  client.sent = []
  client.publish = (topic, payload, _opts, cb) => { client.sent.push([topic, payload]); cb?.() }
  client.end = () => { client.connected = false }
  mock.connects.push({ url, options, client })
  return client
} } }))
import { HomeAssistantMqttService } from './service.js'
type Fake = EventEmitter & { connected: boolean; sent: Array<[string, string]>; options: { reconnectPeriod: number } }
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
    await Promise.resolve()
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
    service.stop()
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
    service.stop(); await ready()
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
    service.stop(); await ready()
  })
})
