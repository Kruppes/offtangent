import { describe, expect, it, vi } from 'vitest'
import type { Task } from '../../api/tasks'
import { createTaskMetadataCache } from './taskMetadata'

describe('task metadata cache', () => {
  it('fetches once and only keeps actual model/provider, never stale usage', async () => {
    const get = vi.fn(async () => ({ task: { model: 'actual-model', provider: 'actual-provider', promptTokens: 1 } as Task }))
    const cached = createTaskMetadataCache(get)
    const [a, b] = await Promise.all([cached('t1'), cached('t1')])
    expect(a).toEqual({ model: 'actual-model', provider: 'actual-provider' })
    expect(b).toEqual(a)
    await cached('t1')
    expect(get).toHaveBeenCalledTimes(1)
  })
  it('does not guess missing models or retry failures on every frame', async () => {
    const get = vi.fn(async () => ({ task: { model: null, provider: null } as Task }))
    expect(await createTaskMetadataCache(get)('legacy')).toEqual({ model: null, provider: null })
    const fail = vi.fn(async (): Promise<{task: Task}> => { throw new Error('403') })
    const cached = createTaskMetadataCache(fail)
    expect(await cached('denied')).toBeNull()
    expect(await cached('denied')).toBeNull()
    expect(fail).toHaveBeenCalledTimes(1)
  })
})
