import { beforeEach, describe, expect, it } from 'vitest'
import {
  getInteractionTelemetry,
  normalizeInteractionChannel,
  recordInteractionEvent,
  resetInteractionTelemetry,
} from './interaction-telemetry.js'
import { classifyInteractionFences } from './contracts/interaction-blocks.js'

describe('interaction telemetry (S0-B/B1)', () => {
  const lines: string[] = []
  beforeEach(() => {
    lines.length = 0
    resetInteractionTelemetry({ logger: line => lines.push(line) })
  })

  it('counts per channel and event', () => {
    recordInteractionEvent('web', 'parse_ok')
    recordInteractionEvent('telegram', 'parse_broken')
    recordInteractionEvent('app', 'click_not_ready', 3)
    const { counters } = getInteractionTelemetry()
    expect(counters.web.parse_ok).toBe(1)
    expect(counters.telegram.parse_broken).toBe(1)
    expect(counters.android.click_not_ready).toBe(3)
    expect(counters.other.parse_ok).toBe(0)
  })

  it('maps unknown channels to other and ignores unknown events', () => {
    expect(normalizeInteractionChannel('cron')).toBe('other')
    expect(normalizeInteractionChannel(42)).toBe('other')
    recordInteractionEvent('web', 'nope' as never)
    expect(Object.values(getInteractionTelemetry().counters.web).every(v => v === 0)).toBe(true)
  })

  it('logs counters only', () => {
    recordInteractionEvent('web', 'answered')
    expect(lines).toEqual(['[interaction-telemetry] channel=web event=answered count=1'])
  })

  it('returns a copy, not the live map', () => {
    const snap = getInteractionTelemetry()
    snap.counters.web.answered = 99
    expect(getInteractionTelemetry().counters.web.answered).toBe(0)
  })

  it('classifies fences without returning content', () => {
    const ok = '```offtangent\n{"block":"confirm","id":"a","question":"Q?"}\n```'
    const broken = '```offtangent\n{"block":"confirm",\n```'
    expect(classifyInteractionFences(`x\n${ok}\n${broken}`)).toEqual(['ok', 'broken'])
    expect(classifyInteractionFences('plain')).toEqual([])
  })
})
