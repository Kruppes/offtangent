import { describe, expect, it, vi } from 'vitest'
import { saveWithModelConsent } from './settingsConsent'

const warning = { fingerprint: 'a'.repeat(64), providerName: 'Google', destination: 'https://google.example/interactions', modelId: 'gemini-tts', role: 'tts',
  variant: '["gemini","Charon"]', policy: { region: 'us', training: 'yes' }, explicitlySelected: true }
const required = { status: 409, body: { error: 'model_consent_required', selections: [warning] } }

describe('settings consent confirmation', () => {
  it('does not prompt when the selection is already confirmed', async () => {
    const save = vi.fn().mockResolvedValue({ message: 'ok' })
    const confirm = vi.fn()
    await expect(saveWithModelConsent(save, { tts: {} }, confirm)).resolves.toEqual({ message: 'ok' })
    expect(confirm).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('asks before retrying and sends only the returned scoped fingerprint', async () => {
    const save = vi.fn().mockRejectedValueOnce(required).mockResolvedValue({ message: 'ok' })
    const confirm = vi.fn().mockReturnValue(true)
    await saveWithModelConsent(save, { tts: { providerId: 'google' } }, confirm)
    expect(confirm).toHaveBeenCalledWith([warning])
    expect(save).toHaveBeenNthCalledWith(2, { tts: { providerId: 'google' }, modelConsentTokens: [warning.fingerprint] })
  })
  it('waits for an explicit asynchronous dialog answer before retrying', async () => {
    const save = vi.fn().mockRejectedValueOnce(required).mockResolvedValue({ message: 'ok' })
    let answer!: (accepted: boolean) => void
    const decision = new Promise<boolean>(resolve => { answer = resolve })
    const confirm = vi.fn(() => decision)
    const pending = saveWithModelConsent(save, {}, confirm)
    await Promise.resolve()
    expect(confirm).toHaveBeenCalledWith([warning])
    expect(save).toHaveBeenCalledTimes(1)
    answer(true)
    await expect(pending).resolves.toEqual({ message: 'ok' })
    expect(save).toHaveBeenCalledTimes(2)
  })
  it('does not treat an asynchronous dialog dismissal as consent', async () => {
    const save = vi.fn().mockRejectedValue(required)
    await expect(saveWithModelConsent(save, {}, async () => false)).rejects.toBe(required)
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('does not persist consent after declining', async () => {
    const save = vi.fn().mockRejectedValue(required)
    await expect(saveWithModelConsent(save, {}, () => false)).rejects.toBe(required)
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('does not endlessly ask or retry when the configuration changed during confirmation', async () => {
    const save = vi.fn().mockRejectedValue(required)
    const confirm = vi.fn().mockReturnValue(true)
    await expect(saveWithModelConsent(save, {}, confirm)).rejects.toBe(required)
    expect(save).toHaveBeenCalledTimes(2)
    expect(confirm).toHaveBeenCalledTimes(1)
  })
  it('does not turn unrelated errors into consent', async () => {
    const other = { status: 403, body: { error: 'forbidden' } }
    const save = vi.fn().mockRejectedValue(other)
    const confirm = vi.fn()
    await expect(saveWithModelConsent(save, {}, confirm)).rejects.toBe(other)
    expect(confirm).not.toHaveBeenCalled()
  })
})
