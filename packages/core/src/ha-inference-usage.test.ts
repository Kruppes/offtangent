import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createHaInferenceHandler, type HaInferenceConfig } from './ha-inference.js'
import type { AssistantMessage } from '@earendil-works/pi-ai'

const token = 'ha-test-only-bearer-value-123456789'
const config: HaInferenceConfig = {
  enabled: true, tokenSha256: createHash('sha256').update(token).digest('hex'),
  providerId: 'subscription-only', model: 'gpt-test', tools: [],
  timeoutMs: 1000, maxBodyBytes: 262144, maxCallsPerHour: 100,
}
const message = {
  role: 'assistant', content: [{ type: 'text', text: 'response unchanged' }],
  api: 'openai-codex-responses', provider: 'openai-codex', model: config.model,
  usage: { input: 11, output: 3, cacheRead: 5, cacheWrite: 0, totalTokens: 19,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: 1,
} as AssistantMessage
const request = () => new Request('http://localhost/v1/chat/completions', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'question' }] }),
})
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe('HA relay usage callback', () => {
  it('books each completed model response, including a rejected completion', async () => {
    const usage = vi.fn()
    const handle = createHaInferenceHandler(config, async () => ({ message, completed: true, wireModel: config.model }), usage)
    expect((await handle(request())).status).toBe(200)
    await tick()
    expect(usage).toHaveBeenCalledOnce()
    expect(usage).toHaveBeenCalledWith(message)
  })

  it('does not book without a model response and a booking failure does not affect output', async () => {
    const usage = vi.fn(() => { throw Error('booking failed') })
    const fail = createHaInferenceHandler(config, async () => { throw Error('inference failed') }, usage)
    expect((await fail(request())).status).toBe(502)
    await tick()
    expect(usage).not.toHaveBeenCalled()
    const without = createHaInferenceHandler(config, async () => ({ message, completed: true, wireModel: config.model }))
    const withFailure = createHaInferenceHandler(config, async () => ({ message, completed: true, wireModel: config.model }), usage)
    const expected = await (await without(request())).json() as { choices: unknown; usage: unknown } as { choices: unknown; usage: unknown }
    const actual = await (await withFailure(request())).json()
    expect(actual).toMatchObject({ choices: expected.choices, usage: expected.usage })
    await tick()
    expect(usage).toHaveBeenCalledOnce()
  })
})
