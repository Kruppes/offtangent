import { describe, expect, it, vi } from 'vitest'
import {
  createOAuthCatalogLoader,
  isOAuthCatalogResultCurrent,
  selectOAuthCatalogModels,
  type OAuthCatalogContext,
} from './oauthCatalogLoader'

interface Model { id: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A tiny stand-in for the dialog: context plus the state the handlers write. */
function harness(initial: OAuthCatalogContext) {
  const ctx: OAuthCatalogContext = { ...initial }
  const state = {
    models: [] as Model[],
    enabledModels: [] as string[],
    loading: false,
    loaded: false,
    error: null as string | null,
  }
  const pending: Array<ReturnType<typeof deferred<Model[]>>> = []
  const fetchModels = vi.fn((_type: string) => {
    const d = deferred<Model[]>()
    pending.push(d)
    return d.promise
  })
  const loader = createOAuthCatalogLoader<Model>({
    fetchModels,
    context: () => ({ ...ctx }),
    onStart: () => { state.models = []; state.error = null; state.loaded = false; state.loading = true },
    onIdle: () => { state.models = []; state.error = null; state.loaded = false; state.loading = false },
    onModels: (models) => {
      state.models = models
      state.loaded = true
      state.enabledModels = selectOAuthCatalogModels(state.enabledModels, models)
    },
    onError: (message) => { state.error = message },
    onSettled: () => { state.loading = false },
  })
  return { ctx, state, pending, fetchModels, loader }
}

const CREATE: OAuthCatalogContext = { open: true, mode: 'create', providerType: 'kimi-coding-oauth', isOAuth: true }
const CATALOG: Model[] = [{ id: 'k3' }, { id: 'k3-256k' }]

describe('OAuth catalog loader', () => {
  it('preselects the first catalog model in create mode', async () => {
    const h = harness(CREATE)
    const run = h.loader.load()
    expect(h.state.loading).toBe(true)
    h.pending[0]!.resolve(CATALOG)
    await run
    expect(h.state.models).toEqual(CATALOG)
    expect(h.state.enabledModels).toEqual(['k3'])
    expect(h.state.loading).toBe(false)
  })

  it('drops a late catalog after the dialog was closed and reopened in edit mode for the same type', async () => {
    const h = harness(CREATE)
    const run = h.loader.load()

    // Dialog closes while the catalog is loading (the watcher reloads → idle).
    h.ctx.open = false
    await h.loader.load()
    // An existing provider of the same type opens in edit mode.
    h.ctx.open = true
    h.ctx.mode = 'edit'
    h.state.enabledModels = ['kimi-for-coding', 'kimi-for-coding-highspeed']
    await h.loader.load()

    h.pending[0]!.resolve(CATALOG)
    await run

    expect(h.state.enabledModels).toEqual(['kimi-for-coding', 'kimi-for-coding-highspeed'])
    expect(h.state.models).toEqual([])
    expect(h.state.loading).toBe(false)
  })

  it('drops a late catalog even if the context check alone would pass (newer load in flight)', async () => {
    const h = harness(CREATE)
    const first = h.loader.load()
    const second = h.loader.load()
    h.pending[0]!.resolve([{ id: 'stale' }])
    await first
    expect(h.state.models).toEqual([])
    expect(h.state.loading).toBe(true)
    h.pending[1]!.resolve(CATALOG)
    await second
    expect(h.state.models).toEqual(CATALOG)
    expect(h.state.enabledModels).toEqual(['k3'])
  })

  it('drops a late error after invalidate()', async () => {
    const h = harness(CREATE)
    const run = h.loader.load()
    h.loader.invalidate()
    h.pending[0]!.reject(new Error('boom'))
    await run
    expect(h.state.error).toBeNull()
  })

  it('reports a failed load and loads again on retry', async () => {
    const h = harness(CREATE)
    const run = h.loader.load()
    h.pending[0]!.reject(new Error('Network error'))
    await run
    expect(h.state.error).toBe('Network error')
    expect(h.state.loading).toBe(false)
    expect(h.state.enabledModels).toEqual([])

    const retry = h.loader.load()
    expect(h.state.error).toBeNull()
    expect(h.state.loading).toBe(true)
    h.pending[1]!.resolve(CATALOG)
    await retry
    expect(h.fetchModels).toHaveBeenCalledTimes(2)
    expect(h.state.enabledModels).toEqual(['k3'])
  })

  it('marks an empty catalog as loaded with no models', async () => {
    const h = harness(CREATE)
    const run = h.loader.load()
    h.pending[0]!.resolve([])
    await run
    expect(h.state.loaded).toBe(true)
    expect(h.state.models).toEqual([])
    expect(h.state.enabledModels).toEqual([])
    expect(h.state.error).toBeNull()
  })

  it('does not fetch outside create mode or for non-OAuth types', async () => {
    for (const ctx of [
      { ...CREATE, open: false },
      { ...CREATE, mode: 'edit' as const },
      { ...CREATE, isOAuth: false },
      { ...CREATE, providerType: '' },
    ]) {
      const h = harness(ctx)
      await h.loader.load()
      expect(h.fetchModels).not.toHaveBeenCalled()
      expect(h.state.loading).toBe(false)
    }
  })
})

describe('isOAuthCatalogResultCurrent', () => {
  const started = { generation: 3, providerType: 'kimi-coding-oauth' }
  it('accepts only the same generation, open, create mode and the same OAuth type', () => {
    expect(isOAuthCatalogResultCurrent(started, { generation: 3, ...CREATE })).toBe(true)
    expect(isOAuthCatalogResultCurrent(started, { generation: 4, ...CREATE })).toBe(false)
    expect(isOAuthCatalogResultCurrent(started, { generation: 3, ...CREATE, open: false })).toBe(false)
    expect(isOAuthCatalogResultCurrent(started, { generation: 3, ...CREATE, mode: 'edit' })).toBe(false)
    expect(isOAuthCatalogResultCurrent(started, { generation: 3, ...CREATE, isOAuth: false })).toBe(false)
    expect(isOAuthCatalogResultCurrent(started, { generation: 3, ...CREATE, providerType: 'copilot' })).toBe(false)
  })
})

describe('selectOAuthCatalogModels', () => {
  it('keeps known picks, drops unknown ones and falls back to the first model', () => {
    expect(selectOAuthCatalogModels(['k3-256k', 'gone'], CATALOG)).toEqual(['k3-256k'])
    expect(selectOAuthCatalogModels(['gone'], CATALOG)).toEqual(['k3'])
    expect(selectOAuthCatalogModels([], [])).toEqual([])
  })
})
