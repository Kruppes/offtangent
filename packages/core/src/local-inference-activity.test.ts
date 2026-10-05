import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCAL_INFERENCE_LINGER_MS, beginLocalInference, isLocalInferenceBusy, localInferenceKey,
  resetLocalInferenceActivityForTest, waitForLocalInferenceIdle,
} from './local-inference-activity.js'

// Synthetic hosts/models only.
const NATIVE = 'http://runner.test:11434'
const LEGACY = 'http://runner.test:11434/v1'

afterEach(() => resetLocalInferenceActivityForTest())

describe('local inference activity (H5 guard)', () => {
  it('keys by server origin + model: native /api and Legacy /v1 of one server match; :latest and case are normalized', () => {
    expect(localInferenceKey(NATIVE, 'Synth:27B')).toBe(localInferenceKey(LEGACY, 'synth:27b'))
    expect(localInferenceKey(NATIVE, 'synth:latest')).toBe(localInferenceKey(NATIVE, 'synth'))
    expect(localInferenceKey(NATIVE, 'a')).not.toBe(localInferenceKey(NATIVE, 'b'))
    expect(localInferenceKey('not a url', 'a')).toBeNull()
    expect(localInferenceKey(undefined, 'a')).toBeNull()
  })

  it('busy while a lease is held and during the linger, idle afterwards; other models/servers unaffected', () => {
    let t = 1_000_000
    const release = beginLocalInference(NATIVE, 'synth:27b', () => t)
    expect(isLocalInferenceBusy(LEGACY, 'synth:27b', t)).toBe(true)
    expect(isLocalInferenceBusy(LEGACY, 'other:8b', t)).toBe(false)
    expect(isLocalInferenceBusy('http://other.test:11434', 'synth:27b', t)).toBe(false)
    t += 500_000 // a long prefill: still busy, no time limit while the lease is held
    expect(isLocalInferenceBusy(NATIVE, 'synth:27b', t)).toBe(true)
    release()
    release() // idempotent
    expect(isLocalInferenceBusy(NATIVE, 'synth:27b', t + LOCAL_INFERENCE_LINGER_MS - 1)).toBe(true)
    expect(isLocalInferenceBusy(NATIVE, 'synth:27b', t + LOCAL_INFERENCE_LINGER_MS)).toBe(false)
  })

  it('two parallel requests: busy until both ended', () => {
    const t = 5_000_000
    const a = beginLocalInference(NATIVE, 'm', () => t)
    const b = beginLocalInference(NATIVE, 'm', () => t)
    a()
    expect(isLocalInferenceBusy(NATIVE, 'm', t + LOCAL_INFERENCE_LINGER_MS + 1)).toBe(true)
    b()
    expect(isLocalInferenceBusy(NATIVE, 'm', t + LOCAL_INFERENCE_LINGER_MS + 1)).toBe(false)
  })

  it('waitForLocalInferenceIdle returns when idle and is bounded by maxWaitMs (stuck lease never blocks forever)', async () => {
    let t = 0
    const sleep = async (ms: number) => { t += ms }
    const now = () => t
    expect(await waitForLocalInferenceIdle(NATIVE, 'm', { maxWaitMs: 10_000, now, sleep })).toEqual({ waitedMs: 0, timedOut: false })

    const release = beginLocalInference(NATIVE, 'm', now)
    const stuck = await waitForLocalInferenceIdle(NATIVE, 'm', { maxWaitMs: 30_000, pollMs: 5_000, now, sleep })
    expect(stuck).toEqual({ waitedMs: 30_000, timedOut: true })

    release() // at t=30000 → linger until 90000
    const after = await waitForLocalInferenceIdle(NATIVE, 'm', { maxWaitMs: 600_000, pollMs: 5_000, now, sleep })
    expect(after.timedOut).toBe(false)
    expect(t).toBe(30_000 + LOCAL_INFERENCE_LINGER_MS)
  })
})
