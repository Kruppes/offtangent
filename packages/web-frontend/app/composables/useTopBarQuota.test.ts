/**
 * The real `useTopBarQuota` composable: route/auth/connection status and
 * `listModels` are mocked, timers are fake, the component really mounts and
 * unmounts so the poll lifecycle is exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, type ComputedRef } from 'vue'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import type { SelectableModel } from '~/api/models'
import type { TopBarQuotaSource } from '~/utils/topBarQuota'
import { createHeadlessApp, installTopBarQuotaGlobals, type QuotaHarnessInput } from '~/test-support/topBarQuotaHarness'

const listModels = vi.fn<() => Promise<SelectableModel[]>>()
vi.mock('~/api/models', () => ({ useModelsApi: () => ({ listModels }) }))

const { useActiveStrandProvider, useTopBarQuota } = await import('./useTopBarQuota')

const anthropicQuota: ProviderQuotaContract = {
  kind: 'anthropic',
  windows: [{ key: 'five_hour', label: '5h', utilization: 40, resetsAt: null, resetDisplay: 'relative' }],
  fetchedAt: '2026-01-01T10:00:00.000Z',
}
const moonshotQuota: ProviderQuotaContract = {
  kind: 'moonshot',
  windows: [],
  balance: { amount: 13.5, currency: 'USD', cash: 13.5, voucher: 0 },
  fetchedAt: '2026-01-01T10:00:00.000Z',
}

function model(providerId: string, providerName: string, quota: ProviderQuotaContract | null): SelectableModel {
  return {
    providerId, providerName, modelId: `${providerId}-m`, displayName: 'M', contextWindow: null, status: 'connected',
    selectable: true, unavailableReason: null, isActive: false, isFallback: false, quota,
  }
}
const catalog = [model('moonshot', 'Moonshot_API', moonshotQuota), model('anthropic', 'Anthropic', anthropicQuota)]

const POLL = 60_000

function setup(input: Partial<QuotaHarnessInput> = {}) {
  const env = installTopBarQuotaGlobals({
    role: 'admin',
    path: '/strands/s1',
    params: { id: 's1' },
    globalProviderName: 'Anthropic',
    globalQuota: anthropicQuota,
    activeStrand: { strandId: 's1', providerId: 'moonshot' },
    ...input,
  })
  let source!: ComputedRef<TopBarQuotaSource | null>
  const app = createHeadlessApp(defineComponent({
    setup() {
      source = useTopBarQuota().source
      return () => h('div')
    },
  }))
  app.mount()
  return { ...env, app, source: () => source.value }
}

beforeEach(() => {
  vi.useFakeTimers()
  listModels.mockReset()
  listModels.mockResolvedValue(catalog)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useTopBarQuota', () => {
  it('on a strand page shows only the strand provider, with its label, not the global default', async () => {
    const t = setup()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.source()).toMatchObject({ providerId: 'moonshot', providerName: 'Moonshot_API', quota: moonshotQuota })
    t.app.unmount()
  })

  it('outside a strand shows the global default and does not poll /api/models', async () => {
    const t = setup({ path: '/', params: {} })
    await vi.advanceTimersByTimeAsync(3 * POLL)
    expect(t.source()).toMatchObject({ providerName: 'Anthropic', quota: anthropicQuota })
    expect(listModels).not.toHaveBeenCalled()
    t.app.unmount()
  })

  it('shows nothing for non-admins, neither on a strand nor globally, and never polls for them', async () => {
    const onStrand = setup({ role: 'user' })
    await vi.advanceTimersByTimeAsync(POLL)
    expect(onStrand.source()).toBeNull()
    onStrand.app.unmount()
    vi.unstubAllGlobals()

    const outside = setup({ role: 'user', path: '/', params: {} })
    expect(outside.source()).toBeNull()
    outside.app.unmount()
    expect(listModels).not.toHaveBeenCalled()
  })

  it('polls every 60 s, once, also after the strand provider changed (no double polling)', async () => {
    const t = setup()
    await vi.advanceTimersByTimeAsync(0)
    expect(listModels).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL)
    expect(listModels).toHaveBeenCalledTimes(2)
    // A new pin: one immediate re-read, then still a single 60 s interval.
    useActiveStrandProvider().publish('s1', 'anthropic')
    await vi.advanceTimersByTimeAsync(0)
    expect(listModels).toHaveBeenCalledTimes(3)
    expect(t.source()).toMatchObject({ providerId: 'anthropic', providerName: 'Anthropic' })
    await vi.advanceTimersByTimeAsync(POLL)
    expect(listModels).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(POLL)
    expect(listModels).toHaveBeenCalledTimes(5)
    t.app.unmount()
  })

  it('stops polling when the user leaves the strand, and falls back to the global default', async () => {
    const t = setup()
    await vi.advanceTimersByTimeAsync(0)
    expect(listModels).toHaveBeenCalledTimes(1)
    t.route.path = '/settings'
    t.route.params = {}
    await vi.advanceTimersByTimeAsync(5 * POLL)
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(t.source()).toMatchObject({ providerName: 'Anthropic' })
    t.app.unmount()
  })

  it('stops the timer on unmount (no leak)', async () => {
    const t = setup()
    await vi.advanceTimersByTimeAsync(0)
    expect(listModels).toHaveBeenCalledTimes(1)
    t.app.unmount()
    await vi.advanceTimersByTimeAsync(5 * POLL)
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a failed poll keeps the last snapshot and never shows another provider', async () => {
    const t = setup()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.source()).toMatchObject({ providerId: 'moonshot', quota: moonshotQuota })
    listModels.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(POLL)
    expect(listModels).toHaveBeenCalledTimes(2)
    expect(t.source()).toMatchObject({ providerId: 'moonshot', providerName: 'Moonshot_API', quota: moonshotQuota })
    t.app.unmount()
  })

  it('a first poll that fails shows nothing on the strand, not the global provider', async () => {
    listModels.mockRejectedValue(new Error('offline'))
    const t = setup()
    await vi.advanceTimersByTimeAsync(POLL)
    expect(listModels).toHaveBeenCalledTimes(2)
    expect(t.source()).toBeNull()
    t.app.unmount()
  })
})

describe('useActiveStrandProvider', () => {
  it('release only clears the entry of its own strand', () => {
    const t = installTopBarQuotaGlobals({ role: 'admin', path: '/strands/s2', params: { id: 's2' } })
    const provider = useActiveStrandProvider()
    provider.publish('s2', 'moonshot')
    // The old strand's header unmounts after the new one published.
    provider.release('s1')
    expect(t.store.get('active_strand_provider')?.value).toEqual({ strandId: 's2', providerId: 'moonshot' })
    provider.release('s2')
    expect(t.store.get('active_strand_provider')?.value).toBeNull()
  })

  it('publishing no provider clears the entry', () => {
    const t = installTopBarQuotaGlobals({ role: 'admin', path: '/strands/s1', params: { id: 's1' } })
    const provider = useActiveStrandProvider()
    provider.publish('s1', 'moonshot')
    provider.publish('s1', null)
    expect(t.store.get('active_strand_provider')?.value).toBeNull()
  })
})
