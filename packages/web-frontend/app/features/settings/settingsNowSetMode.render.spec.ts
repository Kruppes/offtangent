/**
 * The now-set mode control in the settings dialog.
 *
 * SettingsWorkspace.vue is too large to mount in this harness (it pulls the
 * whole settings composable chain), so this spec checks the two things that
 * actually break in practice: the control is wired to
 * `form.offtangent.nowSetMode`, and every mode the contract knows has a label
 * in BOTH locales. A missing translation would otherwise ship as a raw key.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { NOW_SET_MODES } from '@axiom/core/contracts'

const appDir = path.resolve(__dirname, '../..')
const workspace = fs.readFileSync(path.join(appDir, 'features/settings/components/SettingsWorkspace.vue'), 'utf-8')
const locales = Object.fromEntries(['de', 'en'].map(code => [
  code,
  JSON.parse(fs.readFileSync(path.join(appDir, `i18n/locales/${code}.json`), 'utf-8')) as Record<string, Record<string, unknown>>,
]))

describe('settings: now set mode', () => {
  it('binds a select to offtangent.nowSetMode next to the size field', () => {
    expect(workspace).toContain('v-model="form.offtangent.nowSetMode"')
    expect(workspace).toContain('id="now-set-mode"')
    expect(workspace).toContain("$t('settings.nowSetMode')")
    expect(workspace).toContain("$t('settings.nowSetModeHint')")
    // The options come from the contract, not from a hand-written list.
    expect(workspace).toContain('NOW_SET_MODES.map')
    // The size field is still there — the mode is an addition, not a swap.
    expect(workspace).toContain('form.offtangent.nowSetMax')
  })

  it.each(['de', 'en'])('has label, hint and one option label per mode in %s', (code) => {
    const settings = locales[code]!.settings as Record<string, unknown>
    expect(typeof settings.nowSetMode).toBe('string')
    expect(typeof settings.nowSetModeHint).toBe('string')
    const options = settings.nowSetModeOptions as Record<string, string>
    expect(Object.keys(options).sort()).toEqual([...NOW_SET_MODES].sort())
    for (const mode of NOW_SET_MODES) expect(options[mode]!.length).toBeGreaterThan(3)
  })

  it.each(['de', 'en'])('has the auto hint for the home screen in %s', (code) => {
    const capture = locales[code]!.capture as Record<string, unknown>
    expect(typeof capture.nowAutoHint).toBe('string')
    expect((capture.nowAutoHint as string).length).toBeGreaterThan(20)
  })
})
