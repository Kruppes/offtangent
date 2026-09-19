import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, type Component } from 'vue'
import * as Vue from 'vue'
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
  const modules: Record<string, unknown> = { vue: Vue }
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}
const LegacyChat = loadPage('./chat/[id].vue')

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
afterEach(() => {
  trees.splice(0).forEach(({ app }) => app.unmount())
  vi.unstubAllGlobals()
})

describe('compatibility routes', () => {
  for (const [name, component, path] of [['legacy chat', LegacyChat, '/strands/id%2Fwith%20space']] as const) {
    it(`${name} redirects with query and hash intact`, () => {
      const navigate = vi.fn().mockReturnValue('redirect-result')
      let middleware: (to: unknown) => unknown = () => undefined
      vi.stubGlobal('navigateTo', navigate)
      vi.stubGlobal('definePageMeta', (meta: { middleware: typeof middleware }) => { middleware = meta.middleware })
      mount(component)
      const query = { search: 'two words', filter: ['a', 'b'], flag: null }
      expect(middleware({ params: { id: 'id/with space' }, query, hash: '#message-42' })).toBe('redirect-result')
      expect(navigate).toHaveBeenCalledWith({ path, query, hash: '#message-42' }, { redirectCode: 301, replace: true })
    })
  }
})
