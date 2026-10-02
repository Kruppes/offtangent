import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ShellNavigation from './ShellNavigation.vue'
import de from '../i18n/locales/de.json'
import en from '../i18n/locales/en.json'

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
type Messages = Record<string, unknown>
function translator(messages: Messages) {
  return (key: string) => {
    const value = key.split('.').reduce<unknown>((node, part) => (node as Messages | undefined)?.[part], messages)
    return typeof value === 'string' ? value : key
  }
}
async function render(props: Record<string, unknown> = {}, t: (key: string) => string = key => key) {
  const app = createSSRApp(ShellNavigation, { path: '/strands', isAdmin: true, ...props })
  app.component('NuxtLink', Link)
  app.component('AppIcon', defineComponent({ setup: () => () => h('i') }))
  for (const name of ['Tooltip', 'TooltipTrigger']) app.component(name, defineComponent({ setup: (_, { slots }) => () => slots.default?.() }))
  app.component('TooltipContent', defineComponent({ setup: (_, { slots }) => () => h('span', { role: 'tooltip' }, slots.default?.()) }))
  app.config.globalProperties.$t = t
  return renderToString(app)
}
const primary = ['/', '/strands', '/feed', '/boards']
const system = ['/projects', '/memory', '/dashboard', '/tasks', '/cronjobs', '/logs', '/usage', '/email', '/users', '/providers', '/connectors', '/skills', '/personas', '/instructions', '/settings']
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
    // Settings is pinned at the bottom in addition to its place in System.
    expect(links(html)).toEqual([...primary, ...system, '/settings'])
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('id="system-navigation"')
    expect(html).toContain('display:none')
  })
  it('restores expanded System state', async () => {
    storage.open = true
    expect(await render()).toContain('aria-expanded="true"')
    storage.open = false
  })
  it('has four mobile destinations plus More, safe area and minimum target height', async () => {
    const html = await render({ mobile: true })
    expect(links(html)).toEqual(primary)
    expect(html).toContain('grid-cols-5')
    expect(html).toContain('nav.more')
    expect(html).toContain('aria-controls="system-sheet"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('safe-area-inset-bottom')
    expect(html).toContain('min-h-14')
    expect(html).not.toContain('system-navigation')
  })
  it('retains access restrictions: projects and memory for everyone, email when configured', async () => {
    expect(links(await render({ isAdmin: false }))).toEqual([...primary, '/projects', '/memory'])
    expect(links(await render({ isAdmin: false, emailConfigured: true }))).toEqual([...primary, '/projects', '/memory', '/email'])
    expect(await render({ isAdmin: false })).not.toContain('nav-settings-pinned')
  })
  it('opens the System block by itself on a System route', async () => {
    storage.open = false
    const html = await render({ path: '/tasks/abc' })
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('display:none')
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/href="\/tasks"[^>]*aria-current="page"/)
  })
  it('keeps Settings reachable at the bottom while System is collapsed', async () => {
    storage.open = false
    const html = await render({ path: '/' })
    expect(html).toContain('data-testid="nav-settings-pinned"')
    expect(html).toContain('display:none')
  })
  it('marks strand detail as Strands, not Home', async () => {
    const html = await render({ mobile: true, path: '/strands/abc' })
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/href="\/strands"[^>]*aria-current="page"/)
  })
  it('icons-only mode names every entry and keeps 44 px targets', async () => {
    storage.open = false
    const html = await render({ path: '/feed', compact: true })
    expect(html).toContain('data-compact="true"')
    for (const label of ['nav.home', 'nav.strands', 'nav.feed', 'nav.boards', 'nav.system', 'nav.settings']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toMatch(/role="tooltip"[^>]*>\s*nav\.strands/)
    expect(html.match(/w-11 justify-center/g)!.length).toBeGreaterThanOrEqual(6)
  })
  it('marks the active entry with a surface and a leading marker, not colour alone', async () => {
    for (const compact of [false, true]) {
      const html = await render({ path: '/boards', compact })
      const link = html.match(/<a href="\/boards"[^>]*>/)![0]
      expect(link).toContain('aria-current="page"')
      expect(link).toContain('bg-primary-container')
      expect(link).toContain('before:bg-primary')
    }
  })
  it('calls boards Boards in both languages, never Integrations', async () => {
    for (const messages of [de, en]) {
      for (const props of [{}, { mobile: true }, { compact: true }]) {
        const html = await render(props, translator(messages))
        expect(html).toMatch(/href="\/boards"[^>]*>[\s\S]*?Boards/)
        expect(html).not.toMatch(/Integration/i)
      }
      // The boards screens use the same word.
      const boards = (messages as { boards: Record<string, unknown> }).boards
      expect(boards.title).toBe('Boards')
      expect(JSON.stringify(boards)).not.toMatch(/integration/i)
    }
  })
})
