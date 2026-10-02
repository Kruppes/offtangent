import { describe, expect, it } from 'vitest'
import { formSnapshot, isFormDirty } from './settingsDirty'

describe('settings dirty check', () => {
  const form = { language: 'en', tts: { enabled: true, voice: 'one' }, list: [1, 2] }

  it('is clean right after the snapshot', () => {
    expect(isFormDirty(formSnapshot(form), structuredClone(form))).toBe(false)
  })

  it('ignores key order', () => {
    expect(isFormDirty(formSnapshot(form), { list: [1, 2], tts: { voice: 'one', enabled: true }, language: 'en' })).toBe(false)
  })

  it('sees a nested change', () => {
    expect(isFormDirty(formSnapshot(form), { ...form, tts: { ...form.tts, enabled: false } })).toBe(true)
  })

  it('sees an array change', () => {
    expect(isFormDirty(formSnapshot(form), { ...form, list: [2, 1] })).toBe(true)
  })

  it('is never dirty without a baseline or a form', () => {
    expect(isFormDirty(null, form)).toBe(false)
    expect(isFormDirty(formSnapshot(form), null)).toBe(false)
  })
})
