import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { useApi } from '~/composables/useApi'
import * as Vue from 'vue'
import * as pagination from './pagination'
import * as datetime from '~/utils/datetime'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'
import * as shellCommands from '../../composables/useShellCommands'

// The existing render config compiles imports for SSR. Compile these four
// SFCs for Vue's client renderer instead, so onMounted and clicks really run.
function loadPage(path: string): Component {
  const filename = new URL(path, import.meta.url)
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const script = compileScript(descriptor, { id: path, inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  const modules: Record<string, unknown> = { vue: Vue, '~/composables/useShellCommands': shellCommands, './pagination': pagination, '~/utils/datetime': datetime, './StrandActions.vue': { default: defineComponent({ render: () => h('aside') }) } }
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}
const List = loadPage('./StrandList.vue')

// Like the SSR render specs, compile the real SFCs without booting Nuxt.
// A tiny in-memory Vue host also exercises mounted fetches and retry clicks.
interface Node {
  tag: string
  text: string
  props: Record<string, unknown>
  children: Node[]
  parent: Node | null
}
const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [], parent: null })
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag),
  createText: text => node('#text', text),
  createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text },
  setElementText: (el, text) => { el.text = text; el.children = [] },
  patchProp: (el, key, _prev, value) => { el.props[key] = value },
  parentNode: el => el.parent,
  nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  insert(el, parent, anchor) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, el)
    el.parent = parent
  },
  remove(el) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
    el.parent = null
  },
})
const trees: ReturnType<typeof mount>[] = []
function mount(component: Component): { app: Vue.App; root: Node } {
  const root = node('root')
  const app = renderer.createApp(component)
  app.config.globalProperties.$t = ((key: string, params?: unknown) => key + (params && typeof params === 'object' && 'count' in params ? `:${params.count}` : '')) as typeof app.config.globalProperties.$t
  for (const [name, tag] of Object.entries({ PageHeader: 'header', Alert: 'section', AlertDescription: 'p', Button: 'button', AppIcon: 'i', NuxtLink: 'a' })) {
    app.component(name, defineComponent({ setup: (_, { slots }) => () => h(tag, slots.default?.()) }))
  }
  app.mount(root)
  const result = { app, root }
  trees.push(result)
  return result
}
function all(root: Node): Node[] { return [root, ...root.children.flatMap(all)] }
function text(root: Node) { return all(root).map(n => n.text).join(' ') }
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  await nextTick()
}
function setupFetch() {
  vi.stubGlobal('useApi', useApi)
  vi.stubGlobal('useAuth', () => ({ getAccessToken: () => 'test-token' }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://test.example' } }))
  return vi.fn<typeof fetch>()
}
afterEach(() => {
  trees.splice(0).forEach(({ app }) => app.unmount())
  vi.unstubAllGlobals()
})


function setup() {
  const route = Vue.reactive({ query: {} as Record<string, string> })
  const replace = vi.fn(({ query }) => { route.query = query })
  const push = vi.fn(({ query }) => { route.query = query })
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({ replace, push }))
  vi.stubGlobal('useI18n', () => ({ locale: Vue.ref('en') }))
  const fetch = setupFetch()
  vi.stubGlobal('fetch', fetch)
  return { fetch, route, replace, push }
}
describe('shared strand list', () => {
  it('shows loading and then empty state', async () => {
    const { fetch } = setup()
    let resolve!: (response: Response) => void
    fetch.mockImplementation((url) => String(url).includes('/api/projects') ? Promise.resolve(new Response('{"projects":[]}')) : new Promise(r => { resolve = r }))
    const { root } = mount(List); await nextTick()
    expect(text(root)).toContain('common.loading')
    resolve(new Response('{"strands":[]}')); await flush()
    expect(text(root)).toContain('strandsW3.empty')
    expect(text(root)).not.toContain('common.loading')
  })
  it('shows a localized error and retries into content', async () => {
    const { fetch } = setup()
    let failed = false
    fetch.mockImplementation(async url => {
      if (String(url).includes('/api/projects')) return new Response('{"projects":[]}')
      if (!failed) { failed = true; return new Response('{}', { status: 500 }) }
      return new Response(JSON.stringify({ strands: [{ id: 's', title: 'Actual strand', tags: ['tag'], pinned: false, agentId: 'main', messageCount: 12, lastActivity: '2026-09-01', projectId: null, nowRank: 1 }] }))
    })
    const { root } = mount(List); await flush()
    expect(text(root)).toContain('strandsW3.error')
    const retry = all(root).find(n => n.tag === 'button' && text(n).includes('common.retry'))!
    ;(retry.props.onClick as () => void)(); await flush()
    expect(text(root)).toContain('Actual strand')
    expect(text(root)).toContain('strandsW3.messages:12')
    expect(text(root)).not.toContain('strandsW3.error')
  })
  it('renders a truncation hint at the 30-page ceiling', async () => {
    const { fetch } = setup()
    fetch.mockImplementation(async url => {
      if (String(url).includes('/api/projects')) return new Response('{"projects":[]}')
      const offset = Number(new URL(String(url)).searchParams.get('offset'))
      return new Response(JSON.stringify({ strands: Array.from({ length: 100 }, (_, i) => ({ id: String(offset + i), title: 'Strand', tags: [], pinned: false, archived: false, lastActivity: '', messageCount: 0 })) }))
    })
    const { root } = mount(List); await flush()
    for (let page = 1; page < 30; page++) {
      const more = all(root).find(n => n.tag === 'button' && text(n).includes('strandsW3.loadMore'))!
      ;(more.props.onClick as () => void)(); await flush()
    }
    expect(text(root)).toContain('strandsW3.truncated')
    expect(text(root)).toContain('strandsW3.loaded:3000')
    expect(text(root)).not.toContain('strandsW3.loadMore')
    // 30 cumulative re-renders of up to 3000 rows take ~3.5 s on an idle box and
    // tipped over the default 5 s during a Docker build next to the live container.
  }, 20_000)
  it('restores filters from URL and writes changes back while retaining unrelated query', async () => {
    const { fetch, route, replace } = setup()
    route.query = { project_id: 'none', tag: 'old', now: '1', keep: 'yes' }
    fetch.mockImplementation(async url => new Response(String(url).includes('/api/projects') ? '{"projects":[]}' : '{"strands":[]}'))
    const { root } = mount(List); await flush()
    expect(fetch.mock.calls.some(call => String(call[0]).includes('project_id=none&tag=old&now=1'))).toBe(true)
    const input = all(root).find(n => n.props['data-testid'] === 'tag-filter')!
    expect(input.props.value).toBe('old')
    ;(input.props.onChange as (e: unknown) => void)({ target: { value: 'new' } }); await flush()
    expect(replace).toHaveBeenCalledWith({ query: { project_id: 'none', tag: 'new', now: '1', keep: 'yes' } })
    expect(fetch.mock.calls.some(call => String(call[0]).includes('tag=new'))).toBe(true)
  })
  it('debounces the search into ?q=, shows the excerpt with escaped highlight, and resets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { fetch, route, push, replace } = setup()
      route.query = { keep: 'yes' }
      fetch.mockImplementation(async (url) => {
        if (String(url).includes('/api/projects')) return new Response('{"projects":[]}')
        const q = new URL(String(url)).searchParams.get('q')
        if (q === 'nomatch') return new Response('{"strands":[]}')
        if (q) return new Response(JSON.stringify({ strands: [{ id: 'hit', title: 'Synthetic needle strand', tags: [], pinned: false, agentId: 'main', messageCount: 1, lastActivity: '2026-09-01', projectId: null, matchSnippet: 'a <b>needle</b> in text' }] }))
        return new Response('{"strands":[]}')
      })
      const { root } = mount(List); await flush()
      const input = () => all(root).find(n => n.props['data-testid'] === 'strand-search')!
      ;(input().props.onInput as (e: unknown) => void)({ target: { value: 'need' } })
      ;(input().props.onInput as (e: unknown) => void)({ target: { value: 'needle' } })
      await flush()
      expect(push).not.toHaveBeenCalled()
      vi.advanceTimersByTime(250); await flush()
      // One navigation for two keystrokes, other query keys kept.
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith({ query: { keep: 'yes', q: 'needle' } })
      expect(fetch.mock.calls.some(call => String(call[0]).includes('q=needle'))).toBe(true)
      const snippet = all(root).find(n => n.props['data-testid'] === 'strand-snippet')!
      // The raw markup stays text; only the search word is a <mark>.
      expect(text(snippet)).toContain('<b>')
      expect(all(snippet).filter(n => n.tag === 'mark').map(text)).toEqual(['needle'])
      expect(all(root).some(n => n.tag === 'b')).toBe(false)

      ;(input().props.onInput as (e: unknown) => void)({ target: { value: 'nomatch' } })
      await flush(); vi.advanceTimersByTime(250); await flush()
      expect(replace).toHaveBeenCalledWith({ query: { keep: 'yes', q: 'nomatch' } })
      expect(text(root)).toContain('strandsW3.searchEmpty')
      const focus = vi.fn()
      Object.assign(input(), { focus })
      const reset = all(root).find(n => n.tag === 'button' && text(n).includes('strandsW3.searchReset'))!
      ;(reset.props.onClick as () => void)(); await flush()
      expect(focus).toHaveBeenCalled()
      expect(input().props.value).toBe('')
      expect(push).toHaveBeenLastCalledWith({ query: { keep: 'yes' } })
      expect(text(root)).toContain('strandsW3.empty')
    } finally {
      vi.useRealTimers()
    }
  })
  it('restores the search field from the URL', async () => {
    const { fetch, route } = setup()
    route.query = { q: 'needle' }
    fetch.mockImplementation(async url => new Response(String(url).includes('/api/projects') ? '{"projects":[]}' : '{"strands":[]}'))
    const { root } = mount(List); await flush()
    expect(all(root).find(n => n.props['data-testid'] === 'strand-search')!.props.value).toBe('needle')
    expect(fetch.mock.calls.some(call => String(call[0]).includes('q=needle'))).toBe(true)
    expect(text(root)).toContain('strandsW3.searchEmpty')
  })
  it('compact column marks the open strand and shows the turn state of the others', async () => {
    const { fetch } = setup()
    fetch.mockImplementation(async url => {
      if (String(url).includes('/api/projects')) return new Response('{"projects":[]}')
      return new Response(JSON.stringify({ strands: [
        { id: 'open-one', title: 'Open strand', tags: [], pinned: false, archived: false, lastActivity: '2026-09-01', messageCount: 1 },
        { id: 'busy-one', title: 'Busy strand', tags: [], pinned: false, archived: false, lastActivity: '2026-09-01', messageCount: 1 },
        { id: 'queued-one', title: 'Queued strand', tags: [], pinned: false, archived: false, lastActivity: '2026-09-01', messageCount: 1 },
      ] }))
    })
    const { root } = mount(Vue.defineComponent({ render: () => Vue.h(List, { compact: true, activeId: 'open-one', activity: { 'busy-one': { state: 'thinking' }, 'queued-one': { state: 'queued' } } }) }))
    await flush()
    const rows = all(root).filter(n => n.props['data-testid'] === 'strand-row')
    expect(rows.map(r => r.props['data-strand-id'])).toEqual(['open-one', 'busy-one', 'queued-one'])
    expect(rows[0]!.props['data-active']).toBe('true')
    expect(rows[1]!.props['data-active']).toBeUndefined()
    expect(text(rows[1]!)).toContain('strandsW3.state.running')
    expect(text(rows[2]!)).toContain('strandsW3.state.queued')
    expect(text(rows[0]!)).not.toContain('strandsW3.state')
    expect(all(rows[0]!).some(n => n.props['aria-current'] === 'page')).toBe(true)
  })
})
