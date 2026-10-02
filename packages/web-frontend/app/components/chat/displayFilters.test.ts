import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Display-filter panel contract (W6c C). The browser measurement found the
// switch of "Sitzungszusammenfassungen" 6.9 px outside the 256 px panel (de,
// every width) and a 60-char label pushing all switches out: the panel had a
// fixed w-64 and the labels could not shrink (flex min-width auto). These
// tests keep the fix in the markup; the pixel check is cd.cjs (Playwright).
const text = readFileSync(new URL('./ChatToolbar.vue', import.meta.url), 'utf8')
const template = text.slice(text.indexOf('<template>'), text.lastIndexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '')
const panel = template.slice(template.indexOf('<PopoverContent'), template.indexOf('</PopoverContent>'))
const cls = (tag: string) => tag.match(/\sclass="([^"]*)"/)?.[1]?.split(/\s+/) ?? []

describe('display filter panel', () => {
  it('sizes to its content, capped at the viewport minus a margin, never off-screen', () => {
    const open = panel.slice(0, panel.indexOf('>') + 1)
    expect(cls(open)).toEqual(expect.arrayContaining(['w-max', 'min-w-64']))
    expect(cls(open).some(c => /^max-w-\[min\(.*calc\(100vw-/.test(c))).toBe(true)
    expect(open).toMatch(/:collision-padding="8"/)
    expect(cls(open)).not.toContain('w-64')
  })

  it('every row wraps its label, keeps the switch whole and right, and is a 44 px target below md', () => {
    const rows = panel.split('<div data-filter-row').slice(1)
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      const rowClass = cls(row.slice(0, row.indexOf('>') + 1))
      expect(rowClass).toEqual(expect.arrayContaining(['flex', 'justify-between', 'min-h-11']))
      const label = row.match(/<Label[^>]*>/)![0]
      expect(cls(label)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', '[overflow-wrap:anywhere]']))
      expect(cls(label)).not.toContain('truncate')
      const sw = row.match(/<Switch[^>]*>/)![0]
      expect(cls(sw)).toContain('shrink-0')
    }
  })
})
