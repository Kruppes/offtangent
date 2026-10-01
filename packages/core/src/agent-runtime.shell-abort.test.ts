import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createYoloTools } from './agent-runtime.js'

/**
 * The shell tool must stop the whole process group when the tool call is
 * cancelled (a task abort) or when the command floods the output cap —
 * otherwise a build keeps running until the per-call timeout.
 *
 * The workspace is the per-file sandbox from vitest.setup.ts. Thresholds are
 * generous on purpose: the image build runs the suite as root on a busy host.
 */

function shellTool() {
  const tool = createYoloTools().find(t => t.name === 'shell')
  if (!tool) throw new Error('shell tool missing')
  return tool
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(part => part.text ?? '').join('')
}

/** True when the pid no longer runs (gone, or a zombie nobody reaped yet). */
function processGone(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
    // Field 3 is the state; the command name in field 2 may contain spaces.
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state === 'Z' || state === 'X'
  } catch {
    return true
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return check()
}

describe('shell tool — cancellation and output cap', () => {
  it('kills the process group, including a background child, when the tool call is aborted', async () => {
    const pidFile = path.join(process.env.WORKSPACE_DIR!, `child-${Date.now()}.pid`)
    const controller = new AbortController()
    const started = Date.now()
    const pending = shellTool().execute(
      'call-1',
      { command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`, timeout: 60_000 },
      controller.signal,
    )

    // Abort once the background child is up.
    expect(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8').trim() !== '', 10_000)).toBe(true)
    const childPid = Number(fs.readFileSync(pidFile, 'utf-8').trim())
    expect(processGone(childPid)).toBe(false)

    controller.abort()
    const result = await pending
    const elapsed = Date.now() - started

    // Without the abort wiring this only returns after `sleep 30`.
    expect(elapsed).toBeLessThan(10_000)
    expect(textOf(result)).toContain('Command aborted')
    expect(result.details).toMatchObject({ exitCode: expect.any(Number) })
    expect((result.details as { exitCode: number }).exitCode).not.toBe(0)
    expect(await waitFor(() => processGone(childPid), 5_000)).toBe(true)
  }, 30_000)

  it('does not start a command when the signal is already aborted', async () => {
    const marker = path.join(process.env.WORKSPACE_DIR!, `never-${Date.now()}.txt`)
    const controller = new AbortController()
    controller.abort()
    const result = await shellTool().execute(
      'call-2',
      { command: `sleep 1; echo ran > ${JSON.stringify(marker)}`, timeout: 60_000 },
      controller.signal,
    )
    expect(textOf(result)).toContain('Command aborted')
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(fs.existsSync(marker)).toBe(false)
  }, 30_000)

  it('kills the process group once the output exceeds the byte cap', async () => {
    const started = Date.now()
    // `yes` never ends on its own: only the output cap (or the 60 s timeout
    // on the old code path) stops it.
    const result = await shellTool().execute('call-3', { command: 'yes', timeout: 60_000 })
    expect(Date.now() - started).toBeLessThan(30_000)
    const text = textOf(result)
    expect(text).toMatch(/output exceeded \d+ bytes/)
    expect(text).not.toContain('timed out')
  }, 90_000)

  it('keeps the existing behaviour for normal commands and timeouts', async () => {
    const ok = await shellTool().execute('call-4', { command: 'echo hello' }, new AbortController().signal)
    expect(textOf(ok)).toContain('hello')
    expect(ok.details).toMatchObject({ exitCode: 0 })

    const slow = await shellTool().execute('call-5', { command: 'sleep 30', timeout: 300 })
    expect(textOf(slow)).toContain('Command timed out after 300ms and was killed.')
    expect(textOf(slow)).not.toContain('aborted')
  }, 30_000)
})
