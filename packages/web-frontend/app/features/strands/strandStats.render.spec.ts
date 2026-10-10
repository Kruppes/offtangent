/**
 * Phase B render specs for the strand statistics in the context panel:
 * lazy load on open, loading / error / unsupported / ready, the six tiles,
 * the task timeline and the "estimated" hint. Real SFC on an in-memory Vue
 * host (same harness idea as w5b.render.spec.ts); fixtures are {{secret:url-password-10}}.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'
import * as useApiModule from '~/composables/useApi'
import * as datetime from '~/utils/datetime'
import * as strandStats from '~/utils/strandStats'
import type { StrandStatsView } from '~/utils/strandStats'

// Vitest SSR-transforms an imported SFC; the in-memory client host below needs
// the client build, so the SFC is compiled here (same as w5b.render.spec.ts).
function load(path: string): Component {
  const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: path, inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  const modules: Record<string, unknown> = { 'vue': Vue, '~/composables/useApi': useApiModule, '~/utils/datetime': datetime, '~/utils/strandStats': strandStats }
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}
const StrandStats = load('../../components/context/StrandStats.vue')

interface Node { tag: string; text: string; props: Record<string, unknown>; children: Node[]; parent: Node | null }
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
const apps: Vue.App[] = []
function mount(component: Component, props: Record<string, unknown>): Node {
  const root = node('root')
  const app = renderer.createApp(component, props)
  app.config.globalProperties.$t = ((key: string, params?: unknown) => key + (params ? JSON.stringify(params) : '')) as typeof app.config.globalProperties.$t
  app.component('AppIcon', defineComponent({ props: ['name'], setup: () => () => h('i') }))
  app.mount(root)
  apps.push(app)
  return root
}
const all = (root: Node): Node[] => [root, ...root.children.flatMap(all)]
const text = (root: Node) => all(root).map(n => n.text).join(' ')
const find = (root: Node, attr: string) => all(root).find(n => attr in n.props)
const findAll = (root: Node, attr: string) => all(root).filter(n => attr in n.props)
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  await nextTick()
}
function setup() {
  const apiFetch = vi.fn()
  vi.stubGlobal('useApi', () => ({ apiFetch }))
  vi.stubGlobal('useI18n', () => ({ t: (key: string, params?: unknown) => key + (params ? JSON.stringify(params) : ''), locale: Vue.ref('en') }))
  return { apiFetch }
}
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  vi.unstubAllGlobals()
})

const bucket = (requests: number, uncached: number, cacheRead: number, out: number, costUsd: number) =>
  ({ requests, uncached, cacheRead, cacheWrite: 0, out, in: uncached + cacheRead, cacheHitRatio: cacheRead / Math.max(1, uncached + cacheRead), costUsd })
const part = { runs: 1, durationSec: 60, tokensIn: 100, tokensOut: 10, costUsd: 1 }

function fixture(over: Partial<StrandStatsView> = {}): StrandStatsView {
  return {
    schema: 'strand_stats.v1',
    strandId: 's1',
    persona: 'main',
    contextWindow: 200000,
    span: { firstAt: '2026-10-01T10:00:00.000Z', lastAt: '2026-10-01T11:00:00.000Z', wallSec: 3600 },
    prompts: { total: 3, typed: 1, voice: 1, answers: 1 },
    turns: { user: 3, auto: 1, source: 'estimated' },
    tokens: { main: bucket(4, 1000, 9000, 300, 1), tasks: bucket(2, 500, 4500, 200, 2), voice: bucket(0, 0, 0, 0, 0), total: bucket(6, 1500, 13500, 500, 3) },
    cost: { totalUsd: 3, subscriptionUsd: 3, meteredUsd: 0, localUsd: 0, subscriptionShare: 1 },
    models: [
      { provider: 'anthropic', model: 'claude-sonnet', billing: 'subscription', requests: 4, tokensIn: 10000, tokensOut: 300, cacheHitRatio: 0.9, costUsd: 3 },
      { provider: 'ollama', model: 'qwen3', billing: 'local', requests: 2, tokensIn: 5000, tokensOut: 200, cacheHitRatio: null, costUsd: 0 },
    ],
    local: { requests: 2, requestShare: 1 / 3, tokenShare: 0.33 },
    personas: [{ ...part, id: 'main', isStrandPersona: true, ok: 1, failed: 0, running: 0, successRatio: 1, models: ['claude-sonnet'], split: { chat: part, tasks: part } }],
    tools: { main: 2, total: 3, errors: 1, distinct: 2, top: [{ name: 'shell', calls: 2, callsMain: 2, errors: 1, avgMs: 10 }, { name: 'web_fetch', calls: 1, callsMain: 0, errors: 0, avgMs: 20 }] },
    taskCount: 2,
    taskStatus: { completed: 1, failed: 1, running: 0, paused: 0 },
    nestedTasks: 1,
    delegations: { task: 2, askAgent: 0 },
    autarky: { agentSec: 1200, effortSec: 1500, mainSec: 900, tasksSec: 600, longestSec: 700, perPromptSec: 400, latencyMedianSec: 4, parallelPeak: 2, wallSec: 3600, estimated: true },
    compaction: { summaries: 0, trimmedTurns: 2, trimmedMessages: 10, lastKeptTokens: 50000, budgetTokens: 80000 },
    failedRequests: 0,
    tasks: [
      { id: 't1', name: 'Research', persona: 'main', model: 'claude-sonnet', status: 'completed', depth: 0, startedAt: '2026-10-01T10:05:00.000Z', endedAt: '2026-10-01T10:15:00.000Z', durationSec: 600, costUsd: 2, toolCalls: 1, toolErrors: 0 },
      { id: 't2', name: 'Sub', persona: 'main', model: 'qwen3', status: 'failed', depth: 1, startedAt: '2026-10-01T10:07:00.000Z', endedAt: '2026-10-01T10:09:00.000Z', durationSec: 120, costUsd: 0, toolCalls: 0, toolErrors: 0 },
    ],
    series: [
      { at: '2026-10-01T10:00:00.000Z', kind: 'user', maxRequestTokens: 1000, out: 100, requests: 2, durationSec: 30 },
      { at: '2026-10-01T10:20:00.000Z', kind: 'user', maxRequestTokens: 5000, out: 200, requests: 3, durationSec: 60 },
    ],
    ...over,
  }
}

const toggle = (root: Node, open: boolean) => {
  const details = all(root).find(n => n.tag === 'details' && typeof n.props.onToggle === 'function')!
  ;(details.props.onToggle as (e: unknown) => void)({ target: { open } })
}

describe('StrandStats', () => {
  it('stays idle (no request) until the section is opened', async () => {
    const { apiFetch } = setup()
    apiFetch.mockResolvedValue(fixture())
    const root = mount(StrandStats, { strandId: 's1' })
    await flush()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(find(root, 'data-strand-stats')!.props['data-state']).toBe('idle')
    toggle(root, true)
    await flush()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch.mock.calls[0][0]).toBe('/api/strands/s1/stats?include=tasks,series')
    expect(find(root, 'data-strand-stats')!.props['data-state']).toBe('ready')
    // closing and re-opening does not refetch
    toggle(root, false)
    toggle(root, true)
    await flush()
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('renders six tiles, models with billing tags, the timeline and the estimated hint', async () => {
    const { apiFetch } = setup()
    apiFetch.mockResolvedValue(fixture())
    const root = mount(StrandStats, { strandId: 's1', initiallyOpen: true })
    await flush()
    const tiles = findAll(root, 'data-stats-tile').map(n => n.props['data-stats-tile'])
    expect(tiles).toEqual(['in', 'out', 'cost', 'prompts', 'tools', 'autarky'])
    const body = text(root)
    expect(body).toContain('15k') // tokens in
    expect(body).toContain('$3.00')
    expect(body).toContain('20 min') // agent time
    expect(body).toContain('context.stats.billing.local')
    expect(body).toContain('context.stats.billing.subscription')
    expect(find(root, 'data-stats-estimated')).toBeTruthy()
    const timeline = find(root, 'data-stats-timeline')!
    const bars = all(timeline).filter(n => n.tag === 'rect')
    expect(bars).toHaveLength(2)
    expect(bars[1].props.class).toBe('fill-destructive')
    expect(find(root, 'data-stats-spark')).toBeTruthy()
  })

  it('hides the estimated hint for recorded turns', async () => {
    const { apiFetch } = setup()
    const f = fixture()
    apiFetch.mockResolvedValue(fixture({ autarky: { ...f.autarky, estimated: false }, turns: { ...f.turns, source: 'recorded' } }))
    const root = mount(StrandStats, { strandId: 's1', initiallyOpen: true })
    await flush()
    expect(find(root, 'data-stats-estimated')).toBeUndefined()
  })

  it('shows an error with a retry that refetches', async () => {
    const { apiFetch } = setup()
    apiFetch.mockRejectedValueOnce(new useApiModule.ApiError('boom', 500)).mockResolvedValueOnce(fixture())
    const root = mount(StrandStats, { strandId: 's1', initiallyOpen: true })
    await flush()
    expect(find(root, 'data-strand-stats')!.props['data-state']).toBe('error')
    expect(text(root)).toContain('context.stats.error')
    ;(find(root, 'data-stats-retry')!.props.onClick as () => void)()
    await flush()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(find(root, 'data-strand-stats')!.props['data-state']).toBe('ready')
  })

  it('treats a 404 (older backend) and an unknown schema as unsupported', async () => {
    const { apiFetch } = setup()
    apiFetch.mockRejectedValueOnce(new useApiModule.ApiError('not found', 404))
    const root = mount(StrandStats, { strandId: 's1', initiallyOpen: true })
    await flush()
    expect(find(root, 'data-strand-stats')!.props['data-state']).toBe('unsupported')
    apiFetch.mockResolvedValueOnce({ schema: 'strand_stats.v9' })
    const other = mount(StrandStats, { strandId: 's2', initiallyOpen: true })
    await flush()
    expect(find(other, 'data-strand-stats')!.props['data-state']).toBe('unsupported')
  })
})
