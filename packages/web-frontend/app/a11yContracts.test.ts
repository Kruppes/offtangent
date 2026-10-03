import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Structural accessibility contracts found by the W6a browser audit (axe +
// keyboard walk). These guard the markup itself, so a later edit cannot
// silently drop the skip link, nest controls again or lose a control name.
const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const template = (path: string) => {
  const text = src(path)
  return text.slice(text.indexOf('<template>'), text.lastIndexOf('</template>'))
}

describe('a11y contracts (W6a)', () => {
  it('the default layout starts with a skip link to a focusable main landmark', () => {
    const layout = template('./layouts/default.vue')
    const firstTag = layout.replace(/<!--[\s\S]*?-->/g, '').match(/<template>\s*<(\w+)[^>]*>/)
    expect(firstTag?.[1]).toBe('a')
    expect(layout).toMatch(/<a\s[^>]*href="#main-content"[^>]*data-testid="skip-link"/)
    expect(layout).toMatch(/<main id="main-content" tabindex="-1"/)
    // Exactly one main landmark: pages must not render their own <main>.
    expect(src('./features/capture/components/CaptureHome.vue')).not.toMatch(/<main[\s>]/)
  })

  it('the floating sidebar drawer is a modal dialog that traps Tab', () => {
    const layout = src('./layouts/default.vue')
    expect(layout).toMatch(/:role="sidebarOpen \? 'dialog' : undefined"/)
    expect(layout).toMatch(/:aria-modal="sidebarOpen \? 'true' : undefined"/)
    expect(layout).toMatch(/@keydown\.tab="trapDrawerFocus"/)
  })

  it('the page header keeps an h1 on mobile, where the visual bar is hidden', () => {
    const header = src('./components/PageHeader.vue')
    expect(header).toMatch(/<h1 v-if="title && isMobile && !ownMobileHeading" class="sr-only">/)
  })

  it('the mobile task card does not nest the kill button inside the open button', () => {
    const card = template('./features/tasks/components/TaskListCard.vue')
    expect(card.trimStart()).not.toMatch(/^<template>\s*(<!--[\s\S]*?-->\s*)?<button/)
    expect(card).toMatch(/:aria-label="\$t\('tasks\.killButton'\)"/)
  })

  it('every filter select trigger has an accessible name', () => {
    for (const path of [
      './features/tasks/components/TaskFilterFields.vue',
      './features/cronjobs/components/CronjobFilterFields.vue',
      './components/LogFilterToolbar.vue',
      './pages/usage.vue',
    ]) {
      const triggers = src(path).match(/<SelectTrigger\b[^>]*>/g) ?? []
      expect(triggers.length, path).toBeGreaterThan(0)
      // W11: the name is a visible label tied by id (LabeledField), not an
      // invisible aria-label.
      for (const trigger of triggers) expect(trigger, path).toMatch(/:id="id"/)
      const labels = src(path).match(/<LabeledField v-slot="\{ id \}" :label="[\w$]*\('aria\.filterBy\.\w+'\)"/g) ?? []
      expect(labels.length, path).toBe(triggers.length)
    }
  })

  it('the composer file input stays in the Tab order with a name', () => {
    const composer = src('./components/chat/ChatComposer.vue')
    expect(composer).toMatch(/<input class="sr-only" type="file"[^>]*:aria-label="\$t\('chat\.attachFiles'\)"/)
    expect(composer).not.toMatch(/<input class="hidden" type="file"/)
  })

  it('the label text step is at least 12 px on phones', () => {
    // W7 (design review): the label step is 12 px on every width, so no
    // phone-only override is needed and no rule may lower it anywhere.
    const css = src('./assets/css/tailwind.css')
    expect(css).toMatch(/@theme \{[\s\S]*?--text-2xs: 12px;/)
    const assigned = [...css.matchAll(/--text-2xs:\s*([0-9.]+)px/g)].map(m => Number(m[1]))
    expect(assigned.length).toBeGreaterThan(0)
    expect(Math.min(...assigned)).toBeGreaterThanOrEqual(12)
  })
})
