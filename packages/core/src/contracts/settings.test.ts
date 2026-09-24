import { describe, expect, it } from 'vitest'
import {
  CAPTURE_STYLE_HINT_MAX_LENGTH,
  DEFAULT_ASSIST_STYLE_HINT,
  DEFAULT_SETTINGS_CONTRACT,
  normalizeSettingsContract,
  withLegacySettingsPayloadCompatibility,
} from './settings.js'

describe('settings contracts', () => {
  it('normalizes missing sections with canonical defaults', () => {
    const normalized = normalizeSettingsContract({
      sessionTimeoutMinutes: 30,
      language: 'de',
      healthMonitor: {
        notifications: {
          degradedToHealthy: true,
        },
      },
      stt: {
        rewrite: {
          enabled: true,
        },
      },
    })

    expect(normalized.sessionTimeoutMinutes).toBe(30)
    expect(normalized.language).toBe('de')
    expect(normalized.healthMonitor.notifications.degradedToHealthy).toBe(true)
    expect(normalized.healthMonitor.notifications.healthyToDown)
      .toBe(DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.healthyToDown)
    expect(normalized.stt.rewrite.enabled).toBe(true)
    expect(normalized.stt.rewrite.providerId).toBe('')
    expect(normalized.tasks.loopDetection.method)
      .toBe(DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.method)
  })

  it('defaults watchdog, retry and the telegram stall toggle, and keeps overrides', () => {
    const defaults = normalizeSettingsContract({})

    expect(defaults.watchdog).toEqual({ stallWarnMs: 30_000, stallAbortMs: 90_000 })
    expect(defaults.retry).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2_000 })
    expect(defaults.telegram.sendStallWarnings).toBe(false)

    const overridden = normalizeSettingsContract({
      watchdog: { stallWarnMs: 5_000 },
      retry: { enabled: false, maxRetries: 0 },
      telegram: { sendStallWarnings: true },
    })

    expect(overridden.watchdog).toEqual({ stallWarnMs: 5_000, stallAbortMs: 90_000 })
    expect(overridden.retry).toEqual({ enabled: false, maxRetries: 0, baseDelayMs: 2_000 })
    expect(overridden.telegram.sendStallWarnings).toBe(true)
  })

  it('defaults instanceIdentity to an empty name (block off) and keeps overrides', () => {
    expect(normalizeSettingsContract({}).instanceIdentity).toEqual({ name: '', notes: '' })
    expect(normalizeSettingsContract({ instanceIdentity: { name: 'Offtangent' } }).instanceIdentity)
      .toEqual({ name: 'Offtangent', notes: '' })
    expect(normalizeSettingsContract({ instanceIdentity: { name: 'Offtangent', notes: 'LXC 107' } }).instanceIdentity)
      .toEqual({ name: 'Offtangent', notes: 'LXC 107' })
  })

  it('accepts legacy healthMonitor.intervalMinutes payloads', () => {
    const payload = withLegacySettingsPayloadCompatibility({
      language: 'en',
      healthMonitor: {
        intervalMinutes: 9,
      },
    })

    expect(payload.healthMonitorIntervalMinutes).toBe(9)
  })

  it('does not overwrite explicit healthMonitorIntervalMinutes with legacy values', () => {
    const payload = withLegacySettingsPayloadCompatibility({
      healthMonitorIntervalMinutes: 4,
      healthMonitor: {
        intervalMinutes: 9,
      },
    })

    expect(payload.healthMonitorIntervalMinutes).toBe(4)
  })

  it('uses legacy task status interval when only the new enabled flag is present', () => {
    const normalized = normalizeSettingsContract({
      tasks: {
        statusUpdates: { enabled: true },
        statusUpdateIntervalMinutes: 5,
      },
    } as unknown as Parameters<typeof normalizeSettingsContract>[0])

    expect(normalized.tasks.statusUpdates).toEqual({
      enabled: true,
      intervalMinutes: 5,
    })
  })

  describe('thinking level', () => {
    it('defaults both thinking levels to "off"', () => {
      expect(DEFAULT_SETTINGS_CONTRACT.thinkingLevel).toBe('off')
      expect(DEFAULT_SETTINGS_CONTRACT.tasks.backgroundThinkingLevel).toBe('off')
    })

    it('preserves valid thinking levels on normalization', () => {
      const normalized = normalizeSettingsContract({
        thinkingLevel: 'medium',
        tasks: {
          backgroundThinkingLevel: 'low',
        },
      })

      expect(normalized.thinkingLevel).toBe('medium')
      expect(normalized.tasks.backgroundThinkingLevel).toBe('low')
    })

    it('falls back to defaults when thinking level values are invalid', () => {
      const normalized = normalizeSettingsContract({
        // @ts-expect-error — deliberately passing an unsupported value
        thinkingLevel: 'extreme',
        tasks: {
          // @ts-expect-error — deliberately passing an unsupported value
          backgroundThinkingLevel: '',
        },
      })

      expect(normalized.thinkingLevel).toBe('off')
      expect(normalized.tasks.backgroundThinkingLevel).toBe('off')
    })
  })

  describe('capture modes (U10a)', () => {
    it('defaults the quick mode to inherit the model and to speak briefly', () => {
      const quick = DEFAULT_SETTINGS_CONTRACT.captureModes.quick
      expect(quick.providerId).toBe('')
      expect(quick.modelId).toBe('')
      expect(quick.thinkingLevel).toBe('off')
      expect(quick.styleHint.length).toBeGreaterThan(0)
      expect(quick.strandTitle.length).toBeGreaterThan(0)
      expect(DEFAULT_SETTINGS_CONTRACT.captureSources.puck.styleHint.length).toBeGreaterThan(0)
    })

    it('keeps an EMPTY style hint as the decision it is, and fills a MISSING one', () => {
      const cleared = normalizeSettingsContract({ captureModes: { quick: { styleHint: '' } } })
      expect(cleared.captureModes.quick.styleHint).toBe('')

      const untouched = normalizeSettingsContract({ captureModes: { quick: { thinkingLevel: 'low' } } })
      expect(untouched.captureModes.quick.styleHint)
        .toBe(DEFAULT_SETTINGS_CONTRACT.captureModes.quick.styleHint)
      expect(untouched.captureModes.quick.thinkingLevel).toBe('low')
    })

    it('replaces a blank strand title, because a strand needs a name', () => {
      const normalized = normalizeSettingsContract({ captureModes: { quick: { strandTitle: '   ' } } })
      expect(normalized.captureModes.quick.strandTitle)
        .toBe(DEFAULT_SETTINGS_CONTRACT.captureModes.quick.strandTitle)

      const named = normalizeSettingsContract({ captureModes: { quick: { strandTitle: ' Zurufe ' } } })
      expect(named.captureModes.quick.strandTitle).toBe('Zurufe')
    })

    it('falls back to "off" for an unsupported quick thinking level', () => {
      const normalized = normalizeSettingsContract({
        // @ts-expect-error — deliberately passing an unsupported value
        captureModes: { quick: { thinkingLevel: 'extreme' } },
      })
      expect(normalized.captureModes.quick.thinkingLevel).toBe('off')
    })

    it('defaults the assist mode to the draft instruction and nothing else', () => {
      const assist = DEFAULT_SETTINGS_CONTRACT.captureModes.assist
      expect(assist.styleHint).toBe(DEFAULT_ASSIST_STYLE_HINT)
      // The instruction has to name the fence, the JSON key and the plaintext
      // rule, otherwise a model has no way to produce a typable draft.
      expect(assist.styleHint).toContain('offtangent')
      expect(assist.styleHint).toContain('"block":"draft"')
      expect(assist.styleHint).toContain('Plaintext')
      expect(assist.styleHint.length).toBeLessThanOrEqual(CAPTURE_STYLE_HINT_MAX_LENGTH)
      // Assist pins neither a model nor a strand: the router decides.
      expect(Object.keys(assist)).toEqual(['styleHint'])
    })

    it('keeps an EMPTY assist hint and fills a MISSING one', () => {
      expect(normalizeSettingsContract({ captureModes: { assist: { styleHint: '' } } }).captureModes.assist.styleHint)
        .toBe('')
      expect(normalizeSettingsContract({ captureModes: { quick: { thinkingLevel: 'low' } } }).captureModes.assist.styleHint)
        .toBe(DEFAULT_ASSIST_STYLE_HINT)
      expect(normalizeSettingsContract({}).captureModes.assist.styleHint).toBe(DEFAULT_ASSIST_STYLE_HINT)
      // A custom hint survives normalization untouched.
      expect(normalizeSettingsContract({ captureModes: { assist: { styleHint: 'Kurz und knapp.' } } })
        .captureModes.assist.styleHint).toBe('Kurz und knapp.')
    })

    it('keeps a configured pair and the puck hint', () => {
      const normalized = normalizeSettingsContract({
        captureModes: { quick: { providerId: 'fast', modelId: 'tiny' } },
        captureSources: { puck: { styleHint: 'Maximal zwanzig Woerter.' } },
      })
      expect(normalized.captureModes.quick.providerId).toBe('fast')
      expect(normalized.captureModes.quick.modelId).toBe('tiny')
      expect(normalized.captureSources.puck.styleHint).toBe('Maximal zwanzig Woerter.')
    })
  })
})
