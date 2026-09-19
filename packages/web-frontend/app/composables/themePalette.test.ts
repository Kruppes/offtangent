import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../assets/css/tailwind.css', import.meta.url), 'utf8')
function palette(selector: string) {
  const block = css.slice(css.indexOf(`${selector} {`)).split('}')[0]!
  const vars = new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]))
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
  return { hex, contrast }
}

describe.each([
  [':root', '#345D5A', '#FFFFFF', '#F8FAF9', '#F2F4F3', '#2E7D32'],
  ['.dark', '#4DB8A4', '#00382F', '#101418', '#171C20', '#81C784'],
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
})
