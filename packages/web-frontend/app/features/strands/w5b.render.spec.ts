/**
 * W5b render specs: "In messages" search results, the fork action and the
 * recalled list of the context panel — loading, error, empty and success,
 * through the real SFCs on an in-memory Vue host (same harness as
 * strandWorkflows.render.spec.ts). Fixtures are synthetic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, createSSRApp, defineComponent, h, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'
import * as useApiModule from '~/composables/useApi'
import * as commandPalette from '~/utils/commandPalette'
import * as datetime from '~/utils/datetime'
import * as strandW5b from '~/api/strandW5b'
import StrandContextDetails from '../../components/context/StrandContextDetails.vue'
import { setStrandContextForTest } from '~/composables/useStrandContext'
import { mapContextReport } from '~/utils/contextGauge'

function load(path: string): Component {
  const filename = new URL(path, import.meta.url)
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const script = compileScript(descriptor, { id: path, inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  const modules: Record<string, unknown> = { vue: Vue, '~/composables/useApi': useApiModule, '~/utils/commandPalette': commandPalette, '~/utils/datetime': datetime, '~/api/strandW5b': strandW5b }
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}
const SearchResults = load('./MessageSearchResults.vue')
const ForkAction = load('../../components/chat/MessageForkAction.vue')

interface Node { tag: string; text: string; props: Record<string, unknown>; children: Node[]; parent: Node | null; addEventListener: () => void }
const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [], parent: null, addEventListener: () => {} })
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
const apps: Vue.App[] = []
function mount(component: Component, props: Record<string, unknown>): Node {
  const root = node('root')
  const app = renderer.createApp(component, props)
  app.config.globalProperties.$t = ((key: string, params?: unknown) => key + (params ? JSON.stringify(params) : '')) as typeof app.config.globalProperties.$t
  for (const [name, tag] of Object.entries({ AppIcon: 'i', NuxtLink: 'a' })) {
    app.component(name, defineComponent({ props: ['to', 'name'], setup: (props, { slots, attrs }) => () => h(tag, { ...attrs, to: props.to, name: props.name }, slots.default?.()) }))
  }
  app.mount(root)
  apps.push(app)
  return root
}
const all = (root: Node): Node[] => [root, ...root.children.flatMap(all)]
const text = (root: Node) => all(root).map(n => n.text).join(' ')
const find = (root: Node, attr: string) => all(root).find(n => attr in n.props)
async function flush(ms = 0) {
  if (ms) await new Promise(resolve => setTimeout(resolve, ms))
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  await nextTick()
}
function setup() {
  const apiFetch = vi.fn()
  const push = vi.fn(async () => {})
  vi.stubGlobal('useApi', () => ({ apiFetch }))
  vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, locale: Vue.ref('en') }))
  vi.stubGlobal('useRouter', () => ({ push }))
  return { apiFetch, push }
}
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  vi.unstubAllGlobals()
})

const hit = { strandId: 's1', strandTitle: 'Synthetic strand', messageId: 42, role: 'assistant', snippet: 'before <script>x</script> needle after', highlights: [[26, 32]], timestamp: '2026-01-01 10:00:00' }

describe('MessageSearchResults ("In messages")', () => {
  it('nothing below two characters; loading then success with marked, escaped snippet and a message link', async () => {
    const { apiFetch } = setup()
    let resolve!: (value: unknown) => void
    apiFetch.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const short = mount(SearchResults, { query: 'n' })
    expect(find(short, 'data-message-search')).toBeUndefined()

    const root = mount(SearchResults, { query: 'needle' })
    await flush(250)
    expect(find(root, 'data-message-search-loading')).toBeDefined()
    expect(apiFetch.mock.calls[0]![0]).toBe('/api/search?q=needle&limit=20')
    resolve({ query: 'needle', hits: [hit], truncated: false })
    await flush()
    expect(text(root)).toContain('search.inMessages')
    const link = all(root).find(n => n.tag === 'a')!
    expect(link.props.to).toBe('/strands/s1#msg-42')
    const marks = all(root).filter(n => n.tag === 'mark')
    expect(marks.map(text)).toEqual([' needle'.trim()])
    // The markup of the message stays text: no element was created from it.
    expect(all(root).some(n => n.tag === 'script')).toBe(false)
    expect(text(root)).toContain('<script>x</script>')
  })

  it('empty and error with retry (rate limit has its own text)', async () => {
    const { apiFetch } = setup()
    apiFetch.mockResolvedValueOnce({ query: 'zz', hits: [], truncated: false })
    const root = mount(SearchResults, { query: 'zz' })
    await flush(250)
    expect(find(root, 'data-message-search-empty')).toBeDefined()

    apiFetch.mockRejectedValueOnce(new useApiModule.ApiError('slow down', 429))
    const failing = mount(SearchResults, { query: 'yy' })
    await flush(250)
    expect(text(failing)).toContain('search.errorRate')
    apiFetch.mockResolvedValueOnce({ query: 'yy', hits: [hit], truncated: true })
    const retry = all(failing).find(n => n.tag === 'button')!
    ;(retry.props.onClick as () => void)()
    await flush()
    expect(find(failing, 'data-message-search-hits')).toBeDefined()
    expect(find(failing, 'data-message-search-more')).toBeDefined()
  })
})

describe('MessageForkAction', () => {
  it('forks with the message id and opens the new strand', async () => {
    const { apiFetch, push } = setup()
    apiFetch.mockResolvedValueOnce({ fork: { strandId: 'web:new', title: 'T', parentStrandId: 's1', forkedFromMessageId: 7 }, strand: {} })
    const root = mount(ForkAction, { strandId: 's1', messageId: 7 })
    const button = all(root).find(n => n.tag === 'button')!
    expect(button.props['aria-label']).toBe('fork.actionLabel')
    ;(button.props.onClick as () => void)()
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/strands/s1/fork', { method: 'POST', body: JSON.stringify({ messageId: 7 }) })
    expect(push).toHaveBeenCalledWith('/strands/web%3Anew')
  })

  it.each([[404, 'fork.errorNotFound'], [409, 'fork.errorArchived'], [429, 'fork.errorRate'], [500, 'fork.error']])('shows an error for %s', async (status, key) => {
    const { apiFetch, push } = setup()
    apiFetch.mockRejectedValueOnce(new useApiModule.ApiError('x', status))
    const root = mount(ForkAction, { strandId: 's1', messageId: 7 })
    ;(all(root).find(n => n.tag === 'button')!.props.onClick as () => void)()
    await flush()
    expect(find(root, 'data-fork-error')).toBeDefined()
    expect(text(root)).toContain(key)
    expect(push).not.toHaveBeenCalled()
  })
})

describe('context panel: recalled messages', () => {
  const ssr = async (props: Record<string, unknown>) => {
    vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, locale: Vue.ref('en') }))
    vi.stubGlobal('useApi', () => ({ apiFetch: () => new Promise(() => {}) }))
    const app = createSSRApp(StrandContextDetails, props)
    app.component('AppIcon', defineComponent({ render: () => h('i') }))
    app.component('NuxtLink', defineComponent({ props: ['to'], setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
    app.config.globalProperties.$t = ((key: string) => key) as typeof app.config.globalProperties.$t
    return await renderToString(app)
  }
  const owned = { status: 'ready' as const, data: { facts: [], summaries: 0, toolCalls: 0, projectName: null } }
  const gauge = { status: 'ready' as const, data: mapContextReport({ measurement: { state: 'unknown' } }) }

  it('loading and error follow the gauge request', async () => {
    setStrandContextForTest('r1', { status: 'loading' }, owned)
    expect(await ssr({ strandId: 'r1' })).toContain('context.recalled.loading')
    setStrandContextForTest('r1', { status: 'error', offline: false }, owned)
    const html = await ssr({ strandId: 'r1' })
    expect(html).toContain('context.recalled.error')
    expect(html).toContain('data-recalled-retry')
  })

  it('empty and success: links jump to the message, markup stays text', async () => {
    setStrandContextForTest('r1', gauge, owned, [])
    expect(await ssr({ strandId: 'r1' })).toContain('data-recalled-empty')
    setStrandContextForTest('r1', gauge, owned, [
      { messageId: 5, strandId: 'r1', role: 'assistant', excerpt: 'Older <b>answer</b>', recalledAt: '2026-01-01 10:00:00', source: 'recall' },
      { messageId: 6, strandId: 'r0', role: 'user', excerpt: 'From the parent', recalledAt: null, source: 'context' },
    ])
    const html = await ssr({ strandId: 'r1' })
    expect(html).toContain('data-recalled-list')
    expect(html).toContain('href="/strands/r1#msg-5"')
    expect(html).toContain('href="/strands/r0#msg-6"')
    expect(html).toContain('Older &lt;b&gt;answer&lt;/b&gt;')
    expect(html).toContain('context.recalled.byRecall')
    expect(html).toContain('context.recalled.byContext')
  })
})
