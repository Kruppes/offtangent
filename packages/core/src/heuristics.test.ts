import { describe, expect, it, afterEach } from 'vitest'
import { DEFAULT_HEURISTICS, resolveHeuristics, loadHeuristics, setHeuristicsOverrideForTests } from './heuristics.js'
import { detectTopicShift, resolveTopicShiftThresholds, toSessionMessages } from './session-store.js'
import { parseFacts } from './fact-extraction.js'

describe('heuristics', () => {
  afterEach(() => setHeuristicsOverrideForTests(null))

  it('defaults match the former code constants', () => {
    expect(DEFAULT_HEURISTICS.topicShift).toEqual({ jaccardThreshold: 0.25, timeGapMinutes: 30, windowSize: 3, minMessages: 5, minTokens: 200 })
    expect(DEFAULT_HEURISTICS.factExtraction).toEqual({ duplicateOverlap: 0.7, maxFacts: 10 })
    expect(DEFAULT_HEURISTICS.factInjection.limit).toBe(5)
    expect(DEFAULT_HEURISTICS.sessionTail).toEqual({ messages: 5, freshnessHours: 12 })
    expect(DEFAULT_HEURISTICS.summary.minMessages).toBe(3)
    expect(DEFAULT_HEURISTICS.delegation.minBriefChars).toBe(200)
    expect(DEFAULT_HEURISTICS.strand).toEqual({ windowTokens: 24000, indexLines: 60, retrievalHits: 5, retrievalChars: 1200 })
  })

  it('merges partial overrides and ignores invalid values', () => {
    const h = resolveHeuristics({ topicShift: { jaccardThreshold: 0.4 }, strand: { windowTokens: -5, retrievalHits: 'x' as unknown as number } })
    expect(h.topicShift.jaccardThreshold).toBe(0.4)
    expect(h.topicShift.timeGapMinutes).toBe(30)
    expect(h.strand.windowTokens).toBe(24000)
    expect(h.strand.retrievalHits).toBe(5)
  })

  it('loadHeuristics honours the test override', () => {
    setHeuristicsOverrideForTests({ factInjection: { limit: 9 } })
    expect(loadHeuristics().factInjection.limit).toBe(9)
    setHeuristicsOverrideForTests(null)
    expect(loadHeuristics().factInjection.limit).toBe(5)
  })

  it('detectTopicShift and parseFacts read the configured values', () => {
    const history = toSessionMessages(Array.from({ length: 6 }, (_, i) => ({
      content: `alpha beta gamma delta epsilon message ${i} `.repeat(6),
      timestamp: new Date(Date.UTC(2026, 0, 1, 10, i)).toISOString(),
    })))
    const next = toSessionMessages([{ content: 'zeta theta kappa lambda sigma '.repeat(8), timestamp: new Date(Date.UTC(2026, 0, 1, 10, 7)).toISOString() }])[0]

    setHeuristicsOverrideForTests({ topicShift: { minMessages: 99 } })
    expect(detectTopicShift(history, next).insufficient).toBe(true)
    expect(resolveTopicShiftThresholds().minMessages).toBe(99)
    // An explicit argument wins over the configured value.
    expect(detectTopicShift(history, next, false, { minMessages: 1 }).insufficient).toBe(false)

    setHeuristicsOverrideForTests({ factExtraction: { maxFacts: 1 } })
    expect(parseFacts('- one\n- two\n- three')).toHaveLength(1)
  })
})
