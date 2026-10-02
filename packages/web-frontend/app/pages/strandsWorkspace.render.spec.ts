import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'
import * as shellLayout from '../utils/shellLayout'
import * as overview from '../utils/strandOverview'
import * as shortcuts from '../utils/shortcuts'
import * as taskActivity from '../features/threads/taskActivity'

// W4d: `/strands` without an open strand is the full-width overview, an open
// strand shrinks the list to the 304 px side column. Compile the real page
// for Vue's client renderer (like strandList.render.spec) with a stub list.
interface Node { tag: string; text: string; props: Record<string, unknown>; children: Node[]; parent: Node | null; style: Record<string, string> }
const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [], parent: null, style: {} })
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
const listProps: Record<string, unknown>[] = []
const StrandListStub = defineComponent({
  props: ['compact', 'activeId', 'activity', 'liveTasks', 'morphId'],
  setup(props) { return () => { listProps.push({ ...props }); return h('div', { 'data-testid': 'strand-list-stub' }) } },
})
function loadPage(): Component {
  const filename = new URL('./strands.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const script = compileScript(descriptor, { id: 'strands', inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  // The focus handling is browser-only (measured in Playwright); not here.
  const code = outputText.replace(/import\.meta\.client/g, 'false')
  const exports: { default?: Component } = {}
  const modules: Record<string, unknown> = {
    'vue': Vue,
    '~/features/strands/StrandList.vue': { default: StrandListStub },
    '~/composables/useShellLayout': { useShellLayout: () => shell },
    '~/composables/useShortcuts': { onShortcut: () => {} },
    '~/composables/useChat': { useChat: () => ({ sessionActivity: Vue.ref({}), strandTasks: Vue.ref({}) }) },
    '~/features/threads/taskActivity': taskActivity,
    '~/utils/shellLayout': shellLayout,
    '~/utils/strandOverview': overview,
    '~/utils/shortcuts': shortcuts,
  }
  new Function('require', 'exports', code)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}
const tier = Vue.ref<'one' | 'two' | 'three'>('three')
const shell = { tier }
const route = Vue.reactive({ params: {} as Record<string, string>, query: {} as Record<string, string> })
const apps: Vue.App[] = []
function mount() {
  vi.stubGlobal('useRoute', () => route)
  for (const name of ['computed', 'ref', 'watch'] as const) vi.stubGlobal(name, Vue[name])
  const root = node('root')
  const app = renderer.createApp(loadPage())
  app.config.globalProperties.$t = ((key: string) => key) as typeof app.config.globalProperties.$t
  for (const [name, tag] of Object.entries({ AppIcon: 'i', NuxtPage: 'main' })) app.component(name, defineComponent({ setup: () => () => h(tag) }))
  app.component('NuxtLink', defineComponent({ setup: (_, { slots }) => () => h('a', slots.default?.()) }))
  app.mount(root)
  apps.push(app)
  return root
}
function all(root: Node): Node[] { return [root, ...root.children.flatMap(all)] }
const byId = (root: Node, id: string) => all(root).find(n => n.props['data-testid'] === id)
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  listProps.splice(0)
  vi.unstubAllGlobals()
})

describe('strand workspace', () => {
  it('shows the overview over the full width without a conversation column', async () => {
    tier.value = 'three'; route.params = {}; route.query = { sort: 'title', keep: 'x' }
    const root = mount(); await nextTick()
    const list = byId(root, 'strand-list-column')!
    expect(byId(root, 'strand-workspace')!.props['data-list-mode']).toBe('overview')
    expect(String(list.props.class)).toContain('flex-1')
    expect(list.props.style).toBeUndefined()
    expect(byId(root, 'strand-conversation-column')).toBeUndefined()
    expect(byId(root, 'strand-overview-title')).toBeTruthy()
    expect(byId(root, 'strand-overview-link')).toBeUndefined()
    expect(listProps.at(-1)).toMatchObject({ compact: false, activeId: null })
  })
  it('shrinks the list to the 304 px side column once a strand is open', async () => {
    tier.value = 'three'; route.params = { id: 'abc' }; route.query = { pinned: '1', keep: 'x' }
    const root = mount(); await nextTick()
    const list = byId(root, 'strand-list-column')!
    expect(byId(root, 'strand-workspace')!.props['data-list-mode']).toBe('side')
    expect(list.props.style).toEqual({ width: `${shellLayout.LIST_WIDTH}px` })
    expect(shellLayout.LIST_WIDTH).toBe(304)
    expect(String(list.props.class)).toContain('shrink-0')
    const conversation = byId(root, 'strand-conversation-column')!
    expect(String(conversation.props.class)).toContain('[view-transition-name:strand-conversation]')
    expect(listProps.at(-1)).toMatchObject({ compact: true, activeId: 'abc', morphId: 'abc' })
  })
  it('goes back to the overview and keeps the morph target', async () => {
    tier.value = 'two'; route.params = { id: 'abc' }; route.query = {}
    const root = mount(); await nextTick()
    route.params = {}; await nextTick()
    expect(byId(root, 'strand-conversation-column')).toBeUndefined()
    expect(listProps.at(-1)).toMatchObject({ compact: false, activeId: null, morphId: 'abc' })
  })
  it('keeps list OR strand on the phone', async () => {
    tier.value = 'one'; route.params = { id: 'abc' }; route.query = {}
    const root = mount(); await nextTick()
    expect(byId(root, 'strand-list-column')!.style.display).toBe('none')
    expect(byId(root, 'strand-conversation-column')).toBeTruthy()
    route.params = {}; await nextTick()
    expect(byId(root, 'strand-list-column')!.style.display).not.toBe('none')
    expect(byId(root, 'strand-conversation-column')).toBeUndefined()
  })
})
