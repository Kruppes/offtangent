import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Chrome renders only the six neutral tokens. An alpha variant of a neutral
// role (`bg-muted/30`, `border-border/60`, `bg-card/50`, `hsl(var(--border) / .5)`)
// or an opacity on a disabled state mixes a seventh grey with whatever lies
// below, so both are banned from the web source. Disabled states change token
// (surface N2, text N4, icon N3) instead of fading.
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

const NEUTRAL = 'background|foreground|card|card-foreground|popover|popover-foreground|muted|muted-foreground|accent|accent-foreground|border|input|sidebar|sidebar-foreground|sidebar-border|container|surface|outline'
const UTILITY = 'bg|border|border-[trblxy]|text|ring|ring-offset|divide|outline|fill|stroke|from|via|to|placeholder|decoration|caret|shadow|accent'
const alphaClass = new RegExp(`(?<![\\w-])(?:${UTILITY})-(?:${NEUTRAL})\\/(?:\\d+|\\[[^\\]]+\\])(?![\\w-])`, 'g')
const alphaCss = new RegExp(`hsl\\(var\\(--(?:n[0-5]|${NEUTRAL})\\)\\s*\\/`, 'g')
const fadedDisabled = /(?:^|[\s"'`])(?:peer-|group-)?(?:disabled|aria-disabled|data-\[disabled\]):opacity-/g

function hits(re: RegExp) {
  return sources.flatMap(({ path, text }) => [...text.matchAll(re)].map(m => `${path}: ${m[0].trim()}`))
}

describe('neutral token guard', () => {
  it('scans the web source', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('has no alpha variant of a neutral token class', () => {
    expect(hits(alphaClass)).toEqual([])
  })

  it('has no alpha variant of a neutral token in CSS', () => {
    expect(hits(alphaCss)).toEqual([])
  })

  it('never fades a disabled state with opacity', () => {
    expect(hits(fadedDisabled)).toEqual([])
  })

  it('catches the banned forms (self-check)', () => {
    expect('bg-muted/30 border-border/60 bg-card/50 text-muted-foreground/[0.5]'.match(alphaClass)).toHaveLength(4)
    expect('bg-primary/10 bg-muted border-border'.match(alphaClass)).toBeNull()
    expect('color: hsl(var(--muted-foreground) / 0.55)'.match(alphaCss)).toHaveLength(1)
    expect(' disabled:opacity-50 data-[disabled]:opacity-50 peer-disabled:opacity-70'.match(fadedDisabled)).toHaveLength(3)
  })
})
