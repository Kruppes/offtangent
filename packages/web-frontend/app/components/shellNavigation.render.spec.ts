import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ShellNavigation from './ShellNavigation.vue'

const storage = vi.hoisted(() => ({ open: false, unread: 0 }))
vi.mock('~/composables/useFeed', () => ({ useFeed: () => ({ unreadCount: ref(storage.unread), refreshCount: vi.fn() }) }))
vi.mock('~/composables/useChat', () => ({ useChat: () => ({ retainConnection: vi.fn(() => vi.fn()) }) }))
vi.mock('@vueuse/core', () => ({ useStorage: (key: string, initial: boolean) => {
  expect(key).toBe('offtangent-system-navigation-open')
  expect(initial).toBe(false)
  return ref(storage.open)
} }))
const Link = defineComponent({
  props: ['to'],
  setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
})
async function render(props: Record<string, unknown> = {}) {
  const app = createSSRApp(ShellNavigation, { path: '/strands', isAdmin: true, ...props })
  app.component('NuxtLink', Link)
  app.component('AppIcon', defineComponent({ setup: () => () => h('i') }))
  app.config.globalProperties.$t = (key: string) => key
  return renderToString(app)
}
const primary = ['/', '/strands', '/feed', '/projects', '/memory']
const system = ['/dashboard', '/tasks', '/cronjobs', '/logs', '/usage', '/email', '/users', '/providers', '/skills', '/personas', '/instructions', '/settings']
function links(html: string) { return [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]) }
describe('Offtangent shell navigation', () => {
  it('shows an accessible unread dot in desktop and mobile navigation', async () => {
    storage.unread = 3
    for (const mobile of [false, true]) {
      expect(await render({ mobile })).toContain('feed.unreadCount')
      expect(await render({ mobile })).toContain('rounded-full bg-primary')
    }
    storage.unread = 0
    expect(await render()).not.toContain('feed.unreadCount')
  })
  it('orders primary destinations before the collapsed System group', async () => {
    storage.open = false
    const html = await render()
    expect(links(html)).toEqual([...primary, ...system])
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('id="system-navigation"')
    expect(html).toContain('display:none')
  })
  it('restores expanded System state', async () => {
    storage.open = true
    expect(await render()).toContain('aria-expanded="true"')
    storage.open = false
  })
  it('has exactly five mobile targets, safe area and minimum target height', async () => {
    const html = await render({ mobile: true })
    expect(links(html)).toEqual(primary)
    expect(html).toContain('safe-area-inset-bottom')
    expect(html).toContain('min-h-14')
    expect(html).not.toContain('system-navigation')
  })
  it('retains access restrictions but always shows all five primary destinations', async () => {
    expect(links(await render({ isAdmin: false }))).toEqual(primary)
    expect(links(await render({ isAdmin: false, emailConfigured: true }))).toEqual([...primary, '/email'])
  })
  it('marks strand detail as Strands, not Home', async () => {
    const html = await render({ mobile: true, path: '/strands/abc' })
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/href="\/strands"[^>]*aria-current="page"/)
  })
})
