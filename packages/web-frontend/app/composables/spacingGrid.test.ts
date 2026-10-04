import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// W12: every padding, margin, gap and inset sits on the 4 px grid, and a box with
// a border counts the border into its padding. The rendered result (off-grid
// values per viewport, listed stroke exceptions) is measured by the full-route
// browser audit; this guard keeps the CSS and class contract in place.
const appDir = new URL('..', import.meta.url).pathname
const css = readFileSync(join(appDir, 'assets/css/tailwind.css'), 'utf8')

function vueFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...vueFiles(p)) }
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}
const sources = vueFiles(appDir).map(p => ({ p: p.slice(appDir.length), src: readFileSync(p, 'utf8') }))

describe('4 px spacing grid', () => {
  it('records the border width per side and subtracts it in the padding utilities', () => {
    for (const side of ['t', 'r', 'b', 'l']) expect(css).toContain(`@property --bw-${side} { syntax: "<length>"; inherits: false; initial-value: 0px; }`)
    expect(css).toMatch(/@utility border \{ --bw-t: 1px; --bw-r: 1px; --bw-b: 1px; --bw-l: 1px; \}/)
    expect(css).toMatch(/@utility p-\* \{[^}]*padding-top: max\(0px, calc\(var\(--spacing\) \* --value\(number\) - var\(--bw-t\)\)\)/s)
    expect(css).toMatch(/@utility px-\* \{[^}]*var\(--bw-l\)/s)
    expect(css).toMatch(/@utility py-\* \{[^}]*var\(--bw-b\)/s)
  })

  it('uses no half-step spacing utilities (2 px gaps only in tightly coupled groups)', () => {
    // 6, 10, 14, 22 and 30 px steps; `gap-0.5` (2 px) stays allowed for icon + badge and segmented controls.
    const half = /(^|[\s"'`:])-?(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y|top|right|bottom|left|inset|inset-x|inset-y)-(1\.5|2\.5|3\.5|5\.5|7\.5)(?=[\s"'`])/m
    const hits = sources.filter(s => half.test(s.src)).map(s => s.p)
    expect(hits).toEqual([])
  })

  it('sets text line heights in multiples of 4 px, not the off-grid leading presets', () => {
    // leading-tight/snug/normal/relaxed resolve to 17.5 / 19.25 / 21 / 22.75 px at 14 px.
    const preset = /(^|[\s"'`:\]])leading-(tight|snug|normal|relaxed)(?=[\s"'`])/m
    expect(sources.filter(s => preset.test(s.src)).map(s => s.p)).toEqual([])
    expect(css).not.toMatch(/line-height: 1\.4444;/)
  })

  it('keeps the bordered prose blocks on the grid (table cells, quotes)', () => {
    expect(css).toMatch(/padding: 0\.5rem 0\.75rem calc\(0\.5rem - 1px\);/)
    expect(css).toMatch(/padding-left: calc\(1rem - 3px\);/)
  })
})
