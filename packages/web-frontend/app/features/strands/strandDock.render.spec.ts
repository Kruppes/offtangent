/**
 * The strand dock (W4c): two folding sections, the height splitter between
 * them, the width separator and the strand head's hint while the dock is
 * closed. SSR renders the markup; a tiny recording renderer drives the
 * separator's keyboard and pointer handlers.
 */
import { describe, expect, it, vi } from 'vitest'
import { createRenderer, createSSRApp, defineComponent, h, ref, computed, type Component } from 'vue'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, transpileModule } from 'typescript'
import * as strandDock from '~/utils/strandDock'
import { DEFAULT_DOCK_STATE, setActivityHeight, setDockWidth, setSectionOpen, toggleSection, type DockState, type RunningHint } from '~/utils/strandDock'

const dockState = vi.hoisted(() => ({ value: null as unknown }))
const tasks = vi.hoisted(() => ({ live: 0, total: 0 }))

vi.mock('~/composables/useStrandDock', async () => {
  const { ref: vueRef } = await import('vue')
  const state = vueRef<DockState>({ ...DEFAULT_DOCK_STATE })
  dockState.value = state
  return {
    useStrandDock: () => ({
      state,
      setWidth: (w: number) => { state.value = setDockWidth(state.value, w) },
      resetWidth: vi.fn(),
      setActivityHeight: (v: number) => { state.value = setActivityHeight(state.value, v) },
      resetActivityHeight: vi.fn(),
      setSectionOpen: (s: 'activity' | 'context', open: boolean) => { state.value = setSectionOpen(state.value, s, open) },
      toggleSection: (s: 'activity' | 'context') => { state.value = toggleSection(state.value, s) },
    }),
  }
})
vi.mock('@vueuse/core', async () => {
  const { ref: vueRef } = await import('vue')
  return { useElementSize: () => ({ width: vueRef(320), height: vueRef(640) }) }
})
vi.mock('~/composables/useStrandCanvas', () => ({
  useStrandCanvas: () => ({ views: computed(() => []), openViewKey: ref(null), open: vi.fn() }),
}))
vi.mock('~/features/threads/composables/useStrandTasks', () => ({
  useStrandTasks: () => ({
    status: ref('ready'),
    errorMessage: ref(null),
    roots: computed(() => []),
    visibleRows: computed(() => []),
    liveCount: computed(() => tasks.live),
    totalCount: computed(() => tasks.total),
    nowMs: ref(0),
    expanded: ref(new Set()),
    reload: vi.fn(),
    toggle: vi.fn(),
    isExpanded: () => false,
    // W6c: the acknowledge / fold state of the activity panel.
    partition: computed(() => ({ open: [], older: [], hidden: [] })),
    showOlder: ref(false),
    showHidden: ref(false),
    lastDismissed: ref(null),
    dismissError: ref(false),
    dismiss: vi.fn(),
    restore: vi.fn(),
  }),
}))

;(globalThis as Record<string, unknown>).useI18n = () => ({
  t: (key: string, params?: Record<string, unknown>) => (params ? `${key}(${JSON.stringify(params)})` : key),
  locale: ref('en'),
})

// Load the mocked composable once so the shared state ref exists.
await import('~/composables/useStrandDock')
function state() { return (dockState.value as { value: DockState }) }

function stubs(app: ReturnType<typeof createSSRApp>) {
  app.component('AppIcon', defineComponent({ props: ['name'], setup: props => () => h('i', { 'data-icon': props.name }) }))
  app.component('Button', defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) }))
  app.component('Skeleton', defineComponent({ setup: () => () => h('div', { class: 'skeleton' }) }))
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  app.config.globalProperties.$t = (key: string, params?: unknown) => (params ? `${key}(${JSON.stringify(params)})` : key)
}

async function renderDock(props: Record<string, unknown> = {}) {
  const { default: StrandDock } = await import('./StrandDock.vue')
  const app = createSSRApp({
    render: () => h(StrandDock, { strandId: 'strand-1', strand: null, turnRunning: false, resizable: true, ...props }, {
      'context-extra': () => h('div', { 'data-testid': 'extra' }, 'details'),
    }),
  })
  stubs(app)
  return renderToString(app)
}

describe('strand context panel', () => {
  it('shows the server-counted conversation messages, not the session counter', async () => {
    const strand = { id: 'strand-1', agentId: 'main', title: 'Synthetic', pinned: false, archived: false, startedAt: '2026-01-01T00:00:00Z', lastActivity: '2026-01-02T00:00:00Z', endedAt: null, messageCount: 0, conversationMessageCount: 7, lastMessage: null, active: false, tags: [], links: { parents: 0, children: 0 } }
    const html = await renderDock({ strand })
    expect(html).toMatch(/shell\.contextMessages<\/dt><dd>7<\/dd>/)
  })
  it('falls back to the session counter when an older server omits the field', async () => {
    const strand = { id: 'strand-1', agentId: 'main', title: 'Synthetic', pinned: false, archived: false, startedAt: '2026-01-01T00:00:00Z', lastActivity: '2026-01-02T00:00:00Z', endedAt: null, messageCount: 4, lastMessage: null, active: false, tags: [], links: { parents: 0, children: 0 } }
    const html = await renderDock({ strand })
    expect(html).toMatch(/shell\.contextMessages<\/dt><dd>4<\/dd>/)
  })
})

describe('strand dock sections', () => {
  it('shows Activity above Context, both open, with a height separator between them', async () => {
    state().value = { ...DEFAULT_DOCK_STATE }
    const html = await renderDock()
    expect(html.indexOf('data-testid="dock-activity"')).toBeGreaterThan(-1)
    expect(html.indexOf('data-testid="dock-activity"')).toBeLessThan(html.indexOf('data-testid="dock-context"'))
    expect(html).toContain('data-split="split"')
    expect(html).toContain('aria-controls="strand-activity-body"')
    expect(html).toContain('aria-controls="strand-context-body"')
    expect((html.match(/aria-expanded="true"/g) ?? []).length).toBe(2)
    expect(html).toContain('id="strand-context-body"')
    expect(html).toContain('data-testid="extra"')
    // Height split: a horizontal separator with its value and bounds.
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="horizontal"')
    expect(html).toContain(`aria-valuenow="${DEFAULT_DOCK_STATE.activityHeight}"`)
    expect(html).toContain('aria-valuemin="96"')
    expect(html).toContain(`aria-valuemax="${strandDock.activityMaxHeight(640)}"`)
    expect(html).toContain('aria-label="shell.dockSplit"')
    expect(html).toContain(`height:${DEFAULT_DOCK_STATE.activityHeight}px`)
  })

  it('folds each section on its own; no splitter unless both are open', async () => {
    state().value = { ...DEFAULT_DOCK_STATE, contextOpen: false }
    let html = await renderDock()
    expect(html).toContain('data-split="activity-only"')
    expect(html).not.toContain('id="strand-context-body"')
    expect(html).toContain('id="strand-activity-body"')
    expect(html).not.toContain('role="separator"')

    state().value = { ...DEFAULT_DOCK_STATE, activityOpen: false }
    html = await renderDock()
    expect(html).toContain('data-split="context-only"')
    expect(html).not.toContain('id="strand-activity-body"')
    expect(html).toContain('id="strand-context-body"')
    expect(html).not.toContain('role="separator"')
  })

  it('keeps the activity header with live dot and counter when folded (anti-freeze)', async () => {
    tasks.live = 2
    tasks.total = 3
    state().value = { ...DEFAULT_DOCK_STATE, activityOpen: false, contextOpen: false }
    const html = await renderDock({ turnRunning: true })
    expect(html).toContain('data-split="collapsed"')
    expect(html).toContain('data-testid="dock-activity-toggle"')
    expect(html).toContain('data-live="true"')
    expect(html).toContain('strandActivity.liveCount({&quot;count&quot;:2})')
    expect(html).toContain('strandActivity.turnRunning')
    tasks.live = 0
    tasks.total = 0
  })

  it('folds but never drags as a sheet', async () => {
    state().value = { ...DEFAULT_DOCK_STATE }
    const html = await renderDock({ resizable: false })
    expect(html).toContain('data-split="split"')
    expect(html).not.toContain('role="separator"')
    expect(html).toContain('data-testid="dock-activity-toggle"')
    expect(html).toContain('data-testid="dock-context-toggle"')
  })
})

describe('strand head hint while the dock is closed', () => {
  async function renderHint(hint: RunningHint) {
    const { default: Hint } = await import('./StrandRunningHint.vue')
    const app = createSSRApp({ render: () => h(Hint, { hint }) })
    stubs(app)
    return renderToString(app)
  }
  it('renders nothing when nothing runs', async () => {
    expect(await renderHint({ kind: 'none' })).not.toContain('dock-running-hint')
  })
  it('names the running answer and the live tasks, and points at the dock', async () => {
    const turn = await renderHint({ kind: 'turn' })
    expect(turn).toContain('data-kind="turn"')
    expect(turn).toContain('strandActivity.turnRunning')
    expect(turn).toContain('aria-controls="strand-context-column"')
    expect(turn).toContain('shell.dockOpenActivity')

    const both = await renderHint({ kind: 'turn-and-tasks', count: 2 })
    expect(both).toContain('strandActivity.turnRunning · strandActivity.liveCount({&quot;count&quot;:2})')
    expect(both).toContain('min-h-11')
  })
})

// ── Separator interaction through a recording renderer ─────────────────────
interface Node { tag: string; props: Record<string, unknown>; children: Node[] }
const recorder = createRenderer<Node, Node>({
  createElement: tag => ({ tag, props: {}, children: [] }),
  createText: () => ({ tag: '#text', props: {}, children: [] }),
  createComment: () => ({ tag: '#comment', props: {}, children: [] }),
  setText: () => {},
  setElementText: () => {},
  insert: (child, parent) => { parent.children.push(child) },
  remove: () => {},
  parentNode: () => null,
  nextSibling: () => null,
  patchProp: (node, key, _prev, next) => { node.props[key] = next },
})
function find(node: Node, role: string): Node | undefined {
  if (node.props.role === role) return node
  for (const child of node.children) { const hit = find(child, role); if (hit) return hit }
  return undefined
}

// The render config compiles `.vue` for SSR; the recorder needs the client
// render function, so the separator is compiled here (as the chat view spec does).
function loadClientSfc(file: string): Component {
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
  const script = compileScript(descriptor, { id: file, inlineTemplate: true, fs: { fileExists: () => false, readFile: () => undefined } })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  new Function('require', 'exports', outputText)((name: string) => {
    if (name === 'vue') return Vue
    if (name === '~/utils/strandDock') return strandDock
    throw new Error(`Unexpected import in ${file}: ${name}`)
  }, exports)
  return exports.default!
}
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function mountSeparator(orientation: 'vertical' | 'horizontal', value: number) {
  const DockSeparator = loadClientSfc(resolve(APP_DIR, 'components/shell/DockSeparator.vue'))
  const updates: number[] = []
  let resets = 0
  const current = ref(value)
  const root: Node = { tag: 'root', props: {}, children: [] }
  recorder.createApp({
    render: () => h(DockSeparator as Component, {
      orientation, value: current.value, min: 280, max: 560, label: 'resize', controls: 'dock',
      onUpdate: (v: number) => { updates.push(v); current.value = v },
      onReset: () => { resets++ },
    }),
  }).mount(root)
  const sep = find(root, 'separator')!
  const call = async (name: string, event: Record<string, unknown>) => {
    ;(find(root, 'separator')!.props[name] as (e: unknown) => void)({
      preventDefault: () => {}, currentTarget: { setPointerCapture() {}, releasePointerCapture() {}, focus() {} }, ...event,
    })
    await Vue.nextTick()
  }
  return { sep, updates, resets: () => resets, call }
}

describe('dock separator', () => {
  it('carries the window splitter semantics', async () => {
    const { sep } = await mountSeparator('vertical', 320)
    expect(String(sep.props.tabindex)).toBe('0')
    expect(sep.props['aria-orientation']).toBe('vertical')
    expect(sep.props['aria-valuenow']).toBe(320)
    expect(sep.props['aria-valuemin']).toBe(280)
    expect(sep.props['aria-valuemax']).toBe(560)
    expect(sep.props['aria-controls']).toBe('dock')
    // 24 px hit area centred on the line, 48 px (>= 44, on the 4 px grid) on coarse pointers, visible focus ring.
    expect(String(sep.props.class)).toContain('-left-3 w-6')
    expect(String(sep.props.class)).toContain('any-pointer-coarse:-left-6 any-pointer-coarse:w-12')
    expect(String(sep.props.class)).toContain('focus-visible:ring-2')
  })

  it('steps by 16 px with the arrow keys, 64 with Shift, and resets on double click', async () => {
    const { updates, call, resets } = await mountSeparator('vertical', 320)
    await call('onKeydown', { key: 'ArrowLeft', shiftKey: false })
    await call('onKeydown', { key: 'ArrowLeft', shiftKey: true })
    await call('onKeydown', { key: 'ArrowRight', shiftKey: false })
    await call('onKeydown', { key: 'Tab', shiftKey: false })
    expect(updates).toEqual([336, 400, 384])
    await call('onDblclick', {})
    expect(resets()).toBe(1)
  })

  it('follows a pointer drag (mouse or touch) within the bounds', async () => {
    const { updates, call } = await mountSeparator('vertical', 320)
    await call('onPointerdown', { button: 0, pointerId: 7, clientX: 1000, clientY: 0 })
    await call('onPointermove', { pointerId: 7, clientX: 940, clientY: 0 })
    await call('onPointermove', { pointerId: 8, clientX: 500, clientY: 0 })
    await call('onPointermove', { pointerId: 7, clientX: 100, clientY: 0 })
    await call('onPointerup', { pointerId: 7 })
    await call('onPointermove', { pointerId: 7, clientX: 1200, clientY: 0 })
    expect(updates).toEqual([380, 560])
  })
})
