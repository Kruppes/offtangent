import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCommand, resetShellCommandsForTest, useShellCommands } from './useShellCommands'

describe('shell commands', () => {
  beforeEach(() => resetShellCommandsForTest())

  it('offers a command only while a provider is registered and available', async () => {
    const commands = useShellCommands()
    const run = vi.fn()
    let ready = false
    expect(commands.available('dictation.start')).toBe(false)
    const release = registerCommand('dictation.start', { run, available: () => ready })
    expect(commands.available('dictation.start')).toBe(false)
    expect(await commands.run('dictation.start')).toBe(false)
    ready = true
    expect(commands.available('dictation.start')).toBe(true)
    expect(await commands.run('dictation.start')).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    release()
    expect(commands.available('dictation.start')).toBe(false)
  })

  it('lets the newest provider win and falls back when it leaves', async () => {
    const commands = useShellCommands()
    const older = vi.fn()
    const newer = vi.fn()
    registerCommand('strand.archive', { run: older, available: () => true })
    const release = registerCommand('strand.archive', { run: newer, available: () => true })
    await commands.run('strand.archive')
    expect(newer).toHaveBeenCalledTimes(1)
    release()
    await commands.run('strand.archive')
    expect(older).toHaveBeenCalledTimes(1)
  })

  it('counts strand changes so lists can reload', () => {
    const commands = useShellCommands()
    expect(commands.strandsVersion.value).toBe(0)
    commands.strandsChanged()
    expect(commands.strandsVersion.value).toBe(1)
  })
})
