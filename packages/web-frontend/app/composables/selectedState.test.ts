import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The selected surface is a colour step only (< 3:1 against the ground), so
// every place that paints `bg-selected-container` also needs a second carrier
// that does not rely on colour: a 3 px marker, a check icon, a filled
// radio/checkbox or a heavier weight. The marker is a border, so it stays
// visible in forced-colors mode, where backgrounds and shadows are replaced.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('../assets/css/tailwind.css')

/** Every place with a selected surface and the second carrier it uses. */
const SITES: Array<[file: string, carrier: RegExp]> = [
  ['../components/ShellNavigation.vue', /selected-marker/],
  ['../components/CommandPalette.vue', /selected-marker/],
  ['../features/strands/StrandList.vue', /selected-marker/],
  ['../features/memory/components/MemoryFileTreeItem.vue', /selected-marker/],
  ['../components/ThreadRow.vue', /selected-marker/],
  ['../components/ModelPickerDialog.vue', /v-if="!pinned" name="check"/],
  ['../components/NewThreadDialog.vue', /persona === agentId \? 'check'/],
  ['../components/chat/ChatActionCard.vue', /pickerResolvedCommand" name="check"/],
  ['../components/ChatInteractionBlock.vue', /name="check"[\s\S]*multiOwnAnswer \? 'check'/],
  ['../pages/feed.vue', /persona === key" name="check"/],
  ['../features/settings/components/SettingsSectionNav.vue', /selected-marker/],
]

/** Pressed toggles that switch a view: in forced-colors mode the filled or tinted
 * surface is replaced, so the pressed one also carries the bottom border marker. */
const PRESSED: Array<[file: string, carrier: RegExp]> = [
  ['../features/strands/StrandList.vue', /state\.sort === sort \? 'selected-marker-bottom/],
  ['../features/projects/ProjectsView.vue', /:aria-pressed="!archived"[^>]*!archived \? 'selected-marker-bottom'[\s\S]*:aria-pressed="archived"[^>]*archived \? 'selected-marker-bottom'/],
  ['../pages/strands/[id].vue', /contextOpen \? 'selected-marker-bottom/],
]

function block(name: string) {
  const start = css.indexOf(`@utility ${name} {`)
  return start < 0 ? '' : css.slice(start, css.indexOf('\n}\n', start))
}

describe('selected state, second carrier', () => {
  it('covers every file that paints the selected surface', () => {
    for (const [file, carrier] of SITES) {
      const source = read(file)
      expect(source, file).toContain('bg-selected-container')
      expect(source, file).toMatch(carrier)
    }
  })
  it('marks pressed view toggles with a border marker', () => {
    for (const [file, carrier] of PRESSED) expect(read(file), file).toMatch(carrier)
  })
  it('draws the marker as a border, not as a background or shadow', () => {
    for (const name of ['selected-marker', 'selected-marker-top', 'selected-marker-bottom']) {
      const rule = block(name)
      expect(rule, name).toMatch(/border-(left|top|bottom): 3px solid hsl\(var\(--primary\)\)/)
      expect(rule, name).not.toMatch(/background|box-shadow/)
      expect(rule, name).toMatch(/@media \(forced-colors: active\)[\s\S]*border-color: Highlight/)
    }
  })
  it('marks the active tab with a border marker, not only with a lighter surface', () => {
    expect(read('../components/ui/TabsTrigger.vue')).toContain('data-[state=active]:selected-marker-bottom')
  })
  it('keeps the marker clear of an inset focus ring', () => {
    expect(block('selected-marker-inset')).toMatch(/left: 4px/)
    for (const file of ['../features/memory/components/MemoryFileTreeItem.vue', '../features/strands/StrandList.vue']) {
      const source = read(file)
      expect(source, file).toContain('focus-visible:ring-inset')
      expect(source, file).toContain('selected-marker selected-marker-inset')
    }
  })
  it('keeps no background-painted markers in the components', () => {
    for (const [file] of SITES) expect(read(file), file).not.toMatch(/before:bg-primary/)
  })
})
