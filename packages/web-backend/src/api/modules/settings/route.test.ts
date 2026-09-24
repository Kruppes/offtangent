import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AgentCore, Database } from '@axiom/core'
import { initDatabase, loadRetryPolicy, loadStallThresholds } from '@axiom/core'
import { createApp } from '../../../app.js'
import type { AppOptions } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'
import { resolveNowSetMax, resolveNowSetMode } from '../../../now-set-limit.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined

const setTimeoutMinutes = vi.fn()
const refreshSystemPrompt = vi.fn()
const onHealthMonitorSettingsChanged = vi.fn()
const onConsolidationSettingsChanged = vi.fn()
const onAgentHeartbeatSettingsChanged = vi.fn()
const onTelegramSettingsChanged = vi.fn()

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-settings-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')

  const getAgentCore = () => ({
    getSessionManager: () => ({ setTimeoutMinutes }),
    refreshSystemPrompt,
  }) as unknown as AgentCore

  server = http.createServer(createApp({
    db,
    getAgentCore,
    onAgentHeartbeatSettingsChanged,
    onTelegramSettingsChanged,
    healthMonitorService: {
      restart: onHealthMonitorSettingsChanged,
    } as unknown as NonNullable<AppOptions['healthMonitorService']>,
    consolidationScheduler: {
      restart: onConsolidationSettingsChanged,
    } as unknown as NonNullable<AppOptions['consolidationScheduler']>,
    agentHeartbeatService: {
      restart: vi.fn(),
    } as unknown as NonNullable<AppOptions['agentHeartbeatService']>,
  }))

  await new Promise<void>((resolve) => server.listen(0, resolve))

  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}`

  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))

  if (previousDataDir === undefined) {
    delete process.env.DATA_DIR
  } else {
    process.env.DATA_DIR = previousDataDir
  }

  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  setTimeoutMinutes.mockClear()
  refreshSystemPrompt.mockClear()
  onHealthMonitorSettingsChanged.mockClear()
  onConsolidationSettingsChanged.mockClear()
  onAgentHeartbeatSettingsChanged.mockClear()
  onTelegramSettingsChanged.mockClear()
})

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('settings route module', () => {
  it('keeps settings read behavior stable', async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      headers: authHeaders(adminToken),
    })

    const body = await response.json() as {
      telegram: { enabled: boolean; botToken: string; batchingDelayMs: number }
      factExtraction: { enabled: boolean; providerId: string; minSessionMessages: number }
      healthMonitor: { notifications: { downToFallback: boolean } }
    }

    expect(response.status).toBe(200)
    expect(body.telegram).toEqual({
      enabled: false,
      botToken: '',
      batchingDelayMs: 2500,
      sendVoiceReply: false,
      sendStallWarnings: false,
    })
    expect(body.factExtraction).toEqual({ enabled: true, providerId: '', minSessionMessages: 3 })
    expect(body.healthMonitor.notifications.downToFallback).toBe(true)
  })

  it('updates settings, persists to disk, and applies side effects', async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionTimeoutMinutes: 35,
        language: 'German',
        timezone: 'Europe/Berlin',
        healthMonitorIntervalMinutes: 9,
        telegram: {
          enabled: true,
          botToken: 'token-123',
        },
        memoryConsolidation: {
          enabled: true,
          runAtHour: 2,
          lookbackDays: 4,
        },
        agentHeartbeat: {
          enabled: true,
        },
      }),
    })

    const body = await response.json() as {
      sessionTimeoutMinutes: number
      language: string
      timezone: string
      healthMonitorIntervalMinutes: number
      telegram: { enabled: boolean; botToken: string; batchingDelayMs: number }
      memoryConsolidation: { enabled: boolean; runAtHour: number; lookbackDays: number }
      agentHeartbeat: { enabled: boolean }
    }

    expect(response.status).toBe(200)
    expect(body.sessionTimeoutMinutes).toBe(35)
    expect(body.language).toBe('German')
    expect(body.timezone).toBe('Europe/Berlin')
    expect(body.healthMonitorIntervalMinutes).toBe(9)
    expect(body.telegram.enabled).toBe(true)
    expect(body.telegram.botToken).toBe('token-123')
    expect(body.memoryConsolidation).toEqual({ enabled: true, runAtHour: 2, lookbackDays: 4, providerId: '' })
    expect(body.agentHeartbeat.enabled).toBe(true)

    expect(setTimeoutMinutes).toHaveBeenCalledWith(35)
    expect(refreshSystemPrompt).toHaveBeenCalled()
    expect(onHealthMonitorSettingsChanged).toHaveBeenCalled()
    expect(onConsolidationSettingsChanged).toHaveBeenCalled()
    expect(onAgentHeartbeatSettingsChanged).toHaveBeenCalled()
    expect(onTelegramSettingsChanged).toHaveBeenCalled()

    const settingsPath = path.join(tempDataDir, 'config', 'settings.json')
    const telegramPath = path.join(tempDataDir, 'config', 'telegram.json')

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      sessionTimeoutMinutes: number
      language: string
      timezone: string
      healthMonitorIntervalMinutes: number
      memoryConsolidation: { enabled: boolean }
      agentHeartbeat: { enabled: boolean }
    }
    const telegram = JSON.parse(fs.readFileSync(telegramPath, 'utf-8')) as {
      enabled: boolean
      botToken: string
    }

    expect(settings.sessionTimeoutMinutes).toBe(35)
    expect(settings.language).toBe('German')
    expect(settings.timezone).toBe('Europe/Berlin')
    expect(settings.healthMonitorIntervalMinutes).toBe(9)
    expect(settings.memoryConsolidation.enabled).toBe(true)
    expect(settings.agentHeartbeat.enabled).toBe(true)
    expect(telegram.enabled).toBe(true)
    expect(telegram.botToken).toBe('token-123')
  })

  it('accepts 0 as "no session timeout" so a form echoing the stored 0 can still save', async () => {
    // Regression: with sessionTimeoutMinutes: 0 on disk, every save of ANY
    // field failed with "must be a positive number" because the form sends
    // all fields back. 0 is a legitimate runtime value (timer disabled).
    const put = (payload: Record<string, unknown>) => fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { ...authHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const disabled = await put({ sessionTimeoutMinutes: 0 })
    expect(disabled.status).toBe(200)
    expect(setTimeoutMinutes).toHaveBeenCalledWith(0)

    const otherField = await put({ sessionTimeoutMinutes: 0, language: 'German' })
    expect(otherField.status).toBe(200)
    expect((await otherField.json() as { language: string }).language).toBe('German')

    const negative = await put({ sessionTimeoutMinutes: -1 })
    expect(negative.status).toBe(400)
    expect((await negative.json() as { error: string }).error).toBe('sessionTimeoutMinutes must be a non-negative number')
  })

  it('preserves validation and legacy payload handling', async () => {
    const invalidResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tasks: {
          telegramDelivery: 'never',
        },
      }),
    })

    expect(invalidResponse.status).toBe(400)
    expect(await invalidResponse.json()).toEqual({
      error: 'tasks.telegramDelivery must be "auto" or "always"',
    })

    const legacyResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        healthMonitor: {
          intervalMinutes: 12,
        },
      }),
    })

    expect(legacyResponse.status).toBe(200)
    const legacyBody = await legacyResponse.json() as { healthMonitorIntervalMinutes: number }
    expect(legacyBody.healthMonitorIntervalMinutes).toBe(12)
  })

  it('round-trips watchdog, retry and the telegram stall-warning toggle', async () => {
    const defaults = await fetch(`${baseUrl}/api/settings`, {
      headers: authHeaders(adminToken),
    })

    const defaultsBody = await defaults.json() as {
      watchdog: { stallWarnMs: number; stallAbortMs: number }
      retry: { enabled: boolean; maxRetries: number; baseDelayMs: number }
      telegram: { sendStallWarnings: boolean }
    }

    expect(defaultsBody.watchdog).toEqual({ stallWarnMs: 30000, stallAbortMs: 90000 })
    expect(defaultsBody.retry).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000 })
    expect(defaultsBody.telegram.sendStallWarnings).toBe(false)

    const updated = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        watchdog: { stallWarnMs: 15000, stallAbortMs: 45000 },
        retry: { enabled: false, maxRetries: 5, baseDelayMs: 1000 },
        telegram: { sendStallWarnings: true },
      }),
    })

    expect(updated.status).toBe(200)

    const settings = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'config', 'settings.json'), 'utf-8')) as {
      watchdog: { stallWarnMs: number; stallAbortMs: number }
      retry: { enabled: boolean; maxRetries: number; baseDelayMs: number }
    }
    const telegram = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'config', 'telegram.json'), 'utf-8')) as {
      sendStallWarnings: boolean
    }

    expect(settings.watchdog).toEqual({ stallWarnMs: 15000, stallAbortMs: 45000 })
    expect(settings.retry).toEqual({ enabled: false, maxRetries: 5, baseDelayMs: 1000 })
    expect(telegram.sendStallWarnings).toBe(true)

    // The persisted overrides are what the watchdog / retry loop read at turn start.
    expect(loadStallThresholds()).toEqual({ warnMs: 15000, abortMs: 45000 })
    expect(loadRetryPolicy()).toEqual({ enabled: false, maxRetries: 5, baseDelayMs: 1000 })

    const reread = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders(adminToken) })
    const rereadBody = await reread.json() as {
      watchdog: { stallWarnMs: number; stallAbortMs: number }
      retry: { enabled: boolean; maxRetries: number; baseDelayMs: number }
      telegram: { sendStallWarnings: boolean }
    }

    expect(rereadBody.watchdog).toEqual({ stallWarnMs: 15000, stallAbortMs: 45000 })
    expect(rereadBody.retry).toEqual({ enabled: false, maxRetries: 5, baseDelayMs: 1000 })
    expect(rereadBody.telegram.sendStallWarnings).toBe(true)

    const invalid = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ retry: { maxRetries: 42 } }),
    })

    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'retry.maxRetries must be an integer 0-10' })
  })

  it('round-trips offtangent.nowSetMax and rejects an out-of-range value instead of clamping it', async () => {
    const defaults = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders(adminToken) })
    const defaultsBody = await defaults.json() as { offtangent: { nowSetMax: number } }
    expect(defaultsBody.offtangent).toEqual({ nowSetMax: 4, nowSetMode: 'auto' })

    const updated = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ offtangent: { nowSetMax: 10 } }),
    })

    expect(updated.status).toBe(200)
    expect((await updated.json() as { offtangent: { nowSetMax: number } }).offtangent).toEqual({ nowSetMax: 10, nowSetMode: 'auto' })

    const settings = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'config', 'settings.json'), 'utf-8')) as {
      offtangent: { nowSetMax: number }
    }
    expect(settings.offtangent).toEqual({ nowSetMax: 10 })  // only the written key lands on disk
    expect(resolveNowSetMax()).toBe(10)

    const tooLarge = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ offtangent: { nowSetMax: 13 } }),
    })

    expect(tooLarge.status).toBe(400)
    expect(await tooLarge.json()).toEqual({ error: 'offtangent.nowSetMax must be an integer 1-12' })

    // The rejected write left the stored value alone — no silent clamp to 12.
    const reread = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders(adminToken) })
    expect((await reread.json() as { offtangent: { nowSetMax: number } }).offtangent).toEqual({ nowSetMax: 10, nowSetMode: 'auto' })
  })

  it('round-trips offtangent.nowSetMode and rejects an unknown value', async () => {
    const updated = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { ...authHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ offtangent: { nowSetMode: 'manual' } }),
    })
    expect(updated.status).toBe(200)
    expect((await updated.json() as { offtangent: { nowSetMode: string } }).offtangent.nowSetMode).toBe('manual')
    expect(resolveNowSetMode()).toBe('manual')

    const invalid = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { ...authHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ offtangent: { nowSetMode: 'automatic' } }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'offtangent.nowSetMode must be "auto" or "manual"' })

    // The rejected write left the stored mode alone.
    const reread = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders(adminToken) })
    expect((await reread.json() as { offtangent: { nowSetMode: string } }).offtangent.nowSetMode).toBe('manual')

    // Back to the default, so the order of the tests in this file stays free.
    await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { ...authHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ offtangent: { nowSetMode: 'auto' } }),
    })
  })

  it('round-trips instanceIdentity and reports empty defaults', async () => {
    const defaults = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders(adminToken) })
    const defaultsBody = await defaults.json() as { instanceIdentity: { name: string; notes: string } }
    expect(defaultsBody.instanceIdentity).toEqual({ name: '', notes: '' })

    const updated = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ instanceIdentity: { name: 'Offtangent', notes: 'Container offtangent on LXC 107.' } }),
    })

    expect(updated.status).toBe(200)
    expect((await updated.json() as { instanceIdentity: { name: string; notes: string } }).instanceIdentity)
      .toEqual({ name: 'Offtangent', notes: 'Container offtangent on LXC 107.' })

    const settings = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'config', 'settings.json'), 'utf-8')) as {
      instanceIdentity: { name: string; notes: string }
    }
    expect(settings.instanceIdentity).toEqual({ name: 'Offtangent', notes: 'Container offtangent on LXC 107.' })

    const invalid = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ instanceIdentity: { name: 7 } }),
    })

    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'instanceIdentity.name must be a string' })
  })

  it('round-trips the quick capture mode and refuses half a model pair', async () => {
    const put = async (body: unknown) => fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { ...authHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const saved = await put({
      captureModes: { quick: { providerId: 'fast', modelId: 'tiny', thinkingLevel: 'low', styleHint: ' Zwei Saetze. ', strandTitle: ' Zurufe ' } },
      captureSources: { puck: { styleHint: 'Maximal zwanzig Woerter.' } },
    })
    expect(saved.status).toBe(200)
    const body = await saved.json() as {
      captureModes: { quick: { providerId: string; modelId: string; thinkingLevel: string; styleHint: string; strandTitle: string } }
      captureSources: { puck: { styleHint: string } }
    }
    expect(body.captureModes.quick).toEqual({
      providerId: 'fast', modelId: 'tiny', thinkingLevel: 'low', styleHint: 'Zwei Saetze.', strandTitle: 'Zurufe',
    })
    expect(body.captureSources.puck.styleHint).toBe('Maximal zwanzig Woerter.')

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'config', 'settings.json'), 'utf-8')) as {
      captureModes: { quick: { providerId: string; strandTitle: string } }
    }
    expect(onDisk.captureModes.quick.providerId).toBe('fast')
    expect(onDisk.captureModes.quick.strandTitle).toBe('Zurufe')

    // Half a pair is not a pin, it is a bug waiting to happen.
    const half = await put({ captureModes: { quick: { modelId: '' } } })
    expect(half.status).toBe(400)
    expect(await half.json()).toEqual({
      error: 'captureModes.quick.providerId and captureModes.quick.modelId must both be set, or both empty',
    })

    // ...and the rejected write changed nothing.
    const reread = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders(adminToken) })
    expect((await reread.json() as { captureModes: { quick: { modelId: string } } }).captureModes.quick.modelId).toBe('tiny')

    const badLevel = await put({ captureModes: { quick: { thinkingLevel: 'extreme' } } })
    expect(badLevel.status).toBe(400)
    expect((await badLevel.json() as { error: string }).error).toContain('captureModes.quick.thinkingLevel')

    const tooLong = await put({ captureSources: { puck: { styleHint: 'x'.repeat(2001) } } })
    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toEqual({ error: 'captureSources.puck.styleHint must be at most 2000 characters' })

    // Clearing the pin is allowed, both fields together.
    const cleared = await put({ captureModes: { quick: { providerId: '', modelId: '' } } })
    expect(cleared.status).toBe(200)
    expect((await cleared.json() as { captureModes: { quick: { providerId: string; modelId: string } } }).captureModes.quick)
      .toMatchObject({ providerId: '', modelId: '' })
  })

  it('round-trips the assist capture mode hint and bounds its length', async () => {
    const put = async (body: unknown) => fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { ...authHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    // The shipped default is served without any write at all.
    const fresh = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders(adminToken) })
    const before = await fresh.json() as { captureModes: { assist: { styleHint: string } } }
    expect(before.captureModes.assist.styleHint).toContain('"block":"draft"')

    const saved = await put({ captureModes: { assist: { styleHint: '  Nur der Entwurf.  ' } } })
    expect(saved.status).toBe(200)
    const body = await saved.json() as { captureModes: { assist: { styleHint: string }; quick: { styleHint: string } } }
    expect(body.captureModes.assist).toEqual({ styleHint: 'Nur der Entwurf.' })
    // Writing the assist hint does not disturb the quick mode next to it.
    expect(body.captureModes.quick.styleHint.length).toBeGreaterThan(0)

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'config', 'settings.json'), 'utf-8')) as {
      captureModes: { assist: { styleHint: string } }
    }
    expect(onDisk.captureModes.assist.styleHint).toBe('Nur der Entwurf.')

    const tooLong = await put({ captureModes: { assist: { styleHint: 'x'.repeat(2001) } } })
    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toEqual({ error: 'captureModes.assist.styleHint must be at most 2000 characters' })

    const wrongType = await put({ captureModes: { assist: { styleHint: 42 } } })
    expect(wrongType.status).toBe(400)
    expect(await wrongType.json()).toEqual({ error: 'captureModes.assist.styleHint must be a string' })

    // ...and the rejected writes changed nothing.
    const reread = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders(adminToken) })
    expect((await reread.json() as { captureModes: { assist: { styleHint: string } } }).captureModes.assist.styleHint)
      .toBe('Nur der Entwurf.')
  })

  it('enforces authentication and admin boundaries', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/settings`)
    expect(unauthenticated.status).toBe(401)

    const nonAdmin = await fetch(`${baseUrl}/api/settings`, {
      headers: authHeaders(userToken),
    })
    expect(nonAdmin.status).toBe(403)
  })
})
