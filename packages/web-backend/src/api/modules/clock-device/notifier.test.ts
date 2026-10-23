/**
 * Clock wake call: configuration gate (off without URL, switch, LAN only),
 * body carries only the rev, failures and timeouts never reach the phone
 * doorbell, revoked/absent devices are never woken.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { PushDeviceRegistry } from '../../../push/device-registry.js'
import type { FcmClient, FcmMessage, FcmSendResult } from '../../../push/fcm-client.js'
import { PushSender } from '../../../push/sender.js'
import { ClockDeviceRegistry } from './registry.js'
import { buildClockState } from './state.js'
import { ClockNotifier, CLOCK_WAKE_TIMEOUT_MS, resolveClockWakeConfig } from './notifier.js'

const URL_OK = 'http://192.168.1.202/api/v1/apps/Offtangent/data'

let db: Database
let devices: ClockDeviceRegistry

type Call = { url: string; method: string; headers: Record<string, string>; body: string; redirect: string; signal: AbortSignal }

function recordingFetch(answer: () => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 200 })) {
  const calls: Call[] = []
  const fetch = vi.fn(async (url: string, init: Omit<Call, 'url'>) => {
    calls.push({ url, ...init })
    return answer()
  })
  return { calls, fetch }
}

const quietLogger = () => ({ info: vi.fn(), warn: vi.fn() })

function insertFinishedTask(id: string): void {
  db.prepare(`INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('strand-1', 1, 'main', 'S', 'interactive')`).run()
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, session_id, agent_id, completed_at)
     VALUES (?, 'Geheimer Bericht', 'p', 'completed', 'user', ?, 'strand-1', 'main', datetime('now'))`,
  ).run(id, `task-session-${id}`)
  db.prepare(
    `INSERT INTO sessions (id, user_id, agent_id, title, type, parent_session_id) VALUES (?, NULL, 'main', 'Task', 'task', 'strand-1')`,
  ).run(`task-session-${id}`)
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  devices = new ClockDeviceRegistry(db)
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
})

describe('resolveClockWakeConfig', () => {
  it('is off without CLOCK_WAKE_URL', () => {
    expect(resolveClockWakeConfig({}).config).toBeNull()
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: '  ' }).config).toBeNull()
  })

  it('builds the app data URL for a LAN clock', () => {
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://192.168.1.202' }).config).toEqual({ url: URL_OK })
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://192.168.1.202/some/path?x=1' }).config).toEqual({ url: URL_OK })
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://tc002.local:8080' }).config)
      .toEqual({ url: 'http://tc002.local:8080/api/v1/apps/Offtangent/data' })
  })

  it('can be switched off', () => {
    for (const value of ['false', '0', 'off', 'no', 'OFF']) {
      expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://192.168.1.202', CLOCK_WAKE_ENABLED: value }).config).toBeNull()
    }
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://192.168.1.202', CLOCK_WAKE_ENABLED: 'true' }).config).not.toBeNull()
  })

  it('refuses targets outside the LAN, other schemes, credentials and odd app names', () => {
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://8.8.8.8' }).config).toBeNull()
    // Loopback is this host, never the clock.
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://127.0.0.1:3000' }).config).toBeNull()
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://[::1]:3000' }).config).toBeNull()
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://localhost:3000' }).config).toBeNull()
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://example.com' }).config).toBeNull()
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'ftp://192.168.1.202' }).config).toBeNull()
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://u:p@192.168.1.202' }).config).toBeNull()
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'not a url' }).config).toBeNull()
    expect(resolveClockWakeConfig({ CLOCK_WAKE_URL: 'http://192.168.1.202', CLOCK_WAKE_APP: '../x' }).config).toBeNull()
  })
})

describe('ClockNotifier.wake', () => {
  it('does nothing for a user without an active clock device', async () => {
    const { calls, fetch } = recordingFetch()
    const notifier = new ClockNotifier({ db, config: { url: URL_OK }, fetch, logger: quietLogger() })
    expect(await notifier.wake(1)).toBe(false)
    const { device } = devices.create(1, { name: 'TC002' })
    devices.revoke(1, device.id)
    expect(await notifier.wake(1)).toBe(false)
    devices.create(2, { name: 'TC002' })
    expect(await notifier.wake(1)).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('PATCHes exactly {"rev": n} with the rev GET /state would report', async () => {
    devices.create(1, { name: 'TC002' })
    insertFinishedTask('t1')
    const { calls, fetch } = recordingFetch()
    const notifier = new ClockNotifier({ db, config: { url: URL_OK }, fetch, logger: quietLogger() })
    expect(await notifier.wake(1)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(URL_OK)
    expect(calls[0]!.method).toBe('PATCH')
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['rev'])
    expect(body.rev).toBe(buildClockState(db, { userId: 1, privacy: false }).rev)
    // No task name, persona or any other content on the wire.
    expect(calls[0]!.body).not.toContain('Geheimer')
    expect(calls[0]!.body).not.toContain('main')
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
    // A 3xx from the target is an error, never followed out of the LAN.
    expect(calls[0]!.redirect).toBe('error')
  })

  it('does not repeat an unchanged rev, but sends again once the state changed', async () => {
    devices.create(1, { name: 'TC002' })
    const { calls, fetch } = recordingFetch()
    const notifier = new ClockNotifier({ db, config: { url: URL_OK }, fetch, logger: quietLogger() })
    expect(await notifier.wake(1)).toBe(true)
    expect(await notifier.wake(1)).toBe(false)
    insertFinishedTask('t2')
    expect(await notifier.wake(1)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('swallows network errors and HTTP errors, logging only once until a success', async () => {
    devices.create(1, { name: 'TC002' })
    let mode: 'throw' | '500' | 'ok' = 'throw'
    const { calls, fetch } = recordingFetch(async () => {
      if (mode === 'throw') throw new Error('ECONNREFUSED')
      return mode === '500' ? { ok: false, status: 500 } : { ok: true, status: 200 }
    })
    const logger = quietLogger()
    const notifier = new ClockNotifier({ db, config: { url: URL_OK }, fetch, logger })
    await expect(notifier.wake(1)).resolves.toBe(false)
    await expect(notifier.wake(1)).resolves.toBe(false)
    mode = '500'
    await expect(notifier.wake(1)).resolves.toBe(false)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    mode = 'ok'
    await expect(notifier.wake(1)).resolves.toBe(true)
    // A failed call did not remember the rev, so the success went out.
    expect(calls).toHaveLength(4)
  })

  it('aborts a hanging clock after at most 2 s', async () => {
    devices.create(1, { name: 'TC002' })
    let signal: AbortSignal | null = null
    const fetch = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal
      return new Promise<{ ok: boolean; status: number }>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      })
    })
    // A caller asking for more than the cap still gets the cap.
    const notifier = new ClockNotifier({ db, config: { url: URL_OK }, fetch, logger: quietLogger(), timeoutMs: 60_000 })
    const started = Date.now()
    await expect(notifier.wake(1)).resolves.toBe(false)
    const elapsed = Date.now() - started
    expect(signal!.aborted).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(CLOCK_WAKE_TIMEOUT_MS - 100)
    expect(elapsed).toBeLessThan(CLOCK_WAKE_TIMEOUT_MS + 1_000)
  }, 10_000)
})

describe('ClockNotifier.observe', () => {
  it('wakes for task done/failed, question and board update, not for a plain turn', async () => {
    vi.useFakeTimers()
    devices.create(1, { name: 'TC002' })
    const notifier = new ClockNotifier({ db, config: { url: URL_OK }, fetch: recordingFetch().fetch, logger: quietLogger(), debounceMs: 10 })
    const wake = vi.spyOn(notifier, 'wake').mockResolvedValue(true)
    for (const kind of ['task_done', 'error', 'question', 'feed_item'] as const) {
      notifier.observe({ userId: 1, kind, strandId: 's', agentId: 'main' })
      await vi.advanceTimersByTimeAsync(20)
    }
    notifier.observe({ userId: 1, kind: 'turn_done', strandId: 's', agentId: 'main' })
    await vi.advanceTimersByTimeAsync(20)
    expect(wake).toHaveBeenCalledTimes(4)
  })

  it('folds a burst into one wake call per user', async () => {
    vi.useFakeTimers()
    const notifier = new ClockNotifier({ db, config: { url: URL_OK }, fetch: recordingFetch().fetch, logger: quietLogger(), debounceMs: 50 })
    const wake = vi.spyOn(notifier, 'wake').mockResolvedValue(true)
    notifier.observe({ userId: 1, kind: 'task_done', strandId: 's', agentId: 'main' })
    notifier.observe({ userId: 1, kind: 'question', strandId: 's', agentId: 'main' })
    notifier.observe({ userId: 2, kind: 'task_done', strandId: 's', agentId: 'main' })
    await vi.advanceTimersByTimeAsync(60)
    expect(wake).toHaveBeenCalledTimes(2)
    expect(wake.mock.calls.map(call => call[0]).sort()).toEqual([1, 2])
  })
})

describe('PushSender observer', () => {
  class FakeClient {
    readonly sent: FcmMessage[] = []
    configured = true
    isConfigured(): boolean { return this.configured }
    async send(message: FcmMessage): Promise<FcmSendResult> {
      this.sent.push(message)
      return { ok: true, status: 200, name: 'projects/p/messages/1' }
    }
  }

  function makeSender(client: FakeClient) {
    const registry = new PushDeviceRegistry(db)
    registry.register(1, { token: 'fcm-token-1', platform: 'android' })
    return new PushSender({
      registry,
      client: client as unknown as FcmClient,
      now: () => 1_000,
      retryDelayMs: 0,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
  }

  it('a throwing observer does not stop the phone doorbell', async () => {
    const client = new FakeClient()
    const sender = makeSender(client)
    sender.addObserver(() => { throw new Error('boom') })
    const outcome = await sender.send({ userId: 1, kind: 'task_done', strandId: 's-1', agentId: 'main' })
    expect(outcome.delivered).toBe(1)
    expect(client.sent).toHaveLength(1)
  })

  it('a hanging clock does not delay the phone doorbell', async () => {
    devices.create(1, { name: 'TC002' })
    const client = new FakeClient()
    const sender = makeSender(client)
    const fetch = vi.fn(() => new Promise<{ ok: boolean; status: number }>(() => {}))
    const notifier = new ClockNotifier({ db, config: { url: URL_OK }, fetch, logger: quietLogger(), debounceMs: 0 })
    sender.addObserver(doorbell => notifier.observe(doorbell))
    const started = Date.now()
    const outcome = await sender.send({ userId: 1, kind: 'task_done', strandId: 's-1', agentId: 'main' })
    expect(Date.now() - started).toBeLessThan(500)
    expect(outcome.delivered).toBe(1)
    notifier.dispose()
  })

  it('observers see doorbells even when FCM is not configured, and can unsubscribe', async () => {
    const client = new FakeClient()
    client.configured = false
    const sender = makeSender(client)
    const seen: string[] = []
    const off = sender.addObserver(doorbell => { seen.push(doorbell.kind) })
    await sender.send({ userId: 1, kind: 'question', strandId: 's-1', agentId: 'main' })
    off()
    await sender.send({ userId: 1, kind: 'task_done', strandId: 's-2', agentId: 'main' })
    expect(seen).toEqual(['question'])
    expect(client.sent).toHaveLength(0)
  })
})
