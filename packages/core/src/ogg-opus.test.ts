import { describe, expect, it } from 'vitest'
import { createDecoder } from 'libopus-wasm'
import {
  OGG_FLAG_BOS,
  OGG_FLAG_EOS,
  buildOggPage,
  encodeOggOpus,
  normalizePcm,
  oggCrc32,
  wrapPcmInWav,
} from './ogg-opus.js'

interface ParsedPage {
  flags: number
  granule: bigint
  serial: number
  sequence: number
  crcValid: boolean
  packets: Uint8Array[]
}

/** Minimal Ogg reader: enough to verify what the muxer wrote. */
function parseOggPages(file: Buffer): ParsedPage[] {
  const pages: ParsedPage[] = []
  let offset = 0
  while (offset < file.length) {
    if (file.toString('ascii', offset, offset + 4) !== 'OggS') throw new Error(`no OggS at ${offset}`)
    const flags = file[offset + 5]!
    const granule = file.readBigInt64LE(offset + 6)
    const serial = file.readUInt32LE(offset + 14)
    const sequence = file.readUInt32LE(offset + 18)
    const storedCrc = file.readUInt32LE(offset + 22)
    const segmentCount = file[offset + 26]!
    const lacing = Array.from(file.subarray(offset + 27, offset + 27 + segmentCount))
    const bodyStart = offset + 27 + segmentCount
    const bodyLength = lacing.reduce((a, b) => a + b, 0)
    const pageBytes = Buffer.from(file.subarray(offset, bodyStart + bodyLength))
    pageBytes.writeUInt32LE(0, 22)
    const crcValid = oggCrc32(pageBytes) === storedCrc

    const packets: Uint8Array[] = []
    let cursor = bodyStart
    let current: Buffer[] = []
    for (const value of lacing) {
      current.push(file.subarray(cursor, cursor + value))
      cursor += value
      if (value < 255) {
        packets.push(Buffer.concat(current))
        current = []
      }
    }
    pages.push({ flags, granule, serial, sequence, crcValid, packets })
    offset = bodyStart + bodyLength
  }
  return pages
}

function sine(seconds: number, rate: number, hz: number, amplitude = 12_000): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amplitude)
  return out
}

describe('oggCrc32', () => {
  it('matches the Ogg reference polynomial on a known vector', () => {
    // CRC-32/MPEG-2 style (no reflection, init 0) of "123456789" with the
    // Ogg parameters (init 0, no final xor) is 0x89A1897F.
    expect(oggCrc32(Buffer.from('123456789', 'ascii')).toString(16)).toBe('89a1897f')
  })
})

describe('buildOggPage', () => {
  it('writes a self-consistent header and lacing table', () => {
    const page = buildOggPage(7, 3, 1234n, [new Uint8Array(300), new Uint8Array(10)], OGG_FLAG_EOS)
    const [parsed] = parseOggPages(page)
    expect(parsed).toMatchObject({ flags: OGG_FLAG_EOS, granule: 1234n, serial: 7, sequence: 3, crcValid: true })
    expect(parsed!.packets.map(p => p.length)).toEqual([300, 10])
  })

  it('refuses a page that would exceed 255 lacing values', () => {
    const packets = Array.from({ length: 256 }, () => new Uint8Array(1))
    expect(() => buildOggPage(1, 0, 0n, packets, 0)).toThrow(/255/)
  })
})

describe('encodeOggOpus', () => {
  it('produces a stream that decodes back to the original length and tone', async () => {
    const rate = 24_000
    const pcm = sine(1.5, rate, 440)
    const file = await encodeOggOpus({ samples: pcm, sampleRate: rate, channels: 1 }, { serial: 42 })

    const pages = parseOggPages(file)
    expect(pages.every(p => p.crcValid)).toBe(true)
    expect(pages.every(p => p.serial === 42)).toBe(true)
    expect(pages.map(p => p.sequence)).toEqual(pages.map((_, i) => i))

    // Header pages
    expect(pages[0]!.flags & OGG_FLAG_BOS).toBe(OGG_FLAG_BOS)
    const head = Buffer.from(pages[0]!.packets[0]!)
    expect(head.toString('ascii', 0, 8)).toBe('OpusHead')
    expect(head[9]).toBe(1) // channels
    const preSkip = head.readUInt16LE(10)
    expect(head.readUInt32LE(12)).toBe(rate)
    expect(Buffer.from(pages[1]!.packets[0]!).toString('ascii', 0, 8)).toBe('OpusTags')

    // Audio pages: last one carries EOS and the exact sample count (at 48 kHz).
    const audioPages = pages.slice(2)
    expect(audioPages.at(-1)!.flags & OGG_FLAG_EOS).toBe(OGG_FLAG_EOS)
    expect(audioPages.at(-1)!.granule).toBe(BigInt(preSkip) + BigInt(pcm.length * 2))
    for (let i = 1; i < audioPages.length; i++) {
      expect(audioPages[i]!.granule > audioPages[i - 1]!.granule).toBe(true)
    }

    // Decode every packet and compare against the input.
    const decoder = await createDecoder({ sampleRate: rate, channels: 1 })
    try {
      const decoded: Int16Array[] = []
      for (const page of audioPages) for (const packet of page.packets) decoded.push(decoder.decode(packet))
      const total = decoded.reduce((n, f) => n + f.length, 0)
      const out = new Int16Array(total)
      let cursor = 0
      for (const frame of decoded) { out.set(frame, cursor); cursor += frame.length }

      // Padded to whole 20 ms frames: at most one frame longer than the input.
      expect(total).toBeGreaterThanOrEqual(pcm.length)
      expect(total - pcm.length).toBeLessThan(480)

      // The tone survives: RMS in the steady middle second is within 1.5 dB.
      const rms = (a: Int16Array, from: number, to: number) => {
        let s = 0
        for (let i = from; i < to; i++) s += a[i]! * a[i]!
        return Math.sqrt(s / (to - from))
      }
      const preSkipInput = Math.round(preSkip / 2)
      const inRms = rms(pcm, 6000, 30_000)
      const outRms = rms(out, 6000 + preSkipInput, 30_000 + preSkipInput)
      expect(Math.abs(20 * Math.log10(outRms / inRms))).toBeLessThan(1.5)
    } finally {
      decoder.free()
    }
  })

  it('keeps every page under the Ogg segment limit for long inputs', async () => {
    const pcm = sine(12, 24_000, 220)
    const file = await encodeOggOpus({ samples: pcm, sampleRate: 24_000, channels: 1 }, { serial: 1 })
    const pages = parseOggPages(file)
    expect(pages.length).toBeGreaterThan(12)
    expect(pages.every(p => p.crcValid)).toBe(true)
  })

  it('rejects sample rates Opus cannot encode', async () => {
    await expect(
      encodeOggOpus({ samples: new Int16Array(10), sampleRate: 22_050 as never, channels: 1 }),
    ).rejects.toThrow(/22050/)
  })
})

describe('normalizePcm', () => {
  it('raises quiet audio to the target RMS', () => {
    const quiet = sine(1, 24_000, 440, 300)
    const out = normalizePcm(quiet, { targetRmsDb: -20, peakCeilingDb: -1, maxGainDb: 60 })
    let s = 0
    for (let i = 0; i < out.length; i++) s += out[i]! * out[i]!
    const rmsDb = 20 * Math.log10(Math.sqrt(s / out.length) / 32767)
    expect(rmsDb).toBeGreaterThan(-20.5)
    expect(rmsDb).toBeLessThan(-19.5)
  })

  it('never lets the peak cross the ceiling', () => {
    // A sine at -20 dBFS RMS already peaks at -17 dBFS; asking for -3 dBFS RMS
    // would push the peak past 0, so the ceiling has to win.
    const loud = sine(1, 24_000, 440, 20_000)
    const out = normalizePcm(loud, { targetRmsDb: -3, peakCeilingDb: -1 })
    let peak = 0
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!))
    expect(peak).toBeLessThanOrEqual(Math.round(32767 * Math.pow(10, -1 / 20)))
  })

  it('caps the gain so near-silence is not amplified into noise', () => {
    const faint = sine(1, 24_000, 440, 2)
    const out = normalizePcm(faint, { maxGainDb: 20 })
    let peak = 0
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!))
    expect(peak).toBeLessThanOrEqual(20)
  })

  it('returns silence unchanged and does not mutate the input', () => {
    const silence = new Int16Array(100)
    expect(normalizePcm(silence)).toEqual(silence)
    const input = sine(0.1, 24_000, 440, 100)
    const copy = Int16Array.from(input)
    normalizePcm(input)
    expect(input).toEqual(copy)
  })
})

describe('wrapPcmInWav', () => {
  it('writes a canonical 44-byte header', () => {
    const wav = wrapPcmInWav(Buffer.alloc(480), 24_000, 1, 16)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(24_000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(40)).toBe(480)
    expect(wav.length).toBe(44 + 480)
  })
})
