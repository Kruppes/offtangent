/**
 * Linear PCM resampling for 16-bit interleaved audio.
 *
 * The TTS path needs this because some clients cannot take the native rate a
 * provider produces. Gemini and Deepgram both ship 24 kHz mono PCM; a small
 * device that buffers WAV in RAM wants 16 kHz so a given number of seconds
 * fits into a fixed buffer. Nothing here is provider specific: it is a pure
 * function over samples, so it is testable without a network call.
 *
 * Quality note: linear interpolation without a low pass filter aliases when
 * downsampling. For speech at 24 kHz to 16 kHz the artefacts sit far above
 * the voice band and are inaudible on a small speaker, which is the only
 * consumer of this path. Anything that needs studio quality should resample
 * with a real filter instead.
 */

/** Lowest rate we accept as a target; below this speech is unintelligible. */
export const PCM_MIN_SAMPLE_RATE = 8000

/** Highest rate we accept as a target. */
export const PCM_MAX_SAMPLE_RATE = 48000

/** True when `rate` is an integer inside the supported range. */
export function isSupportedSampleRate(rate: number): boolean {
  return Number.isInteger(rate) && rate >= PCM_MIN_SAMPLE_RATE && rate <= PCM_MAX_SAMPLE_RATE
}

function clampToInt16(value: number): number {
  if (value >= 32767) return 32767
  if (value <= -32768) return -32768
  return Math.round(value)
}

/**
 * Resample interleaved 16-bit PCM from `fromRate` to `toRate`.
 *
 * @param samples  Interleaved samples, `channels` values per frame.
 * @param fromRate Source sample rate in Hz, positive integer.
 * @param toRate   Target sample rate in Hz, positive integer.
 * @param channels Channel count, positive integer.
 * @returns The resampled samples. When the rates are equal the input array is
 *          returned unchanged (no copy), because callers only read it.
 * @throws RangeError for non positive or non integer rates / channel counts.
 */
export function resamplePcm(
  samples: Int16Array,
  fromRate: number,
  toRate: number,
  channels: number,
): Int16Array {
  if (!Number.isInteger(fromRate) || fromRate <= 0) {
    throw new RangeError(`resamplePcm: fromRate must be a positive integer, got ${fromRate}`)
  }
  if (!Number.isInteger(toRate) || toRate <= 0) {
    throw new RangeError(`resamplePcm: toRate must be a positive integer, got ${toRate}`)
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new RangeError(`resamplePcm: channels must be a positive integer, got ${channels}`)
  }

  if (fromRate === toRate) return samples
  if (samples.length === 0) return new Int16Array(0)

  const inFrames = Math.floor(samples.length / channels)
  if (inFrames === 0) return new Int16Array(0)

  const ratio = fromRate / toRate
  // Round so a 2:3 conversion of a single frame still yields a frame instead
  // of silence, and so total duration stays as close as the grid allows.
  const outFrames = Math.max(1, Math.round(inFrames / ratio))
  const out = new Int16Array(outFrames * channels)
  const lastFrame = inFrames - 1

  for (let frame = 0; frame < outFrames; frame++) {
    const position = frame * ratio
    const base = Math.floor(position)
    const frac = position - base
    const left = base > lastFrame ? lastFrame : base
    const right = left + 1 > lastFrame ? lastFrame : left + 1
    const leftOffset = left * channels
    const rightOffset = right * channels
    const outOffset = frame * channels
    for (let channel = 0; channel < channels; channel++) {
      const a = samples[leftOffset + channel]!
      const b = samples[rightOffset + channel]!
      out[outOffset + channel] = clampToInt16(a + (b - a) * frac)
    }
  }

  return out
}
