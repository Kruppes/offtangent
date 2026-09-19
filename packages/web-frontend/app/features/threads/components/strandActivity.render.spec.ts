/**
 * What the strand activity view actually renders.
 *
 * No browser exists in the build sandbox, so the components go through Vue's
 * SSR renderer: real SFC compilation, real template logic, real HTML. This
 * checks the things a screenshot would have shown — which rows appear when
 * collapsed vs expanded, how deep a sub-task is indented, which status a row
 * carries, that a failure keeps its reason, that the counter is rendered, and
 * that the four UX states (loading / error / empty / success) exist.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref, computed } from 'vue'
import { renderToString } from 'vue/server-renderer'
import StrandActivityRow from './StrandActivityRow.vue'
import { buildTaskRows, type StrandTaskNode, type StrandTaskRow } from '../taskActivity'

// Nuxt auto-imports are free identifiers at runtime — providing them on
// globalThis is exactly what the Nuxt runtime does for these components.
;(globalThis as Record<string, unknown>).useI18n = () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}(${JSON.stringify(params)})` : key,
})

const IconStub = defineComponent({
  props: { name: { type: String, default: '' } },
  setup: props => () => h('i', { 'data-icon': props.name }),
})
const ButtonStub = defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) })
const SkeletonStub = defineComponent({ setup: () => () => h('div', { class: 'skeleton' }) })

function stubs(app: ReturnType<typeof createSSRApp>): void {
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  app.component('AppIcon', IconStub)
  app.component('Button', ButtonStub)
  app.component('Skeleton', SkeletonStub)
  app.config.globalProperties.$t = (key: string, params?: unknown) =>
    params ? `${key}(${JSON.stringify(params)})` : key
}

function node(over: Partial<StrandTaskNode> & Pick<StrandTaskNode, 'id'>): StrandTaskNode {
  return {
    name: over.id,
    status: 'running',
    resultStatus: null,
    triggerType: 'agent',
    agentId: 'main',
    parentTaskId: null,
    depth: 0,
    hasChildren: false,
    createdAt: '2025-09-15 10:00:00',
    startedAt: '2025-09-15 10:00:00',
    completedAt: null,
    errorMessage: null,
    toolCallCount: 0,
    sessionId: null,
    ...over,
  }
}

function rowsOf(nodes: StrandTaskNode[]): StrandTaskRow[] {
  const map: Record<string, StrandTaskNode> = {}
  for (const n of nodes) map[n.id] = n
  return buildTaskRows({ nodes: map, loadedAt: null })
}

async function renderRow(row: StrandTaskRow, expanded: boolean, reducedMotion = false, metadata?: { model: string | null; provider: string | null }): Promise<string> {
  const app = createSSRApp({
    render: () => h(StrandActivityRow, {
      row,
      expanded,
      nowMs: Date.UTC(2025, 8, 15, 10, 1, 23),
      reducedMotion,
      metadata,
    }),
  })
  stubs(app)
  return await renderToString(app)
}

describe('StrandActivityRow (rendered)', () => {
  it('renders name, running status, a live counter and a 44px touch target', async () => {
    const [row] = rowsOf([node({ id: 't1', name: 'Wave A' })])
    const html = await renderRow(row!, false)
    expect(html).toContain('Wave A')
    expect(html).toContain('strandActivity.statusRunning')
    // started 10:00:00, "now" 10:01:23 -> 1:23
    expect(html).toContain('1:23')
    expect(html).toContain('min-h-[44px]')
    expect(html).toContain('bg-success')
  })

  it('indents a sub-task by its level and shows a chevron only when it has children', async () => {
    const roots = rowsOf([
      node({ id: 'p', name: 'Parent' }),
      node({ id: 'c', name: 'Child', parentTaskId: 'p' }),
    ])
    const parentHtml = await renderRow(roots[0]!, true)
    expect(parentHtml).toContain('data-icon="chevronDown"')
    expect(parentHtml).toContain('aria-expanded="true"')
    expect(parentHtml).toContain('padding-inline-start:0px')

    const collapsed = await renderRow(roots[0]!, false)
    expect(collapsed).toContain('data-icon="chevronRight"')
    expect(collapsed).toContain('aria-expanded="false"')

    const childHtml = await renderRow(roots[0]!.children[0]!, false)
    expect(childHtml).toContain('padding-inline-start:16px')
    expect(childHtml).not.toContain('data-icon="chevron')
    expect(childHtml).not.toContain('aria-expanded')
  })

  it('keeps a failed task visible with its reason', async () => {
    const [row] = rowsOf([node({
      id: 'f', name: 'Boom', status: 'failed', resultStatus: 'failed',
      errorMessage: 'Stream ended without finish_reason', completedAt: '2025-09-15 10:00:20',
    })])
    const html = await renderRow(row!, false)
    expect(html).toContain('Stream ended without finish_reason')
    expect(html).toContain('bg-destructive')
    expect(html).toContain('strandActivity.statusFailed')
    // finished task freezes its counter at 20s
    expect(html).toContain('0:20')
  })

  it('renders a paused task as waiting for an answer', async () => {
    const [row] = rowsOf([node({ id: 'q', name: 'Ask', status: 'paused' })])
    const html = await renderRow(row!, false)
    expect(html).toContain('strandActivity.statusPaused')
    expect(html).toContain('bg-warning')
  })

  it('drops the pulse under prefers-reduced-motion but keeps the counter', async () => {
    const [row] = rowsOf([node({ id: 't', name: 'Live' })])
    const moving = await renderRow(row!, false, false)
    const still = await renderRow(row!, false, true)
    expect(moving).toContain('animate-pulse')
    expect(still).not.toContain('animate-pulse')
    expect(still).toContain('1:23')
  })

  it('labels the row for screen readers', async () => {
    const roots = rowsOf([node({ id: 'p', name: 'Wave A' }), node({ id: 'c', parentTaskId: 'p' })])
    const html = await renderRow(roots[0]!, false)
    expect(html).toMatch(/aria-label="Wave A, strandActivity.statusRunning, \d+:\d\d/)
  })
})

/**
 * The panel itself. `useStrandTasks` is mocked so the four UX states can be
 * rendered deterministically; everything below the mock (tree building,
 * indentation, counters) is the real component code.
 */
const panelState = {
  status: ref<'idle' | 'loading' | 'error' | 'ready'>('ready'),
  rows: ref<StrandTaskRow[]>([]),
  expandedIds: ref<Set<string>>(new Set()),
  live: ref(0),
  total: ref(0),
}

vi.mock('../composables/useStrandTasks', () => ({
  useStrandTasks: () => ({
    status: panelState.status,
    errorMessage: ref<string | null>(null),
    roots: computed(() => panelState.rows.value),
    visibleRows: computed(() => {
      const out: StrandTaskRow[] = []
      const walk = (rs: StrandTaskRow[]): void => {
        for (const r of rs) {
          out.push(r)
          if (panelState.expandedIds.value.has(r.id)) walk(r.children)
        }
      }
      walk(panelState.rows.value)
      return out
    }),
    liveCount: computed(() => panelState.live.value),
    totalCount: computed(() => panelState.total.value),
    nowMs: ref(Date.UTC(2025, 8, 15, 10, 1, 23)),
    expanded: panelState.expandedIds,
    reload: vi.fn(),
    toggle: vi.fn(),
    isExpanded: (id: string) => panelState.expandedIds.value.has(id),
  }),
}))

async function renderPanel(turnRunning = false): Promise<string> {
  const { default: StrandActivityPanel } = await import('./StrandActivityPanel.vue')
  const app = createSSRApp({
    render: () => h(StrandActivityPanel, { strandId: 'strand-1', turnRunning }),
  })
  stubs(app)
  return await renderToString(app)
}

describe('StrandActivityPanel (rendered)', () => {
  it('loading state shows skeletons, not an empty message', async () => {
    panelState.status.value = 'loading'
    panelState.rows.value = []
    panelState.total.value = 0
    const html = await renderPanel()
    expect(html).toContain('skeleton')
    expect(html).not.toContain('strandActivity.empty')
  })

  it('error state offers a retry instead of pretending nothing runs', async () => {
    panelState.status.value = 'error'
    const html = await renderPanel()
    expect(html).toContain('strandActivity.errorDescription')
    expect(html).toContain('common.refresh')
  })

  it('empty state is calm', async () => {
    panelState.status.value = 'ready'
    panelState.rows.value = []
    panelState.total.value = 0
    const idle = await renderPanel(false)
    // Nothing at all to show and no turn: the panel hides itself.
    expect(idle).not.toContain('strandActivity.title')

    const duringTurn = await renderPanel(true)
    expect(duringTurn).toContain('strandActivity.emptyWhileTurn')
    expect(duringTurn).toContain('strandActivity.turnRunning')
  })

  it('collapsed shows one row per direct task, expanded reveals the sub-tasks', async () => {
    panelState.status.value = 'ready'
    panelState.rows.value = rowsOf([
      node({ id: 'wave', name: 'Wave A' }),
      node({ id: 'sub', name: 'Sub B', parentTaskId: 'wave' }),
      node({ id: 'subsub', name: 'Sub Sub C', parentTaskId: 'sub' }),
    ])
    panelState.live.value = 3
    panelState.total.value = 3

    panelState.expandedIds.value = new Set()
    const collapsed = await renderPanel()
    expect(collapsed).toContain('Wave A')
    expect(collapsed).not.toContain('Sub B')
    // SSR escapes the interpolated params, hence the &quot; form.
    expect(collapsed).toContain('strandActivity.liveCount({&quot;count&quot;:3})')

    panelState.expandedIds.value = new Set(['wave', 'sub'])
    const expanded = await renderPanel()
    expect(expanded).toContain('Wave A')
    expect(expanded).toContain('Sub B')
    expect(expanded).toContain('Sub Sub C')
    expect(expanded).toContain('padding-inline-start:16px')
    expect(expanded).toContain('padding-inline-start:32px')
  })
})


describe('task usage display', () => {
  it('shows input/output separately and the current USD cost', async () => {
    const row = rowsOf([node({ id: 'usage', promptTokens: 78, completionTokens: 8221, estimatedCost: 1.204506 })])[0]!
    const html = await renderRow(row, false)
    expect(html).toContain('↑ 78 · ↓ 8221 · $1.2045')
    expect(html).toContain('tasks.tokensTooltip.input')
    expect(html).toContain('tasks.tokensTooltip.output')
  })
})


describe('task card navigation and model', () => {
  it('links directly to details and renders reported model without replacing live tokens', async () => {
    const row = rowsOf([node({ id: 'task/id', promptTokens: 78, completionTokens: 8221 })])[0]!
    const html = await renderRow(row, false, false, { provider: 'OpenAI', model: 'reported-model' })
    expect(html).toContain('href="/tasks/task%2Fid"')
    expect(html).toContain('OpenAI · reported-model')
    expect(html).toContain('↑ 78 · ↓ 8221')
    expect(html).not.toContain('sm:min-h-0')
  })
  it('shows a neutral dash for missing metadata, not an inferred default', async () => {
    const row = rowsOf([node({ id: 'legacy' })])[0]!
    const html = await renderRow(row, false)
    expect(html).toContain('title="—"')
    expect(html).not.toContain('Default')
    expect(html).toContain('href="/tasks/legacy"')
  })
})
