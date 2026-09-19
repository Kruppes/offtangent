<template>
  <!-- Admin gate -->
  <div
    v-if="!isAdmin"
    class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground"
  >
    <AppIcon name="lock" size="xl" class="opacity-50" />
    <h1 class="text-lg font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="max-w-xs text-sm">{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="flex h-full flex-col overflow-y-auto">
    <PageHeader :title="$t('usage.title')" :subtitle="$t('usage.subtitle')">
      <template #actions>
        <Button variant="outline" :disabled="loading" class="gap-2" @click="loadStats">
          <AppIcon name="refresh" class="h-4 w-4" />
          {{ $t('usage.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Filter toolbar — consistent with logs page pattern -->
    <div class="flex-shrink-0 border-b border-border px-5 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <DateRangePicker
          v-model:date-from="filters.dateFrom"
          v-model:date-to="filters.dateTo"
          @change="loadStats"
        />

        <Select v-model="filters.provider" @update:model-value="onProviderChange">
          <SelectTrigger class="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{{ $t('usage.filters.allProviders') }}</SelectItem>
            <SelectItem v-for="p in availableProviders" :key="p" :value="p">{{ p }}</SelectItem>
          </SelectContent>
        </Select>

        <Select v-model="filters.model" @update:model-value="loadStats">
          <SelectTrigger class="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{{ $t('usage.filters.allModels') }}</SelectItem>
            <SelectItem v-for="m in availableModels" :key="m" :value="m">{{ m }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <!-- Content area -->
    <div class="mx-auto flex w-full max-w-6xl flex-col p-6">
      <!-- Error banner -->
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="error = null"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Loading skeleton -->
      <div v-if="loading" class="space-y-4">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Skeleton v-for="i in 3" :key="i" class="h-24 rounded-xl" />
        </div>
        <Skeleton class="h-72 rounded-xl" />
        <Skeleton class="h-52 rounded-xl" />
      </div>

      <template v-else>
        <!-- No usage at all — first-time empty state -->
        <Card v-if="!hasAnyUsage">
          <CardContent class="flex flex-col items-center gap-3 py-14 text-center">
            <AppIcon name="trendDown" size="xl" class="opacity-40" />
            <h2 class="text-base font-semibold text-foreground">{{ $t('usage.emptyTitle') }}</h2>
            <p class="max-w-md text-sm text-muted-foreground">{{ $t('usage.emptyDescription') }}</p>
          </CardContent>
        </Card>

        <template v-else>
          <!-- KPI row (3 cards) — filtered-range totals -->
          <section class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card v-for="card in kpiCards" :key="card.label">
              <CardContent class="p-5">
                <span class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {{ card.label }}
                </span>
                <strong class="mt-2 block text-2xl font-bold tracking-tight text-foreground">
                  {{ card.value }}
                </strong>
                <span class="mt-1 block text-xs text-muted-foreground">{{ card.meta }}</span>
              </CardContent>
            </Card>
          </section>

          <!-- ─── Provider stalls ─── -->
          <Card class="mb-4">
            <CardContent class="p-5">
              <div class="mb-4">
                <h2 class="text-base font-semibold text-foreground">{{ $t('usage.stalls.title') }}</h2>
                <p class="mt-1 text-sm text-muted-foreground">{{ $t('usage.stalls.description') }}</p>
              </div>

              <div
                v-if="stalls.total === 0"
                class="flex items-center gap-2 rounded-lg border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground"
              >
                <AppIcon name="check" class="h-4 w-4 opacity-60" />
                {{ $t('usage.stalls.empty') }}
              </div>

              <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div v-for="card in stallCards" :key="card.label" class="rounded-lg border border-border/70 p-4">
                  <span class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {{ card.label }}
                  </span>
                  <strong class="mt-2 block text-xl font-bold tracking-tight tabular-nums text-foreground">
                    {{ card.value }}
                  </strong>
                  <span class="mt-1 block text-xs text-muted-foreground">{{ card.meta }}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <!-- No results for current filters -->
          <Card v-if="!hasFilteredResults" class="mb-4">
            <CardContent class="flex flex-col items-center gap-3 py-10 text-center">
              <AppIcon name="compass" size="xl" class="opacity-40" />
              <h2 class="text-base font-semibold text-foreground">{{ $t('usage.emptyFilteredTitle') }}</h2>
              <p class="max-w-md text-sm text-muted-foreground">{{ $t('usage.emptyFilteredDescription') }}</p>
            </CardContent>
          </Card>

          <template v-else>
            <!-- ─── Daily bar chart ─── -->
            <Card class="mb-4">
              <CardContent class="p-5">
                <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 class="text-base font-semibold text-foreground">{{ $t('usage.chart.title') }}</h2>
                    <p class="mt-1 text-sm text-muted-foreground">{{ $t('usage.chart.description') }}</p>
                  </div>
                  <!-- Legend -->
                  <div class="flex items-center gap-4 text-xs text-muted-foreground">
                    <span class="flex items-center gap-1.5">
                      <span class="h-2.5 w-2.5 rounded-sm bg-primary" />
                      {{ $t('usage.chart.prompt') }}
                    </span>
                    <span class="flex items-center gap-1.5">
                      <span class="h-2.5 w-2.5 rounded-sm bg-primary/40" />
                      {{ $t('usage.chart.completion') }}
                    </span>
                  </div>
                </div>

                <!-- Empty chart -->
                <div
                  v-if="chartSeries.length === 0 || chartMax === 0"
                  class="flex min-h-[180px] items-center justify-center text-sm text-muted-foreground"
                >
                  {{ $t('usage.chart.empty') }}
                </div>

                <!-- Chart body -->
                <div v-else class="flex gap-3">
                  <!-- Y-axis labels -->
                  <div class="flex w-14 shrink-0 flex-col justify-between pb-7 text-right">
                    <span class="text-xs tabular-nums text-muted-foreground">{{ formatNumber(chartMax) }}</span>
                    <span class="text-xs tabular-nums text-muted-foreground">{{ formatNumber(Math.round(chartMax / 2)) }}</span>
                    <span class="text-xs tabular-nums text-muted-foreground">0</span>
                  </div>

                  <!-- Grid + bars -->
                  <div class="relative min-h-[220px] flex-1 sm:min-h-[280px]">
                    <!-- Horizontal grid lines -->
                    <div class="pointer-events-none absolute inset-0 flex flex-col justify-between pb-7">
                      <div class="border-t border-dashed border-border/60" />
                      <div class="border-t border-dashed border-border/60" />
                      <div class="border-t border-dashed border-border/60" />
                    </div>

                    <!-- Bars -->
                    <div
                      class="absolute inset-0"
                      :style="{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${chartSeries.length}, minmax(0, 1fr))`,
                        alignItems: 'end',
                        paddingBottom: '28px',
                      }"
                    >
                      <div
                        v-for="point in chartSeries"
                        :key="point.day"
                        class="group flex min-w-0 flex-col items-center justify-end"
                        style="height: 100%"
                        :title="chartTooltip(point)"
                      >
                        <div
                          class="w-full max-w-[26px] overflow-hidden rounded-t-sm transition-opacity group-hover:opacity-80"
                          :style="{ height: `${point.height}%` }"
                        >
                          <!-- Completion (output) on top -->
                          <div
                            v-if="point.completionShare > 0"
                            class="w-full bg-primary/40"
                            :style="{ height: `${point.completionShare}%` }"
                          />
                          <!-- Prompt (input) on bottom -->
                          <div
                            v-if="point.promptShare > 0"
                            class="w-full bg-primary"
                            :style="{ height: `${point.promptShare}%` }"
                          />
                        </div>
                      </div>
                    </div>

                    <!-- X-axis labels -->
                    <div
                      class="absolute bottom-0 left-0 right-0 h-7"
                      :style="{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${xAxisLabels.length}, minmax(0, 1fr))`,
                        alignItems: 'end',
                      }"
                    >
                      <span
                        v-for="lbl in xAxisLabels"
                        :key="lbl.day"
                        class="overflow-hidden text-center text-[10px] text-muted-foreground"
                      >
                        {{ lbl.label }}
                      </span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <!-- ─── Main Agent vs. Task Agent breakdown ─── -->
            <Card v-if="hasTaskUsage" class="mb-4">
              <CardContent class="p-5">
                <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 class="text-base font-semibold text-foreground">{{ $t('usage.sourceChart.title') }}</h2>
                    <p class="mt-1 text-sm text-muted-foreground">{{ $t('usage.sourceChart.description') }}</p>
                  </div>
                  <!-- Legend -->
                  <div class="flex items-center gap-4 text-xs text-muted-foreground">
                    <span class="flex items-center gap-1.5">
                      <span class="h-2.5 w-2.5 rounded-sm bg-primary" />
                      {{ $t('usage.sourceChart.mainAgent') }}
                    </span>
                    <span class="flex items-center gap-1.5">
                      <span class="h-2.5 w-2.5 rounded-sm bg-amber-500" />
                      {{ $t('usage.sourceChart.taskAgent') }}
                    </span>
                    <span class="flex items-center gap-1.5">
                      <span class="h-2.5 w-2.5 rounded-sm bg-emerald-500" />
                      {{ $t('usage.sourceChart.heartbeat') }}
                    </span>
                  </div>
                </div>

                <!-- Empty chart -->
                <div
                  v-if="sourceChartSeries.length === 0 || sourceChartMax === 0"
                  class="flex min-h-[180px] items-center justify-center text-sm text-muted-foreground"
                >
                  {{ $t('usage.chart.empty') }}
                </div>

                <!-- Chart body -->
                <div v-else class="flex gap-3">
                  <!-- Y-axis labels -->
                  <div class="flex w-14 shrink-0 flex-col justify-between pb-7 text-right">
                    <span class="text-xs tabular-nums text-muted-foreground">{{ formatNumber(sourceChartMax) }}</span>
                    <span class="text-xs tabular-nums text-muted-foreground">{{ formatNumber(Math.round(sourceChartMax / 2)) }}</span>
                    <span class="text-xs tabular-nums text-muted-foreground">0</span>
                  </div>

                  <!-- Grid + bars -->
                  <div class="relative min-h-[220px] flex-1 sm:min-h-[280px]">
                    <!-- Horizontal grid lines -->
                    <div class="pointer-events-none absolute inset-0 flex flex-col justify-between pb-7">
                      <div class="border-t border-dashed border-border/60" />
                      <div class="border-t border-dashed border-border/60" />
                      <div class="border-t border-dashed border-border/60" />
                    </div>

                    <!-- Bars -->
                    <div
                      class="absolute inset-0"
                      :style="{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${sourceChartSeries.length}, minmax(0, 1fr))`,
                        alignItems: 'end',
                        paddingBottom: '28px',
                      }"
                    >
                      <div
                        v-for="point in sourceChartSeries"
                        :key="point.day"
                        class="group flex min-w-0 flex-col items-center justify-end"
                        style="height: 100%"
                        :title="sourceChartTooltip(point)"
                      >
                        <div
                          class="flex w-full max-w-[26px] flex-col justify-end overflow-hidden rounded-t-sm transition-opacity group-hover:opacity-80"
                          :style="{ height: `${point.height}%` }"
                        >
                          <!-- Heartbeat (top) -->
                          <div
                            v-if="point.heartbeatShare > 0"
                            class="w-full bg-emerald-500"
                            :style="{ height: `${point.heartbeatShare}%` }"
                          />
                          <!-- Task (middle) -->
                          <div
                            v-if="point.taskShare > 0"
                            class="w-full bg-amber-500"
                            :style="{ height: `${point.taskShare}%` }"
                          />
                          <!-- Main (bottom) -->
                          <div
                            v-if="point.mainShare > 0"
                            class="w-full bg-primary"
                            :style="{ height: `${point.mainShare}%` }"
                          />
                        </div>
                      </div>
                    </div>

                    <!-- X-axis labels -->
                    <div
                      class="absolute bottom-0 left-0 right-0 h-7"
                      :style="{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${sourceChartXAxisLabels.length}, minmax(0, 1fr))`,
                        alignItems: 'end',
                      }"
                    >
                      <span
                        v-for="lbl in sourceChartXAxisLabels"
                        :key="lbl.day"
                        class="overflow-hidden text-center text-[10px] text-muted-foreground"
                      >
                        {{ lbl.label }}
                      </span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <!-- ─── Provider / model breakdown table ─── -->
            <Card class="mb-4">
              <CardContent class="p-5">
                <div class="mb-4">
                  <h2 class="text-base font-semibold text-foreground">{{ $t('usage.table.title') }}</h2>
                  <p class="mt-1 text-sm text-muted-foreground">{{ $t('usage.table.description') }}</p>
                </div>

                <div class="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{{ $t('usage.table.columns.provider') }}</TableHead>
                        <TableHead>{{ $t('usage.table.columns.model') }}</TableHead>
                        <TableHead class="text-right">{{ $t('usage.table.columns.requests') }}</TableHead>
                        <TableHead class="text-right">{{ $t('usage.table.columns.promptTokens') }}</TableHead>
                        <TableHead class="text-right">{{ $t('usage.table.columns.completionTokens') }}</TableHead>
                        <TableHead class="text-right">{{ $t('usage.table.columns.cacheRead') }}</TableHead>
                        <TableHead class="text-right">{{ $t('usage.table.columns.cacheWrite') }}</TableHead>
                        <TableHead class="text-right">{{ $t('usage.table.columns.cacheHitRate') }}</TableHead>
                        <TableHead class="text-right">{{ $t('usage.table.columns.cost') }}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow v-if="breakdown.rows.length === 0">
                        <TableCell colspan="9" class="py-8 text-center text-muted-foreground">
                          {{ $t('usage.table.empty') }}
                        </TableCell>
                      </TableRow>
                      <template v-else>
                        <TableRow
                          v-for="row in breakdown.rows"
                          :key="`${row.provider}-${row.model}`"
                        >
                          <TableCell class="font-medium">{{ row.provider || '—' }}</TableCell>
                          <TableCell class="font-mono text-xs">{{ row.model || '—' }}</TableCell>
                          <TableCell class="text-right tabular-nums">{{ formatNumber(row.requests) }}</TableCell>
                          <TableCell class="text-right tabular-nums">{{ formatNumber(row.promptTokens) }}</TableCell>
                          <TableCell class="text-right tabular-nums">{{ formatNumber(row.completionTokens) }}</TableCell>
                          <TableCell class="text-right tabular-nums">{{ formatNumber(row.cacheRead) }}</TableCell>
                          <TableCell class="text-right tabular-nums">{{ formatNumber(row.cacheWrite) }}</TableCell>
                          <TableCell class="text-right tabular-nums">{{ cacheHitLabel(row) }}</TableCell>
                          <TableCell class="text-right tabular-nums">
                            {{ formatCurrency(row.estimatedCost) }}
                            <span v-if="breakdown.rows.length > 1" class="ml-1 text-[11px] text-muted-foreground">
                              {{ costShareLabel(row.estimatedCost) }}
                            </span>
                          </TableCell>
                        </TableRow>

                        <!-- Totals row -->
                        <TableRow class="border-t-2 border-border bg-muted/30">
                          <TableCell colspan="2" class="font-semibold">
                            {{ $t('usage.table.total') }}
                          </TableCell>
                          <TableCell class="text-right font-semibold tabular-nums">
                            {{ formatNumber(totals.requests) }}
                          </TableCell>
                          <TableCell class="text-right font-semibold tabular-nums">
                            {{ formatNumber(totals.promptTokens) }}
                          </TableCell>
                          <TableCell class="text-right font-semibold tabular-nums">
                            {{ formatNumber(totals.completionTokens) }}
                          </TableCell>
                          <TableCell class="text-right font-semibold tabular-nums">
                            {{ formatNumber(totals.cacheRead) }}
                          </TableCell>
                          <TableCell class="text-right font-semibold tabular-nums">
                            {{ formatNumber(totals.cacheWrite) }}
                          </TableCell>
                          <TableCell class="text-right font-semibold tabular-nums">
                            {{ cacheHitLabel(totals) }}
                          </TableCell>
                          <TableCell class="text-right font-semibold tabular-nums">
                            {{ formatCurrency(totals.estimatedCost) }}
                          </TableCell>
                        </TableRow>
                      </template>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </template>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
const { t, locale } = useI18n()
const { formatNumber, formatCurrency, formatDuration } = useFormat()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const {
  loading,
  error,
  filters,
  daily,
  dailyMainAgent,
  dailyTaskAgent,
  dailyHeartbeat,
  breakdown,
  stalls,
  availableProviders,
  availableModels,
  hasAnyUsage,
  hasFilteredResults,
  totals,
  loadStats,
} = useUsageStats()

// ── Days in the selected range (for avg-per-day KPI) ────────
const daysInRange = computed(() => {
  if (!filters.dateFrom || !filters.dateTo) return 1
  const start = new Date(`${filters.dateFrom}T00:00:00`)
  const end = new Date(`${filters.dateTo}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1)
})

// ── KPI cards — derived from filtered-range totals ──────────
const kpiCards = computed(() => [
  {
    label: t('usage.kpi.requests'),
    value: formatNumber(totals.value.requests),
    meta: t('usage.kpi.requestsPerDay', {
      count: formatNumber(Math.round(totals.value.requests / daysInRange.value)),
    }),
  },
  {
    label: t('usage.kpi.totalTokens'),
    value: formatNumber(totals.value.totalTokens),
    meta: t('usage.kpi.tokenBreakdown', {
      prompt: formatNumber(totals.value.promptTokens),
      completion: formatNumber(totals.value.completionTokens),
    }),
  },
  {
    label: t('usage.kpi.estimatedCost'),
    value: formatCurrency(totals.value.estimatedCost),
    meta: totals.value.requests > 0
      ? t('usage.kpi.costPerRequest', {
          cost: formatCurrency(totals.value.estimatedCost / totals.value.requests),
        })
      : '—',
  },
])

// ── Provider stall cards ────────────────────────────────────
const stallCards = computed(() => {
  const stats = stalls.value
  const share = (count: number) => stats.total > 0
    ? t('usage.stalls.share', { percent: Math.round((count / stats.total) * 100) })
    : '—'

  return [
    {
      label: t('usage.stalls.total'),
      value: formatNumber(stats.total),
      meta: stats.unresolved > 0
        ? t('usage.stalls.unresolved', { count: formatNumber(stats.unresolved) })
        : t('usage.stalls.allResolved'),
    },
    {
      label: t('usage.stalls.avgDuration'),
      value: formatDuration(stats.averageDurationMs),
      meta: t('usage.stalls.longest', { duration: formatDuration(stats.maxDurationMs) }),
    },
    {
      label: t('usage.stalls.recovered'),
      value: formatNumber(stats.recovered),
      meta: stats.recovered > 0
        ? `${share(stats.recovered)} · ${t('usage.stalls.avgShort', { duration: formatDuration(stats.averageRecoveredDurationMs) })}`
        : share(stats.recovered),
    },
    {
      label: t('usage.stalls.aborted'),
      value: formatNumber(stats.aborted),
      meta: stats.aborted > 0
        ? `${share(stats.aborted)} · ${t('usage.stalls.avgShort', { duration: formatDuration(stats.averageAbortedDurationMs) })}`
        : share(stats.aborted),
    },
  ]
})

// ── Chart data ──────────────────────────────────────────────
interface ChartPoint {
  day: string
  label: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimatedCost: number
  height: number
  promptShare: number      // prompt % within this bar (0–100)
  completionShare: number  // completion % within this bar (0–100)
}

function fmtDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric' })
    .format(new Date(`${value}T00:00:00`))
}

function formatFullDate(value: string): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' })
    .format(new Date(`${value}T00:00:00`))
}

const chartSeries = computed<ChartPoint[]>(() => {
  if (!filters.dateFrom || !filters.dateTo) return []

  const start = new Date(`${filters.dateFrom}T00:00:00`)
  const end = new Date(`${filters.dateTo}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return []

  const dailyMap = new Map(
    daily.value.rows
      .filter((row) => row.day)
      .map((row) => [row.day as string, row]),
  )

  const points: Array<Omit<ChartPoint, 'height' | 'promptShare' | 'completionShare'>> = []
  const cursor = new Date(start)

  while (cursor <= end) {
    const day = fmtDateKey(cursor)
    const row = dailyMap.get(day)
    points.push({
      day,
      label: formatShortDate(day),
      promptTokens: row?.promptTokens ?? 0,
      completionTokens: row?.completionTokens ?? 0,
      totalTokens: row?.totalTokens ?? 0,
      estimatedCost: row?.estimatedCost ?? 0,
    })
    cursor.setDate(cursor.getDate() + 1)
  }

  const max = Math.max(...points.map((p) => p.totalTokens), 0)

  return points.map((point) => {
    const total = point.totalTokens
    return {
      ...point,
      height: max > 0 ? Math.max((total / max) * 100, total > 0 ? 8 : 0) : 0,
      promptShare: total > 0 ? (point.promptTokens / total) * 100 : 0,
      completionShare: total > 0 ? (point.completionTokens / total) * 100 : 0,
    }
  })
})

const chartMax = computed(() => Math.max(...chartSeries.value.map((p) => p.totalTokens), 0))

const xAxisLabels = computed(() => {
  const series = chartSeries.value
  if (series.length === 0) return []
  const step = series.length <= 14 ? 1 : series.length <= 31 ? 3 : 7
  return series.map((point, i) => ({
    day: point.day,
    label: i % step === 0 ? point.label : '',
  }))
})

function chartTooltip(point: ChartPoint): string {
  return `${formatFullDate(point.day)} · ${formatNumber(point.promptTokens)} prompt · ${formatNumber(point.completionTokens)} completion · ${formatCurrency(point.estimatedCost)}`
}

// ── Source breakdown chart (Main Agent vs. Task Agent) ──────
const hasTaskUsage = computed(() => {
  return dailyTaskAgent.value.totals.totalTokens > 0 || dailyHeartbeat.value.totals.totalTokens > 0
})

interface SourceChartPoint {
  day: string
  label: string
  mainTokens: number
  taskTokens: number
  heartbeatTokens: number
  totalTokens: number
  height: number
  mainShare: number
  taskShare: number
  heartbeatShare: number
}

const sourceChartSeries = computed<SourceChartPoint[]>(() => {
  if (!filters.dateFrom || !filters.dateTo) return []

  const start = new Date(`${filters.dateFrom}T00:00:00`)
  const end = new Date(`${filters.dateTo}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return []

  const mainMap = new Map(
    dailyMainAgent.value.rows
      .filter((row) => row.day)
      .map((row) => [row.day as string, row.totalTokens]),
  )
  const taskMap = new Map(
    dailyTaskAgent.value.rows
      .filter((row) => row.day)
      .map((row) => [row.day as string, row.totalTokens]),
  )
  const heartbeatMap = new Map(
    dailyHeartbeat.value.rows
      .filter((row) => row.day)
      .map((row) => [row.day as string, row.totalTokens]),
  )

  const points: Array<{ day: string; label: string; mainTokens: number; taskTokens: number; heartbeatTokens: number; totalTokens: number }> = []
  const cursor = new Date(start)

  while (cursor <= end) {
    const day = fmtDateKey(cursor)
    const mainTokens = mainMap.get(day) ?? 0
    const taskTokens = taskMap.get(day) ?? 0
    const heartbeatTokens = heartbeatMap.get(day) ?? 0
    points.push({
      day,
      label: formatShortDate(day),
      mainTokens,
      taskTokens,
      heartbeatTokens,
      totalTokens: mainTokens + taskTokens + heartbeatTokens,
    })
    cursor.setDate(cursor.getDate() + 1)
  }

  const max = Math.max(...points.map((p) => p.totalTokens), 0)

  return points.map((point) => {
    const total = point.totalTokens
    return {
      ...point,
      height: max > 0 ? Math.max((total / max) * 100, total > 0 ? 8 : 0) : 0,
      mainShare: total > 0 ? (point.mainTokens / total) * 100 : 0,
      taskShare: total > 0 ? (point.taskTokens / total) * 100 : 0,
      heartbeatShare: total > 0 ? (point.heartbeatTokens / total) * 100 : 0,
    }
  })
})

const sourceChartMax = computed(() => Math.max(...sourceChartSeries.value.map((p) => p.totalTokens), 0))

const sourceChartXAxisLabels = computed(() => {
  const series = sourceChartSeries.value
  if (series.length === 0) return []
  const step = series.length <= 14 ? 1 : series.length <= 31 ? 3 : 7
  return series.map((point, i) => ({
    day: point.day,
    label: i % step === 0 ? point.label : '',
  }))
})

function sourceChartTooltip(point: SourceChartPoint): string {
  return `${formatFullDate(point.day)} · Main: ${formatNumber(point.mainTokens)} · Tasks: ${formatNumber(point.taskTokens)} · Heartbeat: ${formatNumber(point.heartbeatTokens)}`
}

// ── Table helpers ───────────────────────────────────────────
function cacheHitLabel(row: { promptTokens: number; cacheRead: number; cacheWrite: number }): string {
  if (row.cacheRead + row.cacheWrite === 0) return '—'
  const denominator = row.promptTokens + row.cacheRead + row.cacheWrite
  if (denominator <= 0) return '—'
  return `${((row.cacheRead / denominator) * 100).toFixed(1)}%`
}

function costShareLabel(cost: number): string {
  const total = totals.value.estimatedCost
  if (total === 0) return ''
  return `(${Math.round((cost / total) * 100)}%)`
}

// ── Filter handlers ─────────────────────────────────────────
function onProviderChange() {
  filters.model = ''
  loadStats()
}

// ── Init ────────────────────────────────────────────────────
onMounted(async () => {
  if (!isAdmin.value) return
  await loadStats()
})
</script>
