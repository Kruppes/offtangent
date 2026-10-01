import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { useStt } from './useStt'

/*
 * useStt against stubbed browser APIs: a fake MediaRecorder that yields one
 * synthetic chunk, a fake getUserMedia, and a fetch spy for the upload. No
 * AudioContext, so the level meter stays off (it is optional).
 */

const globals = globalThis as Record<string, unknown>
let fetchMock: ReturnType<typeof vi.fn>
let getUserMedia: ReturnType<typeof vi.fn>
let trackStop: ReturnType<typeof vi.fn>

class FakeRecorder {
  static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus' }
  state: 'inactive' | 'recording' = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['synthetic-audio'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

const keptAudio = { kind: 'file', originalName: 'recording.webm', storedName: 'r.webm', relativePath: 'uploads/r.webm', urlPath: '/api/uploads/r.webm', mimeType: 'audio/webm', size: 15 }

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const states = new Map<string, Ref<unknown>>()
  globals.useState = <T>(key: string, init: () => T): Ref<T> => {
    if (!states.has(key)) states.set(key, ref(init()) as Ref<unknown>)
    return states.get(key) as Ref<T>
  }
  globals.useAuth = () => ({ getAccessToken: () => 'test-token' })
  globals.useRuntimeConfig = () => ({ public: { apiBase: 'http://localhost:3000' } })
  globals.useApi = () => ({ apiFetch: vi.fn(async () => ({ enabled: true })) })
  trackStop = vi.fn()
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  fetchMock = vi.fn(async () => jsonResponse({ transcript: 'raw words', rewritten: 'Clean words.', audio: keptAudio }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete globals.useState
  delete globals.useAuth
  delete globals.useRuntimeConfig
  delete globals.useApi
})

async function record(stt: ReturnType<typeof useStt>, ms = 1500) {
  await stt.start()
  expect(stt.phase.value).toBe('recording')
  vi.advanceTimersByTime(ms)
}

describe('useStt', () => {
  it('records on start, uploads with keepAudio=1 on stop and returns text + kept audio', async () => {
    const stt = useStt()
    await record(stt)
    expect(stt.elapsedMs.value).toBeGreaterThanOrEqual(1000)
    const result = await stt.stop()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://localhost:3000/api/stt/transcribe?keepAudio=1')
    expect(init.headers).toEqual({ Authorization: 'Bearer test-token' })
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob)
    expect(result).toEqual({ text: 'Clean words.', audio: keptAudio, durationMs: 1500 })
    expect(stt.phase.value).toBe('idle')
    expect(trackStop).toHaveBeenCalled()
  })

  it('returns text only when the server keeps no audio', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ transcript: 'only text' }))
    const stt = useStt()
    await record(stt)
    expect(await stt.stop()).toEqual({ text: 'only text', audio: null, durationMs: 1500 })
  })

  it('cancel drops the recording and uploads nothing', async () => {
    const stt = useStt()
    await record(stt)
    stt.cancel()
    expect(stt.phase.value).toBe('idle')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(trackStop).toHaveBeenCalled()
  })

  it('a too short recording is a lasting error and is not uploaded', async () => {
    const stt = useStt()
    await record(stt, 100)
    expect(await stt.stop()).toBeNull()
    expect(stt.phase.value).toBe('error')
    expect(stt.error.value).toBe('too_short')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(stt.error.value).toBe('too_short')
  })

  it('maps a refused microphone to permission_denied', async () => {
    getUserMedia.mockImplementation(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }) })
    const stt = useStt()
    await stt.start()
    expect(stt.phase.value).toBe('error')
    expect(stt.error.value).toBe('permission_denied')
    expect(stt.canRetry.value).toBe(false)
  })

  it('keeps the recording after a failed upload and sends the same blob on retry', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: 'provider down' }, 502))
    const stt = useStt()
    await record(stt)
    expect(await stt.stop()).toBeNull()
    expect(stt.error.value).toBe('transcribe_error')
    expect(stt.canRetry.value).toBe(true)

    const result = await stt.retry()
    expect(result).toEqual({ text: 'Clean words.', audio: keptAudio, durationMs: 1500 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = (fetchMock.mock.calls[0]![1].body as FormData).get('file') as Blob
    const second = (fetchMock.mock.calls[1]![1].body as FormData).get('file') as Blob
    expect(await second.text()).toBe(await first.text())
    expect(stt.phase.value).toBe('idle')
  })
})
