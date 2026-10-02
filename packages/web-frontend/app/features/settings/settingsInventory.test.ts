/**
 * Nothing of the old settings may get lost in the W5c split: every control of
 * the inventory must exist, in the area the inventory says, with the same
 * binding (= same field of the PUT /api/settings payload or same handler).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  SETTINGS_ADDED,
  SETTINGS_INVENTORY,
  SETTINGS_PANELS,
  checkInventory,
  extractSectionControls,
  sectionOfTag,
} from './settingsInventory'
import { findSection, isRoutableSection } from './settingsSections'

const dir = path.resolve(__dirname, 'components')
const workspace = fs.readFileSync(path.join(dir, 'SettingsWorkspace.vue'), 'utf-8')

describe('settings inventory', () => {
  it('lists every control of the old tabs (84 controls)', () => {
    expect(SETTINGS_INVENTORY).toHaveLength(84)
    const fields = SETTINGS_INVENTORY.map(row => row.field)
    expect(new Set(fields).size).toBe(fields.length)
  })

  it('maps every control onto an existing area', () => {
    for (const row of SETTINGS_INVENTORY) expect(isRoutableSection(row.after), row.field).toBe(true)
  })

  it('finds every control in its new area with the same binding, and nothing unlisted', () => {
    const result = checkInventory(SETTINGS_INVENTORY, extractSectionControls(workspace))
    expect(result.missing).toEqual([])
    expect(result.moved).toEqual([])
    expect(result.unknown).toEqual([])
  })

  it('moves only Now and Capture fields out of the agent area', () => {
    const moved = SETTINGS_INVENTORY.filter(row => row.before !== row.after)
    expect(moved.map(row => `${row.field}:${row.after}`)).toEqual([
      'now-set-max:now', 'now-set-mode:now', 'attention-max-age:now',
      'quick-mode-model:capture', 'quick-mode-thinking:capture', 'quick-mode-style:capture', 'quick-mode-strand:capture', 'capture-source-puck:capture',
    ])
    for (const row of moved) expect(row.before).toBe('agent')
  })

  it('keeps every embedded panel in its area', () => {
    for (const panel of SETTINGS_PANELS) expect(sectionOfTag(workspace, panel.tag), panel.tag).toBe(panel.after)
  })

  it('embeds the added controls where the inventory says', () => {
    expect(sectionOfTag(workspace, 'SettingsVoiceReplies')).toBe('tts')
    expect(workspace).toMatch(/<SettingsAppearance v-else-if="activeSection === 'appearance'"/)
    for (const added of SETTINGS_ADDED) {
      const component = fs.readFileSync(path.join(dir, `${added.component}.vue`), 'utf-8')
      expect(component, added.field).toMatch(new RegExp(`(id|name)="${added.field}"`))
      if (added.area !== 'overview') expect(findSection(added.area), added.area).not.toBeNull()
    }
  })

  it('detects a removed control', () => {
    const broken = workspace.replace('id="now-set-max"', 'id="gone"')
    const result = checkInventory(SETTINGS_INVENTORY, extractSectionControls(broken))
    expect(result.missing.map(row => row.field)).toEqual(['now-set-max'])
    expect(result.unknown.map(control => control.id)).toEqual(['gone'])
  })

  it('detects a control moved into another area', () => {
    expect(extractSectionControls(workspace).find(control => control.id === 'session-timeout')?.section).toBe('memory')
    const controls = extractSectionControls(workspace).map(control =>
      control.id === 'session-timeout' ? { ...control, section: 'agent' } : control)
    expect(checkInventory(SETTINGS_INVENTORY, controls).moved).toHaveLength(1)
  })
})
