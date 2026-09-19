/**
 * PCM → Ogg/Opus in-process, plus a small gain normalizer.
 *
 * Why this exists: Gemini TTS only ever returns raw 16-bit PCM (24 kHz mono).
 * The consumers of our TTS want a container — the Android app and Telegram's
 * voice bubble both expect Ogg/Opus — and the agent container ships without
 * ffmpeg. `libopus-wasm` gives us raw Opus packets (WASM, no native build);
 * the Ogg framing (RFC 3533) and the Opus-in-Ogg headers (RFC 7845) are
 * small enough to write here rather than pull in a second dependency.
 *
 * Verified against ffprobe/ffmpeg decode on a 24 kHz mono test signal.
 */

import { createEncoder, Application, Signal } from 'libopus-wasm'
import type { SampleRate as OpusSampleRate } from 'libopus-wasm'

export type PcmSampleRate = OpusSampleRate

export interface PcmAudio {
  /** Interleaved signed 16-bit samples. */
  samples: Int16Array
  /** Any rate; the Opus encoder only accepts 8/12/16/24/48 kHz and says so. */
  sampleRate: number
  channels: 1 | 2
}

export const OPUS_SAMPLE_RATES: readonly PcmSampleRate[] = [8000, 12000, 16000, 24000, 48000]

export function isOpusSampleRate(rate: number): rate is PcmSampleRate {
  return (OPUS_SAMPLE_RATES as readonly number[]).includes(rate)
}

// ── Gain normalization ────────────────────────────────────────────────

export interface NormalizeOptions {
  /** RMS level to aim for, in dBFS. Speech at -20 dBFS sits comfortably next to typical voice notes. */
  targetRmsDb?: number
  /** Never let a sample exceed this, in dBFS. */
  peakCeilingDb?: number
  /** Upper bound for the applied gain, in dB, so near-silent input is not blown up to noise. */
  maxGainDb?: number
}

const dbToLinear = (db: number): number => Math.pow(10, db / 20)

/**
 * Apply one constant gain so the RMS lands on `targetRmsDb` without any peak
 * crossing `peakCeilingDb`. A plain gain (no compression) is enough to bring
 * TTS output — which is consistently quiet — up to a level that matches the
 * ffmpeg `loudnorm` pass the previous Mac-side service used; it deliberately
 * does not reshape dynamics. Returns a new array; the input is untouched.
 */
export function normalizePcm(samples: Int16Array, options: NormalizeOptions = {}): Int16Array {
  const targetRmsDb = options.targetRmsDb ?? -20
  const peakCeilingDb = options.peakCeilingDb ?? -1
  const maxGainDb = options.maxGainDb ?? 20

  if (samples.length === 0) return new Int16Array(0)

  let sumSquares = 0
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!
    sumSquares += s * s
    const a = Math.abs(s)
    if (a > peak) peak = a
  }
  const rms = Math.sqrt(sumSquares / samples.length)
  if (rms === 0 || peak === 0) return Int16Array.from(samples)

  const full = 32767
  const targetRms = dbToLinear(targetRmsDb) * full
  const ceiling = dbToLinear(peakCeilingDb) * full
  const gain = Math.min(targetRms / rms, ceiling / peak, dbToLinear(maxGainDb))

  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i]! * gain)
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v
  }
  return out
}

// ── Ogg framing ───────────────────────────────────────────────────────

/** Ogg uses CRC-32 with polynomial 0x04c11db7, no reflection, init 0, no final XOR. */
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1)
    }
    table[i] = r >>> 0
  }
  return table
})()

export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0
  }
  return crc >>> 0
}

export const OGG_FLAG_CONTINUED = 0x01
export const OGG_FLAG_BOS = 0x02
export const OGG_FLAG_EOS = 0x04

/** Ogg allows at most 255 lacing values per page. */
const OGG_MAX_SEGMENTS = 255

function lacingValues(packet: Uint8Array): number[] {
  const values: number[] = []
  let remaining = packet.length
  while (remaining >= 255) {
    values.push(255)
    remaining -= 255
  }
  values.push(remaining)
  return values
}

/** Number of lacing bytes a packet needs (a 255-byte multiple needs one extra 0 terminator). */
function segmentCount(packet: Uint8Array): number {
  return Math.floor(packet.length / 255) + 1
}

/**
 * Build one Ogg page holding whole packets. Callers guarantee the packets
 * fit into 255 lacing values; no packet is ever split across pages here,
 * which is fine because Opus packets are tiny compared to that limit.
 */
export function buildOggPage(
  serial: number,
  sequence: number,
  granulePosition: bigint,
  packets: readonly Uint8Array[],
  flags: number,
): Buffer {
  const lacing: number[] = []
  for (const packet of packets) lacing.push(...lacingValues(packet))
  if (lacing.length > OGG_MAX_SEGMENTS) {
    throw new Error(`Ogg page would need ${lacing.length} segments (max ${OGG_MAX_SEGMENTS})`)
  }

  const header = Buffer.alloc(27 + lacing.length)
  header.write('OggS', 0, 'ascii')
  header[4] = 0 // stream structure version
  header[5] = flags
  header.writeBigInt64LE(granulePosition, 6)
  header.writeUInt32LE(serial >>> 0, 14)
  header.writeUInt32LE(sequence >>> 0, 18)
  header.writeUInt32LE(0, 22) // CRC placeholder, must be zero while hashing
  header[26] = lacing.length
  for (let i = 0; i < lacing.length; i++) header[27 + i] = lacing[i]!

  const page = Buffer.concat([header, ...packets.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength))])
  page.writeUInt32LE(oggCrc32(page), 22)
  return page
}

/** RFC 7845 §5.1 identification header. `preSkip` is in 48 kHz samples. */
export function buildOpusHead(channels: 1 | 2, preSkip: number, inputSampleRate: number): Buffer {
  const head = Buffer.alloc(19)
  head.write('OpusHead', 0, 'ascii')
  head[8] = 1 // version
  head[9] = channels
  head.writeUInt16LE(preSkip, 10)
  head.writeUInt32LE(inputSampleRate, 12)
  head.writeInt16LE(0, 16) // output gain, Q7.8 dB
  head[18] = 0 // channel mapping family 0 = mono/stereo
  return head
}

/** RFC 7845 §5.2 comment header with a vendor string and no user comments. */
export function buildOpusTags(vendor: string): Buffer {
  const vendorBytes = Buffer.from(vendor, 'utf8')
  const tags = Buffer.alloc(8 + 4 + vendorBytes.length + 4)
  tags.write('OpusTags', 0, 'ascii')
  tags.writeUInt32LE(vendorBytes.length, 8)
  vendorBytes.copy(tags, 12)
  tags.writeUInt32LE(0, 12 + vendorBytes.length) // user comment list length
  return tags
}

// ── Encoder ───────────────────────────────────────────────────────────

export interface EncodeOggOpusOptions {
  /** Target bitrate in bit/s. 48 kbit/s is transparent for mono speech. */
  bitrate?: number
  /** Written into the OpusTags vendor field. */
  vendor?: string
  /** Ogg stream serial; random when omitted. Fixed in tests for reproducibility. */
  serial?: number
}

const DEFAULT_OPUS_BITRATE = 48_000
const DEFAULT_VENDOR = 'offtangent libopus-wasm'
/** Packets per audio page: 50 × 20 ms = one second of audio per page. */
const PACKETS_PER_PAGE = 50

/**
 * Encode PCM into a complete Ogg/Opus file (Buffer). The last frame is
 * zero-padded to a full Opus frame and the final granule position carries
 * the true sample count, so decoders trim the padding again.
 */
export async function encodeOggOpus(pcm: PcmAudio, options: EncodeOggOpusOptions = {}): Promise<Buffer> {
  if (!isOpusSampleRate(pcm.sampleRate)) {
    throw new Error(`Opus cannot encode a ${pcm.sampleRate} Hz signal (supported: ${OPUS_SAMPLE_RATES.join(', ')})`)
  }
  if (pcm.samples.length % pcm.channels !== 0) {
    throw new Error('PCM sample count is not a multiple of the channel count')
  }

  const encoder = await createEncoder({
    sampleRate: pcm.sampleRate,
    channels: pcm.channels,
    application: Application.Audio,
    bitrate: options.bitrate ?? DEFAULT_OPUS_BITRATE,
  })
  try {
    encoder.setSignal(Signal.Voice)

    const frameSamples = encoder.frameSize // per channel
    const frameLength = frameSamples * pcm.channels
    const totalFrames = Math.ceil(pcm.samples.length / frameLength)
    const packets: Uint8Array[] = []
    for (let f = 0; f < totalFrames; f++) {
      const start = f * frameLength
      let frame = pcm.samples.subarray(start, start + frameLength)
      if (frame.length < frameLength) {
        const padded = new Int16Array(frameLength)
        padded.set(frame)
        frame = padded
      }
      packets.push(encoder.encode(frame))
    }

    // Opus streams always count granules at 48 kHz regardless of the input rate.
    const toGranule = 48_000 / pcm.sampleRate
    const preSkip = Math.round(encoder.getLookahead() * toGranule)
    const realSamplesPerChannel = pcm.samples.length / pcm.channels
    const finalGranule = BigInt(preSkip) + BigInt(Math.round(realSamplesPerChannel * toGranule))
    const frameGranule = BigInt(Math.round(frameSamples * toGranule))

    const serial = options.serial ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)
    const pages: Buffer[] = []
    let sequence = 0
    pages.push(buildOggPage(serial, sequence++, 0n, [buildOpusHead(pcm.channels, preSkip, pcm.sampleRate)], OGG_FLAG_BOS))
    pages.push(buildOggPage(serial, sequence++, 0n, [buildOpusTags(options.vendor ?? DEFAULT_VENDOR)], 0))

    let granule = BigInt(preSkip)
    let index = 0
    while (index < packets.length) {
      const group: Uint8Array[] = []
      let segments = 0
      while (
        index < packets.length
        && group.length < PACKETS_PER_PAGE
        && segments + segmentCount(packets[index]!) <= OGG_MAX_SEGMENTS
      ) {
        segments += segmentCount(packets[index]!)
        group.push(packets[index]!)
        index++
      }
      const isLast = index >= packets.length
      granule += frameGranule * BigInt(group.length)
      const pageGranule = isLast ? finalGranule : granule
      pages.push(buildOggPage(serial, sequence++, pageGranule, group, isLast ? OGG_FLAG_EOS : 0))
    }
    if (packets.length === 0) {
      // An empty stream still needs a terminating page so readers see EOS.
      pages.push(buildOggPage(serial, sequence++, finalGranule, [], OGG_FLAG_EOS))
    }

    return Buffer.concat(pages)
  } finally {
    encoder.free()
  }
}

// ── WAV ───────────────────────────────────────────────────────────────

/**
 * Wrap raw little-endian PCM in a canonical 44-byte RIFF/WAVE header so
 * generic players can decode it.
 */
export function wrapPcmInWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const dataLen = pcm.length
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLen, 4) // file size minus first 8 bytes
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)          // PCM subchunk size
  header.writeUInt16LE(1, 20)           // audio format = 1 (PCM)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataLen, 40)
  return Buffer.concat([header, pcm])
}
