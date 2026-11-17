<template>
  <!-- Phase B: strand statistics. Collapsed by default; the request runs on
       the first open (lazy), so the panel costs nothing until asked. -->
  <section
    aria-labelledby="ctx-stats"
    data-strand-stats
    :data-state="state.status"
  >
    <details
      class="group"
      :open="open"
      @toggle="onToggle"
    >
      <summary
        class="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-xs font-semibold uppercase tracking-label text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        data-stats-toggle
      >
        <span
          aria-hidden="true"
          class="inline-block transition-transform group-open:rotate-90"
        >›</span>
        <h4
          id="ctx-stats"
          class="m-0"
        >
          {{ $t('context.stats.title') }}
        </h4>
        <span
          v-if="state.status === 'ready'"
          class="ml-auto font-normal normal-case tracking-normal tabular-nums"
        >{{ formatUsd(state.data.cost.totalUsd, locale) }}</span>
      </summary>

      <p
        v-if="state.status === 'loading'"
        class="text-sm text-muted-foreground"
        role="status"
      >
        {{ $t('context.stats.loading') }}
      </p>
      <p
        v-else-if="state.status === 'unsupported'"
        class="text-sm text-muted-foreground"
      >
        {{ $t('w4b.context.unsupported') }}
      </p>
      <div
        v-else-if="state.status === 'error'"
        class="flex flex-wrap items-center gap-2"
        role="alert"
      >
        <span class="text-sm text-destructive">{{ $t('context.stats.error') }}</span>
        <button
          type="button"
          class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-stats-retry
          @click="load(true)"
        >
          <AppIcon
            name="retry"
            size="sm"
          />{{ $t('w4b.speech.retry') }}
        </button>
      </div>

      <div
        v-else-if="state.status === 'ready'"
        class="space-y-2 text-sm"
        data-stats-body
      >
        <!-- six tiles -->
        <ul
          class="grid grid-cols-2 gap-2 sm:grid-cols-3"
          data-stats-tiles
        >
          <li
            v-for="tile in tiles"
            :key="tile.key"
            class="min-w-0 rounded-lg bg-muted px-2 py-2"
            :data-stats-tile="tile.key"
          >
            <div class="truncate text-xs text-muted-foreground">
              {{ tile.label }}
            </div>
            <div class="truncate text-base font-semibold tabular-nums">
              {{ tile.value }}
            </div>
            <div class="truncate text-xs text-muted-foreground">
              {{ tile.sub }}
            </div>
          </li>
        </ul>
        <p
          v-if="s.autarky.estimated"
          class="text-xs text-muted-foreground"
          data-stats-estimated
        >
          {{ $t('context.stats.estimatedHint') }}
        </p>

        <!-- tokens -->
        <details
          class="group/sec rounded-lg border border-border"
          open
        >
          <summary :class="secSummary">
            <span
              aria-hidden="true"
              :class="chev"
            >›</span>{{ $t('context.stats.tokens') }}<span :class="hint">{{ compactNumber(s.tokens.total.in + s.tokens.total.out) }}</span>
          </summary>
          <div class="px-2 pb-2">
            <div
              class="flex h-3 w-full overflow-hidden rounded-full bg-muted"
              role="img"
              :aria-label="$t('context.stats.tokenBarLabel', { cached: percent(s.tokens.total.cacheHitRatio) })"
            >
              <span
                v-for="seg in tokenBar"
                :key="seg.key"
                :class="seg.cls"
                :style="{ width: `${seg.pct}%` }"
              />
            </div>
            <ul class="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <li
                v-for="seg in tokenBar"
                :key="seg.key"
                class="flex items-center gap-1"
              >
                <span :class="['inline-block h-2 w-2 rounded-full', seg.cls]" />{{ seg.label }} {{ compactNumber(seg.value) }}
              </li>
            </ul>
            <dl class="mt-2 grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1 text-xs">
              <dt />
              <dd class="text-right text-muted-foreground">
                {{ $t('context.stats.in') }}
              </dd><dd class="text-right text-muted-foreground">
                {{ $t('context.stats.out') }}
              </dd>
              <template
                v-for="row in tokenRows"
                :key="row.key"
              >
                <dt class="text-muted-foreground">
                  {{ row.label }}
                </dt>
                <dd class="text-right tabular-nums">
                  {{ compactNumber(row.b.in) }}
                </dd><dd class="text-right tabular-nums">
                  {{ compactNumber(row.b.out) }}
                </dd>
              </template>
            </dl>
          </div>
        </details>

        <!-- cost -->
        <details class="group/sec rounded-lg border border-border">
          <summary :class="secSummary">
            <span
              aria-hidden="true"
              :class="chev"
            >›</span>{{ $t('context.stats.cost') }}<span :class="hint">{{ formatUsd(s.cost.totalUsd, locale) }}</span>
          </summary>
          <dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-2 pb-2 text-xs">
            <dt class="text-muted-foreground">
              {{ $t('context.stats.costChat') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatUsd(s.tokens.main.costUsd, locale) }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.costTasks') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatUsd(s.tokens.tasks.costUsd, locale) }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.costVoice') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatUsd(s.tokens.voice.costUsd, locale) }}
            </dd>
            <template v-if="s.tokens.background">
              <dt class="text-muted-foreground">
                {{ $t('context.stats.costBackground') }}
              </dt><dd class="text-right tabular-nums">
                {{ formatUsd(s.tokens.background.costUsd, locale) }}
              </dd>
            </template>
            <dt class="text-muted-foreground">
              <span class="rounded bg-primary-subtle px-1">{{ $t('context.stats.billing.subscription') }}</span>
            </dt><dd class="text-right tabular-nums">
              {{ formatUsd(s.cost.subscriptionUsd, locale) }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.billing.metered') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatUsd(s.cost.meteredUsd, locale) }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.billing.local') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatUsd(0, locale) }}
            </dd>
          </dl>
          <p class="px-2 pb-2 text-xs text-muted-foreground">
            {{ $t('context.stats.costExplain') }}
          </p>
        </details>

        <!-- models & personas -->
        <details
          class="group/sec rounded-lg border border-border"
          open
        >
          <summary :class="secSummary">
            <span
              aria-hidden="true"
              :class="chev"
            >›</span>{{ $t('context.stats.modelsPersonas') }}<span :class="hint">{{ $t('context.stats.modelsPersonasHint', { models: s.models.length, personas: s.personas.length }) }}</span>
          </summary>
          <ul
            class="space-y-1 px-2 pb-2 text-xs"
            data-stats-models
          >
            <li
              v-for="m in s.models"
              :key="`${m.provider}/${m.model}/${m.billing}`"
              class="grid grid-cols-[1fr_auto] gap-x-2"
            >
              <span class="min-w-0 truncate">{{ shortModel(m.model) }} <span
                v-if="m.billing !== 'metered'"
                class="rounded px-1"
                :class="m.billing === 'local' ? 'bg-success/15 text-success' : 'bg-primary-subtle'"
              >{{ $t(`context.stats.billing.${m.billing}`) }}</span></span>
              <span class="tabular-nums text-muted-foreground">{{ m.requests }} · {{ formatUsd(m.costUsd, locale) }}</span>
              <span class="col-span-2 mt-0.5 block h-1.5 overflow-hidden rounded-full bg-muted"><span
                class="block h-full rounded-full"
                :class="m.billing === 'local' ? 'bg-success' : 'bg-primary'"
                :style="{ width: `${barPct(m.tokensIn + m.tokensOut, maxModelTokens)}%` }"
              /></span>
            </li>
          </ul>
          <p class="px-2 pb-1 text-xs text-muted-foreground">
            {{ $t('context.stats.localShare', { requests: percent(s.local.requestShare), tokens: percent(s.local.tokenShare) }) }}
          </p>
          <ul
            class="space-y-1 px-2 pb-2 text-xs"
            data-stats-personas
          >
            <li
              v-for="p in s.personas"
              :key="p.id"
            >
              <div class="grid grid-cols-[1fr_auto] gap-x-2">
                <span class="min-w-0 truncate font-medium">{{ p.id }}</span>
                <span class="tabular-nums text-muted-foreground">{{ formatDuration(p.durationSec) }} · {{ formatUsd(p.costUsd, locale) }}</span>
              </div>
              <div
                v-if="p.split"
                class="pl-3 text-muted-foreground"
              >
                {{ $t('context.stats.personaChat') }} {{ formatUsd(p.split.chat.costUsd, locale) }} · {{ $t('context.stats.personaTasks', { count: p.split.tasks.runs }) }} {{ formatUsd(p.split.tasks.costUsd, locale) }}
              </div>
              <div
                v-else
                class="pl-3 text-muted-foreground"
              >
                {{ $t('context.stats.personaRuns', { count: p.runs, ok: percent(p.successRatio) }) }}
              </div>
            </li>
          </ul>
        </details>

        <!-- tools -->
        <details class="group/sec rounded-lg border border-border">
          <summary :class="secSummary">
            <span
              aria-hidden="true"
              :class="chev"
            >›</span>{{ $t('context.stats.tools') }}<span :class="hint">{{ $t('context.stats.toolsHint', { calls: s.tools.total, errors: s.tools.errors }) }}</span>
          </summary>
          <ul
            class="space-y-1 px-2 pb-2 text-xs"
            data-stats-tools
          >
            <li
              v-for="tl in s.tools.top"
              :key="tl.name"
              class="grid grid-cols-[1fr_auto] gap-x-2"
            >
              <span class="min-w-0 truncate font-mono">{{ tl.name }}</span>
              <span class="tabular-nums text-muted-foreground">{{ tl.calls }}<span
                v-if="tl.errors"
                class="text-destructive"
              > · {{ tl.errors }} ✕</span></span>
              <span class="col-span-2 block h-1.5 overflow-hidden rounded-full bg-muted"><span
                class="block h-full rounded-full bg-primary"
                :style="{ width: `${barPct(tl.calls, s.tools.top[0]?.calls ?? 1)}%` }"
              /></span>
            </li>
          </ul>
        </details>

        <!-- sub-agent runs -->
        <details class="group/sec rounded-lg border border-border">
          <summary :class="secSummary">
            <span
              aria-hidden="true"
              :class="chev"
            >›</span>{{ $t('context.stats.tasks') }}<span :class="hint">{{ taskHint }}</span>
          </summary>
          <div class="px-2 pb-2">
            <svg
              v-if="timeline.length"
              :viewBox="`0 0 100 ${timeline.length * 4 + 2}`"
              preserveAspectRatio="none"
              class="h-auto w-full"
              role="img"
              :aria-label="$t('context.stats.timelineLabel', { count: timeline.length, peak: s.autarky.parallelPeak })"
              data-stats-timeline
            >
              <rect
                v-for="(bar, i) in timeline"
                :key="bar.id"
                :x="bar.x"
                :y="i * 4 + 1"
                :width="bar.w"
                height="3"
                rx="0.8"
                :class="bar.cls"
              />
            </svg>
            <p class="mt-1 text-xs text-muted-foreground">
              {{ $t('context.stats.taskFacts', { nested: s.nestedTasks, peak: s.autarky.parallelPeak, ask: s.delegations.askAgent }) }}
            </p>
            <ul
              v-if="s.tasks?.length"
              class="mt-1 space-y-1 text-xs"
              data-stats-task-list
            >
              <li
                v-for="tk in s.tasks.slice(0, 30)"
                :key="tk.id"
                class="grid grid-cols-[1fr_auto] gap-x-2"
                :style="{ paddingLeft: `${tk.depth * 0.75}rem` }"
              >
                <span class="min-w-0 truncate">{{ tk.name }}</span>
                <span class="tabular-nums text-muted-foreground">{{ formatDuration(tk.durationSec) }} · {{ formatUsd(tk.costUsd, locale) }}</span>
                <span class="col-span-2 truncate text-muted-foreground">{{ tk.persona }} · {{ shortModel(tk.model) }} · <span :class="statusClass(tk.status)">{{ tk.status }}</span></span>
              </li>
            </ul>
          </div>
        </details>

        <!-- autarky -->
        <details class="group/sec rounded-lg border border-border">
          <summary :class="secSummary">
            <span
              aria-hidden="true"
              :class="chev"
            >›</span>{{ $t('context.stats.autarky') }}<span :class="hint">{{ formatDuration(s.autarky.agentSec) }}</span>
          </summary>
          <dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-2 pb-2 text-xs">
            <dt class="text-muted-foreground">
              {{ $t('context.stats.agentTime') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatDuration(s.autarky.agentSec) }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.effort') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatDuration(s.autarky.effortSec) }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.perPrompt') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatDuration(s.autarky.perPromptSec) }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.longest') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatDuration(s.autarky.longestSec) }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.latency') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatDuration(s.autarky.latencyMedianSec) }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.wall') }}
            </dt><dd class="text-right tabular-nums">
              {{ formatDuration(s.autarky.wallSec) }}
            </dd>
          </dl>
          <p class="px-2 pb-2 text-xs text-muted-foreground">
            {{ $t('context.stats.autarkyExplain') }}
          </p>
        </details>

        <!-- per-turn history -->
        <details
          v-if="series.length > 1"
          class="group/sec rounded-lg border border-border"
          open
        >
          <summary :class="secSummary">
            <span
              aria-hidden="true"
              :class="chev"
            >›</span>{{ $t('context.stats.series') }}<span :class="hint">{{ $t('context.stats.seriesHint', { user: s.turns.user, auto: s.turns.auto }) }}</span>
          </summary>
          <div class="px-2 pb-2">
            <svg
              viewBox="0 0 200 40"
              preserveAspectRatio="none"
              class="h-10 w-full"
              role="img"
              :aria-label="$t('context.stats.seriesLabel', { count: series.length, max: compactNumber(seriesMax) })"
              data-stats-spark
            >
              <polyline
                :points="sparkPoints(series, 200, 40)"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                vector-effect="non-scaling-stroke"
                class="text-primary"
              />
            </svg>
            <p class="text-xs text-muted-foreground">
              {{ $t('context.stats.seriesExplain') }}
            </p>
          </div>
        </details>

        <!-- compaction -->
        <details class="group/sec rounded-lg border border-border">
          <summary :class="secSummary">
            <span
              aria-hidden="true"
              :class="chev"
            >›</span>{{ $t('context.stats.compaction') }}<span :class="hint">{{ $t('context.stats.compactionHint', { trims: s.compaction.trimmedTurns, summaries: s.compaction.summaries }) }}</span>
          </summary>
          <dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-2 pb-2 text-xs">
            <dt class="text-muted-foreground">
              {{ $t('context.stats.trimmedMessages') }}
            </dt><dd class="text-right tabular-nums">
              {{ s.compaction.trimmedMessages }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.lastKept') }}
            </dt><dd class="text-right tabular-nums">
              {{ s.compaction.lastKeptTokens === null ? '–' : `${compactNumber(s.compaction.lastKeptTokens)} / ${compactNumber(s.compaction.budgetTokens)}` }}
            </dd>
            <dt class="text-muted-foreground">
              {{ $t('context.stats.failedRequests') }}
            </dt><dd class="text-right tabular-nums">
              {{ s.failedRequests }}
            </dd>
          </dl>
        </details>
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { ApiError } from '~/composables/useApi'
import type { LoadState } from '~/composables/useStrandContext'
import {
  STRAND_STATS_PATH, compactNumber, formatDuration, formatUsd, isStrandStats, percent, shortModel, sparkPoints,
  type StrandStatsView,
} from '~/utils/strandStats'
import { parseBackendTimestamp } from '~/utils/datetime'

const props = defineProps<{ strandId: string; initiallyOpen?: boolean }>()
const { t, locale } = useI18n()
const { apiFetch } = useApi()

const open = shallowRef(props.initiallyOpen ?? false)
const state = shallowRef<LoadState<StrandStatsView> | { status: 'idle' }>({ status: 'idle' })
let loadedFor: string | null = null

const secSummary = 'flex min-h-11 cursor-pointer list-none items-center gap-2 px-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg [&::-webkit-details-marker]:hidden'
const chev = 'inline-block text-muted-foreground transition-transform group-open/sec:rotate-90'
const hint = 'ml-auto min-w-0 truncate text-xs font-normal text-muted-foreground tabular-nums'

async function load(force = false) {
  const id = props.strandId
  if (!id || (!force && loadedFor === id && state.value.status === 'ready')) return
  loadedFor = id
  state.value = { status: 'loading' }
  try {
    const raw = await apiFetch<unknown>(STRAND_STATS_PATH(id))
    if (props.strandId !== id) return
    state.value = isStrandStats(raw) ? { status: 'ready', data: raw } : { status: 'unsupported' }
  } catch (error) {
    if (props.strandId !== id) return
    if (error instanceof ApiError && error.status === 404) state.value = { status: 'unsupported' }
    else state.value = { status: 'error', offline: !(error instanceof ApiError) || error.status === 0 }
  }
}

function onToggle(event: Event) {
  open.value = (event.target as HTMLDetailsElement).open
  if (open.value) void load()
}

watch(() => props.strandId, () => {
  loadedFor = null
  state.value = { status: 'idle' }
  if (open.value) void load()
}, { immediate: true })

const s = computed(() => (state.value as { data: StrandStatsView }).data)

const tiles = computed(() => {
  const d = s.value
  return [
    { key: 'in', label: t('context.stats.tileIn'), value: compactNumber(d.tokens.total.in), sub: t('context.stats.cached', { ratio: percent(d.tokens.total.cacheHitRatio) }) },
    { key: 'out', label: t('context.stats.tileOut'), value: compactNumber(d.tokens.total.out), sub: t('context.stats.requests', { count: d.tokens.total.requests }) },
    { key: 'cost', label: t('context.stats.tileCost'), value: formatUsd(d.cost.totalUsd, locale.value), sub: d.cost.subscriptionShare !== null ? t('context.stats.subShare', { share: percent(d.cost.subscriptionShare) }) : '' },
    { key: 'prompts', label: t('context.stats.tilePrompts'), value: String(d.prompts.total), sub: t('context.stats.promptKinds', { typed: d.prompts.typed, voice: d.prompts.voice, answers: d.prompts.answers }) },
    { key: 'tools', label: t('context.stats.tileTools'), value: String(d.tools.total), sub: t('context.stats.toolSub', { errors: d.tools.errors, tasks: d.taskCount }) },
    { key: 'autarky', label: t('context.stats.tileAutarky'), value: formatDuration(d.autarky.agentSec), sub: t('context.stats.perPromptShort', { value: formatDuration(d.autarky.perPromptSec) }) },
  ]
})

const tokenBar = computed(() => {
  const b = s.value.tokens.total
  const sum = Math.max(b.cacheRead + b.cacheWrite + b.uncached + b.out, 1)
  return [
    { key: 'cacheRead', label: t('context.stats.cacheRead'), value: b.cacheRead, cls: 'bg-primary' },
    { key: 'cacheWrite', label: t('context.stats.cacheWrite'), value: b.cacheWrite, cls: 'bg-primary-container' },
    { key: 'uncached', label: t('context.stats.uncached'), value: b.uncached, cls: 'bg-warning' },
    { key: 'out', label: t('context.stats.out'), value: b.out, cls: 'bg-muted-foreground' },
  ].map(seg => ({ ...seg, pct: (seg.value / sum) * 100 }))
})

const tokenRows = computed(() => [
  { key: 'main', label: t('context.stats.costChat'), b: s.value.tokens.main },
  { key: 'tasks', label: t('context.stats.costTasks'), b: s.value.tokens.tasks },
  { key: 'voice', label: t('context.stats.costVoice'), b: s.value.tokens.voice },
  ...(s.value.tokens.background ? [{ key: 'background', label: t('context.stats.costBackground'), b: s.value.tokens.background }] : []),
])

const maxModelTokens = computed(() => Math.max(1, ...s.value.models.map(m => m.tokensIn + m.tokensOut)))
function barPct(v: number, max: number) { return Math.max(2, Math.min(100, (v / Math.max(max, 1)) * 100)) }

const taskHint = computed(() => {
  const st = s.value.taskStatus
  const parts = [String(s.value.taskCount)]
  if (st.completed) parts.push(t('context.stats.status.completed', { count: st.completed }))
  if (st.failed) parts.push(t('context.stats.status.failed', { count: st.failed }))
  if (st.running) parts.push(t('context.stats.status.running', { count: st.running }))
  return parts.join(' · ')
})

function statusClass(status: string) {
  return status === 'completed' ? 'text-success' : status === 'failed' ? 'text-destructive' : 'text-warning'
}

const timeline = computed(() => {
  const d = s.value
  const tasks = d.tasks ?? []
  const t0 = parseBackendTimestamp(d.span.firstAt)?.getTime() ?? 0
  const t1 = parseBackendTimestamp(d.span.lastAt)?.getTime() ?? t0
  const span = Math.max(t1 - t0, 1)
  return tasks.slice(0, 40).map((tk) => {
    const a = parseBackendTimestamp(tk.startedAt)?.getTime() ?? t0
    const b = tk.endedAt ? parseBackendTimestamp(tk.endedAt)?.getTime() ?? a : t1
    const x = Math.max(0, Math.min(100, ((a - t0) / span) * 100))
    const w = Math.max(0.8, Math.min(100 - x, ((b - a) / span) * 100))
    const cls = tk.status === 'failed' ? 'fill-destructive' : tk.depth > 0 ? 'fill-primary-container' : 'fill-primary'
    return { id: tk.id, x, w, cls }
  })
})

const series = computed(() => (s.value.series ?? []).map(p => p.maxRequestTokens))
const seriesMax = computed(() => Math.max(0, ...series.value))
</script>
