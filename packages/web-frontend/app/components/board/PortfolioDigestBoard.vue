<script setup lang="ts">
import { computed } from 'vue'
import type { SeriesPoint } from '~/api/boards'
import { renderSafeMarkdown } from '~/composables/useMarkdown'
import { deltaClass, formatEur, formatNumberDe, formatPct, formatSignedEur, isExternalHttpUrl, relativeTimeKey } from '~/utils/boardFormat'
import { parsePortfolioDigest, urgencyIcon } from '~/utils/portfolioDigest'
import BoardSparkline from './BoardSparkline.vue'

const props = defineProps<{ payload: unknown; series: SeriesPoint[] }>()

const digest = computed(() => parsePortfolioDigest(props.payload))
const kpis = computed(() => {
  const overview = digest.value.overview
  if (!overview) return []
  return ([['week', overview.week], ['month', overview.month], ['ytd', overview.ytd]] as const)
    .filter(([, value]) => value)
    .map(([label, value]) => ({ label, deltaEur: value?.deltaEur, deltaPct: value?.deltaPct }))
})
const openSignals = computed(() => digest.value.signals.filter(signal => signal.status === 'carried'))
const todaySignals = computed(() => digest.value.signals.filter(signal => signal.status !== 'carried' && signal.status !== 'closed'))
const maxWeight = computed(() => Math.max(1, ...digest.value.positions.map(position => position.weightPct ?? 0)))
const hasAnything = computed(() => {
  const value = digest.value
  return Boolean(value.overview || value.digest || value.dataIssues.length || value.signals.length
    || value.gainers.length || value.losers.length || value.positions.length || value.macro.length
    || value.news.length || value.calendar.length || value.changesSince.length || value.footer)
})
</script>

<template>
  <div class="flex flex-col gap-5 [overflow-wrap:anywhere]">
    <p v-if="!hasAnything" role="status" class="rounded-lg border p-6 text-center text-muted-foreground">{{ $t('boards.emptyPayload') }}</p>

    <section v-if="digest.dataIssues.length" aria-labelledby="board-issues"
      class="rounded-lg border border-warning/60 bg-warning/10 p-4">
      <h2 id="board-issues" class="flex items-center gap-2 font-medium text-warning">
        <AppIcon name="warning" />{{ $t('boards.digest.dataIssues') }}
      </h2>
      <ul class="mt-2 space-y-2 text-sm">
        <li v-for="(issue, index) in digest.dataIssues" :key="issue.code ?? index">
          <span class="font-medium">{{ issue.code ?? issue.severity ?? $t('boards.digest.issue') }}</span>
          <span v-if="issue.message"> — {{ issue.message }}</span>
          <span v-if="issue.valueEur !== undefined" class="text-muted-foreground"> ({{ formatEur(issue.valueEur, true) }})</span>
        </li>
      </ul>
    </section>

    <section v-if="digest.overview" aria-labelledby="board-overview" class="rounded-lg border bg-card p-4 text-card-foreground">
      <h2 id="board-overview" class="text-sm font-medium text-muted-foreground">{{ $t('boards.digest.overview') }}</h2>
      <p class="mt-1 text-2xl font-bold tracking-tight">{{ formatEur(digest.overview.securitiesEur) }}</p>
      <p class="text-sm text-muted-foreground">{{ $t('boards.digest.securities') }}</p>
      <div class="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span><span class="text-muted-foreground">{{ $t('boards.digest.cash') }}:</span> {{ formatEur(digest.overview.cashEur) }}</span>
        <span><span class="text-muted-foreground">{{ $t('boards.digest.total') }}:</span> {{ formatEur(digest.overview.totalEur) }}</span>
      </div>
      <p v-if="digest.overview.day" class="mt-2 text-base font-medium" :class="deltaClass(digest.overview.day.deltaEur ?? digest.overview.day.deltaPct)">
        {{ formatSignedEur(digest.overview.day.deltaEur) }} · {{ formatPct(digest.overview.day.deltaPct) }}
        <span class="text-sm font-normal text-muted-foreground">{{ $t('boards.digest.today') }}</span>
      </p>
      <ul v-if="kpis.length" class="mt-3 flex flex-wrap gap-2">
        <li v-for="kpi in kpis" :key="kpi.label" class="rounded-full border px-3 py-1 text-xs">
          <span class="text-muted-foreground">{{ $t(`boards.digest.${kpi.label}`) }}</span>
          <span class="ml-1 font-medium" :class="deltaClass(kpi.deltaPct ?? kpi.deltaEur)">{{ formatPct(kpi.deltaPct) }}</span>
          <span class="ml-1 text-muted-foreground">{{ formatSignedEur(kpi.deltaEur, true) }}</span>
        </li>
      </ul>
      <BoardSparkline v-if="series.length > 1" class="mt-3" :points="series" :label="$t('boards.digest.sparkline')" />
      <p v-if="series.length > 1" class="measure mt-1 text-help text-muted-foreground">{{ $t('boards.digest.sparklineHint', { count: series.length }) }}</p>
    </section>

    <section v-if="digest.digest" aria-labelledby="board-text" class="rounded-lg border bg-card p-4 text-card-foreground">
      <h2 id="board-text" class="text-sm font-medium text-muted-foreground">{{ $t('boards.digest.text') }}</h2>
      <!-- eslint-disable-next-line vue/no-v-html -- renderSafeMarkdown escapes raw HTML and drops non-http(s) links. -->
      <div class="prose-chat mt-2 break-words text-sm" v-html="renderSafeMarkdown(digest.digest)" />
    </section>

    <section v-for="group in [{ id: 'open', signals: openSignals }, { id: 'today', signals: todaySignals }].filter(entry => entry.signals.length)"
      :key="group.id" :aria-labelledby="`board-signals-${group.id}`" class="rounded-lg border bg-card p-4 text-card-foreground">
      <h2 :id="`board-signals-${group.id}`" class="text-sm font-medium text-muted-foreground">
        {{ group.id === 'open' ? $t('boards.digest.openSignals') : $t('boards.digest.todaySignals') }}
      </h2>
      <ul class="mt-2 space-y-3">
        <li v-for="(signal, index) in group.signals" :key="signal.id ?? index" class="flex gap-3">
          <span class="text-lg leading-none" aria-hidden="true">{{ urgencyIcon(signal.urgency) }}</span>
          <div class="min-w-0 flex-1 text-sm">
            <p class="font-medium">
              {{ signal.name }}<span v-if="signal.headline"> — {{ signal.headline }}</span>
            </p>
            <p v-if="signal.rationale" class="text-muted-foreground">{{ signal.rationale }}</p>
            <p class="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <span v-if="signal.urgency">{{ signal.urgency }}</span>
              <span v-if="signal.trigger?.value !== undefined">{{ signal.trigger.type }} {{ signal.trigger.op }} {{ formatNumberDe(signal.trigger.value) }}</span>
              <span v-if="signal.firstSeen">{{ $t('boards.digest.since', { date: signal.firstSeen }) }}</span>
            </p>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="digest.gainers.length || digest.losers.length" aria-labelledby="board-movers" class="rounded-lg border bg-card p-4 text-card-foreground">
      <h2 id="board-movers" class="text-sm font-medium text-muted-foreground">{{ $t('boards.digest.movers') }}</h2>
      <div class="mt-2 grid gap-4 sm:grid-cols-2">
        <div v-for="group in [{ id: 'gainers', movers: digest.gainers }, { id: 'losers', movers: digest.losers }].filter(entry => entry.movers.length)" :key="group.id">
          <h3 class="text-xs font-medium uppercase tracking-label text-muted-foreground">{{ $t(`boards.digest.${group.id}`) }}</h3>
          <ul class="mt-1 space-y-2 text-sm">
            <li v-for="(entry, index) in group.movers" :key="entry.name ?? index">
              <p class="flex flex-wrap items-baseline justify-between gap-x-2">
                <span class="font-medium">{{ entry.name }}</span>
                <span :class="deltaClass(entry.deltaPct)">{{ formatPct(entry.deltaPct) }}</span>
              </p>
              <p class="measure text-help text-muted-foreground">
                <span v-if="entry.impactEur !== undefined">{{ formatSignedEur(entry.impactEur, true) }}</span>
                <span v-if="entry.explanation"> · {{ entry.explanation }}</span>
              </p>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <section v-if="digest.positions.length || digest.clusters.length" aria-labelledby="board-allocation" class="rounded-lg border bg-card p-4 text-card-foreground">
      <h2 id="board-allocation" class="text-sm font-medium text-muted-foreground">{{ $t('boards.digest.allocation') }}</h2>
      <ul v-if="digest.positions.length" class="mt-2 space-y-2">
        <li v-for="(position, index) in digest.positions" :key="position.name ?? index" class="text-sm">
          <p class="flex flex-wrap items-baseline justify-between gap-x-2">
            <span class="font-medium">{{ position.name }}</span>
            <span>
              {{ formatPct(position.weightPct, false) }}
              <span v-if="position.driftPp1w !== undefined" class="text-xs" :class="deltaClass(position.driftPp1w)">
                ({{ formatNumberDe(position.driftPp1w) }} pp)
              </span>
            </span>
          </p>
          <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div class="h-full rounded-full bg-primary" :style="{ width: `${Math.min(100, ((position.weightPct ?? 0) / maxWeight) * 100).toFixed(1)}%` }" />
          </div>
          <p v-if="position.valueEur !== undefined" class="text-xs text-muted-foreground">{{ formatEur(position.valueEur, true) }}</p>
        </li>
      </ul>
      <ul v-if="digest.clusters.length" class="mt-3 flex flex-wrap gap-2">
        <li v-for="(cluster, index) in digest.clusters" :key="cluster.label ?? index" class="rounded-full border px-3 py-1 text-xs">
          {{ cluster.label }} <span class="font-medium">{{ formatPct(cluster.weightPct, false) }}</span>
        </li>
      </ul>
    </section>

    <section v-if="digest.macro.length || digest.macroNote" aria-labelledby="board-macro" class="rounded-lg border bg-card p-4 text-card-foreground">
      <h2 id="board-macro" class="text-sm font-medium text-muted-foreground">{{ $t('boards.digest.macro') }}</h2>
      <ul v-if="digest.macro.length" class="mt-2 flex flex-wrap gap-2">
        <li v-for="(entry, index) in digest.macro" :key="entry.label ?? index" class="rounded-full border px-3 py-1 text-xs">
          <span class="font-medium">{{ entry.label }}</span>
          <span class="ml-1">{{ formatNumberDe(entry.value) }}</span>
          <span class="ml-1" :class="deltaClass(entry.deltaPct)">{{ formatPct(entry.deltaPct) }}</span>
        </li>
      </ul>
      <p v-if="digest.macroNote" class="mt-2 text-sm text-muted-foreground">{{ digest.macroNote }}</p>
    </section>

    <section v-if="digest.news.length" aria-labelledby="board-news" class="rounded-lg border bg-card p-4 text-card-foreground">
      <h2 id="board-news" class="text-sm font-medium text-muted-foreground">{{ $t('boards.digest.news') }}</h2>
      <ul class="mt-2 space-y-3 text-sm">
        <li v-for="(entry, index) in digest.news" :key="entry.title ?? index">
          <p>
            <a v-if="isExternalHttpUrl(entry.url)" :href="entry.url" target="_blank" rel="noopener noreferrer"
              class="font-medium underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {{ entry.title }}<AppIcon name="externalLink" size="sm" class="ml-1 inline-block align-[-2px]" />
            </a>
            <span v-else class="font-medium">{{ entry.title }}</span>
          </p>
          <p class="text-xs text-muted-foreground">
            <span v-if="entry.name">{{ entry.name }} · </span>
            <span v-if="entry.publisher">{{ entry.publisher }} · </span>
            <span>{{ $t(relativeTimeKey(entry.publishedAt).key, { count: relativeTimeKey(entry.publishedAt).count }) }}</span>
          </p>
          <p v-if="entry.summary" class="text-muted-foreground">{{ entry.summary }}</p>
        </li>
      </ul>
    </section>

    <section v-if="digest.calendar.length" aria-labelledby="board-calendar" class="rounded-lg border bg-card p-4 text-card-foreground">
      <h2 id="board-calendar" class="text-sm font-medium text-muted-foreground">{{ $t('boards.digest.calendar') }}</h2>
      <ul class="mt-2 space-y-1 text-sm">
        <li v-for="(entry, index) in digest.calendar" :key="`${entry.name}-${index}`" class="flex flex-wrap justify-between gap-x-2">
          <span><span class="font-medium">{{ entry.name }}</span> — {{ entry.event }}</span>
          <span class="text-muted-foreground">{{ entry.date }}<span v-if="entry.when"> ({{ entry.when }})</span></span>
        </li>
      </ul>
    </section>

    <section v-if="digest.changesSince.length" aria-labelledby="board-changes" class="rounded-lg border bg-card p-4 text-card-foreground">
      <h2 id="board-changes" class="text-sm font-medium text-muted-foreground">{{ $t('boards.digest.changes') }}</h2>
      <ul class="mt-2 list-inside list-disc space-y-1 text-sm">
        <li v-for="(entry, index) in digest.changesSince" :key="index">{{ entry }}</li>
      </ul>
    </section>

    <section v-if="digest.footer" aria-labelledby="board-footer" class="rounded-lg border border-dashed p-4 text-help text-muted-foreground">
      <h2 id="board-footer" class="sr-only">{{ $t('boards.digest.footer') }}</h2>
      <p v-if="digest.runId">{{ $t('boards.digest.run', { run: digest.runId }) }}<span v-if="digest.slot"> · {{ digest.slot }}</span></p>
      <p v-if="digest.footer.sources.length">{{ $t('boards.digest.sources', { sources: digest.footer.sources.join(', ') }) }}</p>
      <p v-if="digest.footer.positionsTotal !== undefined">
        {{ $t('boards.digest.positions', { valid: digest.footer.positionsValid ?? 0, total: digest.footer.positionsTotal }) }}
      </p>
      <p v-if="digest.footer.costEur !== undefined">{{ $t('boards.digest.cost', { cost: formatEur(digest.footer.costEur) }) }}</p>
    </section>
  </div>
</template>
