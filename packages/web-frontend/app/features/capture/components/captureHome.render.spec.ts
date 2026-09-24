import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { useApi } from '~/composables/useApi'
import * as Vue from 'vue'
import * as captures from '~/api/captures'
import * as now from '~/api/now'
import * as models from '~/api/models'
import * as personas from '~/api/personas'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
function loadComponent(path: string): Component {
 const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
 const script = compileScript(descriptor, { id: path, inlineTemplate: true })
 const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } })
 const exports: { default?: Component } = {}
 const modules: Record<string, unknown> = { vue: { ...Vue, vModelText: { mounted: (el: Node, binding: { value: unknown }) => { el.props.value = binding.value }, updated: (el: Node, binding: { value: unknown }) => { el.props.value = binding.value } }, vModelSelect: {} }, '~/api/captures': captures, '~/api/now': now, '~/api/models': models, '~/api/personas': personas }
 new Function('require', 'exports', outputText)((name: string) => name === './CaptureDecision.vue' ? { default: loadComponent(name) } : modules[name], exports)
 return exports.default!
}
const Home = loadComponent('./CaptureHome.vue')
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


let status = 'filed'
let max = 7
let nowIds: string[] = []
let failLoad = false
let holdLoad = false
let saved = false
/** `undefined` = a backend without the setting, i.e. the curated set. */
let nowMode: 'auto' | 'manual' | undefined
let request: ReturnType<typeof vi.fn>
function result(state = status) { return { capture: { id: 'c1', text: 'Roof note', createdAt: '2026-01-01T12:00:00Z', status: state, strandId: state === 'unsorted' ? null : 's1', attachments: [] }, decision: { id: 'd1', createdAt: '2026-01-01T12:00:01Z', captureId: 'c1', title: 'Roof', action: 'new_strand', confidence: state === 'filed' ? 0.9 : state === 'needs_review' ? 0.55 : 0.2, rationale: 'Related topic', state: state === 'unsorted' ? 'proposed' : 'applied', alternatives: [{ action: 'append', strandId: 's2', title: 'House', confidence: 0.3, reason: 'Possible match' }] } } }
beforeEach(() => {
 status = 'filed'; max = 7; nowIds = []; nowMode = undefined; failLoad = false; holdLoad = false; saved = false
 setupFetch()
 request = vi.fn(async (url: string, _options?: RequestInit) => {
  const path = url.replace('https://test.example', '')
  if (holdLoad && path === '/api/now') return new Promise(() => {})
  if (failLoad && path === '/api/now') return new Response('{}', { status: 500 })
  let data: unknown = {}
  if (path === '/api/models') data = { models: [] }
  else if (path === '/api/personas/client') data = { personas: [{ id: 'public', displayName: 'Public persona' }] }
  else if (path === '/api/projects') data = { projects: [] }
  else if (path.startsWith('/api/strands/')) data = { strand: { id: path.split('/').pop(), title: 'Resolved destination' } }
  else if (path === '/api/now') { if (_options?.method === 'PUT') nowIds = JSON.parse(_options.body as string).strandIds; data = { strands: nowIds.map(id => ({ id, title: id })), max, ...(nowMode ? { mode: nowMode } : {}) } }
  else if (path.startsWith('/api/strands?')) data = { strands: [{ id: 's2', title: 'House' }] }
  else if (path === '/api/captures') { data = result(); saved = true }
  else if (path.endsWith('/undo')) { status = 'unsorted'; data = result() }
  else if (path.endsWith('/apply')) { status = 'filed'; data = result() }
  else if (path.startsWith('/api/captures?')) data = saved && path.includes('status=' + status) && status !== 'filed' ? { captures: [result().capture], decisions: [result().decision] } : { captures: [], decisions: [] }
  else if (path === '/api/uploads') data = { uploads: [{ originalName: 'a.txt', relativePath: 'a', storedName: 'a', urlPath: '/uploads/a' }, { originalName: 'b.txt', relativePath: 'b', storedName: 'b', urlPath: '/uploads/b' }] }
  return new Response(JSON.stringify(data))
 })
 vi.stubGlobal('fetch', request)
})
function button(root: Node, label: string) { return all(root).find(n => n.tag === 'button' && text(n).includes(label))! }
async function click(root: Node, label: string) { (button(root, label).props.onClick as () => void)(); await flush() }
async function draft(root: Node, value = 'Roof note') {
 const field = all(root).find(n => n.tag === 'textarea')!
 ;(field.props['onUpdate:modelValue'] as (v: string) => void)(value)
 await nextTick()
}
async function send(root: Node) { (all(root).find(n => n.tag === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await flush() }
describe('Capture Home rendered', () => {
 it.each(['filed', 'needs_review', 'unsorted'])('sends text and renders the %s router outcome and alternatives', async state => {
  status = state
  const { root } = mount(Home); await flush(); await draft(root); await send(root)
  expect(text(root)).toContain('capture.status.' + state)
  expect(text(root)).toContain('Related topic'); expect(text(root)).toContain('Possible match')
  const call = request.mock.calls.find(([url]) => url === 'https://test.example/api/captures')!
  expect(JSON.parse(call[1].body)).toMatchObject({ text: 'Roof note', source: 'web', attachments: [], clientMessageId: expect.any(String) })
  expect(all(root).find(n => n.tag === 'textarea')?.props.value).toBe('')
 })
 it('undo returns to the unsorted tray and can be applied again', async () => {
  const { root } = mount(Home); await flush(); await draft(root); await send(root); await click(root, 'capture.undo')
  expect(text(root)).toContain('capture.undone'); expect(text(root)).toContain('capture.status.unsorted')
  expect(request.mock.calls.find(([url]) => url.endsWith('/undo'))?.[1].body).toBe('{}')
  await click(root, 'capture.apply'); expect(text(root)).toContain('capture.status.filed')
 })
 it('renders the API resolved limit, including a non-default value', async () => {
  max = 9
  const { root } = mount(Home); await flush()
  expect(text(root)).toContain('0 / 9'); expect(text(root)).toContain('capture.nowEmpty')
 })
 it('sends with Ctrl+Enter but ignores IME composition', async () => {
  const { root } = mount(Home); await flush(); await draft(root)
  const key = all(root).find(n => n.tag === 'textarea')!.props.onKeydown as (e: unknown) => void
  key({ key: 'Enter', ctrlKey: true, isComposing: true, preventDefault() {} }); await flush()
  expect(request.mock.calls.some(([url]) => url.endsWith('/api/captures'))).toBe(false)
  key({ key: 'Enter', ctrlKey: true, isComposing: false, preventDefault() {} }); await flush()
  expect(request.mock.calls.some(([url]) => url.endsWith('/api/captures'))).toBe(true)
 })
 it('updates Now with selected IDs using the API, without an invented size', async () => {
  const { root } = mount(Home); await flush()
  const selects = all(root).filter(n => n.tag === 'select')
  ;(selects[2]!.props['onUpdate:modelValue'] as (v: string) => void)('s2'); await nextTick()
  await click(root, 'capture.updateNow')
  const call = request.mock.calls.find(([url, options]) => url.endsWith('/api/now') && options?.method === 'PUT')!
  expect(JSON.parse(call[1].body)).toEqual({ strandIds: ['s2'] })
 })
 it('enforces the resolved full limit, swaps a slot and clears Now', async () => {
  max = 1; nowIds = ['s1']
  const { root } = mount(Home); await flush()
  const selects = all(root).filter(n => n.tag === 'select')
  ;(selects[2]!.props['onUpdate:modelValue'] as (v: string) => void)('s2'); await nextTick()
  expect(button(root, 'capture.updateNow').props.disabled).toBe(true)
  ;(selects[3]!.props['onUpdate:modelValue'] as (v: string) => void)('s1'); await nextTick()
  expect(button(root, 'capture.updateNow').props.disabled).toBe(false)
  await click(root, 'capture.updateNow'); expect(nowIds).toEqual(['s2'])
  await click(root, 'capture.clearNow'); expect(nowIds).toEqual([])
 })
 it('hides every now control in auto mode and explains where the list comes from', async () => {
  nowMode = 'auto'; max = 1; nowIds = ['s1']
  const { root } = mount(Home); await flush()
  expect(text(root)).toContain('capture.nowAutoHint')
  // No writing controls: PUT /api/now answers 409 in this mode.
  for (const label of ['capture.updateNow', 'capture.clearNow', 'capture.remove']) {
    expect(all(root).some(n => n.tag === 'button' && text(n).includes(label))).toBe(false)
  }
  // The "now is full" line belongs to the curated set only.
  expect(text(root)).not.toContain('capture.nowFull')
  expect(text(root)).toContain('s1')
 })
 it('keeps the manual controls when the backend reports manual', async () => {
  nowMode = 'manual'; max = 1; nowIds = ['s1']
  const { root } = mount(Home); await flush()
  expect(text(root)).not.toContain('capture.nowAutoHint')
  expect(all(root).some(n => n.tag === 'button' && text(n).includes('capture.updateNow'))).toBe(true)
  expect(text(root)).toContain('capture.nowFull')
 })
 it('renders loading, error with working retry, and empty states', async () => {
  holdLoad = true
  const first = mount(Home); expect(all(first.root).some(n => n.props['data-testid'] === 'skeleton')).toBe(true)
  holdLoad = false; failLoad = true
  const { root } = mount(Home); await flush(); expect(text(root)).toContain('capture.loadError')
  failLoad = false; await click(root, 'common.retry'); expect(text(root)).toContain('capture.empty')
 })
 it('uploads multiple files, shows removable chips and submits descriptors', async () => {
  const { root } = mount(Home); await flush()
  const input = all(root).find(n => n.tag === 'input' && n.props.type === 'file')!
  await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')], value: '' } }); await flush()
  expect(text(root)).toContain('a.txt'); expect(text(root)).toContain('b.txt')
  await draft(root); await send(root)
  expect(JSON.parse(request.mock.calls.find(([url]) => url === 'https://test.example/api/captures')![1].body).attachments).toHaveLength(2)
 })
 it('retains the draft and idempotency key on a failed send and retries', async () => {
  const original = request.getMockImplementation()!
  let failed = false
  request.mockImplementation(async (url: string, options?: RequestInit) => { if (url.endsWith('/api/captures') && !failed) { failed = true; return new Response('{}', { status: 500 }) } return original(url, options) })
  const { root } = mount(Home); await flush(); await draft(root); await send(root)
  expect(text(root)).toContain('capture.sendError'); await send(root)
  const calls = request.mock.calls.filter(([url]) => url.endsWith('/api/captures'))
  expect(JSON.parse(calls[0]![1].body).clientMessageId).toBe(JSON.parse(calls[1]![1].body).clientMessageId)
 })
 it('uses only authenticated public persona catalog, preserving models if it fails', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => {
   if (url.endsWith('/api/personas/client')) return new Response('{}', { status: 500 })
   if (url.endsWith('/api/models')) return new Response(JSON.stringify({ models: [{ providerId: 'p', modelId: 'm', providerName: 'Provider', displayName: 'Independent model', selectable: true }] }))
   return original(url, options)
  })
  const { root } = mount(Home); await flush()
  expect(text(root)).toContain('Independent model')
  expect(text(root)).toContain('capture.optionsError')
  expect(request.mock.calls.some(([url]) => url.endsWith('/api/personas'))).toBe(false)
  expect(request.mock.calls.find(([url]) => url.endsWith('/api/personas/client'))?.[1].headers.Authorization).toBe('Bearer test-token')
 })
 it('renders accessible confidence, review band, raw capture and expanded low-confidence alternatives', async () => {
  status = 'needs_review'
  const { root } = mount(Home); await flush(); await draft(root); await send(root)
  const bar = all(root).find(n => n.props.role === 'progressbar')!
  expect(bar.props['aria-valuenow']).toBe(55)
  expect(bar.props['aria-valuemin']).toBe(0)
  expect(bar.props['aria-valuemax']).toBe(100)
  expect(all(root).some(n => n.props['data-testid'] === 'review-band')).toBe(true)
  expect(all(root).find(n => n.tag === 'details')?.props.open).toBe(true)
  expect(all(root).find(n => n.props['data-testid'] === 'capture-excerpt')?.text).toBe('Roof note')
 })
 it('resolves append proposal outside candidate list by decision.strandId', async () => {
  saved = true; status = 'unsorted'
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => {
   if (url.includes('/api/captures?status=unsorted')) {
    const r = result(); return new Response(JSON.stringify({ captures: [r.capture], decisions: [{ ...r.decision, action: 'append', strandId: 'outside', title: null }] }))
   }
   return original(url, options)
  })
  const { root } = mount(Home); await flush()
  expect(text(root)).toContain('Resolved destination')
  expect(request.mock.calls.some(([url]) => url.endsWith('/api/strands/outside'))).toBe(true)
 })
 it('manually files an unsorted capture into a new named strand', async () => {
  saved = true; status = 'unsorted'
  const { root } = mount(Home); await flush()
  const field = all(root).find(n => n.tag === 'input' && n.props.type === 'text')!
  ;(field.props['onUpdate:modelValue'] as (v: string) => void)('Better destination'); await nextTick()
  const form = all(root).filter(n => n.tag === 'form')[1]!
  ;(form.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await flush()
  expect(JSON.parse(request.mock.calls.find(([url]) => url.endsWith('/apply'))![1].body)).toEqual({ decisionId: 'd1', action: 'new_strand', title: 'Better destination' })
 })
 it('selects newest matching decision independent of server ordering', () => {
  const d = result().decision
  const decisions = [{ ...d, id: 'old', createdAt: '2025-01-01' }, { ...d, id: 'other', captureId: 'c2', createdAt: '2027-01-01' }, { ...d, id: 'new', createdAt: '2026-01-01' }]
  expect(captures.newestDecision('c1', decisions as unknown as captures.Decision[])?.id).toBe('new')
 })
 it('sends the supported persona hint and paired per-turn model fields', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/api/models')
   ? Response.json({ models: [{ providerId: 'chosen', modelId: 'model', providerName: 'Provider', displayName: 'Model', selectable: true }] })
   : original(url, options))
  const { root } = mount(Home); await flush(); await draft(root)
  const selects = all(root).filter(n => n.tag === 'select')
  ;(selects[0]!.props['onUpdate:modelValue'] as (v: string) => void)('public')
  ;(selects[1]!.props['onUpdate:modelValue'] as (v: string) => void)(JSON.stringify(['chosen', 'model']))
  await nextTick(); await send(root)
  const call = request.mock.calls.find(([url]) => url.endsWith('/api/captures'))!
  expect(JSON.parse(call[1].body)).toMatchObject({ agentId: 'public', modelProviderId: 'chosen', modelId: 'model' })
 })
 it('root page renders CaptureHome without the old redirect', () => {
  const page = readFileSync(new URL('../../../pages/index.vue', import.meta.url), 'utf8')
  expect(page).toContain('<CaptureHome />')
  expect(page).not.toMatch(/navigateTo|redirect|definePageMeta/)
 })
 it('omits unverified speech controls and makes no STT requests', async () => {
  const { root } = mount(Home); await flush()
  expect(text(root)).not.toContain('capture.record')
  expect(request.mock.calls.some(([url]) => url.includes('/api/stt'))).toBe(false)
  expect(readFileSync(new URL('./CaptureHome.vue', import.meta.url), 'utf8')).not.toContain('useStt')
 })
 it('honestly displays the answered-capture moved response, not a fake Unsorted success', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => {
   if (url.endsWith('/undo')) {
    const r = result('moved'); r.decision.state = 'undone'
    return Response.json(r)
   }
   return original(url, options)
  })
  const { root } = mount(Home); await flush(); await draft(root); await send(root)
  await click(root, 'capture.undo')
  expect(text(root)).toContain('capture.undoAfterAnswer')
  expect(text(root)).toContain('capture.status.moved')
  expect(text(root)).toContain('capture.openStrand')
  expect(text(root)).not.toContain('capture.undone')
  expect(text(root)).not.toContain('capture.status.unsorted')
 })
 it('keeps Home scrollable with mobile bottom padding', () => {
  const page = readFileSync(new URL('../../../pages/index.vue', import.meta.url), 'utf8')
  expect(page).toContain('min-h-0 flex-1 overflow-y-auto pb-20')
 })

 it.each(['admin', 'user'])('loads public client personas for %s without admin-only requests', async role => {
  vi.stubGlobal('useAuth', () => ({ getAccessToken: () => role + '-token' }))
  const { root } = mount(Home); await flush()
  expect(text(root)).toContain('Public persona')
  expect(request.mock.calls.some(([url]) => url.endsWith('/api/personas') || url.endsWith('/api/health'))).toBe(false)
  expect(request.mock.calls.find(([url]) => url.endsWith('/api/personas/client'))?.[1].headers.Authorization).toBe('Bearer ' + role + '-token')
 })
 it.each(['needs_review', 'unsorted', 'failed', 'filed'])('shows review based on status or low confidence: %s', async state => {
  const r = result(state)
  r.decision.confidence = state === 'filed' ? .69 : .99
  const Decision = loadComponent('./CaptureDecision.vue')
  const { root } = mount(defineComponent({ setup: () => () => h(Decision, { result: r, busy: false }) }))
  expect(all(root).some(n => n.props['data-testid'] === 'review-band')).toBe(true)
 })
 it('does not show review for a high confidence filed capture', () => {
  const Decision = loadComponent('./CaptureDecision.vue')
  const { root } = mount(defineComponent({ setup: () => () => h(Decision, { result: result('filed'), busy: false }) }))
  expect(all(root).some(n => n.props['data-testid'] === 'review-band')).toBe(false)
  expect(all(root).find(n => n.tag === 'details')?.props.open).toBe(false)
 })
 it('shows backend upload rejection details as text', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/api/uploads') ? new Response(JSON.stringify({ error: 'Maximum 3 files allowed' }), { status: 400 }) : original(url, options))
  const { root } = mount(Home); await flush()
  const input = all(root).find(n => n.tag === 'input' && n.props.type === 'file')!
  await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { files: [new File(['a'], 'a.txt')], value: '' } }); await flush()
  expect(text(root)).toContain('Maximum 3 files allowed')
  expect(text(root)).toContain('capture.uploadLimit')
 })

})
