import { describe, it, expect } from 'vitest'
import { isSupportedSampleRate, resamplePcm } from './pcm-resample.js'

/** Build `frames` frames of a sine at `freq` Hz, mono, full-ish scale. */
function sine(freq: number, rate: number, frames: number): Int16Array {
  const out = new Int16Array(frames)
  for (let i = 0; i < frames; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 20000)
  }
  return out
}

/** Count sign changes; for a clean sine that is 2 per period. */
function zeroCrossings(samples: Int16Array): number {
  let count = 0
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!
    const cur = samples[i]!
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) count++
  }
  return count
}

describe('resamplePcm', () => {
  it('keeps the length ratio when downsampling mono', () => {
    const input = new Int16Array(2400)
    const out = resamplePcm(input, 24000, 16000, 1)
    expect(out.length).toBe(1600)
  })

  it('keeps the length ratio when upsampling mono', () => {
    const input = new Int16Array(1600)
    const out = resamplePcm(input, 16000, 48000, 1)
    expect(out.length).toBe(4800)
  })

  it('returns the same instance when the rate does not change', () => {
    const input = new Int16Array([1, 2, 3, 4])
    expect(resamplePcm(input, 24000, 24000, 1)).toBe(input)
  })

  it('keeps a DC signal at the same level', () => {
    const input = new Int16Array(1200).fill(1234)
    const out = resamplePcm(input, 24000, 16000, 1)
    expect(out.length).toBe(800)
    for (const value of out) expect(value).toBe(1234)
  })

  it('keeps a negative DC signal at the same level when upsampling', () => {
    const input = new Int16Array(600).fill(-4321)
    const out = resamplePcm(input, 16000, 24000, 1)
    expect(out.length).toBe(900)
    for (const value of out) expect(value).toBe(-4321)
  })

  it('keeps a 1 kHz sine at 1 kHz across 24k to 16k', () => {
    // One full second: 1000 periods means 2000 zero crossings, whatever the
    // sample rate is. Allow a small tolerance for the boundary frame.
    const input = sine(1000, 24000, 24000)
    const out = resamplePcm(input, 24000, 16000, 1)
    expect(out.length).toBe(16000)
    const before = zeroCrossings(input)
    const after = zeroCrossings(out)
    expect(before).toBeGreaterThanOrEqual(1998)
    expect(after).toBeGreaterThanOrEqual(before - 2)
    expect(after).toBeLessThanOrEqual(before + 2)
  })

  it('keeps channels separated when resampling interleaved stereo', () => {
    // Left channel constant 1000, right channel constant -1000. A resampler
    // that mixes the channels up would produce values between the two.
    const frames = 1200
    const input = new Int16Array(frames * 2)
    for (let i = 0; i < frames; i++) {
      input[i * 2] = 1000
      input[i * 2 + 1] = -1000
    }
    const out = resamplePcm(input, 24000, 16000, 2)
    expect(out.length).toBe(800 * 2)
    for (let i = 0; i < out.length / 2; i++) {
      expect(out[i * 2]).toBe(1000)
      expect(out[i * 2 + 1]).toBe(-1000)
    }
  })

  it('clamps interpolated values into the Int16 range', () => {
    const input = new Int16Array([32767, 32767, -32768, -32768])
    const out = resamplePcm(input, 24000, 48000, 1)
    for (const value of out) {
      expect(value).toBeGreaterThanOrEqual(-32768)
      expect(value).toBeLessThanOrEqual(32767)
    }
  })

  it('handles an empty buffer', () => {
    expect(resamplePcm(new Int16Array(0), 24000, 16000, 1).length).toBe(0)
  })

  it('handles a single frame', () => {
    const out = resamplePcm(new Int16Array([777]), 24000, 16000, 1)
    expect(out.length).toBe(1)
    expect(out[0]).toBe(777)
  })

  it('handles a partial trailing frame in stereo input', () => {
    // Three values, two channels: the dangling sample is dropped.
    const out = resamplePcm(new Int16Array([100, -100, 100]), 24000, 12000, 2)
    expect(out.length).toBe(2)
    expect(out[0]).toBe(100)
    expect(out[1]).toBe(-100)
  })

  it('rejects invalid rates and channel counts', () => {
    expect(() => resamplePcm(new Int16Array(4), 0, 16000, 1)).toThrow(RangeError)
    expect(() => resamplePcm(new Int16Array(4), 24000, -1, 1)).toThrow(RangeError)
    expect(() => resamplePcm(new Int16Array(4), 24000, 16000.5, 1)).toThrow(RangeError)
    expect(() => resamplePcm(new Int16Array(4), 24000, 16000, 0)).toThrow(RangeError)
  })
})

describe('isSupportedSampleRate', () => {
  it('accepts the documented range', () => {
    expect(isSupportedSampleRate(8000)).toBe(true)
    expect(isSupportedSampleRate(16000)).toBe(true)
    expect(isSupportedSampleRate(48000)).toBe(true)
  })

  it('rejects everything outside it', () => {
    expect(isSupportedSampleRate(7999)).toBe(false)
    expect(isSupportedSampleRate(48001)).toBe(false)
    expect(isSupportedSampleRate(16000.5)).toBe(false)
    expect(isSupportedSampleRate(Number.NaN)).toBe(false)
  })
})
