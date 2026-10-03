/**
 * The chat surface, mounted as a whole (safety net for the W2a split).
 *
 * `ChatView.vue` is driven through its real collaborators: the real `useChat`
 * behind a fake WebSocket and a fake `apiFetch`, the real markdown renderer,
 * the real interaction parser and the real transcript grouping. Only leaf
 * components (artifact card, interaction card, dictation bar, attachments,
 * Nuxt UI primitives) and the device facing composables (speech in/out) are
 * replaced by recording stubs. A custom renderer stands in for the DOM, so
 * the spec runs in the plain node environment like every other render spec.
 *
 * The assertions describe behaviour a user can see or trigger, not template
 * internals, so they hold for the monolithic view and for its split into
 * components alike.
 *
 * Run: npx vitest run packages/web-frontend/app/components/chatView.render.spec.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { createRenderer, defineComponent, h, nextTick, ref, type Component, type Ref } from 'vue'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, transpileModule } from 'typescript'
import * as contracts from '@axiom/core/contracts'
import { useChat } from '~/composables/useChat'
import { useMarkdown } from '~/composables/useMarkdown'
import { useInteractions } from '~/composables/useInteractions'
import { useSkillAutocomplete } from '~/composables/useSkillAutocomplete'
import { useSkillDetection } from '~/composables/useSkillDetection'
import { resetStrandCanvasForTest, useStrandCanvas } from '~/composables/useStrandCanvas'
import * as memoryFileDetection from '~/utils/memoryFileDetection'
import * as toolNameFormat from '~/utils/toolNameFormat'

// ── Client-side SFC loader ─────────────────────────────────────────────────
// The render config compiles `.vue` imports for SSR. Like the other mounted
// render specs, compile the chat view (and every local SFC it imports) for
// Vue's client renderer instead, so mounted hooks, watchers and clicks run.
// Plain modules resolve to the real ones; leaf components become stubs.
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REAL_LOADERS = import.meta.glob(
  ['../composables/**/*.ts', '../utils/**/*.ts', '../api/**/*.ts', './**/*.ts', '!../**/*.test.ts', '!../**/*.spec.ts'],
) as Record<string, () => Promise<unknown>>
// Nuxt auto-imports some modules use at load time.
for (const name of ['ref', 'computed', 'watch', 'reactive', 'readonly', 'shallowRef', 'nextTick'] as const) {
  ;(globalThis as Record<string, unknown>)[name] ??= (Vue as Record<string, unknown>)[name]
}
const realByPath = new Map<string, unknown>()
const loadErrors = new Map<string, unknown>()
await Promise.all(Object.entries(REAL_LOADERS).map(async ([key, load]) => {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), key)
  try { realByPath.set(file, await load()) } catch (error) { loadErrors.set(file, error) }
}))
/** Leaf components replaced by recording stubs: component name → stub tag. */
const STUBS: Record<string, string> = {
  PageHeader: 'page-header', Button: 'stub-button', Popover: 'popover', PopoverTrigger: 'popover-trigger', PopoverContent: 'popover-content',
  Label: 'label', Switch: 'switch', AppIcon: 'app-icon', ChatCollapsibleCard: 'collapsible-card', ToolDataDisplay: 'tool-data',
  MemoryEditsDiff: 'memory-edits-diff', MemoryFileDiff: 'memory-file-diff', ChatAttachments: 'chat-attachments', ChatArtifact: 'chat-artifact',
  ChatInteractionBlock: 'chat-interaction-block', TurnProgressStatus: 'turn-progress', ChatSkillAutocomplete: 'skill-autocomplete',
  DictationBar: 'dictation-bar', ComposerAudioChip: 'composer-audio-chip', StrandActivityPanel: 'strand-activity-panel', StrandCanvas: 'strand-canvas',
}
const sfcCache = new Map<string, Component>()
// Transitions need a layout engine; here they render their child directly.
const passThrough = defineComponent({ name: 'PassThrough', setup: (_, { slots }) => () => slots.default?.() })
const VueForSfc = { ...Vue, Transition: passThrough, TransitionGroup: passThrough }

function resolveSpecifier(from: string, name: string): string {
  if (name.startsWith('~/')) return resolve(APP_DIR, name.slice(2))
  return resolve(dirname(from), name)
}

function loadSfc(file: string): Component {
  const cached = sfcCache.get(file)
  if (cached) return cached
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
  const script = compileScript(descriptor, { id: file, inlineTemplate: true, fs: { fileExists: () => false, readFile: () => undefined } })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  new Function('require', 'exports', outputText)((name: string) => {
    if (name === 'vue') return VueForSfc
    if (name === '@axiom/core/contracts') return contracts
    const target = resolveSpecifier(file, name)
    if (target.endsWith('.vue')) {
      const base = target.slice(target.lastIndexOf('/') + 1, -4)
      return STUBS[base] ? { default: stub(STUBS[base]) } : { default: loadSfc(target) }
    }
    for (const candidate of [target, `${target}.ts`, `${target}/index.ts`]) {
      if (realByPath.has(candidate)) return realByPath.get(candidate)
      if (loadErrors.has(candidate)) throw loadErrors.get(candidate)
    }
    throw new Error(`Unexpected import in ${file}: ${name}`)
  }, exports)
  sfcCache.set(file, exports.default!)
  return exports.default!
}

const ChatView = loadSfc(resolve(APP_DIR, 'components/ChatView.vue'))

// ── A DOM stand-in ─────────────────────────────────────────────────────────
interface El {
  tag: string
  text: string
  props: Record<string, unknown>
  children: El[]
  parent: El | null
  listeners: Record<string, Array<(event: unknown) => void>>
  style: Record<string, string>
  classList: { add: () => void; remove: () => void }
  value: string
  type?: string
  selectionStart: number
  selectionEnd: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  focused: number
  addEventListener: (type: string, fn: (event: unknown) => void) => void
  removeEventListener: (type: string, fn: (event: unknown) => void) => void
  getRootNode: () => object
  focus: () => void
  setSelectionRange: (start: number, end: number) => void
}

function el(tag: string, text = ''): El {
  const node: El = {
    tag, text, props: {}, children: [], parent: null, listeners: {}, style: {},
    classList: { add: () => {}, remove: () => {} },
    value: '', selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0, focused: 0,
    addEventListener(type, fn) { (node.listeners[type] ??= []).push(fn) },
    removeEventListener(type, fn) { node.listeners[type] = (node.listeners[type] ?? []).filter(f => f !== fn) },
    getRootNode: () => ({}),
    focus() { node.focused++ },
    setSelectionRange(start, end) { node.selectionStart = start; node.selectionEnd = end },
  }
  return node
}

const renderer = createRenderer<El, El>({
  createElement: tag => el(tag),
  createText: text => el('#text', text),
  createComment: text => el('#comment', text),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, _prev, value) => {
    node.props[key] = value
    if (key === 'type') node.type = value as string
  },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  insert(node, parent, anchor) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    node.parent = parent
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  },
})

function all(root: El): El[] { return [root, ...root.children.flatMap(all)] }
function textOf(root: El): string { return all(root).map(n => n.text).filter(Boolean).join(' ') }
function htmlOf(root: El): string { return all(root).map(n => String(n.props.innerHTML ?? '')).join('\n') }
function cls(node: El): string { return String(node.props.class ?? '') }
function byTag(root: El, tag: string): El[] { return all(root).filter(n => n.tag === tag) }
function kebab(name: string): string { return name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`) }
/** A prop handed to a stub, under its camelCase or kebab-case key. */
function attr(node: El, name: string): unknown {
  return name in node.props ? node.props[name] : node.props[kebab(name)]
}
const evt = (extra: Record<string, unknown> = {}) => ({ preventDefault: () => {}, stopPropagation: () => {}, ...extra })
function click(node: El | undefined) {
  if (!node) throw new Error('nothing to click')
  const handler = node.props.onClick as ((e: unknown) => unknown) | Array<(e: unknown) => unknown>
  for (const fn of Array.isArray(handler) ? handler : [handler]) fn?.(evt())
}
function buttonWithText(root: El, text: string): El | undefined {
  return all(root).find(n => (n.tag === 'button' || n.tag === 'stub-button') && textOf(n).includes(text))
}
/** The chat bubbles (user, assistant, system), not the cards. */
function bubbles(root: El): El[] { return all(root).filter(n => cls(n).includes('rounded-2xl px-4 py-2')) }
function assistantProse(root: El): El[] { return all(root).filter(n => cls(n).includes('prose-chat') && 'innerHTML' in n.props) }

// ── Stubs for leaf components ──────────────────────────────────────────────
function stub(tag: string): Component {
  return defineComponent({
    name: tag,
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, { ...attrs }, Object.values(slots).flatMap(slot => (slot as () => unknown[])?.() ?? []) as never)
    },
  })
}

// ── Fake backend: socket + REST ────────────────────────────────────────────
interface FakeSocket { readyState: number; sent: string[]; onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; send(d: string): void; close(): void }
let sockets: FakeSocket[] = []
let apiCalls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = []
let history: Array<Record<string, unknown>> = []
let apiResponder: (path: string, options?: { method?: string; body?: unknown }) => unknown = () => ({})
let states = new Map<string, Ref<unknown>>()

function socket(): FakeSocket {
  const s = sockets[sockets.length - 1]
  if (!s) throw new Error('no socket')
  return s
}
function receive(frame: Record<string, unknown>) { socket().onmessage?.({ data: JSON.stringify({ sessionId: 'strand-a', ...frame }) }) }
function sentFrames(): Array<Record<string, unknown>> { return socket().sent.map(raw => JSON.parse(raw) as Record<string, unknown>) }
function row(id: number, role: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, role, content, timestamp: `2026-01-01T00:00:${String(id).padStart(2, '0')}.000Z`, session_id: 'strand-a', ...extra }
}

// ── Fake speech in/out ─────────────────────────────────────────────────────
let stt: ReturnType<typeof fakeStt>
let tts: ReturnType<typeof fakeTts>
function fakeStt() {
  const phase = ref<'idle' | 'starting' | 'recording' | 'transcribing' | 'error'>('idle')
  let nextResult: unknown = null
  return {
    setResult(result: unknown) { nextResult = result },
    api: {
      phase, error: ref(null), canRetry: ref(false), elapsedMs: ref(0), levels: ref<number[]>([]), sttEnabled: ref(true),
      fetchSttSettings: vi.fn(async () => {}),
      start: vi.fn(async () => { phase.value = 'recording' }),
      stop: vi.fn(async () => { phase.value = 'idle'; return nextResult }),
      retry: vi.fn(async () => { phase.value = 'idle'; return nextResult }),
      cancel: vi.fn(() => { phase.value = 'idle' }),
      dismiss: vi.fn(() => { phase.value = 'idle' }),
      cleanup: vi.fn(),
    },
  }
}
function fakeTts() {
  return {
    ttsEnabled: ref(true), ttsSettings: ref(null), mistralVoices: ref([]), voicesLoading: ref(false),
    fetchTtsSettings: vi.fn(async () => {}), fetchMistralVoices: vi.fn(async () => {}),
  }
}

const storage = new Map<string, string>()
const t = (key: string, params?: Record<string, unknown>) => params ? `${key}${JSON.stringify(params)}` : key

function stubRuntime() {
  for (const name of ['ref', 'computed', 'watch', 'watchEffect', 'onMounted', 'onUnmounted', 'onBeforeUnmount', 'nextTick', 'reactive', 'provide', 'inject', 'toRef', 'shallowRef', 'readonly', 'getCurrentScope', 'onScopeDispose'] as const) {
    vi.stubGlobal(name, (Vue as Record<string, unknown>)[name])
  }
  vi.stubGlobal('Document', class {})
  vi.stubGlobal('ShadowRoot', class {})
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })
  vi.stubGlobal('useState', <T>(key: string, init: () => T): Ref<T> => {
    if (!states.has(key)) states.set(key, ref(init()) as Ref<unknown>)
    return states.get(key) as Ref<T>
  })
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'http://localhost:3000' } }))
  vi.stubGlobal('useAuth', () => ({ user: ref({ username: 'tester', role: 'admin' }), getAccessToken: () => 'test-token' }))
  vi.stubGlobal('useApi', () => ({
    apiFetch: async (path: string, options?: { method?: string; body?: unknown }) => {
      apiCalls.push({ path, options })
      if (path.startsWith('/api/chat/history')) return { messages: history }
      return apiResponder(path, options)
    },
    getAuthHeaders: () => ({}),
  }))
  vi.stubGlobal('useI18n', () => ({ t, locale: ref('en') }))
  vi.stubGlobal('useFormat', () => ({ formatTimeShort: (ts: string) => `time:${ts}` }))
  vi.stubGlobal('useUserAvatar', () => ({ userAvatarUrl: ref(null), avatarFailed: ref(false), userInitial: ref('T'), onAvatarError: () => {} }))
  vi.stubGlobal('useChat', useChat)
  vi.stubGlobal('useMarkdown', useMarkdown)
  vi.stubGlobal('useInteractions', useInteractions)
  vi.stubGlobal('useSkillAutocomplete', useSkillAutocomplete)
  vi.stubGlobal('useSkillDetection', useSkillDetection)
  vi.stubGlobal('useStrandCanvas', useStrandCanvas)
  vi.stubGlobal('useStt', () => stt.api)
  vi.stubGlobal('useTts', () => tts)
  // W5b: the fork action of a message row opens the new strand.
  vi.stubGlobal('useRouter', () => ({ push: async () => {} }))
  for (const [name, fn] of Object.entries({ ...memoryFileDetection, ...toolNameFormat })) vi.stubGlobal(name, fn)

  class FakeWebSocket implements FakeSocket {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = 1
    sent: string[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onclose?: () => void
    constructor(readonly url: string) { sockets.push(this) }
    send(data: string) { this.sent.push(data) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket)
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

const mounted: Vue.App[] = []
async function mountChat(props: Record<string, unknown> = { threadSessionId: 'strand-a', threadAgentId: 'helper' }) {
  const root = el('root')
  const emitted: string[] = []
  const app = renderer.createApp(ChatView, { ...props, onBack: () => emitted.push('back') })
  app.config.globalProperties.$t = t as never
  for (const [name, tag] of Object.entries(STUBS)) app.component(name, stub(tag))
  app.mount(root)
  mounted.push(app)
  await flush()
  socket().onopen?.()
  await flush()
  return { root, emitted }
}

function textarea(root: El): El { return byTag(root, 'textarea')[0]! }
async function typeInto(root: El, value: string) {
  const input = textarea(root)
  input.value = value
  input.selectionStart = value.length
  input.selectionEnd = value.length
  for (const fn of input.listeners.input ?? []) fn({ target: input })
  await nextTick()
}
function composer(root: El): El { return all(root).find(n => n.props['data-testid'] === 'composer')! }
async function submit(root: El) {
  ;(composer(root).props.onSubmit as (e: unknown) => unknown)(evt())
  await flush()
}
function messagesContainer(root: El): El { return all(root).find(n => typeof n.props.onScroll === 'function')! }

beforeEach(() => {
  sockets = []
  apiCalls = []
  history = []
  states = new Map()
  storage.clear()
  apiResponder = path => path === '/api/personas/client' ? { personas: [{ id: 'helper', displayName: 'Helper', color: '#336699' }] } : {}
  stt = fakeStt()
  tts = fakeTts()
  stubRuntime()
})

afterEach(() => {
  mounted.splice(0).forEach(app => app.unmount())
  useChat().disconnect()
  resetStrandCanvasForTest()
  vi.unstubAllGlobals()
})

// ── Specs ──────────────────────────────────────────────────────────────────

describe('ChatView: transcript from history', () => {
  it('renders user and assistant bubbles with speaker, markdown body and time', async () => {
    history = [row(1, 'user', 'What is up?'), row(2, 'assistant', 'All **good** here.')]
    const { root } = await mountChat()

    expect(bubbles(root)).toHaveLength(2)
    expect(textOf(bubbles(root)[0]!)).toContain('What is up?')
    expect(textOf(bubbles(root)[0]!)).toContain('tester')
    const prose = assistantProse(root)
    expect(prose).toHaveLength(1)
    expect(String(prose[0]!.props.innerHTML)).toContain('<strong>good</strong>')
    expect(textOf(bubbles(root)[1]!)).toContain('Helper')
    expect(textOf(root)).toContain('time:2026-01-01T00:00:02.000Z')
    expect(apiCalls.some(c => c.path.startsWith('/api/chat/history'))).toBe(true)
  })

  it('renders a session divider and system rows', async () => {
    history = [row(1, 'user', 'a'), row(2, 'system', '', { metadata: JSON.stringify({ type: 'session_divider' }) }), row(3, 'system', 'Plain notice')]
    const { root } = await mountChat()
    expect(textOf(root)).toContain('chat.newSessionDivider')
    expect(textOf(root)).toContain('Plain notice')
  })

  it('shows the binding error with a way back instead of the transcript', async () => {
    const { root, emitted } = await mountChat()
    ;(states.get('chat_session_error') as Ref<string | null>).value = 'session_not_found'
    await flush()
    expect(textOf(root)).toContain('threads.sessionErrorNotFound')
    expect(byTag(root, 'textarea')).toHaveLength(0)
    click(buttonWithText(root, 'threads.backToInbox'))
    expect(emitted).toEqual(['back'])
  })
})

describe('ChatView: strand activity placement (W4c)', () => {
  it('keeps the activity out of the transcript, also while a turn streams', async () => {
    history = [row(1, 'user', 'Tell me')]
    const { root } = await mountChat()
    receive({ type: 'text', text: 'Working' })
    await flush()
    // The activity lives in the strand dock now, not below the last message.
    expect(byTag(root, 'strand-activity-panel')).toHaveLength(0)
    expect(byTag(messagesContainer(root), 'strand-activity-panel')).toHaveLength(0)
  })
})

describe('ChatView: streaming', () => {
  it('appends streamed text into one bubble and finalizes it on done', async () => {
    history = [row(1, 'user', 'Tell me')]
    const { root } = await mountChat()
    history = []

    receive({ type: 'text', text: 'Hello' })
    await flush()
    receive({ type: 'text', text: ' world' })
    await flush()

    let prose = assistantProse(root)
    expect(prose).toHaveLength(1)
    expect(String(prose[0]!.props.innerHTML)).toContain('Hello world')
    // streaming: pulsing dots, no timestamp line yet
    const assistantBubble = bubbles(root)[1]!
    expect(all(assistantBubble).filter(n => cls(n).includes('animate-pulse'))).toHaveLength(3)
    expect(textOf(assistantBubble)).not.toContain('time:')

    history = [row(1, 'user', 'Tell me'), row(2, 'assistant', 'Hello world')]
    receive({ type: 'done' })
    await flush()

    prose = assistantProse(root)
    expect(prose).toHaveLength(1)
    expect(String(prose[0]!.props.innerHTML)).toContain('Hello world')
    const finished = bubbles(root)[1]!
    expect(all(finished).filter(n => cls(n).includes('animate-pulse'))).toHaveLength(0)
    expect(textOf(finished)).toContain('time:')
  })

  it('folds a thinking block into the turn line, one level deeper behind its own toggle', async () => {
    const { root } = await mountChat()
    receive({ type: 'thinking', thinking: 'Considering options' })
    await flush()
    const line = all(root).find(n => 'data-turn-line' in n.props)!
    expect(line).toBeDefined()
    expect(attr(line, 'data-turn-state')).toBe('live')
    expect(textOf(line)).toContain('w4a.turn.thinkingNow')
    // Collapsed: the reasoning text is not in the transcript yet.
    expect(textOf(root)).not.toContain('Considering options')
    const toggle = all(line).find(n => 'data-turn-toggle' in n.props)!
    expect(attr(toggle, 'aria-expanded')).toBe(false)
    click(toggle)
    await nextTick()
    expect(attr(toggle, 'aria-expanded')).toBe(true)
    expect(textOf(root)).not.toContain('Considering options')
    const reasoning = all(line).find(n => 'data-reasoning-toggle' in n.props)!
    click(reasoning)
    await nextTick()
    expect(attr(reasoning, 'aria-expanded')).toBe(true)
    expect(textOf(line)).toContain('Considering options')
  })

  it('enables Stop while a turn streams and sends the stop command', async () => {
    const { root } = await mountChat()
    const stop = () => byTag(root, 'stub-button').find(n => attr(n, 'aria-label') === 'turnProgress.stopAll')!
    expect(attr(stop(), 'disabled')).toBe(true)
    receive({ type: 'text', text: 'Working' })
    await flush()
    expect(attr(stop(), 'disabled')).toBe(false)
    click(stop())
    await flush()
    expect(sentFrames().some(f => f.type === 'command' && f.content === '/stop')).toBe(true)
    expect(attr(stop(), 'disabled')).toBe(true)
  })
})

describe('ChatView: tool activity', () => {
  it('folds tool calls into one turn line that lists name, input and output when opened', async () => {
    const { root } = await mountChat()
    receive({ type: 'tool_call_start', toolName: 'web_search', toolCallId: 'call-1', toolArgs: { query: 'weather' } })
    await flush()
    const line = () => all(root).find(n => 'data-turn-line' in n.props)!
    expect(attr(line(), 'data-turn-state')).toBe('live')
    expect(textOf(line())).toContain(toolNameFormat.formatToolName('web_search'))
    receive({ type: 'tool_call_end', toolCallId: 'call-1', toolResult: 'sunny' })
    receive({ type: 'tool_call_start', toolName: 'read_file', toolCallId: 'call-2', toolArgs: { path: 'notes.txt' } })
    receive({ type: 'tool_call_end', toolCallId: 'call-2', toolResult: 'text' })
    receive({ type: 'text', text: 'The answer' })
    await flush()

    // Two calls, one line, collapsed: no tool card in the transcript.
    expect(all(root).filter(n => 'data-turn-line' in n.props)).toHaveLength(1)
    expect(attr(line(), 'data-turn-state')).toBe('done')
    expect(textOf(line())).toContain('w4a.turn.steps{"count":2}')
    expect(byTag(root, 'collapsible-card')).toHaveLength(0)
    click(all(line()).find(n => 'data-turn-toggle' in n.props))
    await nextTick()
    const cards = byTag(line(), 'collapsible-card')
    expect(cards).toHaveLength(2)
    const card = cards[0]!
    expect(attr(card, 'icon')).toBe('settings')
    expect(textOf(card)).toContain(toolNameFormat.formatToolName('web_search'))
    const data = byTag(card, 'tool-data').map(n => attr(n, 'data'))
    expect(data).toContainEqual({ query: 'weather' })
    expect(data).toContain('sunny')
    expect(attr(card, 'expanded')).toBe(false)
    ;(card.props.onToggle as () => void)()
    await nextTick()
    expect(attr(byTag(root, 'collapsible-card')[0]!, 'expanded')).toBe(true)
  })

  it('hides tool calls when the display filter is switched off and remembers it', async () => {
    const { root } = await mountChat()
    receive({ type: 'tool_call_start', toolName: 'web_search', toolCallId: 'call-1', toolArgs: {} })
    await flush()
    expect(all(root).some(n => 'data-turn-line' in n.props)).toBe(true)
    const toggle = byTag(root, 'switch').find(n => attr(n, 'id') === 'filter-tools')!
    ;(toggle.props['onUpdate:checked'] as (v: boolean) => void)(false)
    await flush()
    expect(all(root).some(n => 'data-turn-line' in n.props)).toBe(false)
    expect(JSON.parse(storage.get('axiom-chat-filters')!).showToolCalls).toBe(false)
  })
})

describe('ChatView: special rows', () => {
  it('shows a memory write as a file diff and a skill load without the raw input', async () => {
    const { root } = await mountChat()
    receive({ type: 'tool_call_start', toolName: 'write_file', toolCallId: 'w1', toolArgs: { path: '/data/memory/MEMORY.md', content: '# Notes' } })
    receive({ type: 'tool_call_start', toolName: 'read_file', toolCallId: 'r1', toolArgs: { path: '/data/skills/example/SKILL.md' } })
    await flush()
    click(all(root).find(n => 'data-turn-toggle' in n.props))
    await nextTick()
    const diff = byTag(root, 'memory-file-diff')
    expect(diff).toHaveLength(1)
    expect(attr(diff[0]!, 'after')).toBe('# Notes')
    const cards = byTag(root, 'collapsible-card')
    expect(cards).toHaveLength(2)
    // no "Input" block for either: memory view and skill load hide raw args
    expect(cards.every(card => !textOf(card).includes('Input'))).toBe(true)
    expect(textOf(cards[1]!)).toContain('example')
  })

  it('renders a task heartbeat row with its metrics', async () => {
    storage.set('axiom-chat-filters', JSON.stringify({ showToolCalls: true, showInjections: true, showSessionSummaries: false, showThinking: true }))
    history = [row(1, 'system', 'tick', { metadata: JSON.stringify({ type: 'task_status_update', taskName: 'Long job', runtimeMinutes: 4, toolCallCount: 9, totalTokens: 1500 }) })]
    const { root } = await mountChat()
    const text = textOf(root)
    expect(text).toContain('Long job')
    expect(text).toContain('4')
    expect(text).toContain('9')
    expect(text).toContain('Running')
  })

  it('expands a session summary on the divider when summaries are shown', async () => {
    storage.set('axiom-chat-filters', JSON.stringify({ showToolCalls: true, showInjections: false, showSessionSummaries: true, showThinking: true }))
    history = [row(1, 'system', '', { metadata: JSON.stringify({ type: 'session_divider', summary: 'We **agreed** on a plan' }) })]
    const { root } = await mountChat()
    expect(htmlOf(root)).not.toContain('<strong>agreed</strong>')
    click(buttonWithText(root, 'chat.sessionSummary'))
    await flush()
    expect(htmlOf(root) + textOf(root)).toContain('agreed')
  })

  it('marks a Telegram user message, its reply quote and sealed secrets', async () => {
    history = [row(1, 'user', 'from the phone', { source: 'telegram', metadata: JSON.stringify({ replyContext: 'earlier text' }) })]
    const { root } = await mountChat()
    expect(textOf(root)).toContain('via Telegram')
    expect(textOf(root)).toContain('from the phone')

    expect(textOf(root)).toContain('[Replying to: "earlier text"]')

    await typeInto(root, 'my key is abc')
    await submit(root)
    const sent = sentFrames().find(f => f.type === 'message')!
    expect(all(root).filter(n => 'data-sealed-hint' in n.props)).toHaveLength(0)
    receive({ type: 'message_ack', clientMessageId: sent.clientMessageId, sealed: [{ slug: 'key-1', kind: 'api_key' }], sealedContent: 'my key is [sealed]' })
    await flush()
    const hint = all(root).filter(n => 'data-sealed-hint' in n.props)
    expect(hint).toHaveLength(1)
    expect(textOf(hint[0]!)).toContain('{"count":1}')
  })
})

describe('ChatView: interaction blocks and actions', () => {
  const fence = '```offtangent\n{"block":"confirm","id":"b1","question":"Proceed?"}\n```'

  it('renders the card next to the bubble and sends a free text answer as a message', async () => {
    history = [row(1, 'user', 'go'), row(2, 'assistant', `Before we start:\n\n${fence}`)]
    const { root } = await mountChat()
    await typeInto(root, 'draft stays')

    const card = byTag(root, 'chat-interaction-block')[0]!
    expect(card).toBeDefined()
    expect((attr(card, 'block') as { id: string }).id).toBe('b1')
    expect(attr(card, 'messageId')).toBe(2)
    expect(attr(card, 'answeredElsewhere')).toBe(false)
    expect(String(assistantProse(root)[0]!.props.innerHTML)).toContain('Before we start')
    expect(htmlOf(root)).not.toContain('offtangent')

    await (card.props.onOwnAnswer as (text: string) => Promise<void>)('  my own answer ')
    await flush()
    expect(sentFrames().some(f => f.type === 'message' && f.content === 'my own answer')).toBe(true)
    expect(textarea(root).value).toBe('draft stays')
    // the free answer is a later user message: the card closes
    expect(attr(byTag(root, 'chat-interaction-block')[0]!, 'answeredElsewhere')).toBe(true)
  })

  it('drops the bubble when the message is nothing but a card, keeping the speaker line', async () => {
    history = [row(1, 'assistant', fence)]
    const { root } = await mountChat()
    expect(byTag(root, 'chat-interaction-block')).toHaveLength(1)
    expect(bubbles(root)).toHaveLength(0)
    expect(all(root).some(n => 'data-speaker-label' in n.props && textOf(n).includes('Helper'))).toBe(true)
  })

  it('answers an approval through the actions endpoint and shows the resolution', async () => {
    const { root } = await mountChat()
    apiResponder = path => path.startsWith('/api/chat/actions/') ? { status: 'ok', resolution: 'Approved by you' } : {}
    receive({ type: 'chat_action', chatAction: { messageId: 'act-1', text: 'Send the mail?', actions: [{ actionId: 'approve', label: 'Approve' }, { actionId: 'reject', label: 'Reject', style: 'danger' }] } })
    await flush()
    expect(textOf(root)).toContain('Send the mail?')
    click(buttonWithText(root, 'Approve'))
    await flush()
    const call = apiCalls.find(c => c.path === '/api/chat/actions/act-1')!
    expect(call.options?.method).toBe('POST')
    expect(JSON.parse(String(call.options?.body))).toEqual({ actionId: 'approve' })
    expect(textOf(root)).toContain('Approved by you')
    expect(buttonWithText(root, 'Reject')).toBeUndefined()
  })

  it('sends the picked slash command and locks the picker', async () => {
    const { root } = await mountChat()
    receive({ type: 'system', text: 'Pick a model', picker: { title: 'Model', options: [{ label: 'Small', command: '/model small' }, { label: 'Large', command: '/model large' }] } })
    await flush()
    click(buttonWithText(root, 'Large'))
    await flush()
    expect(sentFrames().some(f => f.type === 'command' && f.content === '/model large')).toBe(true)
    expect(attr(buttonWithText(root, 'Small')!, 'disabled')).toBe(true)
  })

  it('offers a manual retry on a terminal turn error', async () => {
    history = [row(1, 'user', 'q'), row(2, 'system', 'Provider failed', { metadata: JSON.stringify({ kind: 'turn_error', cause: 'non_retryable', error: 'boom', attempts: 2, retryable: true, retryActionId: 'retry-2', occurredAt: '2026-01-01T00:00:00.000Z' }) })]
    apiResponder = path => path.startsWith('/api/chat/actions/') ? { status: 'ok', resolution: 'Retrying now' } : {}
    const { root } = await mountChat()
    expect(textOf(root)).toContain('chat.turnError')
    expect(textOf(root)).toContain('Provider failed')
    expect(textOf(root)).toContain('chat.turnErrorRetried{"count":2}')
    click(buttonWithText(root, 'chat.turnErrorRetry'))
    await flush()
    const call = apiCalls.find(c => c.path === '/api/chat/actions/retry-2')!
    expect(JSON.parse(String(call.options?.body))).toEqual({ actionId: 'retry' })
    expect(textOf(root)).toContain('Retrying now')
    expect(buttonWithText(root, 'chat.turnErrorRetry')).toBeUndefined()
  })
})

describe('ChatView: artifacts and attachments', () => {
  it('renders an artifact card for a one-off canvas and a trail line for a living view', async () => {
    history = [
      row(1, 'user', 'make a page'),
      { ...row(2, 'assistant', 'Here it is'), artifacts: [
        { id: 'art-html', title: 'Page', strandId: 'strand-a' },
        { id: 'art-view', title: 'Board', strandId: 'strand-a', viewKey: 'board', revision: 2, latestRevision: 3, note: 'new numbers' },
      ] },
    ]
    const { root } = await mountChat()
    const cards = byTag(root, 'chat-artifact')
    expect(cards).toHaveLength(1)
    expect(attr(cards[0]!, 'artifactId')).toBe('art-html')
    expect(attr(cards[0]!, 'title')).toBe('Page')
    const line = all(root).find(n => n.props['data-testid'] === 'canvas-trail-line')!
    expect(textOf(line)).toContain('Board')
    expect(textOf(line)).toContain('new numbers')
    expect(textOf(line)).toContain('chat.artifact.revisionOf{"revision":2,"total":3}')
    click(line)
    const canvas = useStrandCanvas(() => 'strand-a')
    expect(canvas.openViewKey.value).toBe('board')
    expect(canvas.openRevision.value).toBe(2)
  })

  it('shows a fenced html block once, as the running artifact with its source, not again as code (n5 P2)', async () => {
    const answer = ['Here is the page:', '', '```html Sample page', '<h1>Hello frame</h1>', '```', '', 'And code:', '```ts', 'const kept = 1', '```'].join('\n')
    history = [
      row(1, 'user', 'make a page'),
      { ...row(2, 'assistant', answer), artifacts: [{ id: 'art-html', kind: 'html', title: 'Sample page', source: 'inline_fence', strandId: 'strand-a' }] },
    ]
    const { root } = await mountChat()
    const prose = all(root).filter(n => cls(n).includes('prose-chat')).map(n => String(n.props.innerHTML)).join('')
    expect(prose).toContain('Here is the page:')
    expect(prose).toContain('const kept = 1')
    expect(prose).not.toContain('Hello frame')
    const cards = byTag(root, 'chat-artifact')
    expect(cards).toHaveLength(1)
    expect(attr(cards[0]!, 'sourceText')).toBe('<h1>Hello frame</h1>')
  })

  it('keeps the code block when the fences and the inline artifacts do not line up', async () => {
    const answer = ['```html', '<h1>First</h1>', '```', '```html', '<h1>Second</h1>', '```'].join('\n')
    history = [
      row(1, 'user', 'two pages'),
      { ...row(2, 'assistant', answer), artifacts: [{ id: 'art-1', kind: 'html', title: 'First', source: 'inline_fence', strandId: 'strand-a' }] },
    ]
    const { root } = await mountChat()
    const prose = all(root).filter(n => cls(n).includes('prose-chat')).map(n => String(n.props.innerHTML)).join('')
    expect(prose).toContain('First')
    expect(prose).toContain('Second')
    expect(attr(byTag(root, 'chat-artifact')[0]!, 'sourceText')).toBeUndefined()
  })

  it('shows an uploaded image once, as the attachment, not again as a canvas frame (n5 P2)', async () => {
    history = [
      row(1, 'user', 'a picture'),
      { ...row(2, 'assistant', 'Here', { metadata: JSON.stringify({ files: [{ kind: 'image', originalName: 'photo.png', storedName: 's.png', relativePath: 'u/s.png', urlPath: '/api/uploads/u/s.png', mimeType: 'image/png', size: 5 }] }) }),
        artifacts: [{ id: 'art-img', kind: 'png', title: 'photo.png', source: 'upload', strandId: 'strand-a' }] },
    ]
    const { root } = await mountChat()
    expect(byTag(root, 'chat-artifact')).toHaveLength(0)
    expect(byTag(root, 'chat-attachments')).toHaveLength(1)
  })

  it('keeps the artifact card when a just finished turn is replayed (n5 regression)', async () => {
    history = [
      row(1, 'user', 'older question'), row(2, 'assistant', 'older answer'),
      row(3, 'user', 'render a page'),
      { ...row(4, 'assistant', 'Here it is'), artifacts: [{ id: 'art-html', title: 'Page', strandId: 'strand-a' }] },
    ]
    const { root } = await mountChat()
    expect(byTag(root, 'chat-artifact')).toHaveLength(1)

    receive({ type: 'turn_replay_start' })
    receive({ type: 'text', text: 'Here it is' })
    receive({ type: 'done' })
    receive({ type: 'turn_replay_end' })
    await flush()

    const cards = byTag(root, 'chat-artifact')
    expect(cards).toHaveLength(1)
    expect(attr(cards[0]!, 'artifactId')).toBe('art-html')
    expect(bubbles(root)).toHaveLength(4)
    expect(assistantProse(root).filter(n => String(n.props.innerHTML).includes('Here it is'))).toHaveLength(1)
  })

  it('hands message attachments to the attachment list', async () => {
    const file = { kind: 'file', originalName: 'notes.txt', storedName: 'x-notes.txt', relativePath: 'uploads/x-notes.txt', urlPath: '/files/x-notes.txt', mimeType: 'text/plain', size: 12 }
    history = [row(1, 'user', 'see file', { metadata: JSON.stringify({ files: [file] }) })]
    const { root } = await mountChat()
    const list = byTag(root, 'chat-attachments')
    expect(list).toHaveLength(1)
    expect(attr(list[0]!, 'attachments')).toEqual([file])
  })

  it('hides task reports unless the injections filter is on', async () => {
    history = [row(1, 'system', 'Task done', { metadata: JSON.stringify({ type: 'task_result', taskName: 'Report job', taskId: 'task-9' }) })]
    const { root } = await mountChat()
    expect(textOf(root)).not.toContain('Report job')
    const toggle = byTag(root, 'switch').find(n => attr(n, 'id') === 'filter-injections')!
    ;(toggle.props['onUpdate:checked'] as (v: boolean) => void)(true)
    await flush()
    expect(textOf(root)).toContain('Report job')
  })

  it('expands a truncated task report by fetching the full text', async () => {
    storage.set('axiom-chat-filters', JSON.stringify({ showToolCalls: true, showInjections: true, showSessionSummaries: false, showThinking: true }))
    history = [row(1, 'system', 'Task done\n\nshort preview', { metadata: JSON.stringify({ type: 'task_result', taskName: 'Report job', taskId: 'task-9', resultTruncated: true, resultFullLength: 900 }) })]
    apiResponder = path => path === '/api/tasks/task-9' ? { task: { resultSummary: 'The **full** report' } } : {}
    const { root } = await mountChat()
    expect(textOf(root)).toContain('Report job')
    click(buttonWithText(root, 'chat.taskResult.showFull'))
    await flush()
    expect(apiCalls.some(c => c.path === '/api/tasks/task-9')).toBe(true)
    expect(htmlOf(root)).toContain('<strong>full</strong>')
    expect(buttonWithText(root, 'chat.taskResult.hideFull')).toBeDefined()
  })
})

describe('ChatView: composer', () => {
  it('sends the typed text on submit and clears the field', async () => {
    const { root } = await mountChat()
    await typeInto(root, 'hello there')
    await submit(root)
    const frame = sentFrames().find(f => f.type === 'message')!
    expect(frame.content).toBe('hello there')
    expect(frame.sessionId ?? frame.threadSessionId ?? 'strand-a').toBeTruthy()
    expect(textarea(root).value).toBe('')
    expect(bubbles(root).some(b => textOf(b).includes('hello there'))).toBe(true)
  })

  it('sends on Enter but not on Shift+Enter', async () => {
    const { root } = await mountChat()
    await typeInto(root, 'line one')
    ;(textarea(root).props.onKeydown as (e: unknown) => void)(evt({ key: 'Enter', shiftKey: true }))
    await flush()
    expect(sentFrames().filter(f => f.type === 'message')).toHaveLength(0)
    ;(textarea(root).props.onKeydown as (e: unknown) => void)(evt({ key: 'Enter' }))
    await flush()
    expect(sentFrames().filter(f => f.type === 'message').map(f => f.content)).toEqual(['line one'])
  })

  it('does not send an empty composer', async () => {
    const { root } = await mountChat()
    await typeInto(root, '   ')
    await submit(root)
    expect(sentFrames().filter(f => f.type === 'message')).toHaveLength(0)
  })

  it('adds dropped files as pending chips', async () => {
    const { root } = await mountChat()
    const surface = all(root).find(n => typeof n.props.onDrop === 'function')!
    ;(surface.props.onDragenter as (e: unknown) => void)(evt({ dataTransfer: { types: ['Files'] } }))
    await nextTick()
    expect(textOf(root)).toContain('chat.dropFilesHere')
    ;(surface.props.onDrop as (e: unknown) => void)(evt({ dataTransfer: { types: ['Files'], files: [{ name: 'photo.png' }] } }))
    await nextTick()
    expect(textOf(root)).not.toContain('chat.dropFilesHere')
    expect(textOf(root)).toContain('photo.png')
  })

  it('switches the thinking level from the composer (admin)', async () => {
    apiResponder = path => path === '/api/settings' ? { thinkingLevel: 'low' } : path === '/api/personas/client' ? { personas: [] } : {}
    const { root } = await mountChat()
    click(buttonWithText(root, 'chat.thinkingLevelMenu.high'))
    await flush()
    const call = apiCalls.find(c => c.path === '/api/settings' && c.options?.method)!
    expect(JSON.parse(String(call.options?.body))).toEqual({ thinkingLevel: 'high' })
  })
})

describe('ChatView: dictation wiring', () => {
  it('inserts the transcript at the caret and never sends it', async () => {
    const { root } = await mountChat()
    await typeInto(root, 'Note: ')
    const mic = () => all(root).find(n => n.props['data-testid'] === 'dictation-mic')!
    click(mic())
    await flush()
    expect(stt.api.start).toHaveBeenCalledTimes(1)
    expect(byTag(root, 'dictation-bar')).toHaveLength(1)
    expect(attr(byTag(root, 'dictation-bar')[0]!, 'phase')).toBe('recording')

    stt.setResult({ text: 'buy milk', audio: null, durationMs: 1200 })
    click(mic())
    await flush()
    expect(stt.api.stop).toHaveBeenCalledTimes(1)
    expect(textarea(root).value).toBe('Note: buy milk')
    expect(byTag(root, 'dictation-bar')).toHaveLength(0)
    expect(sentFrames().filter(f => f.type === 'message')).toHaveLength(0)
    expect(textOf(root)).toContain('chat.dictation.inserted')
  })

  it('finishes from the bar, keeps the recording as a chip and sends it with the message', async () => {
    const audio = { kind: 'file', originalName: 'dictation.webm', storedName: 's.webm', relativePath: 'uploads/s.webm', urlPath: '/files/s.webm', mimeType: 'audio/webm', size: 10 }
    apiResponder = path => path === '/api/chat/message'
      ? { message: { session_id: 'strand-a', role: 'user', content: 'hello', metadata: JSON.stringify({ files: [audio] }), timestamp: '2026-01-01T00:01:00.000Z' } }
      : {}
    const { root } = await mountChat()
    click(all(root).find(n => n.props['data-testid'] === 'dictation-mic'))
    await flush()
    stt.setResult({ text: 'hello', audio, durationMs: 2000 })
    ;(byTag(root, 'dictation-bar')[0]!.props.onFinish as () => Promise<void>)()
    await flush()
    expect(textarea(root).value).toBe('hello')
    const chips = byTag(root, 'composer-audio-chip')
    expect(chips).toHaveLength(1)
    expect(attr(chips[0]!, 'durationMs')).toBe(2000)

    await submit(root)
    const post = apiCalls.find(c => c.path === '/api/chat/message')!
    expect(post).toBeDefined()
    expect(byTag(root, 'composer-audio-chip')).toHaveLength(0)
    expect(textarea(root).value).toBe('')
  })

  it('cancels a recording from the bar without touching the draft', async () => {
    const { root } = await mountChat()
    await typeInto(root, 'keep me')
    click(all(root).find(n => n.props['data-testid'] === 'dictation-mic'))
    await flush()
    ;(byTag(root, 'dictation-bar')[0]!.props.onCancel as () => void)()
    await flush()
    expect(stt.api.cancel).toHaveBeenCalledTimes(1)
    expect(textarea(root).value).toBe('keep me')
    expect(textOf(root)).toContain('chat.dictation.cancelled')
  })
})

describe('ChatView: scrolling and message actions', () => {
  it('offers jump-to-bottom once the reader scrolled up, and follows new text near the bottom', async () => {
    history = [row(1, 'user', 'q'), row(2, 'assistant', 'a')]
    const { root } = await mountChat()
    const box = messagesContainer(root)
    const jump = () => all(root).find(n => n.tag === 'button' && byTag(n, 'polyline').length > 0)

    box.scrollHeight = 2000; box.clientHeight = 500; box.scrollTop = 100
    ;(box.props.onScroll as () => void)()
    await nextTick()
    expect(jump()).toBeDefined()

    // scrolled up: new text does not pull the reader down
    receive({ type: 'text', text: 'more' })
    await flush()
    expect(box.scrollTop).toBe(100)

    click(jump())
    await flush()
    expect(box.scrollTop).toBe(2000)
    expect(jump()).toBeUndefined()

    // near the bottom: streaming text keeps the view pinned
    box.scrollHeight = 2600
    receive({ type: 'text', text: ' and more' })
    await flush()
    expect(box.scrollTop).toBe(2600)
  })

  it('reads an assistant answer aloud from its action row (POST /api/speech/audio with the message id)', async () => {
    history = [row(1, 'user', 'q'), row(2, 'assistant', 'Read me')]
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const { root } = await mountChat()
    const actions = all(root).filter(n => 'data-message-actions' in n.props)
    // One action row, under the answer only (not under the question).
    expect(actions).toHaveLength(1)
    expect(attr(actions[0]!, 'role')).toBe('toolbar')
    const play = all(actions[0]!).find(n => n.tag === 'button' && n.props['data-action'] === 'read-aloud')!
    expect(play).toBeDefined()
    expect(textOf(play)).toContain('w4b.speech.read')
    expect(all(actions[0]!).some(n => n.tag === 'button' && n.props['data-action'] === 'audio-summary')).toBe(true)
    click(play)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:3000/api/speech/audio')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ messageId: 2 })
    // The old client-side TTS path is gone (W6b): nothing posts to /api/tts.
    expect(fetchMock.mock.calls.some(call => String((call as unknown[])[0]).endsWith('/api/tts'))).toBe(false)
  })

  it('copies an answer as Markdown from its action row and says so', async () => {
    history = [row(1, 'user', 'q'), row(2, 'assistant', '**Bold** and `code`')]
    const writeText = vi.fn(async () => {})
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { ...globalThis.navigator, clipboard: { writeText } } })
    try {
      const { root } = await mountChat()
      const copy = all(root).find(n => n.tag === 'button' && n.props['data-action'] === 'copy')!
      click(copy)
      await flush()
      expect(writeText).toHaveBeenCalledWith('**Bold** and `code`')
      expect(textOf(all(root).find(n => 'data-copy-status' in n.props)!)).toContain('w4a.actions.copied')
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
    }
  })

  it('copies markdown from the transcript and wires code copy buttons', async () => {
    const { root } = await mountChat()
    const box = messagesContainer(root)
    expect(typeof box.props.onCopy).toBe('function')
    expect(typeof box.props.onClick).toBe('function')
  })
})
