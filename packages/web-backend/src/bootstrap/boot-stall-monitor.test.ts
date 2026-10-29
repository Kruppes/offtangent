import { afterEach, describe, expect, it, vi } from 'vitest'
import { startBootStallMonitor } from './boot-stall-monitor.js'

function busyWait(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* hold the event loop on purpose */ }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('boot stall monitor', () => {
  afterEach(() => vi.restoreAllMocks())

  it('records a synchronous block above the threshold and logs it once', async () => {
    const lines: string[] = []
    const monitor = startBootStallMonitor({ intervalMs: 10, thresholdMs: 150, logger: { log: (l: string) => lines.push(l) } })
    await sleep(30)
    busyWait(300)
    await sleep(40)
    monitor.markListening()
    const stalls = monitor.finish()
    expect(stalls).toHaveLength(1)
    expect(stalls[0].ms).toBeGreaterThanOrEqual(150)
    expect(stalls[0].afterListen).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[boot\] listening after \d+ ms; event-loop stalls >= 150 ms: \d+ ms ending \d{4}-/)
    monitor.finish()
    expect(lines).toHaveLength(1)
  })

  it('flags stalls after listen and reports a clean boot', async () => {
    const lines: string[] = []
    const clean = startBootStallMonitor({ intervalMs: 10, thresholdMs: 150, logger: { log: (l: string) => lines.push(l) } })
    await sleep(40)
    clean.markListening()
    clean.finish()
    expect(lines[0]).toMatch(/no event-loop stall >= 150 ms$/)

    const late = startBootStallMonitor({ intervalMs: 10, thresholdMs: 150, logger: { log: () => {} } })
    late.markListening()
    await sleep(20)
    busyWait(250)
    await sleep(30)
    expect(late.finish()[0]?.afterListen).toBe(true)
  })
})

describe('boot step timing', () => {
  it('logs only steps at or above the threshold and keeps the result and errors', async () => {
    const { timeBootStep, logBootStepDuration } = await import('./boot-stall-monitor.js')
    const lines: string[] = []
    const logger = { log: (l: string) => lines.push(l) }
    expect(timeBootStep(logger, 'fast', () => 42, 100)).toBe(42)
    expect(lines).toEqual([])
    expect(timeBootStep(logger, 'slow', () => { busyWait(120); return 'ok' }, 100)).toBe('ok')
    expect(lines[0]).toMatch(/^\[boot\] slow took \d+ ms$/)
    expect(() => timeBootStep(logger, 'boom', () => { busyWait(120); throw new Error('x') }, 100)).toThrow('x')
    expect(lines[1]).toMatch(/^\[boot\] boom took \d+ ms$/)
    logBootStepDuration(logger, 'wall', 99, 100)
    expect(lines).toHaveLength(2)
  })
})
