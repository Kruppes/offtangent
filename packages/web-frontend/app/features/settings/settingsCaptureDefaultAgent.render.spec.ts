/**
 * The capture default persona (W6b, `capture.defaultAgentId`) in /settings.
 *
 * SettingsWorkspace.vue is too large to mount in this harness, so this spec
 * pins the form contract the way the other settings specs do: the control is
 * named, bound to `form.capture.defaultAgentId`, offers `auto` plus the
 * persona list, hydrates from the server value and is part of what `save()`
 * sends (the payload spreads the whole form). Labels exist in both locales.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const appDir = path.resolve(__dirname, '../..')
const workspace = fs.readFileSync(path.join(appDir, 'features/settings/components/SettingsWorkspace.vue'), 'utf-8')
const locales = Object.fromEntries(['de', 'en'].map(code => [
  code,
  JSON.parse(fs.readFileSync(path.join(appDir, `i18n/locales/${code}.json`), 'utf-8')) as Record<string, Record<string, unknown>>,
]))

describe('settings: capture default persona', () => {
  it('names and binds the select to capture.defaultAgentId inside the capture area', () => {
    expect(workspace).toContain('<Select v-model="form.capture.defaultAgentId" name="capture-default-agent">')
    expect(workspace).toContain('<SelectTrigger id="capture-default-agent">')
    expect(workspace).toContain('<SelectItem value="auto">')
    expect(workspace).toContain('v-for="p in capturePersonaOptions"')
    const area = workspace.indexOf("activeSection === 'capture'")
    const control = workspace.indexOf('id="capture-default-agent"')
    const next = workspace.indexOf("activeSection === 'memory'")
    expect(area).toBeGreaterThan(0)
    expect(control).toBeGreaterThan(area)
    expect(control).toBeLessThan(next)
  })

  it('hydrates from the server value and sends the form value on save', () => {
    expect(workspace).toContain("capture: { defaultAgentId: s.capture?.defaultAgentId ?? 'auto' },")
    // save() sends the whole form: the capture block travels with it.
    expect(workspace).toMatch(/const payload = \{\s*\.\.\.form\.value,/)
    expect(workspace).toMatch(/capture: CaptureSettings\n\}/)
  })

  it.each(['de', 'en'])('has label, auto option and hint in %s', (code) => {
    const settings = locales[code]!.settings as Record<string, unknown>
    for (const key of ['captureDefaultAgent', 'captureDefaultAgentAuto', 'captureDefaultAgentHint']) {
      expect(typeof settings[key], key).toBe('string')
      expect((settings[key] as string).length, key).toBeGreaterThan(5)
    }
  })
})
