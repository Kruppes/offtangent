import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Disabled controls must look different from their active state through
// tokens alone (surface N2 `muted`, text N4 `muted-foreground`, icon N3
// `border`), never through opacity. The test resolves the colour roles a
// control paints when active and when disabled and requires them to differ.
const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

type Look = { bg: string, text: string, icon: string }
function look(classes: string, prefix: string | null): Look {
  const list = classes.split(/\s+/).filter(Boolean)
  const plain = (re: RegExp, fallback: string) => list.filter(c => !c.includes(':')).reduce((v, c) => c.match(re)?.[1] ?? v, fallback)
  const scoped = (re: RegExp) => prefix ? list.filter(c => c.startsWith(prefix)).reduce<string | null>((v, c) => c.slice(prefix.length).match(re)?.[1] ?? v, null) : null
  const bg = scoped(/^bg-([\w-]+)$/) ?? plain(/^bg-([\w-]+)$/, 'transparent')
  const text = scoped(/^text-([a-z][\w-]*)$/) ?? plain(/^text-((?!xs|sm|base|lg|xl|left|right|center)[a-z][\w-]*)$/, 'inherit')
  const icon = scoped(/^\[&_svg\]:text-([\w-]+)$/) ?? text
  return { bg, text, icon }
}

const button = read('Button.vue')
const base = button.match(/cva\(\s*'([^']+)'/)![1]!
const variantBlock = button.slice(button.indexOf('variant: {'), button.indexOf('size: {'))
const variants = Object.fromEntries([...variantBlock.matchAll(/^\s+(\w+): '([^']*)',?$/gm)]
  .filter(m => ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'].includes(m[1]!))
  .map(m => [m[1]!, m[2]!]))

describe('base button disabled state', () => {
  it('declares every variant', () => {
    expect(Object.keys(variants).sort()).toEqual(['default', 'destructive', 'ghost', 'link', 'outline', 'secondary'])
  })

  it('does not fade with opacity', () => {
    expect(base).not.toMatch(/disabled:opacity/)
    for (const v of Object.values(variants)) expect(v).not.toMatch(/opacity/)
  })

  for (const name of ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']) {
    it(`${name}: disabled differs from active in token colours`, () => {
      const classes = `${base} ${variants[name]}`
      const active = look(classes, null)
      const disabled = look(classes, 'disabled:')
      expect(disabled).not.toEqual(active)
      // Disabled text is the secondary-text step N4, the icon the line step N3.
      expect(disabled.text).toBe('muted-foreground')
      expect(disabled.icon).toBe('border')
      // Filled and outlined buttons also drop to the N2 surface.
      if (!['ghost', 'link'].includes(name)) expect(disabled.bg).toBe('muted')
    })
  }
})

describe('form controls disabled state', () => {
  const cases: Array<[string, RegExp]> = [
    ['Input.vue', /disabled:bg-muted disabled:text-muted-foreground/],
    ['SelectTrigger.vue', /disabled:bg-muted disabled:text-muted-foreground/],
    ['Switch.vue', /disabled:data-\[state=checked\]:bg-muted disabled:data-\[state=unchecked\]:bg-muted/],
    ['DropdownMenuItem.vue', /data-\[disabled\]:text-muted-foreground data-\[disabled\]:\[&_svg\]:text-border/],
    ['SelectItem.vue', /data-\[disabled\]:text-muted-foreground data-\[disabled\]:\[&_svg\]:text-border/],
    ['TabsTrigger.vue', /disabled:text-muted-foreground disabled:line-through/],
    ['Label.vue', /peer-disabled:text-muted-foreground/],
  ]
  for (const [file, re] of cases) {
    it(`${file} changes token instead of opacity`, () => {
      const src = read(file)
      expect(src).toMatch(re)
      expect(src).not.toMatch(/(disabled|disabled\]):opacity-/)
    })
  }
})
