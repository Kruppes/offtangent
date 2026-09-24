import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import * as detailApi from './detailApi'
import { ApiError } from '~/composables/useApi'
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
  const modules: Record<string, unknown> = { vue: Vue, './detailApi': detailApi, '~/api/models': { useModelsApi: () => ({ listModels: async () => [] }) }, '~/api/projects': { useProjectsApi: () => ({ list: async () => [] }) }, './StrandActions.vue': { default: defineComponent({ render: () => h('aside') }) } }
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}
const Actions = loadPage('./StrandActions.vue')
const Header = loadPage('./StrandDetailHeader.vue')

// Like the SSR render specs, compile the real SFCs without booting Nuxt.
// A tiny in-memory Vue host also exercises mounted fetches and retry clicks.
interface Node {
  tag: string
  text: string
  props: Record<string, unknown>
  children: Node[]
  parent: Node | null
  addEventListener: () => void
}
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
const trees: ReturnType<typeof mount>[] = []
function mount(component: Component, props: Record<string, unknown> = {}): { app: Vue.App; root: Node } {
  const root = node('root')
  const app = renderer.createApp(component, props)
  app.config.globalProperties.$t = ((key: string, params?: unknown) => key + (params && typeof params === 'object' && 'count' in params ? `:${params.count}` : '')) as typeof app.config.globalProperties.$t
  for (const [name, tag] of Object.entries({ PageHeader: 'header', Alert: 'section', AlertDescription: 'p', Button: 'button', AppIcon: 'i', NuxtLink: 'a' })) {
    app.component(name, defineComponent({ setup: (_, { slots }) => () => h(tag, slots.default?.()) }))
  }
  app.component('ConfirmDialog', defineComponent({ props: ['open', 'description'], emits: ['confirm', 'cancel'], setup: (props, { emit }) => () => props.open ? h('section', [h('p', String(props.description)), h('button', { 'data-testid': 'confirm', onClick: () => emit('confirm') }, 'Confirm')]) : null }))
  app.component('ModelPickerDialog', defineComponent({ render: () => null }))
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
afterEach(() => {
  trees.splice(0).forEach(({ app }) => app.unmount())
  vi.unstubAllGlobals()
})



/**
 * Per-session turn state, the same shape `useChat` keeps. The header watches it
 * so the model indicator is re-read when a turn starts or ends.
 */
function setup(activity: Record<string, { state: 'running' | 'queued' }> = {}) {
  const apiFetch = vi.fn()
  const sessionActivity = Vue.ref(activity)
  vi.stubGlobal('useApi', () => ({ apiFetch }))
  vi.stubGlobal('useChat', () => ({ sessionActivity }))
  vi.stubGlobal('useI18n', () => ({ t: (key: string, params?: unknown) => key + (params ? JSON.stringify(params) : '') }))
  return Object.assign(apiFetch, { sessionActivity })
}
async function click(root: Node, label: string) {
  const button = all(root).find(n => n.tag === 'button' && text(n).includes(label))!
  expect(button, label).toBeDefined()
  ;(button.props.onClick as () => void)()
  await flush()
}
describe('strand mutation workflows', () => {
  it('optimistically archives, rolls back a busy rejection, and explains the conflict', async () => {
    const api = setup()
    let reject!: (error: unknown) => void
    api.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r }))
    const update = vi.fn()
    const { root } = mount(Actions, { strandId: 's', archived: false, 'onUpdate:archived': update })
    await click(root, 'strandDetail.archive')
    expect(update).toHaveBeenNthCalledWith(1, true)
    reject(new ApiError('private raw details', 409, { code: 'strand_busy' })); await flush()
    expect(update).toHaveBeenNthCalledWith(2, false)
    expect(text(root)).toContain('strandDetail.busy')
    expect(text(root)).not.toContain('private raw')
  })
  it('offers archive undo and patches the original archived state', async () => {
    const api = setup().mockResolvedValue({ strand: {} })
    const { root } = mount(Actions, { strandId: 's', archived: false })
    await click(root, 'strandDetail.archive'); expect(text(root)).toContain('strandDetail.undo')
    await click(root, 'strandDetail.undo')
    expect(api.mock.calls.map(call => call[1].body)).toEqual(['{"archived":true}', '{"archived":false}'])
    expect(text(root)).not.toContain('strandDetail.undo')
  })
  it('loads real preview counts and Now slot before confirmation; keeps facts by default', async () => {
    const api = setup().mockResolvedValue({ messages: 12, captures: 3, attachments: 2, artifacts: 1, facts: [{ id: 1 }], nowSlot: true })
    const deleted = vi.fn()
    const { root } = mount(Actions, { strandId: 's', archived: false, onDeleted: deleted })
    expect(api).not.toHaveBeenCalled()
    await click(root, 'strandDetail.delete')
    expect(api.mock.calls).toEqual([['/api/strands/s/delete-preview']])
    expect(text(root)).toContain('"messages":12')
    expect(text(root)).toContain('strandDetail.nowSlotRemoved')
    const deleteButtons = all(root).filter(n => n.tag === 'button' && text(n).includes('strandDetail.delete'))
    ;(deleteButtons.at(-1)!.props.onClick as () => void)(); await flush()
    expect(api).toHaveBeenCalledTimes(1)
    await click(root, 'Confirm')
    expect(api).toHaveBeenLastCalledWith('/api/strands/s?confirm=1&delete_facts=0', { method: 'DELETE' })
    expect(deleted).toHaveBeenCalledWith('s')
  })
  it('loads detail directly and exposes loading, missing and retry states', async () => {
    const api = setup()
    let reject!: (error: unknown) => void
    api.mockImplementationOnce(() => new Promise((_r, fail) => { reject = fail }))
    const { root } = mount(Header, { strandId: 'beyond-first-page' })
    expect(text(root)).toContain('strandDetail.loading')
    reject(new ApiError('missing', 404)); await flush()
    expect(text(root)).toContain('strandDetail.notFound')
    api.mockResolvedValueOnce({ strand: { id: 'beyond-first-page', title: 'Fetched directly', tags: [], projectId: null } })
    await click(root, 'strandDetail.retry')
    expect(text(root)).toContain('Fetched directly')
    expect(api.mock.calls).toEqual([['/api/strands/beyond-first-page'], ['/api/strands/beyond-first-page']])
  })
  /**
   * Incident 2026-09-24: the header showed gpt-6-astra (the freshly selected
   * global model) while claude-fable-5-1 was still streaming the answer, so a
   * provider error looked like it came from the wrong provider.
   */
  it('names the model of the running turn and re-reads the strand when the turn ends', async () => {
    const base = { id: 's', title: 'Live turn', tags: [], projectId: null, pinned: false }
    const api = setup({ s: { state: 'running' } })
    api.mockResolvedValueOnce({ strand: { ...base, effectiveModel: { providerId: 'openai-codex', modelId: 'gpt-6-astra', source: 'global' }, runningTurnModel: { providerId: 'anthropic', modelId: 'claude-fable-5-1', source: 'global' } } })
    const { root } = mount(Header, { strandId: 's' }); await flush()
    expect(text(root)).toContain('claude-fable-5-1')
    expect(text(root)).toContain('strandDetail.answeringWith')
    expect(text(root)).not.toContain('strandDetail.model: gpt-6-astra')

    api.mockResolvedValueOnce({ strand: { ...base, effectiveModel: { providerId: 'openai-codex', modelId: 'gpt-6-astra', source: 'global' }, runningTurnModel: null } })
    delete api.sessionActivity.value.s
    api.sessionActivity.value = { ...api.sessionActivity.value }
    await flush()
    expect(api.mock.calls).toEqual([['/api/strands/s'], ['/api/strands/s']])
    expect(text(root)).toContain('gpt-6-astra')
    expect(text(root)).not.toContain('strandDetail.answeringWith')
  })

  it.each(['accept', 'dismiss'])('only %ss a project suggestion after explicit action', async action => {
    const strand = { id: 's', title: 'Real title', tags: [], projectId: null, pinned: false, projectSuggestion: { projectId: 'p', projectName: 'Proposal', reason: 'Reason' } }
    const api = setup().mockResolvedValueOnce({ strand }).mockResolvedValueOnce({ strand: { ...strand, projectSuggestion: null, projectId: action === 'accept' ? 'p' : null } })
    const { root } = mount(Header, { strandId: 's' }); await flush()
    expect(text(root)).toContain('Reason')
    expect(api.mock.calls).toEqual([['/api/strands/s']])
    await click(root, 'strandDetail.' + action)
    expect(api).toHaveBeenLastCalledWith('/api/strands/s/project-suggestion/' + action, { method: 'POST' })
    expect(text(root)).not.toContain('Reason')
  })
})
