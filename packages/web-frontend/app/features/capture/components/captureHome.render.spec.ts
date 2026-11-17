import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { useApi } from '~/composables/useApi'
import * as Vue from 'vue'
import * as captures from '~/api/captures'
import * as now from '~/api/now'
import * as models from '~/api/models'
import * as personas from '~/api/personas'
import * as composerHandoff from '~/composables/useComposerHandoff'
import * as fileDrop from '~/composables/chat/useFileDrop'
import * as resurfaceApi from '~/api/resurface'
import * as captureParts from '../captureParts'
import * as captureDictation from '../captureDictation'
import * as captureDictationUse from '../useCaptureDictation'
import * as dictationUtils from '~/utils/dictation'
import * as thinkingLevel from '~/composables/chat/useThinkingLevel'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
function loadComponent(path: string): Component {
 const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
 const script = compileScript(descriptor, { id: path, inlineTemplate: true })
 const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } })
 const exports: { default?: Component } = {}
 const modules: Record<string, unknown> = { vue: { ...Vue, vModelText: { mounted: (el: Node, binding: { value: unknown }) => { el.props.value = binding.value }, updated: (el: Node, binding: { value: unknown }) => { el.props.value = binding.value } }, vModelSelect: {} }, '~/api/captures': captures, '~/api/now': now, '~/api/models': models, '~/api/personas': personas, '~/composables/useComposerHandoff': composerHandoff, '~/composables/chat/useFileDrop': fileDrop, '~/api/resurface': resurfaceApi, '../captureParts': captureParts, '../captureDictation': captureDictation, '../useCaptureDictation': captureDictationUse, '~/utils/dictation': dictationUtils, '~/composables/chat/useThinkingLevel': thinkingLevel }
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
  app.config.globalProperties.$t = ((key: string, params?: unknown) => (key === 'capture.thinking.saveError' && saveErrorParams.push(params), key) + (params && typeof params === 'object' && 'count' in params ? `:${params.count}` : '')) as typeof app.config.globalProperties.$t
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
  vi.stubGlobal('useAuth', () => ({ getAccessToken: () => 'test-token', ...(authUser ? { user: authUser } : asAdmin ? { user: Vue.ref({ id: 1, role: 'admin' }) } : {}) }))
  vi.stubGlobal('useModelConsentDialog', () => ({ request: async () => false }))
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
  // The thinking level is shared page-wide; every test starts from an empty page.
  thinkingLevel.resetThinkingLevelForTest()
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
/** W7 D1: the server stored the capture, filing waits for the agent core (202). */
let routingPending = false
/** STT on the server: `GET /api/stt/settings` answers `{ enabled }`. */
let sttConfigured = false
/** Synthetic transcription answer; `hold` keeps the request open (transcribing). */
let transcribe: { status: number; body: unknown; hold?: boolean } = { status: 200, body: { transcript: 'Synthetic spoken words.' } }
let latestKind: string | undefined
/** Thinking level (global setting): admin session, stored level, read/save failures, held PUT. */
let asAdmin = false
/** Set to drive the signed-in user by hand (identity arriving after the mount). */
let authUser: Vue.Ref<{ id: number; role: string } | null> | null = null
let settingsLevel: string | undefined = 'high'
let settingsReadFail = false
let settingsPutFail = false
/** The PUT gets no answer (network error): unclear whether it was stored. */
let settingsPutLost = false
/** Params passed to `capture.thinking.saveError`, to check the level it names. */
const saveErrorParams: unknown[] = []
let releasePut: (() => void) | null = null
let holdPut = false
let request: ReturnType<typeof vi.fn>
function result(state = status) { return { capture: { id: 'c1', text: 'Roof note', ...(latestKind ? { kind: latestKind } : {}), createdAt: '2026-01-01T12:00:00Z', status: state, strandId: state === 'unsorted' ? null : 's1', attachments: [] }, decision: { id: 'd1', createdAt: '2026-01-01T12:00:01Z', captureId: 'c1', title: 'Roof', action: 'new_strand', confidence: state === 'filed' ? 0.9 : state === 'needs_review' ? 0.55 : 0.2, rationale: 'Related topic', state: state === 'unsorted' ? 'proposed' : 'applied', alternatives: [{ action: 'append', strandId: 's2', title: 'House', confidence: 0.3, reason: 'Possible match' }] } } }
function splitResult() {
 const base = result()
 const part = (index: number, id: string, state: string) => ({ index, title: `Part ${index}`, text: `Synthetic part ${index}.`, sentenceIds: [index + 1], decision: { ...base.decision, id, state } })
 return { ...base, parts: [part(0, 'p0', 'proposed'), part(1, 'p1', 'applied')], partCount: 2 }
}
beforeEach(() => {
 status = 'filed'; max = 7; nowIds = []; nowMode = undefined; failLoad = false; holdLoad = false; saved = false
 resurfaceItems = []; resurfaceFail = false; splitLatest = false; routingPending = false
 sttConfigured = false; latestKind = undefined
 asAdmin = false; authUser = null; settingsLevel = 'high'; settingsReadFail = false; settingsPutFail = false; settingsPutLost = false; saveErrorParams.length = 0; releasePut = null; holdPut = false
 transcribe = { status: 200, body: { transcript: 'Synthetic spoken words.' } }
 setupFetch()
 request = vi.fn(async (url: string, _options?: RequestInit) => {
  const path = url.replace('https://test.example', '')
  if (holdLoad && path === '/api/now') return new Promise(() => {})
  if (failLoad && path === '/api/now') return new Response('{}', { status: 500 })
  let data: unknown = {}
  if (path === '/api/stt/settings') return Response.json({ enabled: sttConfigured })
  if (path === '/api/settings') {
   if (_options?.method === 'PUT') {
    if (settingsPutLost) throw new TypeError('Failed to fetch')
    const finish = () => settingsPutFail ? new Response('{}', { status: 500 }) : (settingsLevel = JSON.parse(_options.body as string).thinkingLevel, new Response(JSON.stringify({ thinkingLevel: settingsLevel, message: 'ok' })))
    if (holdPut) return new Promise<Response>(resolve => { releasePut = () => resolve(finish()) })
    return finish()
   }
   if (settingsReadFail) return new Response('{}', { status: 500 })
   return new Response(JSON.stringify(settingsLevel ? { thinkingLevel: settingsLevel } : {}))
  }
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
  else if (path === '/api/captures' && routingPending) { saved = true; return new Response(JSON.stringify({ ...result('unsorted'), code: 'routing_pending' }), { status: 202 }) }
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
/**
 * A real click on the send button (`data-testid="send"`), as the browser does
 * it: a disabled button does nothing; an enabled `type="submit"` button runs its
 * own click handler (none here) and then submits its form.
 */
async function clickSend(root: Node): Promise<boolean> {
 const target = all(root).find(n => n.props['data-testid'] === 'send')!
 expect(target.tag).toBe('button')
 expect(target.props.type).toBe('submit')
 if (target.props.disabled) return false
 ;(target.props.onClick as ((e: unknown) => void) | undefined)?.({ preventDefault() {} })
 let form = target.parent
 while (form && form.tag !== 'form') form = form.parent
 ;(form!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await flush()
 return true
}
describe('Capture Home rendered', () => {
 it('says "saved, routing pending" on a 202 and clears the box (no retry of a stored capture)', async () => {
  routingPending = true
  const { root } = mount(Home); await flush(); await draft(root); await send(root)
  expect(text(root)).toContain('capture.routingPending')
  expect(text(root)).not.toContain('capture.sendError')
  expect(all(root).find(n => n.tag === 'textarea')?.props.value).toBe('')
  expect(request.mock.calls.filter(([url]) => url === 'https://test.example/api/captures')).toHaveLength(1)
 })
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
 /**
  * The "New strand (skip router)" toggle: off by default, sends
  * `forceNewStrand: true` for exactly one capture and switches itself off
  * again after a successful send. A failed send keeps it with the draft.
  */
 it('offers the skip-router toggle, sends forceNewStrand once and switches it off after the send', async () => {
  const { root } = mount(Home); await flush()
  const toggle = () => byTestId(root, 'capture-force-new-strand')[0]!
  expect(toggle()).toBeTruthy()
  expect(toggle().props.type).toBe('checkbox')
  expect(toggle().props.checked).toBe(false)
  expect(text(root)).toContain('capture.forceNewStrand')

  ;(toggle().props.onChange as (e: unknown) => void)({ target: { checked: true } })
  await nextTick()
  expect(toggle().props.checked).toBe(true)
  await draft(root, 'Start something new')
  await send(root)
  const [first] = captureBodies()
  expect(first).toMatchObject({ text: 'Start something new', source: 'web', forceNewStrand: true })
  expect(first!.destination).toBeUndefined()
  expect(toggle().props.checked).toBe(false)

  await draft(root, 'A routed thought')
  await send(root)
  const bodies = captureBodies()
  expect(bodies).toHaveLength(2)
  expect(bodies[1]!.forceNewStrand).toBeUndefined()
 })
 it('keeps the skip-router toggle on when the send fails', async () => {
  const { root } = mount(Home); await flush()
  const toggle = () => byTestId(root, 'capture-force-new-strand')[0]!
  ;(toggle().props.onChange as (e: unknown) => void)({ target: { checked: true } })
  await nextTick()
  const ok = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => url === 'https://test.example/api/captures' && options?.method === 'POST' ? new Response('{}', { status: 500 }) : ok(url, options))
  await draft(root, 'Will fail')
  await send(root)
  expect(text(root)).toContain('capture.sendError')
  expect(toggle().props.checked).toBe(true)
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
 async function paste(root: Node, files: File[], plain = '', html = '') {
  const preventDefault = vi.fn()
  const field = all(root).find(n => n.tag === 'textarea')!
  await (field.props.onPaste as (e: unknown) => void)({ clipboardData: {
   files, types: ['Files'], getData: (type: string) => type === 'text/plain' ? plain : type === 'text/html' ? html : '',
  }, preventDefault })
  await flush()
  return preventDefault
 }
 it('pastes a nameless screenshot as a chip and submits its descriptor with the draft', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => {
   if (!url.endsWith('/api/uploads')) return original(url, options)
   const file = (options?.body as FormData).get('files') as File
   expect(file.name).toMatch(/^paste-.*\.png$/)
   return new Response(JSON.stringify({ uploads: [{ originalName: file.name, relativePath: 'synthetic-paste', storedName: 'synthetic-paste', urlPath: '/uploads/synthetic-paste' }] }))
  })
  const { root } = mount(Home); await flush(); await draft(root, 'Keep this screenshot')
  const preventDefault = await paste(root, [new File(['synthetic pixels'], '', { type: 'image/png' })])
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(request.mock.calls.filter(([url]) => url.endsWith('/api/uploads'))).toHaveLength(1)
  expect(text(root)).toMatch(/paste-.*\.png/)
  expect(text(root)).toContain('capture.filesAttached:1')
  await send(root)
  const capture = JSON.parse(request.mock.calls.find(([url]) => url.endsWith('/api/captures'))![1].body)
  expect(capture).toMatchObject({ text: 'Keep this screenshot', attachments: [{ originalName: expect.stringMatching(/^paste-.*\.png$/), relativePath: 'synthetic-paste' }] })
 })
 it('leaves a meaningful text paste to the browser without uploading a clipboard image', async () => {
  const { root } = mount(Home); await flush()
  const prevented = await paste(root, [new File(['pixels'], 'synthetic.png', { type: 'image/png' })], 'Meaningful words')
  expect(prevented).not.toHaveBeenCalled()
  expect(request.mock.calls.filter(([url]) => url.endsWith('/api/uploads'))).toHaveLength(0)
 })
 it('shows the 413 upload error while retaining typed text after a screenshot paste', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/api/uploads')
   ? new Response(JSON.stringify({ error: 'Synthetic large upload' }), { status: 413 }) : original(url, options))
  const { root } = mount(Home); await flush(); await draft(root, 'Important typed text')
  await paste(root, [new File(['pixels'], 'synthetic.png', { type: 'image/png' })])
  expect(text(root)).toContain('capture.uploadTooLarge')
  expect(all(root).find(n => n.tag === 'textarea')?.props.value).toBe('Important typed text')
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

 it('sends a dictated capture with the skip-router toggle as forceNewStrand voice capture', async () => {
  sttConfigured = true
  stubMicrophone()
  const { root } = mount(Home); await flush()
  ;(byTestId(root, 'capture-force-new-strand')[0]!.props.onChange as (e: unknown) => void)({ target: { checked: true } })
  await nextTick()
  await dictate(root)
  await send(root)
  const [body] = captureBodies()
  expect(body).toMatchObject({ text: 'Synthetic spoken words.', kind: 'voice', forceNewStrand: true })
  expect(byTestId(root, 'capture-force-new-strand')[0]!.props.checked).toBe(false)
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

/**
 * Thinking level on Home: the same global setting and logic as the strand
 * composer (`useThinkingLevel`), shown as readable text to admins only.
 */
describe('Capture Home thinking level', () => {
 const thinking = (root: Node) => byTestId(root, 'capture-thinking-select')[0]
 const settingsCalls = () => request.mock.calls.filter(([url]) => url === 'https://test.example/api/settings')
 const puts = () => settingsCalls().filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
 async function pick(root: Node, level: string) { (thinking(root)!.props.onChange as (e: unknown) => void)({ target: { value: level } }); await flush() }
 const selectedLabel = (root: Node) => {
  const select = thinking(root)!
  return text(select.children.find(o => o.tag === 'option' && o.props.value === select.props.value) ?? node('none'))
 }

 it('shows the current level as text to an admin, labelled as applying to all strands', async () => {
  asAdmin = true; settingsLevel = 'high'
  const { root } = mount(Home); await flush()
  expect(thinking(root)).toBeTruthy()
  expect(thinking(root)!.props.value).toBe('high')
  expect(selectedLabel(root)).toContain('chat.thinkingLevelMenu.high')
  expect(text(root)).toContain('capture.thinking.label')
  expect(text(byTestId(root, 'capture-thinking-hint')[0]!)).toContain('capture.thinking.global')
  expect(thinking(root)!.props['aria-describedby']).toBe('capture-thinking-hint')
  expect(String(thinking(root)!.props.class)).toContain('min-h-11')
  expect(String(thinking(root)!.props.class)).toContain('focus-visible:ring-2')
  // All six levels are offered.
  expect(thinking(root)!.children.filter(o => o.tag === 'option').map(o => o.props.value)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
 })

 it('shows nothing and reads nothing for a non-admin', async () => {
  asAdmin = false
  const { root } = mount(Home); await flush()
  expect(byTestId(root, 'capture-thinking')).toHaveLength(0)
  expect(settingsCalls()).toHaveLength(0)
 })

 it('sends a PUT with only the thinking level when the admin switches it', async () => {
  asAdmin = true; settingsLevel = 'high'
  const { root } = mount(Home); await flush()
  await pick(root, 'low')
  expect(puts()).toHaveLength(1)
  expect(JSON.parse((puts()[0]![1] as RequestInit).body as string)).toEqual({ thinkingLevel: 'low' })
  expect(thinking(root)!.props.value).toBe('low')
  expect(byTestId(root, 'capture-thinking-save-error')).toHaveLength(0)
 })

 it('rolls back and says so when saving fails', async () => {
  asAdmin = true; settingsLevel = 'high'; settingsPutFail = true
  const { root } = mount(Home); await flush()
  await pick(root, 'off')
  expect(puts()).toHaveLength(1)
  expect(thinking(root)!.props.value).toBe('high')
  const alert = byTestId(root, 'capture-thinking-save-error')[0]
  expect(alert?.props.role).toBe('alert')
  expect(text(alert!)).toContain('capture.thinking.saveError')
 })

 it('Z1 click: holds a send made right after a switch until the PUT is confirmed', async () => {
  asAdmin = true; settingsLevel = 'xhigh'; holdPut = true
  const { root } = mount(Home); await flush()
  await draft(root, 'Kleine Frage')
  await pick(root, 'minimal')
  expect(thinking(root)!.props.disabled).toBe(true)
  // The button stays usable while the own save runs: the tap reaches the wait.
  expect(byTestId(root, 'send')[0]!.props.disabled).toBe(false)
  expect(await clickSend(root)).toBe(true)
  expect(captureBodies()).toHaveLength(0)
  expect(text(root)).toContain('capture.thinking.sendHeld')
  // While the send waits, Home takes no second send.
  expect(await clickSend(root)).toBe(false)
  releasePut!(); await flush()
  expect(captureBodies()).toHaveLength(1)
  expect(captureBodies()[0]).toMatchObject({ text: 'Kleine Frage' })
  const order = request.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}`)
  expect(order.indexOf('PUT https://test.example/api/settings')).toBeLessThan(order.indexOf('POST https://test.example/api/captures'))
  expect(settingsLevel).toBe('minimal')
 })

 it('Z1 shortcut: Ctrl+Enter during an open save waits too and sends once after the confirmation', async () => {
  asAdmin = true; settingsLevel = 'xhigh'; holdPut = true
  const { root } = mount(Home); await flush()
  await draft(root, 'Kleine Frage')
  await pick(root, 'minimal')
  await send(root)
  expect(captureBodies()).toHaveLength(0)
  expect(text(root)).toContain('capture.thinking.sendHeld')
  releasePut!(); await flush()
  expect(captureBodies()).toHaveLength(1)
 })

 it('Z2 click: sends nothing when the save behind a held send fails, says so and keeps the draft', async () => {
  asAdmin = true; settingsLevel = 'xhigh'; holdPut = true; settingsPutFail = true
  const { root } = mount(Home); await flush()
  await draft(root, 'Kleine Frage')
  await pick(root, 'minimal')
  expect(await clickSend(root)).toBe(true)
  expect(text(root)).toContain('capture.thinking.sendHeld')
  releasePut!(); await flush()
  expect(text(root)).toContain('capture.thinking.notSent')
  expect(captureBodies()).toHaveLength(0)
  expect(thinking(root)!.props.value).toBe('xhigh')
  expect(text(byTestId(root, 'capture-thinking-save-error')[0]!)).toContain('capture.thinking.saveError')
  expect(field(root).props.value).toBe('Kleine Frage')
 })

 it('does not invent a level when the setting cannot be read', async () => {
  asAdmin = true; settingsReadFail = true
  const { root } = mount(Home); await flush()
  expect(thinking(root)!.props.value).toBe('')
  expect(selectedLabel(root)).toContain('capture.thinking.unknown')
  expect(selectedLabel(root)).not.toContain('chat.thinkingLevelMenu')
  expect(text(byTestId(root, 'capture-thinking-load-error')[0]!)).toContain('capture.thinking.loadError')
  // Retry reads again and then shows the real value.
  settingsReadFail = false; settingsLevel = 'medium'
  await click(byTestId(root, 'capture-thinking-load-error')[0]!, 'common.retry')
  expect(thinking(root)!.props.value).toBe('medium')
 })

 it('reads the level again when the tab comes back, so a change made in a strand shows up', async () => {
  const listeners: Record<string, () => void> = {}
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (name: string, fn: () => void) => { listeners[name] = fn }, removeEventListener: () => {} })
  asAdmin = true; settingsLevel = 'high'
  const { root } = mount(Home); await flush()
  expect(thinking(root)!.props.value).toBe('high')
  settingsLevel = 'low'
  listeners.visibilitychange!(); await flush()
  expect(thinking(root)!.props.value).toBe('low')
 })

 it('holds a send on a Home opened again while the PUT of the previous Home is still open', async () => {
  asAdmin = true; settingsLevel = 'xhigh'; holdPut = true
  const first = mount(Home); await flush()
  await pick(first.root, 'minimal')
  first.app.unmount(); trees.splice(trees.indexOf(first), 1)
  const { root } = mount(Home); await flush()
  expect(thinking(root)!.props.disabled).toBe(true)
  await draft(root, 'Kleine Frage')
  await send(root)
  expect(captureBodies()).toHaveLength(0)
  expect(text(root)).toContain('capture.thinking.sendHeld')
  releasePut!(); await flush()
  expect(captureBodies()).toHaveLength(1)
  const order = request.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}`)
  expect(order.indexOf('PUT https://test.example/api/settings')).toBeLessThan(order.indexOf('POST https://test.example/api/captures'))
  expect(settingsLevel).toBe('minimal')
 })

 it('says nothing was sent only for the held send, and clears both messages after a later send', async () => {
  asAdmin = true; settingsLevel = 'xhigh'; holdPut = true; settingsPutFail = true
  const { root } = mount(Home); await flush()
  await draft(root, 'Kleine Frage')
  await pick(root, 'minimal')
  await send(root)
  releasePut!(); await flush()
  expect(text(root)).toContain('capture.thinking.notSent')
  expect(text(byTestId(root, 'capture-thinking-save-error')[0]!)).not.toContain('capture.thinking.notSent')
  // The draft is sent later with the active level: no stale "nothing was sent".
  settingsPutFail = false; holdPut = false
  await send(root)
  expect(captureBodies()).toHaveLength(1)
  expect(text(root)).not.toContain('capture.thinking.notSent')
  expect(byTestId(root, 'capture-thinking-save-error')).toHaveLength(0)
 })

 it('links the shown thinking error to the select via aria-describedby', async () => {
  asAdmin = true; settingsLevel = 'high'; settingsPutFail = true
  const { root } = mount(Home); await flush()
  await pick(root, 'off')
  const error = byTestId(root, 'capture-thinking-save-error')[0]!
  expect(error.props.id).toBe('capture-thinking-save-error')
  expect(String(thinking(root)!.props['aria-describedby']).split(' ')).toEqual(['capture-thinking-hint', 'capture-thinking-save-error'])
 })

 it('links the read error to the select via aria-describedby', async () => {
  asAdmin = true; settingsReadFail = true
  const { root } = mount(Home); await flush()
  expect(byTestId(root, 'capture-thinking-load-error')[0]!.props.id).toBe('capture-thinking-load-error')
  expect(String(thinking(root)!.props['aria-describedby']).split(' ')).toEqual(['capture-thinking-hint', 'capture-thinking-load-error'])
 })

 it('gives keyboard focus back to the select once the save is done', async () => {
  const doc: { activeElement: unknown; visibilityState: string; addEventListener: () => void; removeEventListener: () => void } = { activeElement: null, visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} }
  vi.stubGlobal('document', doc)
  asAdmin = true; settingsLevel = 'high'; holdPut = true
  const { root } = mount(Home); await flush()
  const select = thinking(root)! as Node & { focus: () => void }
  select.focus = () => { doc.activeElement = select }
  doc.activeElement = select
  await pick(root, 'low')
  // Disabling the select while saving drops the focus in a browser.
  doc.activeElement = null
  releasePut!(); await flush()
  expect(thinking(root)!.props.disabled).toBe(false)
  expect(doc.activeElement).toBe(select)
 })
 it('Z8: leaving Home while a send waits drops it: no capture, also after the save is confirmed', async () => {
  asAdmin = true; settingsLevel = 'xhigh'; holdPut = true
  const first = mount(Home); await flush()
  await draft(first.root, 'Kleine Frage')
  await pick(first.root, 'minimal')
  expect(await clickSend(first.root)).toBe(true)
  expect(text(first.root)).toContain('capture.thinking.sendHeld')
  first.app.unmount(); trees.splice(trees.indexOf(first), 1)
  releasePut!(); await flush()
  await new Promise(resolve => setTimeout(resolve, 20)); await flush()
  expect(captureBodies()).toHaveLength(0)
  // The save itself went on.
  expect(settingsLevel).toBe('minimal')
 })

 it('Z8: leave Home while a send waits, open Home again, send the same text: exactly one capture', async () => {
  asAdmin = true; settingsLevel = 'xhigh'; holdPut = true
  const first = mount(Home); await flush()
  await draft(first.root, 'Kleine Frage')
  await pick(first.root, 'minimal')
  expect(await clickSend(first.root)).toBe(true)
  first.app.unmount(); trees.splice(trees.indexOf(first), 1)
  const { root } = mount(Home); await flush()
  await draft(root, 'Kleine Frage')
  expect(await clickSend(root)).toBe(true)
  expect(captureBodies()).toHaveLength(0)
  releasePut!(); await flush()
  await new Promise(resolve => setTimeout(resolve, 20)); await flush()
  expect(captureBodies()).toHaveLength(1)
  expect(captureBodies()[0]).toMatchObject({ text: 'Kleine Frage' })
 })

 it.each([
  ['another admin', { id: 2, role: 'admin' }],
  ['logout', null],
  ['admin role gone', { id: 1, role: 'user' }],
 ] as const)('Z8: an identity change while a send waits drops it (%s): no capture', async (_name, next) => {
  authUser = Vue.ref({ id: 1, role: 'admin' }); settingsLevel = 'xhigh'; holdPut = true
  const { root } = mount(Home); await flush()
  await draft(root, 'Kleine Frage')
  await pick(root, 'minimal')
  expect(await clickSend(root)).toBe(true)
  expect(text(root)).toContain('capture.thinking.sendHeld')
  authUser.value = next ? { ...next } : null; await flush()
  releasePut!(); await flush()
  await new Promise(resolve => setTimeout(resolve, 20)); await flush()
  expect(captureBodies()).toHaveLength(0)
  expect(text(root)).not.toContain('capture.thinking.sendHeld')
  // The draft stays for a send of the new identity.
  expect(field(root).props.value).toBe('Kleine Frage')
 })

 it('reads the level once the admin identity arrives after the mount (hard reload)', async () => {
  authUser = Vue.ref(null)
  settingsLevel = 'medium'
  const { root } = mount(Home); await flush()
  expect(settingsCalls()).toHaveLength(0)
  authUser.value = { id: 1, role: 'admin' }; await flush()
  expect(settingsCalls()).toHaveLength(1)
  expect(thinking(root)!.props.value).toBe('medium')
  expect(selectedLabel(root)).toContain('chat.thinkingLevelMenu.medium')
 })

 it('Z4: settings down for good and no own change: the first send goes out, the read error and Retry stay', async () => {
  asAdmin = true; settingsReadFail = true; settingsLevel = 'low'
  const { root } = mount(Home); await flush()
  await draft(root, 'Kleine Frage')
  await send(root)
  expect(captureBodies()).toHaveLength(1)
  expect(captureBodies()[0]).toMatchObject({ text: 'Kleine Frage' })
  expect(text(root)).not.toContain('capture.thinking.notSent')
  expect(byTestId(root, 'capture-thinking-load-error')).toHaveLength(1)
  expect(text(byTestId(root, 'capture-thinking-load-error')[0]!)).toContain('common.retry')
 })

 it('Z3/Z4: settings down for good with an unresolved own change: held once with a message, the second send goes out', async () => {
  asAdmin = true; settingsLevel = 'low'
  const { root } = mount(Home); await flush()
  settingsReadFail = true; settingsPutLost = true
  await pick(root, 'high')
  expect(text(byTestId(root, 'capture-thinking-save-unclear')[0] ?? root)).toContain('capture.thinking.saveUnclear')
  await draft(root, 'Kleine Frage')
  await send(root)
  expect(captureBodies()).toHaveLength(0)
  expect(text(root)).toContain('capture.thinking.notSentUnknown')
  expect(field(root).props.value).toBe('Kleine Frage')
  await send(root)
  expect(captureBodies()).toHaveLength(1)
  expect(captureBodies()[0]).toMatchObject({ text: 'Kleine Frage' })
  expect(text(root)).not.toContain('capture.thinking.notSentUnknown')
 })

 it('saveError names the level read after an unclear save', async () => {
  asAdmin = true; settingsLevel = 'low'
  const { root } = mount(Home); await flush()
  settingsPutLost = true
  await pick(root, 'high')
  const message = byTestId(root, 'capture-thinking-save-error')[0]!
  expect(message).toBeDefined()
  expect(text(message)).toContain('capture.thinking.saveError')
  expect(text(message)).not.toContain('saveErrorUnknown')
  expect(thinking(root)!.props.value).toBe('low')
  expect(saveErrorParams.at(-1)).toEqual({ level: 'chat.thinkingLevelMenu.low' })
 })

 it('a non-admin sends at once and never reads the setting', async () => {
  asAdmin = false
  const { root } = mount(Home); await flush()
  await draft(root, 'Kleine Frage')
  await send(root)
  expect(captureBodies()).toHaveLength(1)
  expect(settingsCalls()).toHaveLength(0)
 })
})
