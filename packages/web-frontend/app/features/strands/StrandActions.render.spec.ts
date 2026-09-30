import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import StrandActions from './StrandActions.vue'
afterEach(() => vi.unstubAllGlobals())
describe('reusable strand actions', () => {
  it.each([false, true])('renders safe archive controls for archived=%s without deleting on mount', async archived => {
    const apiFetch = vi.fn()
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }))
    const app = createSSRApp(StrandActions, { strandId: 's', archived })
    const passthrough = defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) })
    for (const name of ['Button', 'Alert', 'AlertDescription']) app.component(name, passthrough)
    app.component('ConfirmDialog', defineComponent({ setup: () => () => null }))
    const html = await renderToString(app)
    expect(html).toContain(archived ? 'strandDetail.restore' : 'strandDetail.archive')
    expect(html).toContain('strandDetail.delete')
    expect(html).toContain('min-h-11')
    expect(html).not.toContain('type="checkbox"')
    expect(apiFetch).not.toHaveBeenCalled()
  })
})
