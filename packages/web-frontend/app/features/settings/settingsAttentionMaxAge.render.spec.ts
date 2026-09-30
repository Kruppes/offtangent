/**
 * The "waiting on you" age limit field in the settings dialog
 * (`offtangent.attentionMaxAgeHours`).
 *
 * SettingsWorkspace.vue is too large to mount in this harness (it pulls the
 * whole settings composable chain), so this spec checks the things that break
 * in practice: the input is wired to the form field, it carries the range the
 * contract defines instead of a hand-written one, an invalid value has a
 * visible error state, and label, hint and error message exist in BOTH locales
 * — a missing translation would otherwise ship as a raw key.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ATTENTION_MAX_AGE_HOURS_RANGE, DEFAULT_ATTENTION_MAX_AGE_HOURS } from '@axiom/core/contracts'

const appDir = path.resolve(__dirname, '../..')
const workspace = fs.readFileSync(path.join(appDir, 'features/settings/components/SettingsWorkspace.vue'), 'utf-8')
const locales = Object.fromEntries(['de', 'en'].map(code => [
  code,
  JSON.parse(fs.readFileSync(path.join(appDir, `i18n/locales/${code}.json`), 'utf-8')) as Record<string, Record<string, unknown>>,
]))

describe('settings: "waiting on you" age limit', () => {
  it('binds a number input to offtangent.attentionMaxAgeHours', () => {
    expect(workspace).toContain('v-model.number="form.offtangent.attentionMaxAgeHours"')
    expect(workspace).toContain('id="attention-max-age"')
    expect(workspace).toContain('<Label for="attention-max-age">')
    expect(workspace).toContain("$t('settings.attentionMaxAge')")
    expect(workspace).toContain("$t('settings.attentionMaxAgeHint'")
  })

  it('takes min and max from the contract, not from a literal', () => {
    expect(workspace).toContain(':min="ATTENTION_MAX_AGE_HOURS_RANGE.min"')
    expect(workspace).toContain(':max="ATTENTION_MAX_AGE_HOURS_RANGE.max"')
    expect(workspace).toContain('ATTENTION_MAX_AGE_HOURS_RANGE')
  })

  it('shows an error state for an invalid value and refuses to save it', () => {
    expect(workspace).toContain('const attentionMaxAgeInvalid = computed(')
    expect(workspace).toContain('v-if="attentionMaxAgeInvalid"')
    expect(workspace).toContain('text-destructive')
    expect(workspace).toContain('if (attentionMaxAgeInvalid.value) {')
    expect(workspace).toContain(":aria-invalid=\"attentionMaxAgeInvalid || undefined\"")
  })

  it.each(['de', 'en'])('has label, unit, hint and error text in %s', (code) => {
    const settings = locales[code]!.settings as Record<string, unknown>
    for (const key of [
      'attentionSection',
      'attentionSectionDescription',
      'attentionMaxAge',
      'attentionMaxAgeUnit',
      'attentionMaxAgeHint',
      'attentionMaxAgeInvalid',
    ]) {
      expect(typeof settings[key], `${code}.settings.${key}`).toBe('string')
      expect((settings[key] as string).length).toBeGreaterThan(3)
    }
    // The hint explains both halves of the rule and is parameterised with the range.
    const hint = settings.attentionMaxAgeHint as string
    expect(hint).toContain('{min}')
    expect(hint).toContain('{max}')
    expect(hint.length).toBeGreaterThan(80)
    expect(settings.attentionMaxAgeInvalid as string).toContain('{min}')
  })

  it('documents the same range the backend validates', () => {
    expect(ATTENTION_MAX_AGE_HOURS_RANGE).toEqual({ min: 1, max: 720 })
    expect(DEFAULT_ATTENTION_MAX_AGE_HOURS).toBe(48)
  })
})
