import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import BoardsIndex from './index.vue'
import type { BoardSummary } from '~/api/boards'

const mocked = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('~/composables/useBoards', () => ({ useBoardList: mocked.list }))
afterEach(() => vi.unstubAllGlobals())

const board = (overrides: Partial<BoardSummary> = {}): BoardSummary => ({
  key: 'depot', kind: 'portfolio_digest.v1', title: 'Portfolio', icon: '📈', agentId: 'analyst',
  revision: 4, summary: 'Securities up **1.0 %** today.', asOf: '2026-09-25T20:00:00Z',
  updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), ...overrides,
})

async function render(state: { loading?: boolean; error?: string; boards?: BoardSummary[] }) {
  mocked.list.mockReturnValue({
    boards: ref(state.boards ?? []), loading: ref(state.loading ?? false),
    error: ref(state.error ?? null), load: vi.fn(),
  })
  const app = createSSRApp(BoardsIndex)
  app.config.globalProperties.$t = ((key: string, params?: Record<string, unknown>) =>
    params && 'count' in params ? `${key}:${params.count}` : key) as never
  for (const [name, tag] of Object.entries({ Button: 'button', PageHeader: 'header', Alert: 'section', AlertDescription: 'p', AppIcon: 'i' })) {
    app.component(name, defineComponent({ setup: (_, { slots }) => () => h(tag, slots.default?.()) }))
  }
  app.component('NuxtLink', defineComponent({
    props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
  }))
  return renderToString(app)
}

describe('Integrations chooser', () => {
  it('renders accessible loading skeletons instead of an empty state', async () => {
    const html = await render({ loading: true })
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('animate-pulse')
    expect(html).not.toContain('boards.empty<')
  })

  it('renders an actionable error instead of an empty success', async () => {
    const html = await render({ error: 'boards.loadError' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('boards.loadError')
    expect(html).toContain('common.retry')
    expect(html).not.toContain('boards.empty<')
  })

  it('explains in the empty state how a board gets here', async () => {
    const html = await render({})
    expect(html).toContain('boards.empty')
    expect(html).toContain('boards.emptyHint')
  })

  it('lists every board with icon, summary, relative update time, kind badge and link', async () => {
    const html = await render({
      boards: [board(), board({ key: 'price watch', kind: 'price_search.v1', title: 'Price watch', icon: null, summary: null })],
    })
    expect(html).toContain('Portfolio')
    expect(html).toContain('📈')
    // The row is a link, so markdown is reduced to plain text instead of nested HTML.
    expect(html).toContain('Securities up 1.0 % today.')
    expect(html).not.toContain('**')
    expect(html).toContain('portfolio_digest.v1')
    expect(html).toContain('price_search.v1')
    expect(html).toContain('boards.updatedHours:2')
    expect(html).toContain('href="/boards/depot"')
    expect(html).toContain('href="/boards/price%20watch"')
    expect(html).not.toContain('animate-pulse')
  })
})
