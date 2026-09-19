import { describe, expect, it } from 'vitest'
import {
  mergeAgentHeartbeat,
  mergeConsolidation,
  mergeFactExtraction,
  mergeHealthMonitor,
  mergeInstanceIdentity,
  mergeOfftangent,
  mergeRetry,
  mergeStt,
  mergeTasks,
  mergeTts,
  mergeWatchdog,
  normalizeSettingsPayload,
  validateEnum,
  validateHour,
  validateIntegerRange,
  validateNonEmptyString,
  validateNonNegativeNumber,
  validatePositiveNumber,
} from './schema.js'

describe('settings schema', () => {
  it('supports legacy healthMonitor interval payloads', () => {
    expect(normalizeSettingsPayload({
      healthMonitor: {
        intervalMinutes: 11,
      },
    })).toEqual({
      healthMonitor: {
        intervalMinutes: 11,
      },
      healthMonitorIntervalMinutes: 11,
    })
  })

  it('validates scalar helper primitives', () => {
    expect(validatePositiveNumber(0, 'sessionTimeoutMinutes')).toBe('sessionTimeoutMinutes must be a positive number')
    expect(validatePositiveNumber(5, 'sessionTimeoutMinutes')).toBeNull()

    expect(validateNonNegativeNumber(-1, 'batchingDelayMs')).toBe('batchingDelayMs must be a non-negative number')
    expect(validateNonNegativeNumber(0, 'batchingDelayMs')).toBeNull()

    expect(validateHour(24, 'agentHeartbeat.nightMode.endHour')).toBe('agentHeartbeat.nightMode.endHour must be an integer 0-23')
    expect(validateHour(3, 'agentHeartbeat.nightMode.endHour')).toBeNull()

    expect(validateIntegerRange(121, 'tasks.statusUpdates.intervalMinutes', 1, 120)).toBe('tasks.statusUpdates.intervalMinutes must be an integer 1-120')
    expect(validateIntegerRange(10, 'tasks.statusUpdates.intervalMinutes', 1, 120)).toBeNull()

    expect(validateNonEmptyString('', 'language')).toBe('language must be a non-empty string')
    expect(validateNonEmptyString('German', 'language')).toBeNull()

    expect(validateEnum('invalid', ['a', 'b'], 'field')).toBe('field must be "a" or "b"')
    expect(validateEnum('a', ['a', 'b'], 'field')).toBeNull()
  })

  it('merges health monitor settings and validates fallback trigger', () => {
    const settingsRaw: Record<string, unknown> = {}

    const invalid = mergeHealthMonitor({ healthMonitor: { fallbackTrigger: 'invalid' } }, settingsRaw)
    expect(invalid).toEqual({
      error: 'healthMonitor.fallbackTrigger must be "down" or "degraded"',
      changed: false,
    })

    const valid = mergeHealthMonitor({
      healthMonitor: {
        fallbackTrigger: 'degraded',
        notifications: { degradedToDown: false },
      },
    }, settingsRaw)

    expect(valid).toEqual({ error: null, changed: true })
    expect(settingsRaw.healthMonitor).toEqual({
      fallbackTrigger: 'degraded',
      notifications: { degradedToDown: false },
    })
  })

  it('merges nested settings groups with boundary validation', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeConsolidation({ memoryConsolidation: { lookbackDays: 0 } }, settingsRaw)).toEqual({
      error: 'memoryConsolidation.lookbackDays must be an integer 1-30',
      changed: false,
    })

    expect(mergeFactExtraction({ factExtraction: { minSessionMessages: 5 } }, settingsRaw)).toEqual({
      error: null,
      changed: true,
    })

    expect(mergeAgentHeartbeat({
      agentHeartbeat: {
        nightMode: {
          startHour: 40,
        },
      },
    }, settingsRaw)).toEqual({
      error: 'agentHeartbeat.nightMode.startHour must be an integer 0-23',
      changed: false,
    })

    expect((settingsRaw.factExtraction as Record<string, unknown>).minSessionMessages).toBe(5)
  })

  it('merges watchdog thresholds and keeps abort at or above warn', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeWatchdog({ watchdog: { stallWarnMs: 500 } }, settingsRaw)).toEqual({
      error: 'watchdog.stallWarnMs must be an integer 1000-600000',
      changed: false,
    })

    expect(mergeWatchdog({ watchdog: { stallAbortMs: 5_000_000 } }, settingsRaw)).toEqual({
      error: 'watchdog.stallAbortMs must be an integer 1000-3600000',
      changed: false,
    })

    expect(mergeWatchdog({ watchdog: { stallWarnMs: 60_000, stallAbortMs: 10_000 } }, settingsRaw)).toEqual({
      error: 'watchdog.stallAbortMs must be greater than or equal to watchdog.stallWarnMs',
      changed: false,
    })

    expect(mergeWatchdog({ watchdog: { stallWarnMs: 15_000, stallAbortMs: 45_000 } }, settingsRaw)).toEqual({
      error: null,
      changed: true,
    })
    expect(settingsRaw.watchdog).toEqual({ stallWarnMs: 15_000, stallAbortMs: 45_000 })

    // A partial update is validated against the stored counterpart, not the default.
    expect(mergeWatchdog({ watchdog: { stallAbortMs: 10_000 } }, settingsRaw)).toEqual({
      error: 'watchdog.stallAbortMs must be greater than or equal to watchdog.stallWarnMs',
      changed: false,
    })
  })

  it('merges the retry policy with bounded values', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeRetry({ retry: { maxRetries: 11 } }, settingsRaw)).toEqual({
      error: 'retry.maxRetries must be an integer 0-10',
      changed: false,
    })

    expect(mergeRetry({ retry: { baseDelayMs: 10 } }, settingsRaw)).toEqual({
      error: 'retry.baseDelayMs must be an integer 100-60000',
      changed: false,
    })

    expect(mergeRetry({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 500 } }, settingsRaw)).toEqual({
      error: null,
      changed: true,
    })
    expect(settingsRaw.retry).toEqual({ enabled: false, maxRetries: 0, baseDelayMs: 500 })
  })

  it('leaves watchdog and retry untouched when the payload omits them', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeWatchdog({}, settingsRaw)).toEqual({ error: null, changed: false })
    expect(mergeRetry({}, settingsRaw)).toEqual({ error: null, changed: false })
    expect(settingsRaw).toEqual({})
  })

  it('validates tasks, tts, and stt payload fragments', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeTasks({ tasks: { telegramDelivery: 'never' } }, settingsRaw)).toEqual({
      error: 'tasks.telegramDelivery must be "auto" or "always"',
    })

    expect(mergeTasks({ tasks: { statusUpdates: { intervalMinutes: 121 } } }, settingsRaw)).toEqual({
      error: 'tasks.statusUpdates.intervalMinutes must be an integer 1-120',
    })

    expect(mergeTasks({ tasks: { statusUpdateIntervalMinutes: 1.5 } }, settingsRaw)).toEqual({
      error: 'tasks.statusUpdateIntervalMinutes must be an integer 1-120',
    })

    expect(mergeTts({ tts: { openaiVoice: '' } }, settingsRaw)).toEqual({
      error: 'tts.openaiVoice must be a non-empty string',
    })

    expect(mergeStt({ stt: { rewrite: { providerId: 42 } } }, settingsRaw)).toEqual({
      error: 'stt.rewrite.providerId must be a string',
    })
  })

  it('accepts the gemini TTS provider and validates its fields', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeTts({ tts: { provider: 'gemini', geminiModel: ' gemini-3.1-flash-tts-preview ', geminiVoice: 'Charon', geminiStyle: 'Sprich ruhig:' } }, settingsRaw))
      .toEqual({ error: null })
    expect(settingsRaw.tts).toMatchObject({
      provider: 'gemini',
      geminiModel: 'gemini-3.1-flash-tts-preview',
      geminiVoice: 'Charon',
      geminiStyle: 'Sprich ruhig:',
    })

    expect(mergeTts({ tts: { geminiVoice: 'Nova' } }, settingsRaw)).toEqual({
      error: 'tts.geminiVoice must be one of the prebuilt Gemini voices',
    })
    expect(mergeTts({ tts: { geminiModel: '  ' } }, settingsRaw)).toEqual({
      error: 'tts.geminiModel must be a non-empty string',
    })
    expect(mergeTts({ tts: { geminiStyle: 7 } }, settingsRaw)).toEqual({
      error: 'tts.geminiStyle must be a string',
    })
    // Invalid fragments leave the accepted values untouched.
    expect((settingsRaw.tts as Record<string, unknown>).geminiVoice).toBe('Charon')
  })

  it('validates tasks.backgroundThinkingLevel against the enum', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeTasks({ tasks: { backgroundThinkingLevel: 'extreme' } }, settingsRaw)).toEqual({
      error: 'tasks.backgroundThinkingLevel must be "off" or "minimal" or "low" or "medium" or "high" or "xhigh"',
    })

    expect(mergeTasks({ tasks: { backgroundThinkingLevel: 'medium' } }, settingsRaw)).toEqual({
      error: null,
    })
    expect((settingsRaw.tasks as Record<string, unknown>).backgroundThinkingLevel).toBe('medium')
  })

  it('validates offtangent.nowSetMax against its range', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeOfftangent({ offtangent: { nowSetMax: 0 } }, settingsRaw)).toEqual({
      error: 'offtangent.nowSetMax must be an integer 1-12',
      changed: false,
    })
    expect(mergeOfftangent({ offtangent: { nowSetMax: 13 } }, settingsRaw)).toEqual({
      error: 'offtangent.nowSetMax must be an integer 1-12',
      changed: false,
    })
    expect(mergeOfftangent({ offtangent: { nowSetMax: 4.5 } }, settingsRaw)).toEqual({
      error: 'offtangent.nowSetMax must be an integer 1-12',
      changed: false,
    })
    expect(settingsRaw).toEqual({})

    expect(mergeOfftangent({ offtangent: { nowSetMax: 10 } }, settingsRaw)).toEqual({
      error: null,
      changed: true,
    })
    expect(settingsRaw).toEqual({ offtangent: { nowSetMax: 10 } })

    expect(mergeOfftangent({}, settingsRaw)).toEqual({ error: null, changed: false })
  })

  it('validates instanceIdentity as trimmed strings and lets an empty name switch the block off', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeInstanceIdentity({}, settingsRaw)).toEqual({ error: null, changed: false })
    expect(mergeInstanceIdentity({ instanceIdentity: { name: 42 } }, settingsRaw)).toEqual({
      error: 'instanceIdentity.name must be a string',
      changed: false,
    })
    expect(mergeInstanceIdentity({ instanceIdentity: { notes: ['x'] } }, settingsRaw)).toEqual({
      error: 'instanceIdentity.notes must be a string',
      changed: false,
    })
    expect(mergeInstanceIdentity({ instanceIdentity: { name: 'x'.repeat(121) } }, settingsRaw)).toEqual({
      error: 'instanceIdentity.name must be at most 120 characters',
      changed: false,
    })
    expect(mergeInstanceIdentity({ instanceIdentity: { notes: 'x'.repeat(4001) } }, settingsRaw)).toEqual({
      error: 'instanceIdentity.notes must be at most 4000 characters',
      changed: false,
    })
    expect(settingsRaw).toEqual({})

    expect(mergeInstanceIdentity({ instanceIdentity: { name: '  Offtangent ', notes: ' LXC 107 ' } }, settingsRaw)).toEqual({
      error: null,
      changed: true,
    })
    expect(settingsRaw).toEqual({ instanceIdentity: { name: 'Offtangent', notes: 'LXC 107' } })

    // Partial update keeps the other field.
    expect(mergeInstanceIdentity({ instanceIdentity: { name: '' } }, settingsRaw)).toEqual({ error: null, changed: true })
    expect(settingsRaw).toEqual({ instanceIdentity: { name: '', notes: 'LXC 107' } })
  })
})
