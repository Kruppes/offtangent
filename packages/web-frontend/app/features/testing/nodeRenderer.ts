/**
 * A tiny in-memory DOM for render specs that need interaction (clicks, form
 * submits, v-model), where SSR alone only shows the first frame. The repo has
 * no jsdom; this renderer is enough to call the real handlers of real
 * compiled SFCs. Test-only: nothing in the app imports it.
 */
import * as Vue from 'vue'
import { createRenderer, defineComponent, h, nextTick, type App, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

export interface TestNode {
  tag: string
  text: string
  props: Record<string, unknown>
  children: TestNode[]
  parent: TestNode | null
}
/** Last node a component called `.focus()` on (template refs resolve to test nodes). */
export let focusedNode: TestNode | null = null
const node = (tag: string, text = ''): TestNode => {
  const created: TestNode = { tag, text, props: {}, children: [], parent: null }
  Object.defineProperty(created, 'focus', { value: () => { focusedNode = created }, enumerable: false })
  return created
}
const renderer = createRenderer<TestNode, TestNode>({
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

const mounted: App[] = []
/** `$t` returns the key plus `:count`/`:n` so assertions can see interpolated numbers. */
/** `components` registers extra global stubs (e.g. a scoped-slot wrapper the component under test resolves by name). */
export function mountNode(component: Component, props: Record<string, unknown> = {}, components: Record<string, Component> = {}): TestNode {
  const root = node('root')
  const app = renderer.createApp(component, props)
  app.config.globalProperties.$t = ((key: string, params?: Record<string, unknown>) => key + (params && 'count' in params ? `:${String(params.count)}` : '')) as never
  for (const [name, tag] of Object.entries({ PageHeader: 'header', Alert: 'section', AlertDescription: 'p', Button: 'button', AppIcon: 'i' })) {
    app.component(name, defineComponent({ inheritAttrs: false, setup: (_, { slots, attrs }) => () => h(tag, attrs, slots.default?.()) }))
  }
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
  for (const [name, stub] of Object.entries(components)) app.component(name, stub)
  app.mount(root)
  mounted.push(app)
  return root
}
export function unmountAll() { mounted.splice(0).forEach(app => app.unmount()); focusedNode = null }
export function all(root: TestNode): TestNode[] { return [root, ...root.children.flatMap(all)] }
export function text(root: TestNode) { return all(root).map(n => n.text).join(' ') }
export function byTestId(root: TestNode, id: string) { return all(root).filter(n => n.props['data-testid'] === id) }
export async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  await nextTick()
}
export function button(root: TestNode, label: string) {
  const found = all(root).find(n => n.tag === 'button' && text(n).includes(label))
  if (!found) throw new Error(`no button "${label}" in: ${text(root)}`)
  return found
}
export async function click(target: TestNode) { (target.props.onClick as (e?: unknown) => void)({ preventDefault() {}, stopPropagation() {} }); await flush() }
export async function submit(form: TestNode) { (form.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await flush() }
export async function input(field: TestNode, value: string) { (field.props['onUpdate:modelValue'] as (v: string) => void)(value); await flush() }

/**
 * Compile an SFC for the client (vitest compiles SFCs for SSR, whose output
 * this renderer cannot draw). Child `.vue` imports are compiled the same way;
 * every other import must be handed in by the spec, keyed by its specifier,
 * so a missing mock fails loudly instead of reaching the network.
 */
export function loadSfc(file: string, modules: Record<string, unknown>): Component {
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
  const script = compileScript(descriptor, { id: file, inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } })
  const exports: { default?: Component } = {}
  const require = (name: string) => {
    if (name === 'vue') return vueForNodes
    if (name.endsWith('.vue')) {
      const target = name.startsWith('~/') ? path.resolve(APP_DIR, name.slice(2)) : path.resolve(path.dirname(file), name)
      return { default: loadSfc(target, modules) }
    }
    if (!(name in modules)) throw new Error(`loadSfc: no module "${name}" given for ${file}`)
    return modules[name]
  }
  new Function('require', 'exports', outputText)(require, exports)
  return exports.default!
}
export const APP_DIR = path.resolve(__dirname, '..', '..')
/** v-model directives touch DOM APIs; here they mirror the bound value into props, the listener stays a prop. */
const mirror = { mounted: (el: TestNode, b: { value: unknown }) => { el.props.value = b.value }, updated: (el: TestNode, b: { value: unknown }) => { el.props.value = b.value } }
const vueForNodes = { ...Vue, vModelText: mirror, vModelSelect: mirror, vModelDynamic: mirror, vModelCheckbox: mirror }
