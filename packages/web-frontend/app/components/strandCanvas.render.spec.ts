/**
 * The canvas shell of a strand, rendered (interaction spec 2.8 / 2.9).
 *
 * What is pinned here is the chrome, not the document: wide windows get a side
 * panel with a splitter and a 36 px rail when closed, narrow windows get the
 * app layout, the live frame (the RECORDED one) turns into a badge while the
 * canvas is closed and is followed silently while it is open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'
import { createStrandCanvasState, type CanvasViewUpdate, type StrandCanvasState } from '../composables/useStrandCanvas'

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

const FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../../docs/protocol/canvas-view-updated.frame.json'), 'utf8'),
) as { sessionId: string; canvasView: Record<string, unknown> }

const STRAND = FIXTURE.sessionId

function update(overrides: Partial<CanvasViewUpdate> = {}): CanvasViewUpdate {
  return { ...(FIXTURE.canvasView as unknown as CanvasViewUpdate), artifactId: 'art-1', messageId: 4711, ...overrides }
}

const VIEWS = [
  {
    viewKey: 'front-wheel',
    title: 'Wheel truing',
    kind: 'html' as const,
    latestRevision: 1,
    updatedAt: '2026-09-26T12:00:00.000Z',
    revisions: [{ revision: 1, artifactId: 'art-1', messageId: 4711, title: 'Wheel truing', createdAt: '2026-09-26T12:00:00.000Z', note: 'measure spoke 25 first' }],
  },
  {
    viewKey: 'rear-wheel',
    title: 'Rear wheel',
    kind: 'html' as const,
    latestRevision: 1,
    updatedAt: '2026-09-26T11:00:00.000Z',
    revisions: [{ revision: 1, artifactId: 'art-r1', messageId: 4700, title: 'Rear wheel', createdAt: '2026-09-26T11:00:00.000Z', note: null }],
  },
]

const loadStrandViews = vi.fn(async () => VIEWS)
let state: StrandCanvasState

function loadComponent(): Component {
  const filename = new URL('./StrandCanvas.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const script = compileScript(descriptor, { id: 'StrandCanvas.vue', inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  const modules: Record<string, unknown> = {
    vue: Vue,
    './ChatArtifact.vue': { default: { name: 'ChatArtifact', props: ['artifactId', 'title', 'strandId', 'viewKey', 'revision', 'latestRevision'], template: '<div data-testid="artifact" :data-artifact="artifactId"></div>' } },
    '~/api/artifacts': { useArtifactsApi: () => ({ loadStrandViews }) },
    '~/composables/useStrandCanvas': { useStrandCanvas: () => state },
  }
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}

const trees: Array<{ app: Vue.App; root: Node }> = []

function mount(component: Component, props: Record<string, unknown>): Node {
  const root = node('root')
  const app = renderer.createApp(component, props)
  app.config.globalProperties.$t = ((key: string) => key) as typeof app.config.globalProperties.$t
  app.mount(root)
  trees.push({ app, root })
  return root
}

function all(root: Node): Node[] { return [root, ...root.children.flatMap(all)] }
function byTestId(root: Node, id: string): Node | undefined { return all(root).find(n => n.props['data-testid'] === id) }
function click(el: Node | undefined): void { (el?.props.onClick as ((event: unknown) => void) | undefined)?.({}) }
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  await nextTick()
}

let StrandCanvas: Component
const listeners: Record<string, Array<(event: unknown) => void>> = {}

beforeEach(() => {
  loadStrandViews.mockClear()
  state = createStrandCanvasState(() => STRAND)
  StrandCanvas = loadComponent()
  for (const key of Object.keys(listeners)) delete listeners[key]
  vi.stubGlobal('window', {
    innerWidth: 1440,
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: (type: string, handler: (event: unknown) => void) => { (listeners[type] ??= []).push(handler) },
    removeEventListener: () => {},
  })
})

afterEach(() => {
  trees.splice(0).forEach(({ app }) => app.unmount())
  vi.unstubAllGlobals()
})

describe('strand canvas shell', () => {
  it('stays out of the way while the strand has no view', async () => {
    loadStrandViews.mockResolvedValueOnce([])
    const root = mount(StrandCanvas, { strandId: STRAND })
    await flush()
    expect(byTestId(root, 'strand-canvas')).toBeUndefined()
  })

  it('shows the closed rail first and opens on a click', async () => {
    const root = mount(StrandCanvas, { strandId: STRAND })
    await flush()

    const rail = byTestId(root, 'canvas-rail')
    expect(rail).toBeDefined()
    expect(byTestId(root, 'canvas-open')).toBeUndefined()

    click(rail)
    await flush()

    expect(byTestId(root, 'canvas-open')).toBeDefined()
    expect(byTestId(root, 'canvas-splitter')).toBeDefined()
    expect(byTestId(root, 'artifact')?.props['data-artifact']).toBe('art-1')
  })

  it('badges an unseen revision while the canvas is closed and clears it on open', async () => {
    const root = mount(StrandCanvas, { strandId: STRAND })
    await flush()
    expect(byTestId(root, 'canvas-badge')).toBeUndefined()

    state.receive(update({ revision: 2, latestRevision: 2, artifactId: 'art-2' }))
    await flush()
    expect(byTestId(root, 'canvas-badge')).toBeDefined()

    click(byTestId(root, 'canvas-rail'))
    await flush()
    expect(byTestId(root, 'canvas-badge')).toBeUndefined()
    // Opening lands on the newest revision, not on the one from the list call.
    expect(byTestId(root, 'artifact')?.props['data-artifact']).toBe('art-2')
  })

  it('follows a revision that arrives while the view is open, without a badge', async () => {
    const root = mount(StrandCanvas, { strandId: STRAND })
    await flush()
    click(byTestId(root, 'canvas-rail'))
    await flush()

    state.receive(update({ revision: 3, latestRevision: 3, artifactId: 'art-3' }))
    await flush()

    expect(byTestId(root, 'artifact')?.props['data-artifact']).toBe('art-3')
    expect(byTestId(root, 'canvas-badge')).toBeUndefined()
  })

  it('switches views through the tab bar', async () => {
    const root = mount(StrandCanvas, { strandId: STRAND })
    await flush()
    click(byTestId(root, 'canvas-rail'))
    await flush()

    const tab = all(root).find(n => n.tag === 'button' && all(n).some(child => child.text.includes('Rear wheel')))
    expect(tab).toBeDefined()
    click(tab)
    await flush()

    expect(byTestId(root, 'artifact')?.props['data-artifact']).toBe('art-r1')
  })

  it('falls back to the narrow layout when the chat would drop below its minimum', async () => {
    vi.stubGlobal('window', {
      innerWidth: 820,
      localStorage: { getItem: () => null, setItem: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    const root = mount(StrandCanvas, { strandId: STRAND })
    await flush()
    click(byTestId(root, 'canvas-rail'))
    await flush()

    // No splitter in the narrow layout: the panel covers the chat instead of
    // sharing the row with it.
    expect(byTestId(root, 'canvas-open')).toBeDefined()
    expect(byTestId(root, 'canvas-splitter')).toBeUndefined()
  })

  it('closes on Escape and toggles on Ctrl+J', async () => {
    const root = mount(StrandCanvas, { strandId: STRAND })
    await flush()
    const keydown = listeners.keydown ?? []
    expect(keydown.length).toBeGreaterThan(0)

    for (const handler of keydown) handler({ key: 'j', ctrlKey: true, preventDefault: () => {} })
    await flush()
    expect(byTestId(root, 'canvas-open')).toBeDefined()

    for (const handler of keydown) handler({ key: 'Escape', preventDefault: () => {} })
    await flush()
    expect(byTestId(root, 'canvas-open')).toBeUndefined()
  })
})
