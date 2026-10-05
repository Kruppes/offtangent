import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCAL_INFERENCE_STALE_MS, beginLocalInference, beginLocalTurn, isLocalInferenceBusy, localInferenceKey,
  localInferenceActivitySizeForTest, resetLocalInferenceActivityForTest, waitForLocalInferenceIdle,
} from './local-inference-activity.js'
import { NATIVE_FIRST_TOKEN_HARD_CAP_MS } from './provider-phase.js'

// Synthetic hosts/models only.
const NATIVE = 'http://runner.test:11434'
const LEGACY = 'http://runner.test:11434/v1'

afterEach(() => resetLocalInferenceActivityForTest())

describe('local inference activity (H5 guard, review F9/F3/F10)', () => {
  it('keys by server origin + model: native /api and Legacy /v1 of one server match; :latest and case are normalized', () => {
    expect(localInferenceKey(NATIVE, 'Synth:27B')).toBe(localInferenceKey(LEGACY, 'synth:27b'))
    expect(localInferenceKey(NATIVE, 'synth:latest')).toBe(localInferenceKey(NATIVE, 'synth'))
    expect(localInferenceKey(NATIVE, 'a')).not.toBe(localInferenceKey(NATIVE, 'b'))
    expect(localInferenceKey('not a url', 'a')).toBeNull()
    expect(localInferenceKey(undefined, 'a')).toBeNull()
  })

  it('F3: loopback aliases of one port are one server; other ports and hosts stay apart; no credentials in the key', () => {
    const k = localInferenceKey('http://localhost:11434', 'm')
    expect(localInferenceKey('http://127.0.0.1:11434/v1', 'm')).toBe(k)
    expect(localInferenceKey('http://[::1]:11434', 'm')).toBe(k)
    expect(localInferenceKey('http://127.0.1.1:11434', 'm')).toBe(k)
    expect(localInferenceKey('http://localhost:11435', 'm')).not.toBe(k)
    expect(localInferenceKey('http://runner.test:11434', 'm')).not.toBe(k)
    expect(localInferenceKey('http://user:pw@runner.test:11434', 'm')).not.toContain('pw')
  })

  it('a request without a turn is busy only while in flight (no time-based linger)', () => {
    const t = 1_000_000
    const release = beginLocalInference(NATIVE, 'synth:27b', { now: () => t })
    expect(isLocalInferenceBusy(LEGACY, 'synth:27b', t)).toBe(true)
    expect(isLocalInferenceBusy(LEGACY, 'other:8b', t)).toBe(false)
    expect(isLocalInferenceBusy('http://other.test:11434', 'synth:27b', t)).toBe(false)
    release()
    release() // idempotent
    expect(isLocalInferenceBusy(NATIVE, 'synth:27b', t)).toBe(false)
    expect(localInferenceActivitySizeForTest()).toEqual({ keys: 0, turns: 0 })
  })

  it('F9: start → busy, tool gap between two requests of one turn → busy, turn end → idle at once', () => {
    const t = 2_000_000
    const endTurn = beginLocalTurn('s-1')
    const r1 = beginLocalInference(NATIVE, 'm', { sessionId: 's-1', now: () => t })
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(true)
    r1() // tool runs now
    expect(isLocalInferenceBusy(NATIVE, 'm', t + 10 * 60_000)).toBe(true)
    const r2 = beginLocalInference(NATIVE, 'm', { sessionId: 's-1', now: () => t })
    r2()
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(true)
    endTurn()
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(false)
    expect(localInferenceActivitySizeForTest()).toEqual({ keys: 0, turns: 0 })
  })

  it('F9: a turn ending by error/cancel while its request is still in flight releases the turn binding; the request lease ends with the stream', () => {
    const t = 3_000_000
    const endTurn = beginLocalTurn('s-err')
    const req = beginLocalInference(NATIVE, 'm', { sessionId: 's-err', now: () => t })
    endTurn() // finally of the turn (error / cancel)
    endTurn() // idempotent
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(true) // stream still unwinding
    req()
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(false)
    expect(localInferenceActivitySizeForTest()).toEqual({ keys: 0, turns: 0 })
  })

  it('F9: a concurrent turn of ANOTHER strand keeps the key busy after this strand\'s turn ended', () => {
    const t = 4_000_000
    const endA = beginLocalTurn('s-a')
    const endB = beginLocalTurn('s-b')
    beginLocalInference(NATIVE, 'm', { sessionId: 's-a', now: () => t })()
    beginLocalInference(NATIVE, 'm', { sessionId: 's-b', now: () => t })()
    endA()
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(true)
    endB()
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(false)
  })

  it('F10: stale bound above the 15 min first-token cap; a leaked lease stops counting after it, a streaming request is touched', () => {
    expect(LOCAL_INFERENCE_STALE_MS).toBeGreaterThan(NATIVE_FIRST_TOKEN_HARD_CAP_MS)
    let t = 5_000_000
    const leaked = beginLocalInference(NATIVE, 'm', { now: () => t }) // never released
    t += NATIVE_FIRST_TOKEN_HARD_CAP_MS // a 15 min silent prefill is still busy
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(true)
    leaked.touch() // output arrives
    t += LOCAL_INFERENCE_STALE_MS - 1
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(true)
    t += 1
    expect(isLocalInferenceBusy(NATIVE, 'm', t)).toBe(false)
    expect(localInferenceActivitySizeForTest().keys).toBe(0)
  })

  it('waitForLocalInferenceIdle returns when idle and is bounded by maxWaitMs (stuck lease never blocks forever)', async () => {
    let t = 0
    const sleep = async (ms: number) => { t += ms }
    const now = () => t
    expect(await waitForLocalInferenceIdle(NATIVE, 'm', { maxWaitMs: 10_000, now, sleep })).toEqual({ waitedMs: 0, timedOut: false })

    const release = beginLocalInference(NATIVE, 'm', { now })
    const stuck = await waitForLocalInferenceIdle(NATIVE, 'm', { maxWaitMs: 30_000, pollMs: 5_000, now, sleep })
    expect(stuck).toEqual({ waitedMs: 30_000, timedOut: true })

    release() // at t=30000 → idle at once
    const after = await waitForLocalInferenceIdle(NATIVE, 'm', { maxWaitMs: 600_000, pollMs: 5_000, now, sleep })
    expect(after).toEqual({ waitedMs: 0, timedOut: false })
  })
})
