import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// W11: on touch-primary devices every control gets a hit box of at least
// 44 x 44 px without changing its look. The rendered result (count of targets
// under 44 px per viewport, overlaps of neighbouring hit boxes) is measured by
// the full-route browser audit; this guard keeps the CSS contract in place.
const css = readFileSync(new URL('../assets/css/tailwind.css', import.meta.url), 'utf8')
const start = css.indexOf('@media (pointer: coarse) {')
const block = start < 0 ? '' : css.slice(start, css.indexOf('\n  }\n}', start))

describe('touch target contract', () => {
  it('scopes the hit boxes to coarse pointers, not to a width', () => {
    expect(start).toBeGreaterThan(0)
  })
  it('extends controls with a centred, invisible pseudo element of at least 44 px', () => {
    expect(block).toMatch(/::after \{[^}]*content: '';[^}]*position: absolute;[^}]*width: max\(100%, 44px\);[^}]*height: max\(100%, 44px\);[^}]*transform: translate\(-50%, -50%\);/s)
    // Invisible: no background, border, shadow or outline on the hit box.
    expect(block).not.toMatch(/::after \{[^}]*(background|border|box-shadow|outline)/s)
  })
  it('covers buttons, tabs, menu items, options and block links, not inline text links', () => {
    for (const target of ['button', "[role='button']", "[role='tab']", "[role='menuitem']", "[role='option']", "a[href][class*='flex']"]) expect(block).toContain(target)
    expect(block).not.toMatch(/(^|[\s,(])a\[href\](?!\[class)/)
  })
  it('leaves positioned elements and existing ::after users alone', () => {
    expect(block).toContain(":not([class*='after:'])")
    expect(block).toContain(':not(.absolute, .fixed, .sticky, .sr-only)')
  })
  it('gives text fields and selects the 44 px phone height', () => {
    expect(block).toMatch(/select\) \{\s*min-height: 44px;/)
  })
})
