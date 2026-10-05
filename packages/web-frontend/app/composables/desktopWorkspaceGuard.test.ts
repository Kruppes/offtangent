import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Desktop layout + horizontal wheel contract (2026-10-05):
//  - table/list workspaces use the full main pane up to `max-w-workspace`
//    (1800 px) instead of a fixed 1152 px column on every screen;
//  - a horizontal wheel/trackpad scroll never chains to the document on
//    fine-pointer screens, where macOS turns it into the history swipe that
//    switched app tabs. Touch screens keep their swipe.
const root = new URL('..', import.meta.url).pathname
const read = (path: string) => readFileSync(root + path, 'utf8')
const css = read('assets/css/tailwind.css')

describe('desktop workspace width', () => {
  it('defines the workspace container at 1800 px', () => {
    expect(css).toMatch(/--container-workspace:\s*112\.5rem;/)
  })

  it.each([
    'features/email/components/EmailWorkspace.vue',
    'features/memory/components/MemoryWorkspace.vue',
    'features/providers/components/ProvidersWorkspace.vue',
    'pages/usage.vue',
    'pages/users.vue',
  ])('%s uses the workspace column, not a fixed narrow cap', (path) => {
    const source = read(path)
    expect(source).toContain('max-w-workspace')
    expect(source).not.toMatch(/mx-auto flex w-full max-w-[56]xl/)
  })
})

describe('horizontal wheel never becomes a history swipe on desktop', () => {
  it('stops horizontal overscroll at the document only for fine pointers', () => {
    const block = css.match(/@media \(hover: hover\) and \(pointer: fine\) \{\s*html,\s*body \{\s*overscroll-behavior-x: none;\s*\}\s*\}/)
    expect(block).not.toBeNull()
    // no unconditional root rule that would also take the swipe from phones
    const unguarded = css.replace(block![0], '')
    expect(unguarded).not.toMatch(/(html|body)[^{]*\{[^}]*overscroll-behavior-x:\s*none/)
  })

  it('keeps horizontal scroll inside the table scroller', () => {
    expect(read('components/ui/Table.vue')).toContain('overflow-auto overscroll-x-contain')
  })

  it('registers no app-level wheel handler that could switch tabs', () => {
    for (const path of ['layouts/default.vue', 'app.vue']) {
      let source = ''
      try { source = read(path) } catch { continue }
      expect(source).not.toMatch(/['"@]wheel/)
    }
  })
})
