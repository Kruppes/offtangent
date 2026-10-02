import { describe, expect, it, vi } from 'vitest'
import { createVoiceReplies } from './voiceReplies'

describe('voice replies switch', () => {
  it('loads the stored value', async () => {
    const c = createVoiceReplies({ get: async () => ({ enabled: true }), set: vi.fn() })
    expect(c.state.value).toBe('loading')
    await c.load()
    expect(c.state.value).toBe('ready')
    expect(c.enabled.value).toBe(true)
  })

  it('reports a load failure and can retry', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ enabled: false })
    const c = createVoiceReplies({ get, set: vi.fn() })
    await c.load()
    expect(c.state.value).toBe('error')
    await c.load()
    expect(c.state.value).toBe('ready')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('saves on change and confirms', async () => {
    vi.useFakeTimers()
    const set = vi.fn(async (enabled: boolean) => ({ enabled }))
    const c = createVoiceReplies({ get: async () => ({ enabled: false }), set }, 1000)
    await c.load()
    await c.toggle(true)
    expect(set).toHaveBeenCalledWith(true)
    expect(c.enabled.value).toBe(true)
    expect(c.feedback.value).toBe('saved')
    vi.advanceTimersByTime(1000)
    expect(c.feedback.value).toBeNull()
    vi.useRealTimers()
  })

  it('rolls back and reports a failed save', async () => {
    const c = createVoiceReplies({ get: async () => ({ enabled: false }), set: async () => { throw new Error('500') } })
    await c.load()
    await c.toggle(true)
    expect(c.enabled.value).toBe(false)
    expect(c.feedback.value).toBe('failed')
    expect(c.saving.value).toBe(false)
  })
})
