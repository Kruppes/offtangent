import { describe, it, expect } from 'vitest'
import type { ProviderConfig } from './provider-config.js'
import { resolveTaskDefaultProvider } from './task-provider-resolution.js'
import { runWithTaskExecutionContext } from './task-execution-context.js'

function makeProvider(id: string, models: string[]): ProviderConfig {
  return {
    id,
    name: id,
    providerType: 'openai-compatible',
    type: 'openai-completions',
    provider: id,
    baseUrl: 'http://localhost',
    enabledModels: models,
  } as unknown as ProviderConfig
}

const SYSTEM_DEFAULT = makeProvider('system', ['system-model'])

function baseOptions(overrides: Partial<Parameters<typeof resolveTaskDefaultProvider>[0]> = {}) {
  return {
    resolveProvider: (id: string) => {
      const catalog: Record<string, ProviderConfig> = {
        kimi: makeProvider('kimi', ['kimi-k2.6', 'kimi-k3']),
        openai: makeProvider('openai', ['gpt-5', 'gpt-4o']),
      }
      return catalog[id] ?? null
    },
    getSystemDefault: () => SYSTEM_DEFAULT,
    ...overrides,
  }
}

describe('resolveTaskDefaultProvider (task model inheritance chain)', () => {
  it('falls back to the system default when nothing else applies', () => {
    const result = resolveTaskDefaultProvider(baseOptions())
    expect(result.id).toBe('system')
  })

  it('uses the per-agent default when the agent has one', () => {
    const result = resolveTaskDefaultProvider(baseOptions({
      agentId: 'warren',
      getPerAgentProviderSpec: (id) => (id === 'warren' ? 'kimi:kimi-k2.6' : undefined),
    }))
    expect(result.id).toBe('kimi')
    expect(result.enabledModels).toEqual(['kimi-k2.6'])
  })

  it('per-agent default without a model keeps the provider unpinned', () => {
    const result = resolveTaskDefaultProvider(baseOptions({
      agentId: 'gekko',
      getPerAgentProviderSpec: () => 'openai',
    }))
    expect(result.id).toBe('openai')
    expect(result.enabledModels).toEqual(['gpt-5', 'gpt-4o'])
  })

  it('falls through to system default when the per-agent spec is unresolvable', () => {
    const result = resolveTaskDefaultProvider(baseOptions({
      agentId: 'ghost',
      getPerAgentProviderSpec: () => 'nonexistent:whatever',
    }))
    expect(result.id).toBe('system')
  })

  it('parent task model (ALS context) wins over per-agent and system default', async () => {
    const parent = makeProvider('openai', ['gpt-5'])
    const result = await runWithTaskExecutionContext(
      { provider: parent, agentId: 'warren', taskId: 'parent' },
      async () =>
        resolveTaskDefaultProvider(baseOptions({
          agentId: 'warren',
          getPerAgentProviderSpec: () => 'kimi:kimi-k2.6', // would win if not for parent
        })),
    )
    // Parent (openai/gpt-5) beats the per-agent kimi default.
    expect(result.id).toBe('openai')
    expect(result.enabledModels).toEqual(['gpt-5'])
  })

  it('uses the ALS agentId for the per-agent lookup when none is passed', async () => {
    // No parent provider bound (null), but an agentId is in context.
    const result = await runWithTaskExecutionContext(
      { provider: null, agentId: 'warren', taskId: 'parent' },
      async () =>
        resolveTaskDefaultProvider(baseOptions({
          // agentId intentionally omitted → resolver reads it from ALS ctx
          getPerAgentProviderSpec: (id) => (id === 'warren' ? 'kimi:kimi-k3' : undefined),
        })),
    )
    expect(result.id).toBe('kimi')
    expect(result.enabledModels).toEqual(['kimi-k3'])
  })

  it('documented ordering: explicit > parent > agent > system (parent even if it inherited system)', async () => {
    // Parent provider IS the system default (i.e. parent inherited it). Per spec,
    // the parent still wins over the child's per-agent default.
    const result = await runWithTaskExecutionContext(
      { provider: SYSTEM_DEFAULT, agentId: 'warren', taskId: 'parent' },
      async () =>
        resolveTaskDefaultProvider(baseOptions({
          agentId: 'warren',
          getPerAgentProviderSpec: () => 'kimi:kimi-k2.6',
        })),
    )
    expect(result.id).toBe('system')
  })
})
