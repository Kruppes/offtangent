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
import { buildTaskRows, partitionActivity, type StrandTaskNode, type StrandTaskRow } from '../taskActivity'

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

describe('per-task model label', () => {
  it('renders the row identity without waiting for a detail request', async () => {
    const [row] = rowsOf([node({ id: 'sub', provider: 'OpenAI', model: 'gpt-6-sol' })])
    expect(await renderRow(row!, false)).toContain('OpenAI · gpt-6-sol')
  })

  it('never pairs a live provider with a stale detail model', async () => {
    const [row] = rowsOf([node({ id: 'partial', provider: 'OpenAI', model: null })])
    const html = await renderRow(row!, false, false, { provider: 'Anthropic', model: 'claude-opus-5-5' })
    expect(html).toContain('OpenAI')
    expect(html).not.toContain('claude-opus-5-5')
  })

  it('does not inherit a parent identity for a legacy child', async () => {
    const roots = rowsOf([
      node({ id: 'parent', provider: 'Anthropic', model: 'claude-opus-5-5' }),
      node({ id: 'child', parentTaskId: 'parent' }),
    ])
    const html = await renderRow(roots[0]!.children[0]!, false)
    expect(html).toContain('—')
    expect(html).not.toContain('claude-opus-5-5')
  })
})

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
  lastDismissed: ref<string[] | null>(null),
  showOlder: ref(false),
  showHidden: ref(false),
}
const PANEL_NOW = Date.UTC(2025, 8, 15, 10, 1, 23)

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
      // Same grouping as the real composable (W6c): open, then the folded groups on demand.
      const p = partitionActivity(panelState.rows.value, PANEL_NOW)
      walk([...p.open, ...(panelState.showOlder.value ? p.older : []), ...(panelState.showHidden.value ? p.hidden : [])])
      return out
    }),
    liveCount: computed(() => panelState.live.value),
    totalCount: computed(() => panelState.total.value),
    nowMs: ref(Date.UTC(2025, 8, 15, 10, 1, 23)),
    expanded: panelState.expandedIds,
    reload: vi.fn(),
    toggle: vi.fn(),
    isExpanded: (id: string) => panelState.expandedIds.value.has(id),
    // W6c: the real partition over the mocked rows.
    partition: computed(() => partitionActivity(panelState.rows.value, PANEL_NOW)),
    showOlder: panelState.showOlder,
    showHidden: panelState.showHidden,
    lastDismissed: panelState.lastDismissed,
    dismissError: ref(false),
    dismiss: vi.fn(),
    restore: vi.fn(),
  }),
}))

async function renderPanel(turnRunning = false, open = true): Promise<string> {
  const { default: StrandActivityPanel } = await import('./StrandActivityPanel.vue')
  const app = createSSRApp({
    render: () => h(StrandActivityPanel, { strandId: 'strand-1', turnRunning, open }),
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
    // W4c: the panel is a dock section now and keeps its header; nothing
    // runs, so it says so calmly and the live dot stays off.
    expect(idle).toContain('strandActivity.title')
    expect(idle).toContain('strandActivity.empty')
    expect(idle).not.toContain('strandActivity.turnRunning')
    expect(idle).toContain('data-live="false"')

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

describe('StrandActivityPanel as a dock section (W4c)', () => {
  it('folded keeps the header line with the live dot and the counter (anti-freeze)', async () => {
    panelState.status.value = 'ready'
    panelState.rows.value = rowsOf([node({ id: 'wave', name: 'Wave A' })])
    panelState.live.value = 1
    panelState.total.value = 1
    const folded = await renderPanel(true, false)
    expect(folded).toContain('aria-expanded="false"')
    expect(folded).toContain('aria-controls="strand-activity-body"')
    expect(folded).toContain('data-live="true"')
    expect(folded).toContain('strandActivity.liveCount({&quot;count&quot;:1})')
    expect(folded).toContain('strandActivity.turnRunning')
    // The body is gone, the rows with it.
    expect(folded).not.toContain('id="strand-activity-body"')
    expect(folded).not.toContain('Wave A')

    const open = await renderPanel(false, true)
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('id="strand-activity-body"')
    expect(open).toContain('Wave A')
    // W6c: the scrollable body is a region with its own name, not a second
    // landmark labelled like the section (axe landmark-unique).
    const body = open.match(/<div[^>]*id="strand-activity-body"[^>]*>/)![0]
    expect(body).toContain('aria-label="strandActivity.listLabel"')
    expect(body).not.toContain('aria-labelledby="strand-activity-title"')
  })

  it('keeps loading and error states inside the section', async () => {
    panelState.status.value = 'error'
    expect(await renderPanel(false, true)).toContain('strandActivity.errorDescription')
    panelState.status.value = 'loading'
    expect(await renderPanel(false, true)).toContain('skeleton')
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

describe('StrandActivityPanel acknowledge / hide (W6c)', () => {
  const finished = (id: string, hoursAgo: number, over: Partial<StrandTaskNode> = {}) => {
    const at = new Date(PANEL_NOW - hoursAgo * 3600_000).toISOString()
    return node({ id, name: `Task ${id}`, status: 'completed', createdAt: at, startedAt: at, completedAt: at, ...over })
  }

  it('offers "hide all finished" and a per-row acknowledge button only on finished root rows', async () => {
    panelState.status.value = 'ready'
    panelState.expandedIds.value = new Set()
    panelState.lastDismissed.value = null
    panelState.rows.value = rowsOf([
      node({ id: 'live', name: 'Live one' }),
      finished('done', 1),
      finished('fail', 2, { status: 'failed', errorMessage: 'exit 1' }),
    ])
    const html = await renderPanel()
    expect(html).toContain('data-testid="activity-dismiss-all"')
    expect(html).toContain('strandActivity.dismissAll({&quot;count&quot;:2})')
    expect(html.match(/data-testid="activity-dismiss"/g)?.length).toBe(2)
    expect(html).toContain('strandActivity.dismissOne({&quot;name&quot;:&quot;Task done&quot;})')
    expect(html).not.toContain('strandActivity.dismissOne({&quot;name&quot;:&quot;Live one&quot;})')
    // Acknowledge buttons are touch sized.
    expect(html).toMatch(/min-h-\[44px\] min-w-\[44px\][^"]*"[^>]*data-testid="activity-dismiss"/)
  })

  it('folds finished entries older than 24 h and counts the acknowledged ones', async () => {
    panelState.rows.value = rowsOf([
      finished('old', 30),
      finished('gone', 1, { dismissedAt: '2025-09-15T09:00:00Z' }),
    ])
    const html = await renderPanel()
    expect(html).toContain('strandActivity.showOlder({&quot;count&quot;:1})')
    expect(html).toContain('strandActivity.showHidden({&quot;count&quot;:1})')
    expect(html).toContain('aria-expanded="false"')
  })

  it('says "no open activity" when everything is folded or hidden, and shows the undo line after a dismiss', async () => {
    panelState.rows.value = rowsOf([finished('gone', 1, { dismissedAt: '2025-09-15T09:00:00Z' }), finished('old', 30)])
    panelState.expandedIds.value = new Set()
    panelState.lastDismissed.value = null
    const empty = await renderPanel()
    expect(empty).toContain('strandActivity.emptyOpen')
    expect(empty).not.toContain('data-testid="activity-rows"')
    panelState.showHidden.value = true
    const shown = await renderPanel()
    expect(shown).toContain('data-testid="activity-restore"')
    expect(shown).toContain('strandActivity.hideHidden')
    panelState.showHidden.value = false
    panelState.lastDismissed.value = ['gone']
    const undo = await renderPanel()
    expect(undo).toContain('data-testid="activity-undo"')
    expect(undo).toContain('role="status"')
    expect(undo).toContain('strandActivity.dismissed({&quot;count&quot;:1})')
    expect(undo).not.toContain('data-testid="activity-dismiss-all"')
    panelState.lastDismissed.value = null
  })

  it('30 synthetic entries: the default view shows only live, fresh and unacknowledged failed ones, counters match', async () => {
    const nodes: StrandTaskNode[] = []
    // 4 running, 2 paused, 6 finished < 24 h, 10 finished > 24 h, 3 failed > 24 h (open),
    // 2 failed acknowledged, 3 finished acknowledged = 30.
    for (let i = 0; i < 4; i++) nodes.push(node({ id: `run${i}`, name: `Running ${i}` }))
    for (let i = 0; i < 2; i++) nodes.push(node({ id: `pause${i}`, name: `Paused ${i}`, status: 'paused' }))
    for (let i = 0; i < 6; i++) nodes.push(finished(`fresh${i}`, 1 + i))
    for (let i = 0; i < 10; i++) nodes.push(finished(`old${i}`, 25 + i * 10))
    for (let i = 0; i < 3; i++) nodes.push(finished(`fail${i}`, 48 + i, { status: 'failed', errorMessage: 'synthetic failure' }))
    for (let i = 0; i < 2; i++) nodes.push(finished(`ackfail${i}`, 2, { status: 'failed', errorMessage: 'synthetic failure', dismissedAt: '2025-09-15T09:30:00Z' }))
    for (let i = 0; i < 3; i++) nodes.push(finished(`ack${i}`, 3, { dismissedAt: '2025-09-15T09:30:00Z' }))
    expect(nodes).toHaveLength(30)
    panelState.status.value = 'ready'
    panelState.expandedIds.value = new Set()
    panelState.lastDismissed.value = null
    panelState.showOlder.value = false
    panelState.showHidden.value = false
    panelState.rows.value = rowsOf(nodes)
    panelState.live.value = 6
    panelState.total.value = 30
    const html = await renderPanel()
    // One task link per rendered row: count rows by their link target.
    const shown = (prefix: string) => (html.match(new RegExp(`href="/tasks/${prefix}\\d"`, 'g')) ?? []).length
    expect(shown('run')).toBe(4)
    expect(shown('pause')).toBe(2)
    expect(shown('fresh')).toBe(6)
    expect(shown('fail')).toBe(3)
    expect(shown('old')).toBe(0)
    expect(shown('ackfail')).toBe(0)
    expect(shown('ack')).toBe(0)
    expect(html).toContain('strandActivity.showOlder({&quot;count&quot;:10})')
    expect(html).toContain('strandActivity.showHidden({&quot;count&quot;:5})')
    // Acknowledgeable now: 6 fresh + 3 failed; live and paused are not.
    expect(html).toContain('strandActivity.dismissAll({&quot;count&quot;:9})')
    expect(html.match(/data-testid="activity-dismiss"/g)?.length).toBe(9)
  })
})
