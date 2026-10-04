import { readdirSync, readFileSync } from 'node:fs'
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
    // W12: a locked tab is aria-disabled (stays focusable), so the look hangs on that state.
    ['TabsTrigger.vue', /aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground/],
    ['Label.vue', /peer-disabled:text-muted-foreground/],
  ]
  for (const [file, re] of cases) {
    it(`${file} changes token instead of opacity`, () => {
      const src = read(file)
      expect(src).toMatch(re)
      expect(src).not.toMatch(/(disabled|disabled\]):opacity-/)
      // W11: a locked element is never struck through (reads as "deleted").
      expect(src).not.toMatch(/line-through/)
    })
  }
})

// W12: a strike-through never tells a state anywhere in the product (it reads
// as "deleted" and is hard to read). Removed entries are secondary text plus
// an icon plus the word "removed" plus an action to clear them.
describe('no strike-through as a state sign', () => {
  const root = new URL('../../', import.meta.url)
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name === 'node_modules' || d.name.startsWith('.')) return []
    const url = new URL(d.name + (d.isDirectory() ? '/' : ''), dir)
    return d.isDirectory() ? walk(url) : /\.(vue|css)$/.test(d.name) ? [url] : []
  })
  const files = walk(root)
  it('finds the product sources', () => {
    expect(files.length).toBeGreaterThan(50)
  })
  it('no template or stylesheet strikes text through', () => {
    const hits = files.filter(f => /line-through|<(s|del|strike)>/.test(readFileSync(f, 'utf8'))).map(f => f.pathname.slice(root.pathname.length))
    expect(hits).toEqual([])
  })
  it('the cronjob dialog marks removed overrides with icon, word and a clear action', () => {
    const src = readFileSync(new URL('components/CronjobFormDialog.vue', root), 'utf8')
    const rows = src.split('data-stale-override').slice(1)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const body = row.slice(0, row.indexOf('</div>'))
      expect(body).toMatch(/text-muted-foreground/)
      expect(body).toMatch(/<AppIcon name="archive"/)
      expect(body).toMatch(/\$t\('cronjobs\.form\.staleRemoved'\)/)
      expect(body).toMatch(/<Button[^>]*@click="toggle(Tool|Skill)\((tool|skill), true\)"/)
    }
  })
})
