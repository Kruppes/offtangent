import { describe, it, expect } from 'vitest'
import type { ProviderConfig } from './provider-config.js'
import {
  runWithTaskExecutionContext,
  getCurrentTaskExecutionContext,
  getCurrentTaskProvider,
  getCurrentTaskAgentId,
} from './task-execution-context.js'

function makeProvider(id: string, model: string): ProviderConfig {
  return {
    id,
    name: id,
    providerType: 'openai-compatible',
    type: 'openai-completions',
    provider: id,
    baseUrl: 'http://localhost',
    enabledModels: [model],
  } as unknown as ProviderConfig
}

describe('task-execution-context', () => {
  it('returns undefined/null outside any task context', () => {
    expect(getCurrentTaskExecutionContext()).toBeUndefined()
    expect(getCurrentTaskProvider()).toBeNull()
    expect(getCurrentTaskAgentId()).toBeUndefined()
  })

  it('exposes the bound provider inside the context', async () => {
    const provider = makeProvider('kimi', 'kimi-k2.6')
    const seen = await runWithTaskExecutionContext(
      { provider, agentId: 'warren', taskId: 'task-1' },
      async () => {
        return {
          provider: getCurrentTaskProvider(),
          agentId: getCurrentTaskAgentId(),
          taskId: getCurrentTaskExecutionContext()?.taskId,
        }
      },
    )
    expect(seen.provider?.id).toBe('kimi')
    expect(seen.provider?.enabledModels?.[0]).toBe('kimi-k2.6')
    expect(seen.agentId).toBe('warren')
    expect(seen.taskId).toBe('task-1')
  })

  it('inherits the parent context in nested (sub-sub-task) calls', async () => {
    const parent = makeProvider('kimi', 'kimi-k2.6')
    const result = await runWithTaskExecutionContext(
      { provider: parent, agentId: 'main', taskId: 'parent' },
      async () => {
        // A nested tool call that does NOT rebind context still sees the parent.
        const inheritedProvider = await Promise.resolve().then(() => getCurrentTaskProvider())
        return inheritedProvider?.id
      },
    )
    expect(result).toBe('kimi')
  })

  it('lets a sub-task override the context (explicit child model wins)', async () => {
    const parent = makeProvider('kimi', 'kimi-k2.6')
    const child = makeProvider('openai', 'gpt-5')
    const observed = await runWithTaskExecutionContext(
      { provider: parent, taskId: 'parent' },
      async () => {
        // Simulate the child task binding its own (explicitly pinned) provider.
        return runWithTaskExecutionContext(
          { provider: child, taskId: 'child' },
          async () => getCurrentTaskProvider()?.id,
        )
      },
    )
    expect(observed).toBe('openai')
  })

  it('restores the parent context after a nested context returns', async () => {
    const parent = makeProvider('kimi', 'kimi-k2.6')
    const child = makeProvider('openai', 'gpt-5')
    const trail: (string | null)[] = []
    await runWithTaskExecutionContext({ provider: parent, taskId: 'parent' }, async () => {
      trail.push(getCurrentTaskProvider()?.id ?? null)
      await runWithTaskExecutionContext({ provider: child, taskId: 'child' }, async () => {
        trail.push(getCurrentTaskProvider()?.id ?? null)
      })
      trail.push(getCurrentTaskProvider()?.id ?? null)
    })
    expect(trail).toEqual(['kimi', 'openai', 'kimi'])
  })

  it('isolates concurrent task trees from each other', async () => {
    const a = makeProvider('provider-a', 'model-a')
    const b = makeProvider('provider-b', 'model-b')
    const [seenA, seenB] = await Promise.all([
      runWithTaskExecutionContext({ provider: a, taskId: 'a' }, async () => {
        await new Promise(r => setTimeout(r, 10))
        return getCurrentTaskProvider()?.id
      }),
      runWithTaskExecutionContext({ provider: b, taskId: 'b' }, async () => {
        await new Promise(r => setTimeout(r, 5))
        return getCurrentTaskProvider()?.id
      }),
    ])
    expect(seenA).toBe('provider-a')
    expect(seenB).toBe('provider-b')
  })

  it('carries a null provider when the task has none (e.g. on resume)', async () => {
    const seen = await runWithTaskExecutionContext(
      { provider: null, taskId: 'resumed' },
      async () => getCurrentTaskProvider(),
    )
    expect(seen).toBeNull()
  })
})
