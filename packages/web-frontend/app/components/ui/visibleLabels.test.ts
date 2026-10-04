import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// W11: every form field has a visible label. A placeholder disappears while
// typing and an aria-label or an sr-only label is invisible, so neither is a
// label for sighted users. This static guard catches the two invisible forms;
// the full-route browser audit measures the rendered result (label[for],
// wrapping label or aria-labelledby pointing at visible text).
const root = new URL('../..', import.meta.url).pathname
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.vue') ? [path] : []
  })
}
const sources = walk(root).map(path => ({ file: relative(root, path), text: readFileSync(path, 'utf8') }))
const field = /<(Input|input|textarea|select|SelectTrigger)\b([^>]*?)\/?>/gs

/** Invisible-only names that stay, with the reason. Key: file, value: count. */
const EXCEPTIONS: Record<string, { count: number, reason: string }> = {
  'components/CommandPalette.vue': { count: 1, reason: 'palette search combobox, the only field of the dialog, introduced by its search icon' },
  'components/ThreadHeader.vue': { count: 1, reason: 'inline rename that replaces the visible title in place' },
  'components/ThreadRow.vue': { count: 1, reason: 'inline rename that replaces the visible title in place' },
  'features/personas/components/PersonasWorkspace.vue': { count: 1, reason: 'hex mirror of the colour picker, inside the visibly labelled colour group' },
}

function invisibleNames() {
  const hits = new Map<string, number>()
  for (const { file, text } of sources) {
    for (const match of text.matchAll(field)) {
      const attrs = match[2]!
      if (/type="(hidden|checkbox|radio|file)"/.test(attrs)) continue
      if (/(^|\s):?aria-label=/.test(attrs)) hits.set(file, (hits.get(file) ?? 0) + 1)
    }
    for (const _ of text.matchAll(/<(label|Label)\b[^>]*\bsr-only\b[^>]*>/g)) hits.set(file, (hits.get(file) ?? 0) + 1)
  }
  return hits
}

describe('visible form labels', () => {
  it('scans the web components', () => {
    expect(sources.length).toBeGreaterThan(100)
  })
  it('names no form field by aria-label or an sr-only label alone', () => {
    const offenders = [...invisibleNames()].filter(([file, count]) => EXCEPTIONS[file]?.count !== count)
    expect(offenders).toEqual([])
  })
  it('lists only exceptions that still exist', () => {
    const hits = invisibleNames()
    for (const file of Object.keys(EXCEPTIONS)) expect(hits.get(file), file).toBe(EXCEPTIONS[file]!.count)
  })
  it('catches the invisible forms (self-check)', () => {
    const sample = '<Input v-model="q" :aria-label="t(\'x\')" /><label for="a" class="sr-only">A</label><input type="checkbox" aria-label="c">'
    const fields = [...sample.matchAll(field)].filter(m => !/type="checkbox"/.test(m[2]!) && /:?aria-label=/.test(m[2]!))
    expect(fields).toHaveLength(1)
    expect(sample.match(/<(label|Label)\b[^>]*\bsr-only\b[^>]*>/g)).toHaveLength(1)
  })
})
