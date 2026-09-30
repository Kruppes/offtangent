/**
 * F6 (review A finding A6 / review B, triage 2026-09-26 19:25): the tag cache
 * was keyed by `host:port` in addition to the provider id, and EVERY key of an
 * endpoint got the same entry written. Two providers pointing at the same
 * Ollama box (a normal setup: one entry for the local weights, one for the
 * cloud-proxied models, or a second provider with a different model list)
 * therefore overwrote each other's answer through the shared `url:` key, and a
 * slow refresh that finished late could resurrect an outdated model list.
 *
 * The fix: one entry per provider id + normalised URL, and a per-key sequence
 * number so a late answer never overwrites a newer one.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  beginOllamaTagRefresh,
  clearOllamaTagCache,
  getOllamaHostingVerdict,
  ollamaTagCacheStats,
  recordOllamaTags,
  refreshOllamaTags,
} from './ollama-tag-cache.js'

const URL_A = 'http://127.0.0.1:11434'

beforeEach(() => {
  clearOllamaTagCache()
})

describe('F6: the tag cache is keyed per provider', () => {
  it('keeps two providers with the SAME url apart', () => {
    recordOllamaTags({ providerId: 'box-local', baseUrl: URL_A }, { models: [{ name: 'qwen3:8b' }] })
    recordOllamaTags(
      { providerId: 'box-cloud', baseUrl: URL_A },
      { models: [{ name: 'kimi-k2.5:cloud', remote_host: 'https://ollama.com:443' }] },
    )

    // Each provider reads its OWN entry, not the last writer of that host.
    expect(getOllamaHostingVerdict({ providerId: 'box-local', baseUrl: URL_A }, 'qwen3:8b')).toBe('local')
    expect(getOllamaHostingVerdict({ providerId: 'box-cloud', baseUrl: URL_A }, 'kimi-k2.5:cloud')).toBe('remote')
    // …and does not see the other provider's model at all.
    expect(getOllamaHostingVerdict({ providerId: 'box-cloud', baseUrl: URL_A }, 'qwen3:8b')).toBe('unverified')
    expect(getOllamaHostingVerdict({ providerId: 'box-local', baseUrl: URL_A }, 'kimi-k2.5:cloud')).toBe('unverified')

    expect(ollamaTagCacheStats()).toHaveLength(2)
  })

  it('normalises the url so a trailing slash or /v1 is the same endpoint', () => {
    recordOllamaTags({ providerId: 'box', baseUrl: `${URL_A}/v1/` }, { models: [{ name: 'qwen3:8b' }] })
    expect(getOllamaHostingVerdict({ providerId: 'box', baseUrl: URL_A }, 'qwen3:8b')).toBe('local')
    expect(ollamaTagCacheStats()).toHaveLength(1)
  })

  it('still answers when the lookup knows only the provider id', () => {
    recordOllamaTags({ providerId: 'box', baseUrl: URL_A }, { models: [{ name: 'qwen3:8b' }] })
    expect(getOllamaHostingVerdict({ providerId: 'box' }, 'qwen3:8b')).toBe('local')
  })

  it('files a probe without a provider id under the url alone', () => {
    recordOllamaTags({ baseUrl: URL_A }, { models: [{ name: 'qwen3:8b' }] })
    expect(getOllamaHostingVerdict({ baseUrl: URL_A }, 'qwen3:8b')).toBe('local')
    // A saved provider does not inherit the anonymous probe's entry.
    expect(getOllamaHostingVerdict({ providerId: 'box', baseUrl: URL_A }, 'qwen3:8b')).toBe('unverified')
  })

  it('does not let a late answer overwrite a newer one', () => {
    const source = { providerId: 'box', baseUrl: URL_A }
    // Two refreshes are started; the FIRST one answers last (reversed order).
    const first = beginOllamaTagRefresh(source)
    const second = beginOllamaTagRefresh(source)

    expect(recordOllamaTags(source, { models: [{ name: 'new-model' }] }, second)).toBe(1)
    expect(recordOllamaTags(source, { models: [{ name: 'stale-model' }] }, first)).toBe(0)

    expect(getOllamaHostingVerdict(source, 'new-model')).toBe('local')
    expect(getOllamaHostingVerdict(source, 'stale-model')).toBe('unverified')
  })

  it('keeps parallel refreshes of two same-url providers apart and ordered', async () => {
    const answers: Record<string, unknown> = {
      'box-slow': { models: [{ name: 'slow-model' }] },
      'box-fast': { models: [{ name: 'fast-model' }] },
    }
    const makeFetch = (provider: string, delayMs: number): typeof fetch =>
      (async () => {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        return {
          ok: true,
          status: 200,
          json: async () => answers[provider],
        } as unknown as Response
      }) as unknown as typeof fetch

    await Promise.all([
      refreshOllamaTags({ providerId: 'box-slow', baseUrl: URL_A, fetchImpl: makeFetch('box-slow', 30) }),
      refreshOllamaTags({ providerId: 'box-fast', baseUrl: URL_A, fetchImpl: makeFetch('box-fast', 1) }),
    ])

    expect(getOllamaHostingVerdict({ providerId: 'box-slow', baseUrl: URL_A }, 'slow-model')).toBe('local')
    expect(getOllamaHostingVerdict({ providerId: 'box-fast', baseUrl: URL_A }, 'fast-model')).toBe('local')
    expect(getOllamaHostingVerdict({ providerId: 'box-fast', baseUrl: URL_A }, 'slow-model')).toBe('unverified')
  })
})
