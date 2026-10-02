/**
 * The revision switcher of a living view, rendered (2026-09-26).
 *
 * The canvas card is the only surface that decides which revision of a view a
 * user sees, so the rules are pinned against the real SFC: paging is clamped at
 * both ends, an older revision announces itself, and switching a revision
 * fetches THAT revision's bytes — never the newest ones under an old label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'
import * as inlineArtifacts from '~/utils/inlineArtifacts'

interface Node {
  tag: string
  text: string
  props: Record<string, unknown>
  children: Node[]
  parent: Node | null
  addEventListener: () => void
  closest: () => null
}

const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [], parent: null, addEventListener: () => {}, closest: () => null })

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

const REVISIONS = [
  { revision: 1, artifactId: 'art-1', messageId: 10, title: 'Front wheel round 1', createdAt: '2026-09-26T10:00:00.000Z' },
  { revision: 2, artifactId: 'art-2', messageId: 11, title: 'Front wheel round 2', createdAt: '2026-09-26T11:00:00.000Z' },
  { revision: 3, artifactId: 'art-3', messageId: 12, title: 'Front wheel round 3', createdAt: '2026-09-26T12:00:00.000Z' },
]

const loadArtifact = vi.fn(async (id: string) => ({
  detail: {
    artifact: {
      id,
      strandId: 'strand-1',
      messageId: 10,
      agentId: 'main',
      kind: 'html' as const,
      title: `Title of ${id}`,
      source: 'upload',
      mimeType: 'text/html',
      size: 10,
      createdAt: '2026-09-26T10:00:00.000Z',
      viewKey: 'front-wheel',
      revision: REVISIONS.find(entry => entry.artifactId === id)?.revision ?? null,
      latestRevision: 3,
    },
    contentUrl: `/api/artifacts/${id}/content?t=x`,
    contentExpiresAt: '2026-09-26T10:05:00.000Z',
    embed: { iframeSandbox: 'allow-scripts', iframeReferrerPolicy: 'no-referrer', separateOrigin: false, denies: [] },
  },
  blob: new Blob([`<p>${id}</p>`]),
  document: `<p>${id}</p>`,
}))
const loadStrandViews = vi.fn(async () => ([
  { viewKey: 'front-wheel', title: 'Front wheel round 3', kind: 'html' as const, latestRevision: 3, updatedAt: '2026-09-26T12:00:00.000Z', revisions: REVISIONS },
]))

function loadComponent(): Component {
  const filename = new URL('./ChatArtifact.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const script = compileScript(descriptor, { id: 'ChatArtifact.vue', inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  const modules: Record<string, unknown> = {
    vue: Vue,
    '~/api/artifacts': { useArtifactsApi: () => ({ loadArtifact, loadStrandViews }) },
    '~/utils/inlineArtifacts': inlineArtifacts,
  }
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}

const trees: Array<{ app: Vue.App; root: Node }> = []

function mount(component: Component, props: Record<string, unknown>): { app: Vue.App; root: Node } {
  const root = node('root')
  const app = renderer.createApp(component, props)
  app.config.globalProperties.$t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key}(${Object.values(params).join('/')})` : key) as typeof app.config.globalProperties.$t
  app.mount(root)
  const result = { app, root }
  trees.push(result)
  return result
}

function all(root: Node): Node[] { return [root, ...root.children.flatMap(all)] }
function text(root: Node): string { return all(root).map(n => n.text).join(' ') }
function buttons(root: Node): Node[] { return all(root).filter(n => n.tag === 'button') }
function byLabel(root: Node, label: string): Node | undefined {
  return all(root).find(n => n.props['aria-label'] === label)
}
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  await nextTick()
}
function click(el: Node | undefined) {
  const handler = el?.props.onClick as ((event: unknown) => void) | undefined
  handler?.({})
}

let ChatArtifact: Component

beforeEach(() => {
  loadArtifact.mockClear()
  loadStrandViews.mockClear()
  ChatArtifact = loadComponent()
  vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }))
})

afterEach(() => {
  trees.splice(0).forEach(({ app }) => app.unmount())
  vi.unstubAllGlobals()
})

describe('ChatArtifact revision switcher', () => {
  const viewProps = {
    artifactId: 'art-3',
    title: 'Front wheel round 3',
    strandId: 'strand-1',
    viewKey: 'front-wheel',
    revision: 3,
    latestRevision: 3,
  }

  it('shows the revision counter of the view and loads the revision of the message', async () => {
    const { root } = mount(ChatArtifact, viewProps)
    await flush()
    expect(loadStrandViews).toHaveBeenCalledWith('strand-1')
    expect(loadArtifact).toHaveBeenCalledWith('art-3')
    expect(text(root)).toContain('chat.artifact.revisionOf(3/3)')
  })

  it('pages back to the previous revision and fetches its bytes', async () => {
    const { root } = mount(ChatArtifact, viewProps)
    await flush()
    click(byLabel(root, 'chat.artifact.previousRevision'))
    await flush()
    expect(loadArtifact).toHaveBeenLastCalledWith('art-2')
    expect(text(root)).toContain('chat.artifact.revisionOf(2/3)')
    click(byLabel(root, 'chat.artifact.previousRevision'))
    await flush()
    expect(loadArtifact).toHaveBeenLastCalledWith('art-1')
    expect(text(root)).toContain('chat.artifact.revisionOf(1/3)')
  })

  it('disables the switcher at both ends instead of wrapping around', async () => {
    const { root } = mount(ChatArtifact, viewProps)
    await flush()
    expect(byLabel(root, 'chat.artifact.nextRevision')!.props.disabled).toBe(true)
    expect(byLabel(root, 'chat.artifact.previousRevision')!.props.disabled).toBe(false)
    click(byLabel(root, 'chat.artifact.previousRevision'))
    click(byLabel(root, 'chat.artifact.previousRevision'))
    await flush()
    expect(byLabel(root, 'chat.artifact.previousRevision')!.props.disabled).toBe(true)
    expect(byLabel(root, 'chat.artifact.nextRevision')!.props.disabled).toBe(false)
    // Clicking the disabled end must not move anywhere.
    click(byLabel(root, 'chat.artifact.previousRevision'))
    await flush()
    expect(loadArtifact).toHaveBeenLastCalledWith('art-1')
  })

  it('announces an older revision and can jump to the newest', async () => {
    const { root } = mount(ChatArtifact, { ...viewProps, artifactId: 'art-1', revision: 1 })
    await flush()
    expect(text(root)).toContain('chat.artifact.outdated')
    const latest = buttons(root).find(button => text(button).includes('chat.artifact.showLatest'))
    click(latest)
    await flush()
    expect(loadArtifact).toHaveBeenLastCalledWith('art-3')
    expect(text(root)).not.toContain('chat.artifact.outdated')
  })

  it('stays a plain canvas without a view key: no switcher, no history request', async () => {
    const { root } = mount(ChatArtifact, { artifactId: 'art-9', title: 'One off', strandId: 'strand-1' })
    await flush()
    expect(loadStrandViews).not.toHaveBeenCalled()
    expect(byLabel(root, 'chat.artifact.previousRevision')).toBeUndefined()
    expect(text(root)).not.toContain('chat.artifact.outdated')
  })

  it('keeps the canvas when the view history cannot be loaded', async () => {
    loadStrandViews.mockRejectedValueOnce(new Error('offline'))
    const { root } = mount(ChatArtifact, viewProps)
    await flush()
    expect(loadArtifact).toHaveBeenCalledWith('art-3')
    expect(byLabel(root, 'chat.artifact.previousRevision')).toBeUndefined()
    expect(all(root).some(n => n.tag === 'iframe')).toBe(true)
  })
})

// ── Inline frame (W4a): lazy window, states, sandbox ─────────────────────────
/** A controllable IntersectionObserver: tests decide what is near. */
class FakeObserver {
  static all: FakeObserver[] = []
  margin: string
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void, options: { rootMargin: string }) {
    this.margin = options.rootMargin
    FakeObserver.all.push(this)
  }
  observe() {}
  disconnect() { FakeObserver.all = FakeObserver.all.filter(o => o !== this) }
  fire(isIntersecting: boolean) { this.callback([{ isIntersecting }]) }
}
const margin = (px: number) => FakeObserver.all.find(o => o.margin === `${px}px 0px`)!
const frame = (root: Node) => all(root).find(n => 'data-artifact-frame' in n.props)!
const iframes = (root: Node) => all(root).filter(n => n.tag === 'iframe')

describe('ChatArtifact inline frame', () => {
  beforeEach(() => {
    FakeObserver.all = []
    vi.stubGlobal('IntersectionObserver', FakeObserver)
  })

  it('placeholder: fixed height, no fetch, no frame until it comes near', async () => {
    const { root } = mount(ChatArtifact, { artifactId: 'art-9', title: 'One off', strandId: 'strand-1' })
    await flush()
    expect(frame(root).props['data-frame-state']).toBe('idle')
    expect(loadArtifact).not.toHaveBeenCalled()
    expect(iframes(root)).toHaveLength(0)
    expect(text(root)).toContain('w4a.artifact.placeholder')
    const body = all(root).find(n => 'data-artifact-body' in n.props)!
    expect(body.props.style).toEqual({ height: `${inlineArtifacts.FRAME_HEIGHT_PX}px` })
  })

  it('loaded: runs sandboxed without same-origin once near, parks far away and comes back without a refetch', async () => {
    const { root } = mount(ChatArtifact, { artifactId: 'art-9', title: 'One off', strandId: 'strand-1' })
    margin(inlineArtifacts.FRAME_KEEP_MARGIN_PX).fire(true)
    margin(inlineArtifacts.FRAME_MOUNT_MARGIN_PX).fire(true)
    await flush()
    expect(loadArtifact).toHaveBeenCalledTimes(1)
    expect(frame(root).props['data-load-state']).toBe('ready')
    const [iframe] = iframes(root)
    expect(iframe!.props.sandbox).toBe('allow-scripts')
    expect(String(iframe!.props.sandbox)).not.toContain('allow-same-origin')
    expect(iframe!.props.srcdoc).toBe('<p>art-9</p>')
    expect(iframe!.props.referrerpolicy).toBe('no-referrer')

    // out of the mount margin but inside the keep zone: keeps running
    margin(inlineArtifacts.FRAME_MOUNT_MARGIN_PX).fire(false)
    await flush()
    expect(iframes(root)).toHaveLength(1)
    // far away: unloaded, the placeholder holds the height
    margin(inlineArtifacts.FRAME_KEEP_MARGIN_PX).fire(false)
    await flush()
    expect(frame(root).props['data-frame-state']).toBe('parked')
    expect(iframes(root)).toHaveLength(0)
    expect(text(root)).toContain('w4a.artifact.paused')
    // back again: remounted from the kept document
    margin(inlineArtifacts.FRAME_KEEP_MARGIN_PX).fire(true)
    margin(inlineArtifacts.FRAME_MOUNT_MARGIN_PX).fire(true)
    await flush()
    expect(iframes(root)).toHaveLength(1)
    expect(loadArtifact).toHaveBeenCalledTimes(1)
  })

  it('error: says so and loads again on "Reload"', async () => {
    loadArtifact.mockImplementationOnce(async () => { throw new Error('network down') })
    const { root } = mount(ChatArtifact, { artifactId: 'art-9', title: 'One off', strandId: 'strand-1' })
    margin(inlineArtifacts.FRAME_MOUNT_MARGIN_PX).fire(true)
    await flush()
    expect(frame(root).props['data-load-state']).toBe('error')
    const alert = all(root).find(n => 'data-artifact-error' in n.props)!
    expect(alert.props.role).toBe('alert')
    expect(text(alert)).toContain('w4a.artifact.error')
    expect(iframes(root)).toHaveLength(0)
    click(all(root).find(n => 'data-artifact-retry' in n.props))
    await flush()
    expect(loadArtifact).toHaveBeenCalledTimes(2)
    expect(frame(root).props['data-load-state']).toBe('ready')
    expect(iframes(root)).toHaveLength(1)
  })

  it('shows the fenced source on request, as text, never as markup', async () => {
    const { root } = mount(ChatArtifact, { artifactId: 'art-9', title: 'One off', sourceText: '<script>alert(1)</script>' })
    expect(all(root).find(n => 'data-artifact-source' in n.props)).toBeUndefined()
    const toggle = all(root).find(n => 'data-artifact-source-toggle' in n.props)!
    expect(toggle.props['aria-expanded']).toBe(false)
    click(toggle)
    await flush()
    const source = all(root).find(n => 'data-artifact-source' in n.props)!
    expect(text(source)).toContain('<script>alert(1)</script>')
    expect(all(source).some(n => 'innerHTML' in n.props)).toBe(false)
    expect(toggle.props['aria-controls']).toBe(source.props.id)
  })
})
