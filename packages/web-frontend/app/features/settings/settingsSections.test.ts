import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  SETTINGS_SECTIONS,
  findSection,
  groupSections,
  isRoutableSection,
  legacyTabRedirect,
  normalizeSearch,
  searchSettings,
  sectionPath,
  showsFormSave,
} from './settingsSections'

const locales = Object.fromEntries(['de', 'en'].map(code => [
  code,
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../i18n/locales/${code}.json`), 'utf-8')) as Record<string, unknown>,
]))
function translator(messages: Record<string, unknown>) {
  return (key: string) => {
    const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
    return typeof value === 'string' ? value : key
  }
}
const en = translator(locales.en!)
const de = translator(locales.de!)

/** Every tab id of the old single-page settings (origin/main before W5c). */
const OLD_TABS = ['agent', 'memory', 'agentHeartbeat', 'healthMonitor', 'models', 'telegram', 'tasks', 'tts', 'stt', 'secrets', 'secretHandles', 'email']

describe('settings sections: grouping', () => {
  it('splits the areas into everyday first, then system', () => {
    const groups = groupSections()
    expect(groups.map(group => group.id)).toEqual(['everyday', 'system'])
    expect(groups[0]!.sections.map(s => s.id)).toEqual(['appearance', 'now', 'capture', 'tts', 'stt'])
    expect(groups[1]!.sections.map(s => s.id)).toEqual([
      'agent', 'models', 'memory', 'agentHeartbeat', 'healthMonitor', 'tasks', 'telegram', 'email', 'secrets', 'secretHandles', 'logs', 'usage',
    ])
  })

  it('keeps every old tab as an area of its own', () => {
    for (const tab of OLD_TABS) expect(isRoutableSection(tab)).toBe(true)
  })

  it('has unique ids and a known group for every area', () => {
    const ids = SETTINGS_SECTIONS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const grouped = groupSections().flatMap(group => group.sections)
    expect(grouped).toHaveLength(SETTINGS_SECTIONS.length)
  })

  it.each(['de', 'en'])('has a label and description for every key in %s', (code) => {
    const t = translator(locales[code]!)
    const keys = SETTINGS_SECTIONS.flatMap(s => [s.labelKey, s.descriptionKey, ...s.fieldKeys])
    keys.push('settings.groups.everyday', 'settings.groups.system', 'settings.groups.everydayDescription', 'settings.groups.systemDescription')
    for (const key of keys) expect(t(key), key).not.toBe(key)
  })
})

describe('settings sections: routing', () => {
  it('maps areas onto /settings/<id> and link areas onto their page', () => {
    expect(sectionPath(findSection('memory')!)).toBe('/settings/memory')
    expect(sectionPath(findSection('logs')!)).toBe('/logs')
    expect(sectionPath(findSection('usage')!)).toBe('/usage')
    expect(isRoutableSection('logs')).toBe(false)
    expect(isRoutableSection('nope')).toBe(false)
    expect(isRoutableSection(null)).toBe(false)
  })

  it('redirects the old ?tab= deep links', () => {
    expect(legacyTabRedirect({ tab: 'agent' })).toBe('/settings/agent')
    expect(legacyTabRedirect({ tab: 'secretHandles' })).toBe('/settings/secretHandles')
    expect(legacyTabRedirect({ tab: ['tts', 'stt'] })).toBe('/settings/tts')
    expect(legacyTabRedirect({ tab: 'unknown' })).toBe('/settings')
    expect(legacyTabRedirect({ tab: 'logs' })).toBe('/settings')
    expect(legacyTabRedirect({})).toBeNull()
    expect(legacyTabRedirect({ tab: '' })).toBeNull()
  })

  it('shows the shared save button only on areas of the shared form', () => {
    for (const id of ['now', 'capture', 'tts', 'stt', 'agent', 'memory', 'agentHeartbeat', 'healthMonitor', 'tasks', 'telegram']) {
      expect(showsFormSave(id), id).toBe(true)
    }
    for (const id of ['appearance', 'models', 'email', 'secrets', 'secretHandles', 'logs', null, 'nope']) {
      expect(showsFormSave(id), String(id)).toBe(false)
    }
  })
})

describe('settings sections: search', () => {
  it('normalizes case, accents and whitespace', () => {
    expect(normalizeSearch('  Zeit  ZÓNE ')).toBe('zeit zone')
  })

  it('returns every area for an empty query', () => {
    expect(searchSettings('   ', en)).toHaveLength(SETTINGS_SECTIONS.length)
  })

  it('finds a setting by its name and names the match', () => {
    const hits = searchSettings('timezone', en)
    expect(hits.map(hit => hit.section.id)).toEqual(['agent'])
    expect(hits[0]!.matches).toEqual([en('settings.timezone')])
  })

  it('finds areas by their own name first', () => {
    const hits = searchSettings('memory', en)
    expect(hits[0]!.section.id).toBe('memory')
  })

  it('searches the German labels too', () => {
    expect(searchSettings('zeitzone', de).map(hit => hit.section.id)).toEqual(['agent'])
    expect(searchSettings('darstellung', de).map(hit => hit.section.id)).toContain('appearance')
  })

  it('requires every term (AND)', () => {
    expect(searchSettings('voice replies', en).map(hit => hit.section.id)).toEqual(['tts'])
    expect(searchSettings('timezone heartbeat', en)).toEqual([])
  })

  it('returns nothing for a term no setting has', () => {
    expect(searchSettings('qqqzzz', en)).toEqual([])
  })
})
