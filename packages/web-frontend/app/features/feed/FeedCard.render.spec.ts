import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import FeedCard from './FeedCard.vue'
import type { FeedItem } from '~/api/feed'
const item: FeedItem = { id: 'x', kind: 'task_result', title: 'Result <script>', body: '**Safe plain text**', readAt: null, createdAt: '2026-09-01T12:00:00Z', strandId: 'strand/one', agentId: null, taskId: null, notify: false, boardKey: null }
async function render(overrides: Partial<FeedItem> = {}, busy = false) {
  vi.stubGlobal('useI18n', () => ({ locale: ref('en') }))
  const app = createSSRApp(FeedCard, { item: { ...item, ...overrides }, busy })
  app.config.globalProperties.$t = (key: string) => key
  app.component('Button', defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) }))
  app.component('AppIcon', defineComponent({ props: ['name'], setup: props => () => h('i', { class: props.name }) }))
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
    expect(html).toContain('<strong>Safe plain text</strong>')
    expect(html).toContain('min-h-[44px]')
    expect(html).toContain('flex-wrap')
  })
  it('hides the redundant read action and disables pending actions', async () => {
    const html = await render({ readAt: '2026-09-02T00:00:00Z' }, true)
    expect(html).not.toContain('feed.markRead')
    expect(html).not.toContain('feed.unread')
    expect(html).toContain('disabled')
  })
  it('renders markdown bodies (lists, emphasis, links) as HTML', async () => {
    const html = await render({ body: '- one\n- two\n\n[docs](https://example.com/docs)' })
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li>two</li>')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
  it('keeps plain text bodies readable without pre-formatting them', async () => {
    const html = await render({ body: 'Just a sentence.' })
    expect(html).toContain('<p>Just a sentence.</p>')
    expect(html).not.toContain('whitespace-pre-wrap')
  })
  it('never lets agent-published HTML or javascript URLs into the DOM', async () => {
    const html = await render({ body: '<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n[y](https://ok.example.com)' })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('href="javascript:alert(1)"')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('href="https://ok.example.com"')
  })
  it('renders a board update as a compact card linking to the board', async () => {
    const html = await render({ kind: 'board_update', title: 'Portfolio updated', body: 'Securities **+1,0 %** today.', boardKey: 'depot', strandId: null })
    expect(html).toContain('feed.kinds.board_update')
    expect(html).toContain('<strong>+1,0 %</strong>')
    expect(html).toContain('feed.openBoard')
    expect(html).toContain('href="/boards/depot"')
    expect(html).not.toContain('feed.ask')
  })
})
