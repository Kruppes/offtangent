/**
 * W6b: `useTts` is settings + voice catalogue only. The old client-side
 * `play()`/`stop()` path is gone; `ttsEnabled` still follows the server
 * settings exactly as before (the speech actions and palette read it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useTts } from './useTts'

function setup(answer: () => Promise<unknown>) {
  const apiFetch = vi.fn(answer)
  vi.stubGlobal('useApi', () => ({ apiFetch }))
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()))
  vi.stubGlobal('computed', computed)
  return apiFetch
}
afterEach(() => vi.unstubAllGlobals())

describe('useTts', () => {
  it('exposes settings and voices only, no playback', () => {
    setup(async () => ({}))
    expect(Object.keys(useTts()).sort()).toEqual(['fetchMistralVoices', 'fetchTtsSettings', 'mistralVoices', 'ttsEnabled', 'ttsSettings', 'voicesLoading'])
  })

  it('ttsEnabled follows /api/tts/settings and is false on failure', async () => {
    const apiFetch = setup(async () => ({ enabled: true, provider: 'openai' }))
    const tts = useTts()
    expect(tts.ttsEnabled.value).toBe(false)
    await tts.fetchTtsSettings()
    expect(apiFetch).toHaveBeenCalledWith('/api/tts/settings')
    expect(tts.ttsEnabled.value).toBe(true)
    apiFetch.mockRejectedValueOnce(new Error('down'))
    await tts.fetchTtsSettings()
    expect(tts.ttsEnabled.value).toBe(false)
  })

  it('loads voices and empties them on failure', async () => {
    const apiFetch = setup(async () => ({ voices: [{ id: 'v1', name: 'Synthetic voice', languages: ['en'], isPreset: true }] }))
    const tts = useTts()
    await tts.fetchMistralVoices()
    expect(tts.mistralVoices.value).toHaveLength(1)
    expect(tts.voicesLoading.value).toBe(false)
    apiFetch.mockRejectedValueOnce(new Error('down'))
    await tts.fetchMistralVoices()
    expect(tts.mistralVoices.value).toEqual([])
  })
})
