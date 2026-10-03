<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useCapturesApi, type Capture, type Decision } from '~/api/captures'
import { useNowApi } from '~/api/now'
import { barHeights, loadWeekWindow, weekClaim, weekStats } from './weekStats'
import { addDays } from '~/utils/localDay'

/**
 * The week (the app's Week screen): what went in this week, counted from the
 * newest captures. Only numbers and strand titles, never capture text.
 */
const api = useCapturesApi()
const nowApi = useNowApi()
const { locale } = useI18n()
const captures = ref<Capture[]>([])
const decisions = ref<Decision[]>([])
const titles = ref<Record<string, string | null>>({})
const loading = ref(true)
const loadError = ref(false)
const nowMs = ref(Date.now())
const stats = computed(() => weekStats(captures.value, decisions.value, nowMs.value))
const claim = computed(() => weekClaim(stats.value))
const bars = computed(() => barHeights(stats.value.perDay))
function dayName(index: number, style: 'short' | 'long') {
  const day = addDays(stats.value.weekStart, index)
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale.value, { weekday: style, timeZone: 'UTC' })
}
function dateLabel(day: string) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale.value, { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
async function load() {
  loading.value = true; loadError.value = false
  try {
    // W6b: the whole week, exact, instead of the newest 200 captures.
    const at = Date.now()
    const page = await loadWeekWindow((since, offset) => api.since(since, offset), at)
    captures.value = page.captures
    decisions.value = page.decisions
    nowMs.value = at
    const ids = weekStats(page.captures, page.decisions, nowMs.value).strandIds
    await Promise.all(ids.filter(id => !(id in titles.value)).map(async (id) => {
      try { titles.value[id] = (await nowApi.strand(id)).title } catch { titles.value[id] = null }
    }))
  } catch { loadError.value = true }
  finally { loading.value = false }
}
onMounted(load)
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
    <header>
      <h1 class="text-xl font-bold tracking-tight md:hidden">{{ $t('week.title') }}</h1>
      <p v-if="!loading && !loadError" class="mt-1 font-medium" data-testid="week-range">{{ $t('week.range', { week: stats.week, from: dateLabel(stats.weekStart), to: dateLabel(stats.weekEnd) }) }}</p>
    </header>
    <div v-if="loading" role="status" class="space-y-4" data-testid="skeleton"><span class="sr-only">{{ $t('common.loading') }}</span><div v-for="i in 2" :key="i" aria-hidden="true" class="h-32 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" /></div>
    <section v-else-if="loadError" role="alert" class="rounded-xl border p-4">
      <p>{{ $t('week.loadError') }}</p>
      <Button variant="outline" class="mt-2 min-h-11" @click="load">{{ $t('common.retry') }}</Button>
    </section>
    <template v-else>
      <p class="text-lg font-medium" data-testid="week-claim">{{ $t(`week.claim.${claim}`, { count: stats.captures, strands: stats.strandsTouched }) }}</p>
      <section v-if="stats.captures === 0" class="rounded-xl border p-6 text-left" data-testid="week-empty">
        <p class="text-muted-foreground">{{ $t('week.emptyText') }}</p>
        <NuxtLink to="/" class="mt-3 inline-flex min-h-11 items-center rounded-md border px-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ $t('week.toHome') }}</NuxtLink>
      </section>
      <template v-else>
        <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="week-tiles">
          <div class="rounded-xl border bg-card p-3"><dt class="text-sm text-muted-foreground">{{ $t('week.tiles.captures') }}</dt><dd class="text-2xl font-semibold tabular-nums">{{ stats.captures }}</dd></div>
          <div class="rounded-xl border bg-card p-3"><dt class="text-sm text-muted-foreground">{{ $t('week.tiles.strands') }}</dt><dd class="text-2xl font-semibold tabular-nums">{{ stats.strandsTouched }}</dd></div>
          <div class="rounded-xl border bg-card p-3"><dt class="text-sm text-muted-foreground">{{ $t('week.tiles.auto') }}</dt><dd class="text-2xl font-semibold tabular-nums">{{ stats.filedWithoutAskingPercent }}&#8239;%</dd></div>
          <div class="rounded-xl border bg-card p-3"><dt class="text-sm text-muted-foreground">{{ $t('week.tiles.reviewed') }}</dt><dd class="text-2xl font-semibold tabular-nums">{{ stats.reviewed }}<span class="text-sm font-normal text-muted-foreground"> · {{ $t('week.tiles.undone', { count: stats.undone }) }}</span></dd></div>
        </dl>
        <section class="rounded-xl border bg-card p-4" aria-labelledby="week-days-heading">
          <h2 id="week-days-heading" class="mb-3 font-semibold">{{ $t('week.perDay') }}</h2>
          <ol class="grid grid-cols-7 items-end gap-2" data-testid="week-bars">
            <li v-for="(count, index) in stats.perDay" :key="index" class="flex min-w-0 flex-col items-center gap-1" :aria-label="$t('week.dayCount', { day: dayName(index, 'long'), count })">
              <span class="text-xs tabular-nums text-muted-foreground" aria-hidden="true">{{ count }}</span>
              <span class="flex h-24 w-full items-end" aria-hidden="true"><span class="w-full rounded-t-sm" :class="index === stats.todayIndex ? 'bg-primary' : count ? 'bg-primary-container' : 'bg-muted'" :style="{ height: bars[index] + '%' }" /></span>
              <span class="text-xs" :class="index === stats.todayIndex ? 'font-semibold' : 'text-muted-foreground'" aria-hidden="true">{{ dayName(index, 'short') }}</span>
            </li>
          </ol>
        </section>
        <section v-if="stats.strandIds.length" class="space-y-2" aria-labelledby="week-strands-heading">
          <h2 id="week-strands-heading" class="font-semibold">{{ $t('week.strands') }}</h2>
          <ul class="space-y-2">
            <li v-for="id in stats.strandIds" :key="id"><NuxtLink :to="`/strands/${encodeURIComponent(id)}`" class="flex min-h-11 items-center rounded-xl border bg-card px-3 [overflow-wrap:anywhere] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ titles[id] || $t('capture.untitled') }}</NuxtLink></li>
          </ul>
        </section>
        <p class="text-xs text-muted-foreground">{{ $t('week.basis') }}</p>
      </template>
    </template>
  </div>
</template>
