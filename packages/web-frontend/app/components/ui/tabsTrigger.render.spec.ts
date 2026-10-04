import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import Tabs from './Tabs.vue'
import TabsList from './TabsList.vue'
import TabsTrigger from './TabsTrigger.vue'

async function render(triggers: Array<{ value: string, disabled?: boolean, disabledReason?: string }>) {
  const app = createSSRApp(defineComponent({
    setup: () => () => h(Tabs, { defaultValue: 'a' }, () => h(TabsList, null, () => triggers.map(props => h(TabsTrigger, props, () => props.value.toUpperCase())))),
  }))
  app.component('AppIcon', defineComponent({ props: ['name'], setup: props => () => h('i', { 'data-icon': props.name, 'aria-hidden': 'true' }) }))
  return renderToString(app)
}
const button = (html: string, value: string) => { const m = html.match(new RegExp(`<button[^>]*-trigger-${value}"[^>]*>[\\s\\S]*?</button>`)); if (!m) throw new Error(html); return m[0] }

describe('TabsTrigger locked state', () => {
  it('shows a lock icon and N4 text instead of a strike-through', async () => {
    const html = await render([{ value: 'a' }, { value: 'b', disabled: true }])
    const locked = button(html, 'b')
    expect(locked).toContain('aria-disabled="true"')
    expect(locked).toContain('data-icon="lock"')
    expect(locked).toContain('aria-disabled:text-muted-foreground')
    expect(locked).not.toContain('line-through')
    expect(button(html, 'a')).not.toContain('data-icon="lock"')
  })
  it('stays focusable: aria-disabled instead of the native disabled attribute', async () => {
    const html = await render([{ value: 'a' }, { value: 'b', disabled: true }])
    const locked = button(html, 'b')
    // W12: the native attribute would take the tab out of the focus order.
    expect(locked).not.toMatch(/ disabled[ =>]/)
    expect(locked).not.toContain('data-disabled')
    // A roving-focus item of the tab list with a tabindex, reached by the arrow keys.
    expect(locked).toMatch(/tabindex="-?\d"/)
    expect(locked).toContain('data-reka-collection-item')
    expect(locked).toContain('aria-selected="false"')
  })
  it('links the reason as accessible description, outside the tab name', async () => {
    const html = await render([{ value: 'a' }, { value: 'b', disabled: true, disabledReason: 'Needs an admin account' }])
    const locked = button(html, 'b')
    expect(locked).toContain('title="Needs an admin account"')
    const id = locked.match(/aria-describedby="([^"]+)"/)![1]
    // The reason node is a sibling of the tab, so it does not join the tab's name.
    expect(locked).not.toContain('Needs an admin account</span>')
    expect(html).toMatch(new RegExp(`<span id="${id}" role="note" data-testid="tab-lock-reason" class="tab-lock-reason [^"]*"[^>]*>Needs an admin account</span>`))
  })
  it('shows the reason next to the tab on keyboard focus, linked by aria-describedby', async () => {
    const html = await render([{ value: 'a' }, { value: 'b', disabled: true, disabledReason: 'Needs an admin account' }])
    const locked = button(html, 'b')
    const id = locked.match(/aria-describedby="([^"]+)"/)![1]
    // The note directly follows its tab, so `:focus-visible + .tab-lock-reason` reaches it.
    const after = html.slice(html.indexOf(locked) + locked.length)
    expect(after).toMatch(new RegExp(`^<span id="${id}" role="note"`))
    const note = after.slice(0, after.indexOf('</span>'))
    // At rest it is closed (no data-open) and never focusable itself: no focus trap.
    expect(note).not.toContain('data-open')
    expect(note).not.toContain('tabindex')
    // The visible look is on the note; the stylesheet hides it unless opened or its tab has keyboard focus.
    expect(note).toContain('bg-popover')
    const css = readFileSync(new URL('../../assets/css/tailwind.css', import.meta.url), 'utf8')
    const rule = css.slice(css.indexOf('.tab-lock-reason:not('), css.indexOf('}', css.indexOf('.tab-lock-reason:not(')))
    expect(rule).toContain('.tab-lock-reason:not([data-open]):not(:focus-visible + .tab-lock-reason)')
    expect(rule).toContain('.tab-lock-reason[data-dismissed]')
    expect(rule).toContain('clip-path: inset(50%)')
  })
  it('adds no description to an enabled tab', async () => {
    const html = await render([{ value: 'a', disabledReason: 'unused' }])
    const tab = button(html, 'a')
    expect(tab).not.toContain('aria-describedby')
    expect(tab).not.toContain('title=')
    expect(tab).not.toMatch(/ aria-disabled=/)
  })
})
