import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { useApi } from '~/composables/useApi'
import * as Vue from 'vue'
import * as pagination from './pagination'
import * as datetime from '~/utils/datetime'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'

// The existing render config compiles imports for SSR. Compile these four
// SFCs for Vue's client renderer instead, so onMounted and clicks really run.
function loadPage(path: string): Component {
  const filename = new URL(path, import.meta.url)
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const script = compileScript(descriptor, { id: path, inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  const modules: Record<string, unknown> = { vue: Vue, './pagination': pagination, '~/utils/datetime': datetime, './StrandActions.vue': { default: defineComponent({ render: () => h('aside') }) } }
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
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.stubGlobal('useI18n', () => ({ locale: Vue.ref('en') }))
  const fetch = setupFetch()
  vi.stubGlobal('fetch', fetch)
  return { fetch, route, replace }
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
  })
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
})
