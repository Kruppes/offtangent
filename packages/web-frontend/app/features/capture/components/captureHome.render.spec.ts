import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { useApi } from '~/composables/useApi'
import * as Vue from 'vue'
import * as captures from '~/api/captures'
import * as now from '~/api/now'
import * as models from '~/api/models'
import * as personas from '~/api/personas'
import * as composerHandoff from '~/composables/useComposerHandoff'
import * as resurfaceApi from '~/api/resurface'
import * as captureParts from '../captureParts'
import * as captureDictation from '../captureDictation'
import * as captureDictationUse from '../useCaptureDictation'
import * as dictationUtils from '~/utils/dictation'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
function loadComponent(path: string): Component {
 const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
 const script = compileScript(descriptor, { id: path, inlineTemplate: true })
 const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } })
 const exports: { default?: Component } = {}
 const modules: Record<string, unknown> = { vue: { ...Vue, vModelText: { mounted: (el: Node, binding: { value: unknown }) => { el.props.value = binding.value }, updated: (el: Node, binding: { value: unknown }) => { el.props.value = binding.value } }, vModelSelect: {} }, '~/api/captures': captures, '~/api/now': now, '~/api/models': models, '~/api/personas': personas, '~/composables/useComposerHandoff': composerHandoff, '~/api/resurface': resurfaceApi, '../captureParts': captureParts, '../captureDictation': captureDictation, '../useCaptureDictation': captureDictationUse, '~/utils/dictation': dictationUtils }
 new Function('require', 'exports', outputText)((name: string) => name === './CaptureDecision.vue' || name === './CaptureParts.vue' ? { default: loadComponent(name) } : modules[name], exports)
 return exports.default!
}
const Home = loadComponent('./CaptureHome.vue')
/** The real dictation bar of the chat composer, reused on Home. */
const DictationBarComponent = loadComponent('../../../components/DictationBar.vue')
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
  app.component('DictationBar', DictationBarComponent)
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
  const states = new Map<string, Vue.Ref<unknown>>()
  vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
    if (!states.has(key)) states.set(key, Vue.ref(init()) as Vue.Ref<unknown>)
    return states.get(key)
  })
  vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }))
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
let resurfaceItems: unknown[] = []
let resurfaceFail = false
let splitLatest = false
/** STT on the server: `GET /api/stt/settings` answers `{ enabled }`. */
let sttConfigured = false
/** Synthetic transcription answer; `hold` keeps the request open (transcribing). */
let transcribe: { status: number; body: unknown; hold?: boolean } = { status: 200, body: { transcript: 'Synthetic spoken words.' } }
let latestKind: string | undefined
let request: ReturnType<typeof vi.fn>
function result(state = status) { return { capture: { id: 'c1', text: 'Roof note', ...(latestKind ? { kind: latestKind } : {}), createdAt: '2026-01-01T12:00:00Z', status: state, strandId: state === 'unsorted' ? null : 's1', attachments: [] }, decision: { id: 'd1', createdAt: '2026-01-01T12:00:01Z', captureId: 'c1', title: 'Roof', action: 'new_strand', confidence: state === 'filed' ? 0.9 : state === 'needs_review' ? 0.55 : 0.2, rationale: 'Related topic', state: state === 'unsorted' ? 'proposed' : 'applied', alternatives: [{ action: 'append', strandId: 's2', title: 'House', confidence: 0.3, reason: 'Possible match' }] } } }
function splitResult() {
 const base = result()
 const part = (index: number, id: string, state: string) => ({ index, title: `Part ${index}`, text: `Synthetic part ${index}.`, sentenceIds: [index + 1], decision: { ...base.decision, id, state } })
 return { ...base, parts: [part(0, 'p0', 'proposed'), part(1, 'p1', 'applied')], partCount: 2 }
}
beforeEach(() => {
 status = 'filed'; max = 7; nowIds = []; nowMode = undefined; failLoad = false; holdLoad = false; saved = false
 resurfaceItems = []; resurfaceFail = false; splitLatest = false
 sttConfigured = false; latestKind = undefined
 transcribe = { status: 200, body: { transcript: 'Synthetic spoken words.' } }
 setupFetch()
 request = vi.fn(async (url: string, _options?: RequestInit) => {
  const path = url.replace('https://test.example', '')
  if (holdLoad && path === '/api/now') return new Promise(() => {})
  if (failLoad && path === '/api/now') return new Response('{}', { status: 500 })
  let data: unknown = {}
  if (path === '/api/stt/settings') return Response.json({ enabled: sttConfigured })
  if (path.startsWith('/api/stt/transcribe')) {
   if (transcribe.hold) return new Promise(() => {})
   return { ok: transcribe.status < 400, status: transcribe.status, json: async () => transcribe.body } as Response
  }
  if (path.startsWith('/api/resurface?')) { if (resurfaceFail) return new Response('{}', { status: 500 }); data = { items: resurfaceItems } }
  else if (path.endsWith('/snooze')) data = {}
  else if (path === '/api/models') data = { models: [] }
  else if (path === '/api/personas/client') data = { personas: [{ id: 'public', displayName: 'Public persona' }] }
  else if (path === '/api/projects') data = { projects: [] }
  else if (path.startsWith('/api/strands/')) data = { strand: { id: path.split('/').pop(), title: 'Resolved destination' } }
  else if (path === '/api/now') { if (_options?.method === 'PUT') nowIds = JSON.parse(_options.body as string).strandIds; data = { strands: nowIds.map(id => ({ id, title: id })), max, ...(nowMode ? { mode: nowMode } : {}) } }
  else if (path.startsWith('/api/strands?')) data = { strands: [{ id: 's2', title: 'House' }] }
  else if (path === '/api/captures' || (splitLatest && /\/(apply|undo|keep-as-one)$/.test(path))) { data = splitLatest && !path.endsWith('/keep-as-one') ? splitResult() : result(); saved = !splitLatest }
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
 /**
  * "Use in question" on a news story hands the article snapshot over; the
  * composer opens with it in the box, unsent, and takes it exactly once.
  */
 it('prefills the box from a composer handoff and consumes it', async () => {
  const store = new Map<string, string>()
  store.set('offtangent.composer.handoff', '--- Off-Tangent news article (board snapshot, not the full text) ---\nTitle: A story\n--- end of article snapshot ---\n\n')
  vi.stubGlobal('window', {
   sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
   },
   matchMedia: () => ({ matches: false }),
  })
  const { root } = mount(Home); await flush()
  expect(all(root).find(n => n.tag === 'textarea')?.props.value).toContain('Title: A story')
  expect(text(root)).toContain('capture.contextAdded')
  expect(store.size).toBe(0)

  // A second visit starts empty instead of resurrecting the snapshot.
  const second = mount(Home); await flush()
  expect(all(second.root).find(n => n.tag === 'textarea')?.props.value).toBe('')
 })
 it('sends a news handoff as its own new strand, with the article title', async () => {
  const store = new Map<string, string>()
  store.set('offtangent.composer.handoff', JSON.stringify({ text: 'Title: A story\n\n', newStrand: true, title: 'A story' }))
  vi.stubGlobal('window', {
   sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
   },
   matchMedia: () => ({ matches: false }),
  })
  const { root } = mount(Home); await flush()
  expect(text(root)).toContain('capture.contextAddedNewStrand')
  await draft(root, 'Title: A story\n\nWas heisst das fuer uns?')
  await send(root)
  const post = request.mock.calls.find(([url, options]) => url === 'https://test.example/api/captures' && (options as RequestInit | undefined)?.method === 'POST')
  expect(post).toBeTruthy()
  const body = JSON.parse((post![1] as RequestInit).body as string)
  expect(body.destination).toBe('new_strand')
  expect(body.strandTitle).toBe('A story')

  // The promise belongs to that one draft: the next capture is routed again.
  await draft(root, 'Ganz normale Notiz')
  await send(root)
  const posts = request.mock.calls.filter(([url, options]) => url === 'https://test.example/api/captures' && (options as RequestInit | undefined)?.method === 'POST')
  const second = JSON.parse((posts[posts.length - 1]![1] as RequestInit).body as string)
  expect(second.destination).toBeUndefined()
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
 it('sends without crypto.randomUUID (http on a LAN address) and keeps the key for a retry', async () => {
  vi.stubGlobal('crypto', {})
  const original = request.getMockImplementation()!
  let failed = false
  request.mockImplementation(async (url: string, options?: RequestInit) => { if (url.endsWith('/api/captures') && !failed) { failed = true; return new Response('{}', { status: 500 }) } return original(url, options) })
  const { root } = mount(Home); await flush(); await draft(root); await send(root)
  expect(text(root)).toContain('capture.sendError')
  expect(all(root).find(n => n.tag === 'textarea')!.props.disabled).toBeFalsy()
  await send(root)
  const calls = request.mock.calls.filter(([url]) => url.endsWith('/api/captures'))
  expect(calls).toHaveLength(2)
  const key = JSON.parse(calls[0]![1].body).clientMessageId
  expect(key).toMatch(/^[A-Za-z0-9._:-]{8,64}$/)
  expect(JSON.parse(calls[1]![1].body).clientMessageId).toBe(key)
  expect(text(root)).not.toContain('capture.sendError')
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
 // Deciding moved to /unsorted (UnsortedPage.render.spec.ts covers proposal titles and manual filing).
 it('shows the unsorted tray only as a counted hint that links to /unsorted', async () => {
  saved = true; status = 'unsorted'
  const { root } = mount(Home); await flush()
  const link = all(root).find(n => n.tag === 'a' && n.props.to === '/unsorted')!
  expect(text(link)).toContain('home.unsortedHint:1')
  expect(all(root).filter(n => n.tag === 'form')).toHaveLength(1)
  expect(text(root)).not.toContain('Roof note')
 })
 it('shows resurface suggestions and snoozes one for seven days', async () => {
  resurfaceItems = [{ strandId: 'q1', title: 'Quiet topic', lastActivity: '2026-01-01T00:00:00Z', reason: 'dormant', tags: [] }]
  const { root } = mount(Home); await flush()
  expect(text(root)).toContain('home.resurface.title'); expect(text(root)).toContain('Quiet topic')
  expect(all(root).some(n => n.tag === 'a' && n.props.to === '/strands/q1')).toBe(true)
  await click(root, 'home.resurface.snooze')
  const call = request.mock.calls.find(([url]) => url.endsWith('/api/resurface/q1/snooze'))!
  expect(JSON.parse(call[1].body)).toEqual({ days: 7 })
  expect(text(root)).toContain('home.resurface.snoozed'); expect(text(root)).not.toContain('Quiet topic')
 })
 it('offers a retry when resurface fails, without blocking Home', async () => {
  resurfaceFail = true
  const { root } = mount(Home); await flush()
  expect(text(root)).toContain('home.resurface.error'); expect(text(root)).toContain('capture.unsorted')
  resurfaceFail = false; resurfaceItems = [{ strandId: 'q2', title: 'Back again', lastActivity: '2026-01-01T00:00:00Z', reason: 'unanswered', tags: [] }]
  await click(all(root).find(n => n.props['data-testid'] === 'resurface')!, 'common.retry')
  expect(text(root)).toContain('Back again')
 })
 it('lets the latest split capture keep, undo and keep-as-one per part', async () => {
  splitLatest = true
  const { root } = mount(Home); await flush(); await draft(root); await send(root)
  expect(all(root).filter(n => n.props['data-testid'] === 'capture-part')).toHaveLength(2)
  await click(all(root).find(n => n.props['data-testid'] === 'capture-part')!, 'home.parts.keep')
  expect(JSON.parse(request.mock.calls.find(([url]) => url.endsWith('/apply'))![1].body)).toEqual({ decisionId: 'p0', partIndex: 0 })
  expect(text(root)).toContain('home.parts.kept')
  await click(all(root).filter(n => n.props['data-testid'] === 'capture-part')[1]!, 'home.parts.undo')
  expect(JSON.parse(request.mock.calls.find(([url]) => url.endsWith('/undo'))![1].body)).toEqual({ partIndex: 1 })
  await click(root, 'home.parts.keepAsOne')
  expect(request.mock.calls.some(([url]) => url.endsWith('/keep-as-one'))).toBe(true)
  expect(text(root)).toContain('home.parts.keptAsOne')
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
 /** W6b: the persona picker starts at the server's capture default. */
 it.each([
  ['public', 'public'],
  ['auto', undefined],
  ['vanished', undefined],
  [undefined, undefined],
 ])('starts the persona picker at the server default %s and sends it', async (serverDefault, sent) => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/api/personas/client')
   ? Response.json({ personas: [{ id: 'public', displayName: 'Public persona' }], ...(serverDefault ? { captureDefaultAgentId: serverDefault } : {}) })
   : original(url, options))
  // The harness stubs `vModelSelect`, so the preselection is proven by what
  // the untouched picker sends.
  const { root } = mount(Home); await flush(); await draft(root)
  await send(root)
  const call = request.mock.calls.find(([url]) => url.endsWith('/api/captures'))!
  const body = JSON.parse(call[1].body) as Record<string, unknown>
  if (sent) expect(body.agentId).toBe(sent)
  else expect(body).not.toHaveProperty('agentId')
 })
 it('root page renders CaptureHome without the old redirect', () => {
  const page = readFileSync(new URL('../../../pages/index.vue', import.meta.url), 'utf8')
  expect(page).toContain('<CaptureHome />')
  expect(page).not.toMatch(/navigateTo|redirect|definePageMeta/)
 })
 /**
  * The dictation contract (W5d, replaces "omits unverified speech controls"):
  * Home asks the server whether STT is configured and shows nothing when it is
  * not; when it is, a recording is transcribed WITHOUT keepAudio, only the
  * text lands in the box, and the capture carries `kind: 'voice'`, never audio.
  */
 it('hides dictation completely and records nothing while STT is not configured', async () => {
  const getUserMedia = stubMicrophone()
  const { root } = mount(Home); await flush()
  expect(request.mock.calls.filter(([url]) => String(url).includes('/api/stt')).map(([url]) => url)).toEqual(['https://test.example/api/stt/settings'])
  expect(byTestId(root, 'capture-dictation-mic')).toHaveLength(0)
  expect(byTestId(root, 'dictation-bar')).toHaveLength(0)
  expect(text(root)).not.toContain('capture.dictation.shortcut')
  await keydown(root, ctrlM)
  expect(getUserMedia).not.toHaveBeenCalled()
  expect(request.mock.calls.some(([url]) => String(url).includes('/api/stt/transcribe'))).toBe(false)
 })
 it('never asks the server to keep the recording (text only, no audio at the capture)', () => {
  const source = readFileSync(new URL('../useCaptureDictation.ts', import.meta.url), 'utf8')
  expect(source).toContain('useStt({ keepAudio: false })')
  expect(readFileSync(new URL('./CaptureHome.vue', import.meta.url), 'utf8')).not.toMatch(/keepAudio|new Blob|pendingAudio/)
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

/* ---- Dictation on Home (W5d) ------------------------------------------- */

class FakeRecorder {
 static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus' }
 state: 'inactive' | 'recording' = 'inactive'
 mimeType = 'audio/webm'
 ondataavailable: ((event: { data: Blob }) => void) | null = null
 onstop: (() => void) | null = null
 start() { this.state = 'recording' }
 stop() {
  this.state = 'inactive'
  this.ondataavailable?.({ data: new Blob(['synthetic-audio'], { type: 'audio/webm' }) })
  this.onstop?.()
 }
}
let clockMs = 0
let dateSpy: { mockRestore(): void } | null = null
/** A fake microphone; `deny` makes the browser refuse it. */
function stubMicrophone(options: { deny?: boolean; onLine?: boolean } = {}) {
 const getUserMedia = vi.fn(async () => {
  if (options.deny) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' })
  return { getTracks: () => [{ stop() {} }] }
 })
 vi.stubGlobal('navigator', { mediaDevices: { getUserMedia }, onLine: options.onLine ?? true })
 vi.stubGlobal('MediaRecorder', FakeRecorder)
 clockMs = 1_000_000
 dateSpy?.mockRestore()
 dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => clockMs)
 return getUserMedia
}
const ctrlM = { key: 'm', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
async function keydown(root: Node, init: Partial<KeyboardEvent>) {
 const form = all(root).find(n => n.tag === 'form')!
 ;(form.props.onKeydown as (e: unknown) => void)({ preventDefault() {}, stopPropagation() {}, ...init })
 await flush()
}
function byTestId(root: Node, id: string) { return all(root).filter(n => n.props['data-testid'] === id) }
function mic(root: Node) { return byTestId(root, 'capture-dictation-mic')[0]! }
function field(root: Node) { return all(root).find(n => n.tag === 'textarea')! }
async function tapMic(root: Node) { (mic(root).props.onClick as () => void)(); await flush() }
/** Start, speak for `ms`, stop: the transcript lands in the box. */
async function dictate(root: Node, ms = 1500) {
 await tapMic(root)
 clockMs += ms
 await tapMic(root)
}
function captureBodies() {
 return request.mock.calls.filter(([url, init]) => url === 'https://test.example/api/captures' && (init as RequestInit | undefined)?.method === 'POST').map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>)
}

describe('Capture Home dictation', () => {
 afterEach(() => { dateSpy?.mockRestore(); dateSpy = null })

 it('dictates into the field, lets the text be edited and sends it marked as dictated only on submit', async () => {
  sttConfigured = true
  const getUserMedia = stubMicrophone()
  const { root } = mount(Home); await flush()
  expect(mic(root).props['aria-label']).toBe('capture.dictation.start')
  expect(mic(root).props['aria-pressed']).toBe(false)
  expect(text(root)).toContain('capture.dictation.shortcut')
  await draft(root, 'Typed start')

  await tapMic(root)
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  expect(byTestId(root, 'dictation-bar')[0]!.props['data-phase']).toBe('recording')
  expect(mic(root).props['aria-pressed']).toBe(true)
  expect(mic(root).props['aria-label']).toBe('capture.dictation.stop')
  // The bar announces the recording to screen readers.
  expect(all(byTestId(root, 'dictation-bar')[0]!).some(n => n.props.role === 'status' && text(n).includes('chat.dictation.recording'))).toBe(true)
  // Sending is blocked while the words are still on their way.
  expect(button(root, 'capture.send').props.disabled).toBe(true)

  clockMs += 1500
  await tapMic(root)
  const stt = request.mock.calls.filter(([url]) => String(url).includes('/api/stt/transcribe'))
  expect(stt.map(([url]) => url)).toEqual(['https://test.example/api/stt/transcribe'])
  expect((stt[0]![1] as RequestInit).body).toBeInstanceOf(FormData)
  // Appended to what was typed, not replacing it; nothing was sent.
  expect(field(root).props.value).toBe('Typed start Synthetic spoken words.')
  expect(captureBodies()).toHaveLength(0)
  expect(byTestId(root, 'capture-dictated')).toHaveLength(1)
  expect(text(byTestId(root, 'capture-dictation-announcement')[0]!)).toContain('capture.dictation.inserted')
  expect(byTestId(root, 'dictation-bar')).toHaveLength(0)

  await draft(root, 'Typed start, then edited spoken words.')
  await send(root)
  const [body] = captureBodies()
  expect(body).toMatchObject({ text: 'Typed start, then edited spoken words.', kind: 'voice', source: 'web', attachments: [] })
  expect(Object.keys(body!).filter(key => /audio|blob|recording/i.test(key))).toEqual([])
  expect(JSON.stringify(body)).not.toMatch(/recording\.webm|audio\//)
  // After the send the box is empty and the mark is gone.
  expect(field(root).props.value).toBe('')
  expect(byTestId(root, 'capture-dictated')).toHaveLength(0)
 })

 it('Ctrl+M starts and stops the recording inside the capture form', async () => {
  sttConfigured = true
  stubMicrophone()
  const { root } = mount(Home); await flush()
  await keydown(root, ctrlM)
  expect(byTestId(root, 'dictation-bar')[0]!.props['data-phase']).toBe('recording')
  clockMs += 900
  await keydown(root, ctrlM)
  expect(field(root).props.value).toBe('Synthetic spoken words.')
 })

 it('Esc cancels a running recording and uploads nothing', async () => {
  sttConfigured = true
  stubMicrophone()
  const { root } = mount(Home); await flush()
  await tapMic(root)
  await keydown(root, { key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
  expect(byTestId(root, 'dictation-bar')).toHaveLength(0)
  expect(request.mock.calls.some(([url]) => String(url).includes('/api/stt/transcribe'))).toBe(false)
  expect(text(byTestId(root, 'capture-dictation-announcement')[0]!)).toContain('capture.dictation.cancelled')
 })

 it('resets the mark when the field is emptied completely and sends a typed capture without kind', async () => {
  sttConfigured = true
  stubMicrophone()
  const { root } = mount(Home); await flush()
  await dictate(root)
  expect(byTestId(root, 'capture-dictated')).toHaveLength(1)
  await draft(root, '   ')
  expect(byTestId(root, 'capture-dictated')).toHaveLength(0)
  await draft(root, 'Typed after all')
  await send(root)
  const [body] = captureBodies()
  expect(body).toMatchObject({ text: 'Typed after all' })
  expect('kind' in body!).toBe(false)
 })

 it('keeps the mark through edits and appends a second dictation', async () => {
  sttConfigured = true
  stubMicrophone()
  const { root } = mount(Home); await flush()
  await dictate(root)
  await draft(root, 'Synthetic spoken words, edited.')
  await dictate(root)
  expect(field(root).props.value).toBe('Synthetic spoken words, edited. Synthetic spoken words.')
  await send(root)
  expect(captureBodies()[0]).toMatchObject({ kind: 'voice' })
 })

 it('shows the transcribing state and keeps send disabled until the text arrived', async () => {
  sttConfigured = true
  stubMicrophone()
  transcribe = { status: 200, body: {}, hold: true }
  const { root } = mount(Home); await flush()
  await draft(root, 'Typed start')
  await dictate(root)
  const bar = byTestId(root, 'dictation-bar')[0]!
  expect(bar.props['data-phase']).toBe('transcribing')
  expect(text(bar)).toContain('chat.dictation.transcribing')
  // W6b: inert via aria-disabled instead of `disabled`, so keyboard focus stays on the mic.
  expect(mic(root).props['aria-disabled']).toBe('true')
  expect(mic(root).props.disabled).toBeFalsy()
  await tapMic(root)
  expect(byTestId(root, 'dictation-bar')[0]!.props['data-phase']).toBe('transcribing')
  expect(mic(root).props['aria-label']).toBe('capture.dictation.transcribing')
  expect(button(root, 'capture.send').props.disabled).toBe(true)
  expect(field(root).props.value).toBe('Typed start')
 })

 it('a refused microphone shows the permission error and keeps the typed text', async () => {
  sttConfigured = true
  stubMicrophone({ deny: true })
  const { root } = mount(Home); await flush()
  await draft(root, 'Typed and kept')
  await tapMic(root)
  const error = byTestId(root, 'dictation-error')[0]!
  expect(error.props['data-error']).toBe('permission_denied')
  expect(error.props.role).toBe('alert')
  expect(text(error)).toContain('chat.dictation.errors.permission_help')
  expect(field(root).props.value).toBe('Typed and kept')
  expect(byTestId(root, 'capture-dictated')).toHaveLength(0)
  expect(button(root, 'capture.send').props.disabled).toBe(false)
 })

 it('a failed transcription keeps the text, offers a retry and inserts the words on success', async () => {
  sttConfigured = true
  stubMicrophone()
  transcribe = { status: 502, body: { error: 'provider down' } }
  const { root } = mount(Home); await flush()
  await draft(root, 'Typed and kept')
  await dictate(root)
  expect(byTestId(root, 'dictation-error')[0]!.props['data-error']).toBe('transcribe_error')
  // Home keeps no audio: its own wording, never the chat's "the recording is kept".
  expect(text(root)).toContain('capture.dictation.errors.transcribe_error')
  expect(text(root)).not.toContain('chat.dictation.errors.transcribe_error')
  expect(field(root).props.value).toBe('Typed and kept')
  expect(byTestId(root, 'capture-dictated')).toHaveLength(0)
  transcribe = { status: 200, body: { transcript: 'Synthetic spoken words.' } }
  await click(root, 'chat.dictation.retry')
  expect(field(root).props.value).toBe('Typed and kept Synthetic spoken words.')
  expect(byTestId(root, 'capture-dictated')).toHaveLength(1)
 })

 it('says offline when the upload fails without network', async () => {
  sttConfigured = true
  stubMicrophone({ onLine: false })
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => String(url).includes('/api/stt/transcribe') ? Promise.reject(new TypeError('Failed to fetch')) : original(url, options))
  const { root } = mount(Home); await flush()
  await draft(root, 'Typed and kept')
  await dictate(root)
  expect(byTestId(root, 'dictation-error')[0]!.props['data-error']).toBe('offline')
  expect(text(root)).toContain('capture.dictation.errors.offline')
  expect(text(root)).not.toContain('chat.dictation.errors.offline')
  expect(field(root).props.value).toBe('Typed and kept')
 })

 it('marks a dictated capture in the latest decision card', async () => {
  sttConfigured = true
  latestKind = 'voice'
  const { root } = mount(Home); await flush(); await draft(root); await send(root)
  expect(byTestId(root, 'capture-dictated-badge')).toHaveLength(1)
  expect(text(root)).toContain('capture.dictation.badge')
 })
 it('shows no dictation badge for a typed capture', async () => {
  latestKind = 'text'
  const { root } = mount(Home); await flush(); await draft(root); await send(root)
  expect(byTestId(root, 'capture-dictated-badge')).toHaveLength(0)
 })
})
