import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import Tabs from './Tabs.vue'
import TabsList from './TabsList.vue'
import TabsTrigger from './TabsTrigger.vue'

async function render(triggers: Array<Record<string, unknown>>) {
  const app = createSSRApp(defineComponent({
    setup: () => () => h(Tabs, { defaultValue: 'a' }, () => h(TabsList, null, () => triggers.map(props => h(TabsTrigger, props, () => String(props.value).toUpperCase())))),
  }))
  app.component('AppIcon', defineComponent({ props: ['name'], setup: props => () => h('i', { 'data-icon': props.name, 'aria-hidden': 'true' }) }))
  return renderToString(app)
}
const button = (html: string, value: string) => { const m = html.match(new RegExp(`<button[^>]*-trigger-${value}"[^>]*>[\\s\\S]*?</button>`)); if (!m) throw new Error(html); return m[0] }

describe('TabsTrigger locked state', () => {
  it('shows a lock icon and N4 text instead of a strike-through', async () => {
    const html = await render([{ value: 'a' }, { value: 'b', disabled: true }])
    const locked = button(html, 'b')
    expect(locked).toMatch(/ disabled[ =>]/)
    expect(locked).toContain('data-icon="lock"')
    expect(locked).toContain('disabled:text-muted-foreground')
    expect(locked).not.toContain('line-through')
    expect(button(html, 'a')).not.toContain('data-icon="lock"')
  })
  it('exposes the reason as tooltip and accessible description', async () => {
    const html = await render([{ value: 'a' }, { value: 'b', disabled: true, disabledReason: 'Needs an admin account' }])
    const locked = button(html, 'b')
    expect(locked).toContain('title="Needs an admin account"')
    const id = locked.match(/aria-describedby="([^"]+)"/)![1]
    expect(locked).toContain(`<span id="${id}" class="sr-only">Needs an admin account</span>`)
  })
  it('adds no description to an enabled tab', async () => {
    const html = await render([{ value: 'a', disabledReason: 'unused' }])
    const tab = button(html, 'a')
    expect(tab).not.toContain('aria-describedby')
    expect(tab).not.toContain('title=')
  })
})
