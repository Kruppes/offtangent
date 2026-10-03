import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// W10: the primary and Telegram tints are opaque tokens. An alpha variant
// (`bg-primary/10`, `border-telegram/30`, `hsl(var(--primary) / .4)`) turns
// into a different colour on every surface below it (dark: #152323 on N0,
// #1C2C2D on N1; light: primary/10 on N0 lands on N2, so an active item looked
// like the grey hover). So the web source may only use the opaque tokens:
// primary, primary-hover, primary-subtle, primary-subtle-hover,
// primary-container, telegram, telegram-subtle.
const root = new URL('..', import.meta.url).pathname
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path)
    if (!/\.(vue|ts|css)$/.test(name) || /\.(test|spec)\.ts$/.test(name)) return []
    return [path]
  })
}
const sources = files(root).map(path => ({ path: path.slice(root.length), text: readFileSync(path, 'utf8') }))

// Overlays over photos or images may keep a translucent primary/telegram tone.
// Every exception is listed here with its exact match; there is none today.
const PHOTO_OVERLAY_EXCEPTIONS: string[] = []

const CHROMA = '(?:on-)?(?:primary|telegram|ring)(?:-[a-z]+)*'
// utility (with variants) + token + /alpha: `hover:bg-primary/15`, `ring-ring/50`, `border-t-telegram/[0.3]`
const alphaClass = new RegExp(`(?<![\\w-])(?:[\\w-]+:)*[a-z]+(?:-[a-z]+)*?-${CHROMA}\\/(?:\\d+|\\[[^\\]]+\\])(?![\\w-])`, 'g')
const alphaCss = new RegExp(`(?:hsla?|rgba?)\\(\\s*var\\(--(?:color-)?${CHROMA}\\)\\s*[/,]`, 'g')
const colorMix = new RegExp(`color-mix\\([^;]*--(?:color-)?${CHROMA}`, 'g')
const alphaFn = new RegExp(`--alpha\\(\\s*var\\(--(?:color-)?${CHROMA}`, 'g')
// A primary/telegram fill faded by opacity is an alpha tint as well.
const fadedFill = /["'`][^"'`\n]*?\bbg-(?:primary|telegram)[\w-]*[^"'`\n]*?(?<![\w-])(?:[\w-]+:)*opacity-(?:[0-9]{1,2}|\[[^\]]+\])(?![\w-])[^"'`\n]*["'`]/g

function hits(re: RegExp) {
  return sources.flatMap(({ path, text }) => [...text.matchAll(re)].map(m => `${path}: ${m[0].trim().slice(0, 120)}`))
    .filter(hit => !PHOTO_OVERLAY_EXCEPTIONS.includes(hit))
}

describe('primary / telegram tint guard', () => {
  it('scans the web source', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('has no alpha variant of a primary or telegram class', () => {
    expect(hits(alphaClass)).toEqual([])
  })

  it('has no translucent primary or telegram colour in CSS', () => {
    expect(hits(alphaCss)).toEqual([])
    expect(hits(colorMix)).toEqual([])
    expect(hits(alphaFn)).toEqual([])
  })

  it('never fades a primary or telegram fill with opacity', () => {
    expect(hits(fadedFill)).toEqual([])
  })

  it('lists only exceptions that still exist', () => {
    const all = [alphaClass, alphaCss, colorMix, alphaFn].flatMap(re =>
      sources.flatMap(({ path, text }) => [...text.matchAll(re)].map(m => `${path}: ${m[0].trim().slice(0, 120)}`)))
    for (const exception of PHOTO_OVERLAY_EXCEPTIONS) expect(all).toContain(exception)
  })

  it('catches the banned forms (self-check)', () => {
    const banned = 'bg-primary/10 hover:bg-primary/15 dark:bg-primary/[0.08] border-telegram/30 bg-telegram/10 ring-primary/30 ring-ring/50 border-primary-foreground/30 text-primary/80 bg-primary-subtle/50 text-on-primary-container/70 decoration-primary/40'
    expect(banned.match(alphaClass)).toHaveLength(12)
    expect('bg-primary bg-primary-subtle hover:bg-primary-subtle-hover hover:bg-primary-hover bg-telegram-subtle ring-primary border-primary w-1/2 bg-muted/30 ring-warning/30'.match(alphaClass)).toBeNull()
    expect('outline: 2px solid hsl(var(--primary) / 0.6); color: hsl(var(--telegram) / .1); x: rgba(var(--ring), .5)'.match(alphaCss)).toHaveLength(3)
    expect('outline: 2px solid hsl(var(--primary)); color: hsl(var(--telegram-subtle))'.match(alphaCss)).toBeNull()
    expect('background: color-mix(in oklab, var(--color-primary) 10%, transparent)'.match(colorMix)).toHaveLength(1)
    expect('color: --alpha(var(--color-telegram) / 20%)'.match(alphaFn)).toHaveLength(1)
    expect(`class="bg-primary group-hover:opacity-80"`.match(fadedFill)).toHaveLength(1)
    expect(`class="bg-primary opacity-100" :class="'bg-muted opacity-50'"`.match(fadedFill)).toBeNull()
  })
})

// The opaque tints, per theme: built in OKLCH at N1/N2 lightness with the hue
// of the primary (Telegram) colour and enough chroma to read as colour on N0
// and N1, not as grey.
const css = readFileSync(new URL('../assets/css/tailwind.css', import.meta.url), 'utf8')
function block(selector: string) {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block in tailwind.css`)
  return new Map([...css.slice(start).split('}')[0]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]))
}
const DARK = ':root,\n.dark'
const LIGHT = ':root.light'
function palette(selector: string) {
  const vars = new Map([...block(DARK), ...(selector === LIGHT ? block(LIGHT) : [])])
  function rgb(name: string): number[] {
    const value = vars.get(name)
    if (!value) throw new Error(`--${name} missing`)
    if (value.startsWith('var(')) return rgb(value.slice(6, -1))
    const [h, s, l] = value.split(' ').map(Number.parseFloat) as [number, number, number]
    const a = s / 100 * Math.min(l / 100, 1 - l / 100)
    return [0, 8, 4].map(n => {
      const k = (n + h / 30) % 12
      return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
    })
  }
  const linear = (name: string) => rgb(name).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const hex = (name: string) => '#' + rgb(name).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  const luminance = (name: string) => linear(name).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
  function contrast(a: string, b: string) {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (values[0]! + 0.05) / (values[1]! + 0.05)
  }
  function oklab(name: string) {
    const [r, g, b] = linear(name) as [number, number, number]
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s] as const
  }
  const deltaE = (a: string, b: string) => { const p = oklab(a), q = oklab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }
  const chroma = (name: string) => { const [, a, b] = oklab(name); return Math.hypot(a, b) }
  const hue = (name: string) => { const [, a, b] = oklab(name); return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360 }
  return { hex, contrast, deltaE, chroma, hue, oklab }
}

describe.each([
  ['dark', DARK, { 'primary-subtle': '#04332C', 'primary-subtle-hover': '#043F36', 'primary-hover': '#60C6B2', 'telegram-subtle': '#052F45' }],
  ['light', LIGHT, { 'primary-subtle': '#C1F2ED', 'primary-subtle-hover': '#ADE8E3', 'primary-hover': '#28504D', 'telegram-subtle': '#C8E8FE' }],
])('%s opaque tint tokens', (_theme, selector, expected) => {
  const p = palette(selector)
  it('round-trips the HSL triplets to the documented hex values', () => {
    for (const [name, value] of Object.entries(expected)) expect(p.hex(name)).toBe(value)
  })
  it.each(['primary-subtle', 'primary-subtle-hover', 'telegram-subtle'])('primary text and N5 text on %s meet 4.5:1', (surface) => {
    expect(p.contrast('primary', surface)).toBeGreaterThanOrEqual(4.5)
    expect(p.contrast('n5', surface)).toBeGreaterThanOrEqual(4.5)
  })
  it('keeps the on-primary text at 4.5:1 on the filled hover', () => {
    expect(p.contrast('primary-foreground', 'primary-hover')).toBeGreaterThanOrEqual(4.5)
  })
  it('reads as colour, not as the grey hover surface N2', () => {
    // Floor 0.04; target for new chroma tokens is dE >= 0.045 against N2, so
    // rounding, display profiles and small L tweaks keep them above the floor.
    for (const surface of ['primary-subtle', 'primary-subtle-hover', 'telegram-subtle']) {
      expect(p.deltaE(surface, 'n2')).toBeGreaterThanOrEqual(0.04)
      expect(p.deltaE(surface, 'n1')).toBeGreaterThanOrEqual(0.05)
      expect(p.chroma(surface)).toBeGreaterThanOrEqual(0.04)
    }
    expect(p.deltaE('primary-subtle', 'primary-subtle-hover')).toBeGreaterThanOrEqual(0.03)
  })
  it('keeps the Telegram bubble at the 0.045 target distance from N2', () => {
    expect(p.deltaE('telegram-subtle', 'n2')).toBeGreaterThanOrEqual(0.045)
  })
  it('keeps the hue of its source colour', () => {
    for (const name of ['primary-subtle', 'primary-subtle-hover', 'primary-hover']) expect(Math.abs(p.hue(name) - p.hue('primary'))).toBeLessThan(12)
    expect(Math.abs(p.hue('telegram-subtle') - p.hue('telegram'))).toBeLessThan(12)
  })
  it('sits at the lightness of the N1/N2 surfaces', () => {
    for (const name of ['primary-subtle', 'telegram-subtle']) {
      const [l] = p.oklab(name), [l1] = p.oklab('n1'), [l2] = p.oklab('n2')
      expect(l).toBeGreaterThanOrEqual(Math.min(l1, l2) - 0.02)
      expect(l).toBeLessThanOrEqual(Math.max(l1, l2) + 0.02)
    }
  })
})
