import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import Feed from './feed.vue'
import type { FeedItem } from '~/api/feed'

const mocked = vi.hoisted(() => ({ feed: vi.fn() }))
vi.mock('~/composables/useFeed', () => ({ useFeed: mocked.feed }))
afterEach(() => vi.unstubAllGlobals())
async function render(state: { loading?: boolean; error?: string; items?: FeedItem[] }) {
  mocked.feed.mockReturnValue({ items: ref(state.items ?? []), unreadCount: ref(0), loading: ref(state.loading ?? false), busy: ref(false), error: ref(state.error ?? null), load: vi.fn(), markRead: vi.fn(), ask: vi.fn() })
  vi.stubGlobal('useI18n', () => ({ locale: ref('en') }))
  const app = createSSRApp(Feed)
  app.config.globalProperties.$t = (key: string) => key
  for (const [name, tag] of Object.entries({ Button: 'button', PageHeader: 'header', Alert: 'section', AlertDescription: 'p', AppIcon: 'i', NuxtLink: 'a' })) {
    app.component(name, defineComponent({ setup: (_, { slots }) => () => h(tag, slots.default?.()) }))
  }
  return renderToString(app)
}
describe('Feed view states', () => {
  it('renders accessible loading skeletons', async () => {
    const html = await render({ loading: true })
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('animate-pulse')
    expect(html).not.toContain('feed.empty</p>')
  })
  it('renders an actionable error instead of an empty success', async () => {
    const html = await render({ error: 'feed.error' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('common.retry')
    expect(html).not.toContain('feed.empty</p>')
  })
  it('renders the explained empty state', async () => {
    expect(await render({})).toContain('feed.empty')
  })
  it('renders content and all permitted actions', async () => {
    const html = await render({ items: [{ id: 'f1', title: 'Completed', body: 'Report', kind: 'task_result', readAt: null, createdAt: '2026-09-01T10:00:00Z', strandId: 's1', taskId: null, agentId: null }] })
    expect(html).toContain('Completed')
    expect(html).toContain('feed.markRead')
    expect(html).toContain('feed.ask')
    expect(html).not.toContain('animate-pulse')
  })
})
