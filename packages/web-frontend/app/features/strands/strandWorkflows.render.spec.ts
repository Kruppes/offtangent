import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import * as Vue from 'vue'
import * as detailApi from './detailApi'
import { ApiError } from '~/composables/useApi'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transpileModule, ModuleKind } from 'typescript'
import * as shellCommands from '../../composables/useShellCommands'
import * as strandW5b from '~/api/strandW5b'
import * as strandEco from '~/api/strandEco'

// The existing render config compiles imports for SSR. Compile these four
// SFCs for Vue's client renderer instead, so onMounted and clicks really run.
function loadPage(path: string): Component {
  const filename = new URL(path, import.meta.url)
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const script = compileScript(descriptor, { id: path, inlineTemplate: true })
  const { outputText } = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS } })
  const exports: { default?: Component } = {}
  const modules: Record<string, unknown> = { vue: Vue, '~/composables/useShellCommands': shellCommands, './detailApi': detailApi, '~/api/strandW5b': strandW5b, '~/api/models': { useModelsApi: () => ({ listModels: async () => [] }) }, '~/api/projects': { useProjectsApi: () => ({ list: async () => [] }) }, './StrandActions.vue': { default: defineComponent({ render: () => h('aside') }) }, './EcoModeSwitch.vue': { default: defineComponent({ render: () => h('span') }) }, '~/api/strandEco': strandEco }
  new Function('require', 'exports', outputText)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`)
    return modules[name]
  }, exports)
  return exports.default!
}
const Actions = loadPage('./StrandActions.vue')
const Header = loadPage('./StrandDetailHeader.vue')
const EcoSwitch = loadPage('./EcoModeSwitch.vue')

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

  it('W5b: shows the lineage both ways, linked, only when present', async () => {
    const api = setup()
    api.mockResolvedValueOnce({ strand: { id: 'child', title: 'Child', tags: [], projectId: null, pinned: false, parentStrandId: 'parent', parentStrandTitle: 'Parent strand', forkedFromMessageId: 12, childStrands: [{ id: 'grandchild', title: 'Grandchild', forkedAt: null, forkedFromMessageId: 3 }] } })
    const { root } = mount(Header, { strandId: 'child' }); await flush()
    expect(text(root)).toContain('fork.forkedFrom')
    expect(text(root)).toContain('Parent strand')
    expect(text(root)).toContain('fork.branches')
    expect(text(root)).toContain('Grandchild')
    const nav = all(root).find(n => n.tag === 'nav')
    expect(nav?.props['aria-label']).toBe('fork.lineageLabel')
    const links = all(root).filter(n => n.tag === 'a').map(n => n.props.to)
    expect(links).toContain('/strands/parent#msg-12')
    expect(links).toContain('/strands/grandchild')

    const plain = setup()
    plain.mockResolvedValueOnce({ strand: { id: 'solo', title: 'Solo', tags: [], projectId: null, pinned: false, parentStrandId: null } })
    const second = mount(Header, { strandId: 'solo' }); await flush()
    expect(all(second.root).some(n => n.tag === 'nav')).toBe(false)
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

describe('eco mode switch', () => {
  const eco = (enabled: boolean, last: unknown = null) => ({ eco: { enabled, observedContextLimitTokens: null, inputBudgetTokens: 28000, outputReserveTokens: 4096, contextFallback: false, last } })
  it('loads off by default, switches on with a strict PATCH and shows estimates', async () => {
    const api = setup()
    api.mockResolvedValueOnce(eco(false))
    api.mockResolvedValueOnce(eco(true, { estimatedTokensBefore: 1000, estimatedTokensAfter: 400, inputBudgetTokens: 28000, compactedResults: 2, droppedMessages: 0, degraded: true, at: null }))
    const { root } = mount(EcoSwitch, { strandId: 's/1' })
    await flush()
    const toggle = all(root).find(n => n.props['data-testid'] === 'eco-toggle')!
    expect(toggle.props['aria-checked']).toBe(false)
    expect(text(root)).toContain('eco.off')
    await click(root, 'eco.label')
    expect(api.mock.calls).toEqual([['/api/strands/s%2F1/context'], ['/api/strands/s%2F1/eco', { method: 'PATCH', body: '{"enabled":true}' }]])
    expect(text(root)).toContain('eco.on')
    expect(text(root)).toContain('eco.saved{"percent":60}')
    expect(text(root)).toContain('eco.degraded')
    expect(text(root)).toContain('eco.turnedOn')
  })
  it('keeps the old state and shows an error when the switch fails', async () => {
    const api = setup()
    api.mockResolvedValueOnce(eco(true))
    api.mockRejectedValueOnce(new ApiError('raw', 500, {}))
    const { root } = mount(EcoSwitch, { strandId: 's' })
    await flush()
    await click(root, 'eco.label')
    expect(text(root)).toContain('eco.saveError')
    expect(text(root)).toContain('eco.on')
  })
  it('context window: Unverändert by default, sends only contextWindow, shows the honest state', async () => {
    const api = setup()
    const cw = (choice: number | null, state: string, supported = true) => ({ choice, presets: [32768, 49152, 65536, 131072], supported, state })
    api.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: cw(null, 'unchanged') } })
    api.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: cw(65536, 'baseline_unknown') } })
    const { root } = mount(EcoSwitch, { strandId: 's' })
    await flush()
    const select = all(root).find(n => n.props['data-testid'] === 'eco-cw-select')!
    expect(select.props.value).toBe('')
    expect(text(root)).toContain('eco.cwUnchanged')
    expect(text(root)).toContain('eco.cwState.unchanged')
    const label = all(root).find(n => n.tag === 'label')!
    expect(label.props.for).toBe(select.props.id)
    ;(select.props.onChange as (e: unknown) => void)({ target: { value: '65536' } })
    await flush()
    expect(api.mock.calls[1]).toEqual(['/api/strands/s/eco', { method: 'PATCH', body: '{"contextWindow":65536}' }])
    expect(text(root)).toContain('eco.cwState.baseline_unknown')
    expect(text(root)).toContain('eco.off')
  })
  it('context window: shows the effective num_ctx, pending facts, and that a choice is a request, not a guaranteed limit', async () => {
    const api = setup()
    const cw = { choice: 65536, presets: [32768, 49152, 65536, 131072], supported: true, state: 'applied', effective: 65536, facts: 'known' }
    api.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: cw } })
    const { root } = mount(EcoSwitch, { strandId: 's' })
    await flush()
    const eff = all(root).find(n => n.props['data-testid'] === 'eco-cw-effective')!
    expect(text(eff)).toContain('eco.cwEffective')
    expect(text(root)).toContain('eco.cwNotGuaranteed')
    const api2 = setup()
    api2.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: { ...cw, state: 'baseline_unknown', effective: null, facts: 'pending' } } })
    const second = mount(EcoSwitch, { strandId: 's' })
    await flush()
    expect(text(second.root)).toContain('eco.cwEffectiveNone')
    expect(text(second.root)).toContain('eco.cwFactsPending')
  })
  it('context window: shows the configured baseline and its source, or a clear "baseline unknown" call to action', async () => {
    const api = setup()
    const base = { choice: 65536, presets: [32768, 49152, 65536, 131072], supported: true, facts: 'known' }
    api.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: { ...base, state: 'applied', effective: 65536, baseline: 40960, baselineSource: 'model_setting' } } })
    const { root } = mount(EcoSwitch, { strandId: 's' })
    await flush()
    expect(all(root).some(n => n.props['data-testid'] === 'eco-cw-baseline')).toBe(true)
    expect(text(root)).toContain('eco.cwBaseline')
    expect(text(root)).not.toContain('eco.cwBaselineMissing')
    const api2 = setup()
    api2.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: { ...base, state: 'baseline_unknown', effective: null, baseline: null, baselineSource: null } } })
    const second = mount(EcoSwitch, { strandId: 's' })
    await flush()
    expect(text(second.root)).toContain('eco.cwBaselineMissing')
    expect(text(second.root)).toContain('eco.cwEffectiveNone')
  })
  it('context window: MLX runner (fixed window) blocks a new choice, keeps a stale choice resettable and says why', async () => {
    const api = setup()
    const base = { presets: [32768, 49152, 65536, 131072], supported: true, facts: 'known', effective: null, baseline: 262144, baselineSource: 'runner_max' }
    api.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: { ...base, choice: null, state: 'unchanged' } } })
    const { root } = mount(EcoSwitch, { strandId: 's' })
    await flush()
    expect(all(root).find(n => n.props['data-testid'] === 'eco-cw-select')!.props.disabled).toBe(true)
    expect(text(root)).toContain('eco.cwBaseline')
    const api2 = setup()
    api2.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: { ...base, choice: 65536, state: 'runner_fixed' } } })
    const second = mount(EcoSwitch, { strandId: 's' })
    await flush()
    expect(all(second.root).find(n => n.props['data-testid'] === 'eco-cw-select')!.props.disabled).toBe(false)
    expect(text(second.root)).toContain('eco.cwState.runner_fixed')
    expect(text(second.root)).toContain('eco.cwEffectiveNone')
  })
  it('context window: disabled with a reason on a non-native provider, error keeps the old value', async () => {
    const api = setup()
    api.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: { choice: null, presets: [32768], supported: false, state: 'provider_unsupported' } } })
    const { root } = mount(EcoSwitch, { strandId: 's' })
    await flush()
    const select = all(root).find(n => n.props['data-testid'] === 'eco-cw-select')!
    expect(select.props.disabled).toBe(true)
    expect(text(root)).toContain('eco.cwState.provider_unsupported')
    const api2 = setup()
    api2.mockResolvedValueOnce({ eco: { ...eco(false).eco, contextWindow: { choice: null, presets: [32768], supported: true, state: 'unchanged' } } })
    api2.mockRejectedValueOnce(new ApiError('raw', 500, {}))
    const second = mount(EcoSwitch, { strandId: 's' })
    await flush()
    const sel2 = all(second.root).find(n => n.props['data-testid'] === 'eco-cw-select')!
    ;(sel2.props.onChange as (e: unknown) => void)({ target: { value: '32768' } })
    await flush()
    expect(text(second.root)).toContain('eco.cwSaveError')
    expect(all(second.root).find(n => n.props['data-testid'] === 'eco-cw-select')!.props.value).toBe('')
  })
  it('context window picker is hidden for an older server without the block', async () => {
    const api = setup()
    api.mockResolvedValueOnce(eco(false))
    const { root } = mount(EcoSwitch, { strandId: 's' })
    await flush()
    expect(all(root).some(n => n.props['data-testid'] === 'eco-context-window')).toBe(false)
  })
  it('offers retry on a load error and hides itself for an older server without eco', async () => {
    const api = setup()
    api.mockRejectedValueOnce(new ApiError('raw', 500, {}))
    api.mockResolvedValueOnce({ tokens: {} })
    const { root } = mount(EcoSwitch, { strandId: 's' })
    await flush()
    expect(text(root)).toContain('eco.loadError')
    await click(root, 'strandDetail.retry')
    expect(all(root).some(n => n.props['data-testid'] === 'eco-mode')).toBe(false)
  })
})
