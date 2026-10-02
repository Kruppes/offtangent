import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { arcDash, formatTokens, gaugeBand, gaugePercent, mapContextReport, ringGeometry, tickPoint } from './contextGauge'
import { STRAND_CONTEXT_PATH, STRAND_FACTS_PREVIEW_PATH } from '~/api/strandContext'

const backend = path.resolve(__dirname, '../../../web-backend/src/api/modules/strands')
const route = readFileSync(path.join(backend, 'route.ts'), 'utf8')
const service = readFileSync(path.join(backend, 'service.ts'), 'utf8')

/** Exactly the shape of `StrandContextReport` (synthetic numbers). */
const REPORT = {
  strandId: 'strand-1',
  measurement: { state: 'measured', requestTokens: 128_000, inputTokens: 3_000, cacheReadTokens: 120_000, cacheWriteTokens: 5_000, outputTokens: 900, measuredAt: '2026-01-01T10:00:00.000Z', measuredModelId: 'model-a', measuredProviderId: 'p', stale: false, estimated: false },
  budget: { contextWindow: 200_000, outputCapTokens: 64_000, outputCapSource: 'model_catalog' },
  transcript: { state: 'measured', estimatedTokens: 40_000, budgetTokens: 150_000, at: '2026-01-01T10:00:00.000Z', trimmedMessages: 0, estimated: true },
  lastCompaction: { at: '2026-01-01T09:00:00.000Z', droppedMessages: 12, keptTokens: 30_000, budgetTokens: 150_000 },
  model: { providerId: 'p', modelId: 'model-a', source: 'global', displayName: 'Model A', providerName: 'P' },
  generatedAt: '2026-01-01T10:00:01.000Z',
}

describe('strand context contract (pinned against the backend router)', () => {
  it('reads GET /api/strands/:id/context and the delete preview', () => {
    expect(STRAND_CONTEXT_PATH('a b')).toBe('/api/strands/a%20b/context')
    expect(STRAND_FACTS_PREVIEW_PATH('s1')).toBe('/api/strands/s1/delete-preview')
    expect(route).toContain("strands.get('/:id/context', controller.strandContext)")
    expect(route).toContain("strands.get('/:id/delete-preview', controller.deletePreview)")
    for (const field of ['measurement: StrandContextMeasurement', 'budget: StrandContextBudget', 'transcript: StrandTranscriptStatus', 'requestTokens: number | null', 'contextWindow: number | null', 'stale: boolean']) {
      expect(service).toContain(field)
    }
  })
})

describe('context mapping', () => {
  it('maps a measured report', () => {
    const view = mapContextReport(REPORT)
    expect(view).toMatchObject({ measured: true, requestTokens: 128_000, contextWindow: 200_000, ratio: 0.64, modelLabel: 'Model A', transcriptTokens: 40_000, lastCompaction: { at: '2026-01-01T09:00:00.000Z', droppedMessages: 12 } })
  })

  it('an unmeasured strand has no ratio and no numbers, never zero', () => {
    const view = mapContextReport({ ...REPORT, measurement: { state: 'unknown', requestTokens: null, stale: false, estimated: false } })
    expect(view.measured).toBe(false)
    expect(view.requestTokens).toBeNull()
    expect(view.ratio).toBeNull()
  })

  it('no window means no ratio', () => {
    expect(mapContextReport({ ...REPORT, budget: { contextWindow: null } }).ratio).toBeNull()
    expect(mapContextReport({ ...REPORT, budget: { contextWindow: 0 } }).ratio).toBeNull()
  })

  it('survives garbage', () => {
    expect(mapContextReport(null).ratio).toBeNull()
    expect(mapContextReport({ measurement: { state: 'measured', requestTokens: 'x' } }).requestTokens).toBeNull()
  })
})

describe('ring', () => {
  it('bands at 0.7 and 0.9', () => {
    expect(gaugeBand(null)).toBe('unknown')
    expect(gaugeBand(0.4)).toBe('ok')
    expect(gaugeBand(0.6999)).toBe('ok')
    expect(gaugeBand(0.7)).toBe('caution')
    expect(gaugeBand(0.75)).toBe('caution')
    expect(gaugeBand(0.9)).toBe('full')
    expect(gaugeBand(1.3)).toBe('full')
  })

  it('splits the fill at the caution mark', () => {
    expect(ringGeometry(0.4)).toEqual({ base: 0.4, over: 0, ticks: [0.7, 0.9], band: 'ok' })
    const caution = ringGeometry(0.75)
    expect(caution.base).toBe(0.7)
    expect(caution.over).toBeCloseTo(0.05)
    const full = ringGeometry(1.4)
    expect(full.base + full.over).toBe(1)
    expect(ringGeometry(null)).toMatchObject({ base: 0, over: 0, band: 'unknown' })
  })

  it('percent and token labels', () => {
    expect(gaugePercent(0.644)).toBe(64)
    expect(gaugePercent(null)).toBeNull()
    expect(formatTokens(null)).toBe('–')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(200_000)).toBe('200k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  it('dash and tick geometry', () => {
    expect(arcDash(100, 0.7, 0.05)).toEqual({ dasharray: '5 100', dashoffset: -70 })
    const top = tickPoint(10, 10, 5, 0)
    expect(top.x).toBeCloseTo(10)
    expect(top.y).toBeCloseTo(5)
    const right = tickPoint(10, 10, 5, 0.25)
    expect(right.x).toBeCloseTo(15)
  })
})
