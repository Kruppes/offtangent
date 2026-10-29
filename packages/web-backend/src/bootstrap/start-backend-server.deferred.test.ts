/**
 * Boot warnings: the short-timeout network services (MQTT connect/publish,
 * Ollama `/api/tags` warm-up) start only after the HTTP server listens, and
 * never when the listen fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const order: string[] = []
let listenFails = false

vi.mock('./runtime-composition.js', () => ({
  createRuntimeComposition: vi.fn(async () => {
    order.push('compose')
    return {
      startDeferredServices: vi.fn(() => { order.push('deferred') }),
      stopBackgroundServices: vi.fn(async () => { order.push('stopBackground') }),
    }
  }),
}))

vi.mock('./http-boundary.js', () => ({
  startHttpBoundary: vi.fn(async () => {
    order.push('listen')
    if (listenFails) throw new Error('EADDRINUSE')
    return { server: {}, host: '127.0.0.1', port: 1, stopHttp: vi.fn(async () => { order.push('stopHttp') }) }
  }),
}))

const { startBackendServer } = await import('./start-backend-server.js')

describe('startBackendServer: deferred network services', () => {
  beforeEach(() => {
    order.length = 0
    listenFails = false
  })

  it('starts MQTT and the Ollama warm-up only after listen', async () => {
    const started = await startBackendServer({ installSignalHandlers: false })
    expect(order).toEqual(['compose', 'listen', 'deferred'])
    await started.stop()
    expect(order).toEqual(['compose', 'listen', 'deferred', 'stopBackground', 'stopHttp'])
  })

  it('does not start them when listen fails', async () => {
    listenFails = true
    await expect(startBackendServer({ installSignalHandlers: false })).rejects.toThrow('EADDRINUSE')
    expect(order).toEqual(['compose', 'listen', 'stopBackground'])
  })
})
