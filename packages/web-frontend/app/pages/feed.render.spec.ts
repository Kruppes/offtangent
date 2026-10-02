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
  vi.stubGlobal('useI18n', () => ({ locale: ref('en'), t: (key: string) => key }))
  const app = createSSRApp(Feed)
  app.config.globalProperties.$t = (key: string) => key
  for (const [name, tag] of Object.entries({ Button: 'button', PageHeader: 'header', Alert: 'section', AlertDescription: 'p', AppIcon: 'i' })) {
    app.component(name, defineComponent({ setup: (_, { slots }) => () => h(tag, slots.default?.()) }))
  }
  // Keep the link target visible so route assertions are real.
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  return renderToString(app)
}
const synthetic = (id: string, agentId: string | null, createdAt: string, body = 'Short'): FeedItem => ({ id, title: `Item ${id}`, body, kind: 'task_result', readAt: null, createdAt, strandId: null, taskId: null, agentId, notify: false, boardKey: null })
describe('Feed view states', () => {
  it('groups by day, offers persona chips for a mixed feed and collapses long cards', async () => {
    const long = 'Synthetic paragraph. '.repeat(40)
    const html = await render({ items: [synthetic('a', null, new Date().toISOString(), long), synthetic('b', 'helper', '2026-01-02T10:00:00Z'), synthetic('c', 'helper', '2026-01-02T09:00:00Z')] })
    expect(html.match(/data-testid="feed-day"/g)).toHaveLength(2)
    expect(html).toContain('feed.day.today')
    expect(html).toContain('data-testid="feed-personas"')
    expect(html).toContain('feed.allPersonas')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('helper')
    expect(html).toContain('data-testid="feed-toggle"')
    expect(html).toContain('aria-expanded="false"')
  })
  it('hides persona chips while the feed holds a single persona', async () => {
    const html = await render({ items: [synthetic('a', 'helper', '2026-01-02T10:00:00Z'), synthetic('b', 'helper', '2026-01-02T09:00:00Z')] })
    expect(html).not.toContain('data-testid="feed-personas"')
    expect(html.match(/data-testid="feed-day"/g)).toHaveLength(1)
  })
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
  it('offers every kind in the filter, including board updates, without losing the old ones', async () => {
    const html = await render({})
    for (const kind of ['task_result', 'task_question', 'cron_report', 'heartbeat', 'reminder', 'system', 'board_update']) {
      expect(html).toContain(`value="${kind}"`)
      expect(html).toContain(`feed.kinds.${kind}`)
    }
    // "All types" stays the default, so the filter does not hide anything on load.
    expect(html).toMatch(/<option value=""[^>]*selected/)
  })
  it('renders a board update as a compact card: board link, no strand question', async () => {
    const boardItem: FeedItem = { id: 'f2', title: 'Depot updated', body: 'Securities **+1,21 %**.', kind: 'board_update', readAt: null, createdAt: '2026-09-25T20:00:00Z', strandId: null, taskId: null, agentId: 'analyst', notify: true, boardKey: 'depot' }
    const html = await render({ items: [boardItem] })
    expect(html).toContain('feed.openBoard')
    expect(html).toContain('href="/boards/depot"')
    expect(html).toContain('<strong>+1,21 %</strong>')
    expect(html).toContain('feed.markRead')
    // A board has no strand, so the question action must not be offered.
    expect(html).not.toContain('feed.ask')
    expect(html).not.toContain('feed.openStrand')
  })
  it('renders content and all permitted actions', async () => {
    const html = await render({ items: [{ id: 'f1', title: 'Completed', body: 'Report', kind: 'task_result', readAt: null, createdAt: '2026-09-01T10:00:00Z', strandId: 's1', taskId: null, agentId: null, notify: false, boardKey: null }] })
    expect(html).toContain('Completed')
    expect(html).toContain('feed.markRead')
    expect(html).toContain('feed.ask')
    expect(html).not.toContain('animate-pulse')
  })
})
