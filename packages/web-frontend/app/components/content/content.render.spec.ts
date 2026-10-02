import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import TranscriptState from './TranscriptState.vue'
import TurnLine from './TurnLine.vue'
import * as transcript from './transcript'
import * as Vue from 'vue'
import { createRenderer, nextTick, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'
import type { ChatMessage } from '../../composables/useChat'

const t = (key: string, params?: Record<string, unknown>) => `${key}${params && Object.keys(params).length ? JSON.stringify(params) : ''}`

async function render(props: Record<string, unknown>) {
  const app = createSSRApp({ render: () => h(TurnLine, props, { tool: ({ msg }: { msg: ChatMessage }) => h('pre', String(msg.toolData!.toolResult ?? '')) }) })
  app.config.globalProperties.$t = t as never
  app.component('AppIcon', { render: () => null })
  return renderToString(app)
}

const finished: ChatMessage[] = [
  { id: 1, role: 'assistant', content: 'Weighing <both> options', isThinking: true, timestamp: '2026-01-01T10:00:00Z' },
  { id: 2, role: 'tool', content: '', timestamp: '2026-01-01T10:00:02Z', toolData: { toolName: 'shell', toolCallId: 'a', toolResult: '<output>' } },
  { id: 3, role: 'tool', content: '', timestamp: '2026-01-01T10:00:05Z', toolData: { toolName: 'read_file', toolCallId: 'b', toolIsError: true, toolResult: 'denied' } },
]

describe('turn line, collapsed (SSR)', () => {
  it('is one button with count, duration, error hint and aria-expanded=false, no step content', async () => {
    const html = await render({ steps: finished, active: false, turnEnd: '2026-01-01T10:00:40Z' })
    expect(html).toContain('data-turn-line')
    expect(html).toContain('data-turn-state="error"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('w4a.turn.steps{&quot;count&quot;:2}')
    expect(html).toContain('w4a.turn.duration.seconds{&quot;s&quot;:40}')
    expect(html).toContain('w4Content.errors{&quot;count&quot;:1}')
    expect(html).not.toContain('data-turn-steps')
    expect(html).not.toContain('&lt;output&gt;')
    expect(html).not.toContain('Weighing')
    expect(html).toMatch(/class="[^"]*text-sm[^"]*"[^>]*aria-expanded/)
    expect(html).toContain('min-h-11')
    expect(html).toContain('pointer-fine:min-h-8')
  })
  it('says "reasoning" when a turn only thought and never shows an invented duration', async () => {
    const html = await render({ steps: [{ role: 'assistant', content: 'x', isThinking: true }], active: false })
    expect(html).toContain('w4a.turn.reasoningOnly')
    expect(html).not.toContain('w4a.turn.duration')
  })
  it('streaming: shows the live step with the tool name and stays collapsed', async () => {
    const html = await render({
      steps: [{ role: 'tool', content: '', timestamp: new Date(Date.now() - 5000).toISOString(), toolData: { toolName: 'web_search', toolCallId: 'a' } }],
      active: true,
      labelOf: (m: ChatMessage) => `Label ${m.toolData!.toolName}`,
    })
    expect(html).toContain('data-turn-state="live"')
    expect(html).toContain('w4a.turn.live{&quot;step&quot;:1}')
    expect(html).toContain('Label web_search')
    expect(html).toContain('w4a.turn.duration.seconds{&quot;s&quot;:5}')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('data-turn-steps')
  })
})

// ── mounted with a stand-in DOM, so clicks run ──────────────────────────────
interface El { tag: string; text: string; props: Record<string, unknown>; children: El[]; parent: El | null; addEventListener: () => void }
const el = (tag: string, text = ''): El => ({ tag, text, props: {}, children: [], parent: null, addEventListener: () => {} })
const renderer = createRenderer<El, El>({
  createElement: tag => el(tag),
  createText: text => el('#text', text),
  createComment: text => el('#comment', text),
  setText: (n, text) => { n.text = text },
  setElementText: (n, text) => { n.text = text; n.children = [] },
  patchProp: (n, key, _prev, value) => { n.props[key] = value },
  parentNode: n => n.parent,
  nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  insert(n, parent, anchor) {
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, n)
    n.parent = parent
  },
  remove(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null },
})
function loadTurnLine(): Component {
  const filename = new URL('./TurnLine.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const script = compileScript(descriptor, { id: 'TurnLine.vue', inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  const modules: Record<string, unknown> = { vue: Vue, './transcript': transcript }
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}
const all = (n: El): El[] => [n, ...n.children.flatMap(all)]
const textOf = (n: El) => all(n).map(x => x.text).join(' ')
const find = (n: El, attr: string) => all(n).find(x => attr in x.props)

describe('turn line, opened (mounted)', () => {
  it('lists every tool step with its state; reasoning opens one level deeper; text is escaped data', async () => {
    const root = el('root')
    const app = renderer.createApp(loadTurnLine(), { steps: finished, active: false })
    app.config.globalProperties.$t = t as never
    app.component('AppIcon', { render: () => null })
    app.mount(root)
    const toggle = find(root, 'data-turn-toggle')!
    ;(toggle.props.onClick as () => void)()
    await nextTick()
    expect(toggle.props['aria-expanded']).toBe(true)
    const list = find(root, 'data-turn-steps')!
    expect(list.props.id).toBe(toggle.props['aria-controls'])
    const states = all(list).filter(x => 'data-tool-state' in x.props).map(x => x.props['data-tool-state'])
    expect(states).toEqual(['complete', 'error'])
    expect(textOf(list)).toContain('w4Content.complete')
    expect(textOf(list)).toContain('w4Content.error')
    expect(textOf(list)).not.toContain('Weighing')
    const reasoning = find(root, 'data-reasoning-toggle')!
    expect(reasoning.props['aria-expanded']).toBe(false)
    ;(reasoning.props.onClick as () => void)()
    await nextTick()
    // Interpolated as text, never as markup.
    expect(textOf(list)).toContain('Weighing <both> options')
    ;(toggle.props.onClick as () => void)()
    await nextTick()
    expect(find(root, 'data-turn-steps')).toBeUndefined()
    app.unmount()
  })
})

describe('transcript states', () => {
  it.each(['error', 'loading', 'empty', 'ready'] as const)('renders %s without leaking other states or stale messages', async state => {
    const app = createSSRApp({ render: () => h(TranscriptState, { state }, { default: () => h('p', 'Visible answer') }) })
    app.config.globalProperties.$t = (key: string) => key
    const html = await renderToString(app)
    if (state === 'ready') {
      expect(html).toContain('Visible answer')
      expect(html).not.toContain('data-transcript-state')
    } else {
      expect(html).toContain(`data-transcript-state="${state}"`)
      expect(html).not.toContain('Visible answer')
    }
    if (state === 'error') expect(html).toContain('role="alert"')
    if (state === 'loading') expect(html).toContain('role="status"')
    if (state === 'empty') expect(html).toContain('chat.noMessages')
  })
})
