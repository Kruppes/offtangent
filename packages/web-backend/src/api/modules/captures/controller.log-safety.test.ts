/**
 * Review K0-K2-4 #4: an unexpected exception of the capture service must
 * reach neither the log nor the HTTP answer with its message or stack — a
 * capture carries a dictation, and a message can echo it.
 */
import { describe, it, expect, vi } from 'vitest'
import { createCapturesController } from './controller.js'
import type { CapturesService } from './service.js'

const MARKER = 'PRIVATE_CLOCK_DICTATION_MARKER_CAPTURES'

describe('captures controller log safety (review K0-K2-4 #4)', () => {
  it('a 500 carries the error class in log and body, never the message', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    try {
      const service = { createCapture: async () => { throw new Error(`boom while filing "${MARKER}"`) } } as unknown as CapturesService
      const controller = createCapturesController(service)
      let status = 0
      let body: unknown = null
      const res = { status(code: number) { status = code; return this }, json(value: unknown) { body = value; return this } }
      await controller.create({ body: { text: `diktat ${MARKER}` }, user: { userId: 1 } } as never, res as never)
      const logged = spies.flatMap(spy => spy.mock.calls.flat())
        .map(arg => arg instanceof Error ? `${arg.message}\n${arg.stack ?? ''}` : String(arg)).join('\n')
      expect(status).toBe(500)
      expect(JSON.stringify(body)).toContain('error')
      expect(JSON.stringify(body)).not.toContain(MARKER)
      expect(logged).toContain('[captures]')
      expect(logged).not.toContain(MARKER)
    } finally { spies.forEach(spy => spy.mockRestore()) }
  })
})
