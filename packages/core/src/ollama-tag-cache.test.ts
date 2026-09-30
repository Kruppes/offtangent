/**
 * T1b: `remote_host` from Ollama's `/api/tags` is the authoritative hosting
 * signal, and the gate may only read it from a cache (it must stay
 * synchronous). Every fixture here is made up: private RFC1918 hosts, invented
 * provider ids, invented model names, no token of any kind.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearOllamaTagCache,
  createOllamaTagWarmup,
  getOllamaHostingVerdict,
  getOllamaTagMeta,
  isOllamaModelRemote,
  OLLAMA_TAG_MAX_AGE_MS,
  OLLAMA_TAG_WARMUP_INTERVAL_MS,
  ollamaTagCacheAgeMs,
  ollamaTagCacheStats,
  recordOllamaTags,
  refreshOllamaTags,
  scheduleOllamaTagRefresh,
  scheduleOllamaTagRefreshForProvider,
} from './ollama-tag-cache.js'

/** A shortened `/api/tags` answer in Ollama's own spelling. */
const TAGS = {
  models: [
    { name: 'kimi-k2.5:cloud', size: 0, remote_host: 'https://ollama.example:443' },
    { name: 'qwen3-coder:480b-cloud', size: 0, remote_host: 'https://ollama.example:443' },
    { name: 'glm-4.7-flash:latest', size: 12_345, details: { family: 'glm' } },
    { name: 'qwen3.8:27b-mlx', size: 23_456 },
    { name: 'gemma4:latest', size: 34_567 },
    // Reads local, is proxied: exactly the case a name heuristic cannot catch.
    { name: 'house-model:latest', size: 0, remote_host: 'https://ollama.example:443' },
  ],
}

const SOURCE = { providerId: 'prov-box', baseUrl: 'http://127.0.0.1:11434' }

afterEach(() => {
  clearOllamaTagCache()
  vi.unstubAllEnvs()
})

describe('recordOllamaTags', () => {
  it('stores every usable entry under ONE key and reports how many', () => {
    // F6 (triage 2026-09-26 19:25): the answer used to be written to two keys
    // (`id:` and `url:`), which let two providers on the same box overwrite
    // each other. It is one entry per provider id + normalised url now.
    expect(recordOllamaTags(SOURCE, TAGS)).toBe(6)
    expect(ollamaTagCacheStats()).toEqual([
      expect.objectContaining({ key: 'p:prov-box|http://127.0.0.1:11434', models: 6, remote: 3 }),
    ])
  })

  it('accepts a bare array and the camelCase spelling of remote_host', () => {
    recordOllamaTags(SOURCE, [{ name: 'mirror:latest', remoteHost: 'https://ollama.example:443' }])
    expect(isOllamaModelRemote(SOURCE, 'mirror:latest')).toBe(true)
  })

  it('ignores junk entries and an answer without any usable model', () => {
    expect(recordOllamaTags(SOURCE, { models: [null, 42, { name: '  ' }] })).toBe(0)
    expect(recordOllamaTags(SOURCE, 'nonsense')).toBe(0)
    expect(ollamaTagCacheStats()).toEqual([])
  })

  it('needs at least one key to store anything', () => {
    expect(recordOllamaTags({}, TAGS)).toBe(0)
  })

  it('is reachable by provider id, but never by the url of another provider', () => {
    recordOllamaTags(SOURCE, TAGS)
    // The provider finds its own entry, with or without the url.
    expect(isOllamaModelRemote({ providerId: 'prov-box' }, 'kimi-k2.5:cloud')).toBe(true)
    expect(isOllamaModelRemote(SOURCE, 'kimi-k2.5:cloud')).toBe(true)
    expect(isOllamaModelRemote({ providerId: 'prov-box', baseUrl: 'http://127.0.0.1:11434/v1/' }, 'kimi-k2.5:cloud')).toBe(true)
    // F6: a lookup WITHOUT a provider id no longer inherits a saved
    // provider's answer — that shared `url:` key was the bug. An unsaved probe
    // gets `null` (= keep the heuristic) instead of someone else's model list.
    expect(isOllamaModelRemote({ baseUrl: 'http://127.0.0.1:11434/v1' }, 'kimi-k2.5:cloud')).toBe(null)
    expect(isOllamaModelRemote({ providerId: 'other' }, 'kimi-k2.5:cloud')).toBe(null)
    expect(isOllamaModelRemote({ providerId: 'other', baseUrl: 'http://127.0.0.1:11434' }, 'kimi-k2.5:cloud')).toBe(null)
  })
})

describe('isOllamaModelRemote', () => {
  it('answers null while nothing is cached, so the caller keeps the heuristic', () => {
    expect(isOllamaModelRemote(SOURCE, 'kimi-k2.5:cloud')).toBe(null)
  })

  it('reports a proxied model as remote and a local one as local', () => {
    recordOllamaTags(SOURCE, TAGS)
    expect(isOllamaModelRemote(SOURCE, 'kimi-k2.5:cloud')).toBe(true)
    expect(isOllamaModelRemote(SOURCE, 'house-model:latest')).toBe(true)
    expect(isOllamaModelRemote(SOURCE, 'qwen3.8:27b-mlx')).toBe(false)
    expect(isOllamaModelRemote(SOURCE, 'glm-4.7-flash:latest')).toBe(false)
  })

  it('matches a config that omits the :latest tag', () => {
    recordOllamaTags(SOURCE, TAGS)
    expect(isOllamaModelRemote(SOURCE, 'house-model')).toBe(true)
    expect(isOllamaModelRemote(SOURCE, 'gemma4')).toBe(false)
  })

  it('lets a proxied tag win over a local one of the same base name (fail closed)', () => {
    recordOllamaTags(SOURCE, {
      models: [
        { name: 'twin:local', size: 5 },
        { name: 'twin:cloud', size: 0, remote_host: 'https://ollama.example:443' },
      ],
    })
    expect(isOllamaModelRemote(SOURCE, 'twin')).toBe(true)
    expect(isOllamaModelRemote(SOURCE, 'twin:local')).toBe(false)
  })

  it('is case-insensitive and ignores an unknown model of a known endpoint', () => {
    recordOllamaTags(SOURCE, TAGS)
    expect(isOllamaModelRemote(SOURCE, 'KIMI-K2.5:CLOUD')).toBe(true)
    expect(isOllamaModelRemote(SOURCE, 'never-pulled:latest')).toBe(null)
    expect(isOllamaModelRemote(SOURCE, '')).toBe(null)
  })

  it('exposes the remote host itself for diagnostics', () => {
    recordOllamaTags(SOURCE, TAGS)
    expect(getOllamaTagMeta(SOURCE, 'kimi-k2.5:cloud')).toEqual({
      name: 'kimi-k2.5:cloud',
      remoteHost: 'https://ollama.example:443',
    })
    expect(getOllamaTagMeta(SOURCE, 'gemma4:latest')?.remoteHost).toBe(null)
  })
})

describe('refreshOllamaTags', () => {
  it('fetches /api/tags with the injected fetch and caches the answer', async () => {
    const fetchImpl = vi.fn(async (_url: unknown) => new Response(JSON.stringify(TAGS), { status: 200 }))
    const stored = await refreshOllamaTags({ ...SOURCE, baseUrl: SOURCE.baseUrl, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(stored).toBe(6)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:11434/api/tags')
    expect(isOllamaModelRemote(SOURCE, 'kimi-k2.5:cloud')).toBe(true)
  })

  it('strips a trailing /v1 and trailing slashes from the base url', async () => {
    const fetchImpl = vi.fn(async (_url: unknown) => new Response(JSON.stringify(TAGS), { status: 200 }))
    await refreshOllamaTags({ baseUrl: 'http://127.0.0.1:11434/v1/', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:11434/api/tags')
  })

  it('swallows an HTTP error, a network error and an empty base url', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    expect(await refreshOllamaTags({ ...SOURCE, fetchImpl: failing as unknown as typeof fetch })).toBe(0)
    const throwing = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    expect(await refreshOllamaTags({ ...SOURCE, fetchImpl: throwing as unknown as typeof fetch })).toBe(0)
    expect(await refreshOllamaTags({ baseUrl: '   ' })).toBe(0)
    expect(ollamaTagCacheStats()).toEqual([])
  })
})

describe('scheduleOllamaTagRefresh', () => {
  it('does nothing under vitest, so no unit test ever reaches the network', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    scheduleOllamaTagRefresh([{ id: 'prov-box', providerType: 'ollama', baseUrl: SOURCE.baseUrl }])
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('asks an ollama provider once and then honours the throttle', async () => {
    vi.stubEnv('VITEST', '')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(TAGS), { status: 200 }))
    const providers = [
      { id: 'prov-box', providerType: 'ollama', baseUrl: SOURCE.baseUrl },
      { id: 'prov-cloud', providerType: 'anthropic', baseUrl: 'https://api.example.com' },
      { id: 'prov-nourl', providerType: 'ollama', baseUrl: '' },
    ]
    scheduleOllamaTagRefresh(providers)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:11434/api/tags')
    scheduleOllamaTagRefresh(providers)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
  })
})

// ── T1c: verdict per model, age, warm-up ──────────────────────────────

describe('getOllamaHostingVerdict', () => {
  it('reports remote, local and unverified per model', () => {
    recordOllamaTags(SOURCE, TAGS)
    expect(getOllamaHostingVerdict(SOURCE, 'kimi-k2.5:cloud')).toBe('remote')
    expect(getOllamaHostingVerdict(SOURCE, 'house-model:latest')).toBe('remote')
    expect(getOllamaHostingVerdict(SOURCE, 'qwen3.8:27b-mlx')).toBe('local')
    expect(getOllamaHostingVerdict(SOURCE, 'gemma4')).toBe('local')
    // In the answer of this box? No → we know nothing about it.
    expect(getOllamaHostingVerdict(SOURCE, 'mistral-next:7b')).toBe('unverified')
  })

  it('is unverified for an endpoint that never answered', () => {
    expect(getOllamaHostingVerdict(SOURCE, 'qwen3.8:27b-mlx')).toBe('unverified')
    expect(getOllamaHostingVerdict({ providerId: 'other' }, 'qwen3.8:27b-mlx')).toBe('unverified')
    expect(ollamaTagCacheAgeMs(SOURCE)).toBe(null)
  })

  it('lets a stale answer confirm remote but no longer certify local', () => {
    recordOllamaTags(SOURCE, TAGS)
    const stale = Date.now() + OLLAMA_TAG_MAX_AGE_MS + 1_000
    expect(getOllamaHostingVerdict(SOURCE, 'kimi-k2.5:cloud', stale)).toBe('remote')
    expect(getOllamaHostingVerdict(SOURCE, 'qwen3.8:27b-mlx', stale)).toBe('unverified')
    // Still inside the window it counts.
    const fresh = Date.now() + OLLAMA_TAG_MAX_AGE_MS - 1_000
    expect(getOllamaHostingVerdict(SOURCE, 'qwen3.8:27b-mlx', fresh)).toBe('local')
    expect(isOllamaModelRemote(SOURCE, 'qwen3.8:27b-mlx', stale)).toBe(null)
    expect(isOllamaModelRemote(SOURCE, 'kimi-k2.5:cloud', stale)).toBe(true)
    expect(ollamaTagCacheAgeMs(SOURCE, stale)).toBeGreaterThan(OLLAMA_TAG_MAX_AGE_MS)
  })

  it('reports 30 minutes as the age limit', () => {
    expect(OLLAMA_TAG_MAX_AGE_MS).toBe(30 * 60_000)
  })
})

describe('createOllamaTagWarmup', () => {
  const PROVIDERS = [
    { id: 'prov-box', providerType: 'ollama', baseUrl: SOURCE.baseUrl },
    { id: 'prov-box2', providerType: 'ollama', baseUrl: 'http://127.0.0.2:11434' },
    { id: 'prov-cloud', providerType: 'anthropic', baseUrl: 'https://api.example.com' },
    { id: 'prov-nourl', providerType: 'ollama', baseUrl: '' },
  ]

  function okFetch() {
    return vi.fn(async (_url: unknown) => new Response(JSON.stringify(TAGS), { status: 200 }))
  }

  it('asks every ollama provider in parallel on start and skips the others', async () => {
    const fetchImpl = okFetch()
    const warmup = createOllamaTagWarmup({
      listProviders: () => PROVIDERS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const stored = await warmup.refreshNow()
    expect(stored).toBe(12) // two reachable boxes × 6 models
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      'http://127.0.0.1:11434/api/tags',
      'http://127.0.0.2:11434/api/tags',
    ])
    expect(getOllamaHostingVerdict({ providerId: 'prov-box2' }, 'qwen3.8:27b-mlx')).toBe('local')
    warmup.stop()
  })

  it('runs once at boot and then on the interval, with an unref timer', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = okFetch()
      const warmup = createOllamaTagWarmup({
        listProviders: () => [PROVIDERS[0]!],
        intervalMs: 10 * 60_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      const unref = vi.spyOn(globalThis, 'setInterval')
      warmup.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchImpl).toHaveBeenCalledTimes(1) // boot run
      expect(unref.mock.results[0]!.value.hasRef()).toBe(false)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(fetchImpl).toHaveBeenCalledTimes(4)
      warmup.stop()
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(fetchImpl).toHaveBeenCalledTimes(4) // stopped for good
      unref.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults to a ten minute interval', () => {
    expect(OLLAMA_TAG_WARMUP_INTERVAL_MS).toBe(10 * 60_000)
  })

  it('refreshes more often than the age limit, so a reachable box never goes stale', async () => {
    expect(OLLAMA_TAG_WARMUP_INTERVAL_MS).toBeLessThan(OLLAMA_TAG_MAX_AGE_MS)
    const fetchImpl = okFetch()
    const warmup = createOllamaTagWarmup({
      listProviders: () => [PROVIDERS[0]!],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await warmup.refreshNow()
    const recorded = Date.now()
    // One interval later the entry still certifies local…
    expect(getOllamaHostingVerdict(SOURCE, 'qwen3.8:27b-mlx', recorded + OLLAMA_TAG_WARMUP_INTERVAL_MS)).toBe('local')
    // …and it would go stale without the next run.
    expect(getOllamaHostingVerdict(SOURCE, 'qwen3.8:27b-mlx', recorded + OLLAMA_TAG_MAX_AGE_MS + 1)).toBe('unverified')
    // The next run resets the age (a second answer of the same box).
    await warmup.refreshNow()
    expect(ollamaTagCacheAgeMs(SOURCE)!).toBeLessThan(OLLAMA_TAG_WARMUP_INTERVAL_MS)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    warmup.stop()
  })

  it('swallows a failing box, logs one line without credentials and keeps the others', async () => {
    const warn = vi.fn()
    const fetchImpl = vi.fn(async (url: unknown) => String(url).includes('127.0.0.2')
      ? new Response(JSON.stringify(TAGS), { status: 200 })
      : Promise.reject(new Error('ECONNREFUSED')))
    const warmup = createOllamaTagWarmup({
      listProviders: () => [
        { id: 'prov-box', providerType: 'ollama', baseUrl: 'http://user:pw@127.0.0.1:11434' },
        PROVIDERS[1]!,
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn },
    })
    expect(await warmup.refreshNow()).toBe(6)
    expect(warn).toHaveBeenCalledTimes(1)
    const line = warn.mock.calls[0]![0] as string
    expect(line).toContain('127.0.0.1:11434')
    expect(line).toContain('ECONNREFUSED')
    expect(line).not.toContain('pw')
    expect(line).not.toContain('user')
    warmup.stop()
  })

  it('logs an HTTP error the same way', async () => {
    const warn = vi.fn()
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))
    const warmup = createOllamaTagWarmup({
      listProviders: () => [PROVIDERS[0]!],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn },
    })
    expect(await warmup.refreshNow()).toBe(0)
    expect(warn.mock.calls[0]![0]).toBe(
      '[privacy] Ollama tag refresh for 127.0.0.1:11434 returned HTTP 503',
    )
    warmup.stop()
  })

  it('survives a provider list that throws', async () => {
    const warn = vi.fn()
    const warmup = createOllamaTagWarmup({
      listProviders: () => { throw new Error('providers.json unreadable') },
      fetchImpl: okFetch() as unknown as typeof fetch,
      logger: { warn },
    })
    expect(await warmup.refreshNow()).toBe(0)
    expect(warn.mock.calls[0]![0]).toContain('providers.json unreadable')
    warmup.stop()
  })

  it('touches no network under vitest without an injected fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const warmup = createOllamaTagWarmup({ listProviders: () => PROVIDERS })
    warmup.start()
    expect(await warmup.refreshNow()).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    warmup.stop()
    fetchSpy.mockRestore()
  })

  it('refreshes one provider immediately, e.g. right after it was saved', async () => {
    const fetchImpl = okFetch()
    const warmup = createOllamaTagWarmup({
      listProviders: () => [],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(await warmup.refreshProvider(PROVIDERS[0]!)).toBe(6)
    // Not an Ollama provider, and one without a base url: nothing happens.
    expect(await warmup.refreshProvider(PROVIDERS[2]!)).toBe(0)
    expect(await warmup.refreshProvider(PROVIDERS[3]!)).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(getOllamaHostingVerdict(SOURCE, 'qwen3.8:27b-mlx')).toBe('local')
  })
})

describe('scheduleOllamaTagRefreshForProvider', () => {
  it('does nothing under vitest', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    scheduleOllamaTagRefreshForProvider({ id: 'prov-box', providerType: 'ollama', baseUrl: SOURCE.baseUrl })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('asks the saved provider without waiting for the throttle', async () => {
    vi.stubEnv('VITEST', '')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(TAGS), { status: 200 }))
    const provider = { id: 'prov-box', providerType: 'ollama', baseUrl: SOURCE.baseUrl }
    scheduleOllamaTagRefreshForProvider(provider)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    // A second save re-asks at once (unlike the throttled listing warm-up).
    scheduleOllamaTagRefreshForProvider(provider)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    // Not an Ollama provider / no base url → no request.
    scheduleOllamaTagRefreshForProvider({ id: 'x', providerType: 'anthropic', baseUrl: 'https://api.example.com' })
    scheduleOllamaTagRefreshForProvider({ id: 'y', providerType: 'ollama', baseUrl: '' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    fetchSpy.mockRestore()
  })
})
