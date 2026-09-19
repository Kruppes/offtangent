import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import FeedCard from './FeedCard.vue'
import type { FeedItem } from '~/api/feed'
const item: FeedItem = { id: 'x', kind: 'task_result', title: 'Result <script>', body: '**Safe plain text**', readAt: null, createdAt: '2026-09-01T12:00:00Z', strandId: 'strand/one', agentId: null, taskId: null }
async function render(readAt: string | null = null, busy = false) {
  vi.stubGlobal('useI18n', () => ({ locale: ref('en') }))
  const app = createSSRApp(FeedCard, { item: { ...item, readAt }, busy })
  app.config.globalProperties.$t = (key: string) => key
  app.component('Button', defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) }))
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  return renderToString(app)
}
afterEach(() => vi.unstubAllGlobals())
describe('feed card', () => {
  it('renders unread state, timestamp, safe body and encoded strand link', async () => {
    const html = await render()
    expect(html).toContain('feed.unread')
    expect(html).toContain('feed.markRead')
    expect(html).toContain('feed.ask')
    expect(html).toContain('datetime="2026-09-01T12:00:00Z"')
    expect(html).toContain('/strands/strand%2Fone')
    expect(html).toContain('Result &lt;script&gt;')
    expect(html).toContain('**Safe plain text**')
    expect(html).toContain('min-h-[44px]')
    expect(html).toContain('flex-wrap')
  })
  it('hides the redundant read action and disables pending actions', async () => {
    const html = await render('2026-09-02T00:00:00Z', true)
    expect(html).not.toContain('feed.markRead')
    expect(html).not.toContain('feed.unread')
    expect(html).toContain('disabled')
  })
})
