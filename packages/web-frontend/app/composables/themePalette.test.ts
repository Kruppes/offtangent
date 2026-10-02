import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../assets/css/tailwind.css', import.meta.url), 'utf8')
function block(selector: string) {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block in tailwind.css`)
  return new Map([...css.slice(start).split('}')[0]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]))
}
// Dark is the default (`:root, .dark`); light overrides it (`:root.light`).
const DARK = ':root,\n.dark'
const LIGHT = ':root.light'
function palette(selector: string) {
  const vars = new Map([...block(DARK), ...(selector === LIGHT ? block(LIGHT) : [])])
  function rgb(name: string): number[] {
    const value = vars.get(name)!
    if (value.startsWith('var(')) return rgb(value.slice(6, -1))
    const [h, s, l] = value.split(' ').map(Number.parseFloat) as [number, number, number]
    const a = s / 100 * Math.min(l / 100, 1 - l / 100)
    return [0, 8, 4].map(n => {
      const k = (n + h / 30) % 12
      return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
    })
  }
  function hex(name: string) {
    return '#' + rgb(name).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  function luminance(name: string) {
    return rgb(name).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
  }
  function contrast(a: string, b: string) {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (values[0]! + 0.05) / (values[1]! + 0.05)
  }
  return { hex, contrast, vars }
}

describe.each([
  [LIGHT, '#345D5A', '#F8FAF9', '#F8FAF9', '#F2F4F3', '#256A29'],
  [DARK, '#4DB8A4', '#00382F', '#0F1215', '#171C20', '#81C784'],
])('%s Android palette', (selector, primary, onPrimary, background, card, success) => {
  const colors = palette(selector!)
  it('round-trips calculated HSL to exact Android hex', () => {
    expect(colors.hex('primary')).toBe(primary)
    expect(colors.hex('primary-foreground')).toBe(onPrimary)
    expect(colors.hex('background')).toBe(background)
    expect(colors.hex('card')).toBe(card)
    expect(colors.hex('success')).toBe(success)
  })
  it.each([
    ['foreground', 'background'], ['card-foreground', 'card'], ['primary-foreground', 'primary'],
    ['muted-foreground', 'muted'], ['success-foreground', 'success'], ['warning-foreground', 'warning'],
    ['destructive-foreground', 'destructive'], ['primary', 'card'], ['warning', 'card'], ['success', 'card'],
  ])('%s on %s meets WCAG AA normal text', (text, background) => {
    const ratio = colors.contrast(text, background)
    console.log(`${selector} ${text}/${background}: ${ratio.toFixed(2)}:1`)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
  it.each([
    ['muted-foreground', 'background'], ['muted-foreground', 'card'], ['foreground', 'muted'],
  ])('secondary text %s on %s meets WCAG AA normal text', (text, background) => {
    expect(colors.contrast(text, background)).toBeGreaterThanOrEqual(4.5)
  })
  it.each([
    ['ring-track', 'background'], ['ring-track', 'card'], ['ring-track', 'muted'], ['input', 'background'], ['input', 'card'],
  ])('non-text %s on %s meets WCAG 1.4.11 (3:1)', (part, background) => {
    expect(colors.contrast(part, background)).toBeGreaterThanOrEqual(3)
  })
  it('keeps the neutral ramp at seven steps', () => {
    expect([...colors.vars.keys()].filter(k => /^n\d$/.test(k))).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
  })
})
