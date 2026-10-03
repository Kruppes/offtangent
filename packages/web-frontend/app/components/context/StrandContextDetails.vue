<template>
  <!-- Context panel slot `extra` (W4b): usage of the last request (large ring
       + counters, like the app's ContextDetailsSheet) and what belongs to
       the strand (project, linked facts, summaries, tool calls). -->
  <section aria-labelledby="ctx-usage" data-context-usage :data-state="gauge.status">
    <h4 id="ctx-usage" class="mb-2 text-xs font-semibold uppercase tracking-label text-muted-foreground">{{ $t('w4b.context.usage') }}</h4>
    <p v-if="gauge.status === 'loading'" class="text-sm text-muted-foreground" role="status">{{ $t('w4b.context.loading') }}</p>
    <p v-else-if="gauge.status === 'unsupported'" class="text-sm text-muted-foreground">{{ $t('w4b.context.unsupported') }}</p>
    <div v-else-if="gauge.status === 'error'" class="flex flex-wrap items-center gap-2" role="alert">
      <span class="text-sm text-destructive">{{ $t(gauge.offline ? 'w4b.context.offline' : 'w4b.context.error') }}</span>
      <button type="button" class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-context-retry @click="refreshGauge">
        <AppIcon name="retry" size="sm" />{{ $t('w4b.speech.retry') }}
      </button>
    </div>
    <template v-else>
      <div class="flex items-center gap-3">
        <ContextRing :ratio="gauge.data.ratio" :label="ringLabel(gauge.data)" :size="72" />
        <div class="min-w-0 text-sm">
          <p class="font-medium tabular-nums">{{ formatTokens(gauge.data.requestTokens) }} / {{ formatTokens(gauge.data.contextWindow) }}</p>
          <p class="text-muted-foreground">{{ gauge.data.modelLabel ?? '–' }}</p>
          <p v-if="!gauge.data.measured" class="text-muted-foreground">{{ $t('w4b.context.notMeasured') }}</p>
        </div>
      </div>
      <p v-if="bandOf(gauge.data) === 'caution' || bandOf(gauge.data) === 'full'" class="mt-2 rounded-md border px-2 py-2 text-sm" :class="bandOf(gauge.data) === 'full' ? 'border-destructive text-foreground' : 'border-border text-foreground'" data-context-hint>
        <strong>{{ bandOf(gauge.data) === 'full' ? $t('w4b.context.fullTitle') : $t('w4b.context.cautionTitle') }}</strong>
        {{ $t('w4b.context.hint') }}
      </p>
      <p v-if="gauge.data.stale" class="mt-2 text-sm text-destructive" data-context-stale>{{ $t('w4b.context.stale', { model: gauge.data.measuredModelId ?? '–' }) }}</p>
      <dl class="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
        <dt class="text-muted-foreground">{{ $t('w4b.context.request') }}</dt><dd class="text-right tabular-nums">{{ formatTokens(gauge.data.requestTokens) }}</dd>
        <dt class="pl-3 text-muted-foreground">{{ $t('w4b.context.cacheRead') }}</dt><dd class="text-right tabular-nums">{{ formatTokens(gauge.data.cacheReadTokens) }}</dd>
        <dt class="pl-3 text-muted-foreground">{{ $t('w4b.context.uncached') }}</dt><dd class="text-right tabular-nums">{{ formatTokens(gauge.data.inputTokens) }}</dd>
        <dt class="text-muted-foreground">{{ $t('w4b.context.answer') }}</dt><dd class="text-right tabular-nums">{{ formatTokens(gauge.data.outputTokens) }}</dd>
        <dt class="text-muted-foreground">{{ $t('w4b.context.window') }}</dt><dd class="text-right tabular-nums">{{ formatTokens(gauge.data.contextWindow) }}</dd>
        <dt class="text-muted-foreground">{{ $t('w4b.context.transcript') }}</dt><dd class="text-right tabular-nums">{{ gauge.data.transcriptTokens === null ? '–' : `${formatTokens(gauge.data.transcriptTokens)} / ${formatTokens(gauge.data.transcriptBudget)}` }}</dd>
        <dt class="text-muted-foreground">{{ $t('w4b.context.compaction') }}</dt><dd class="text-right tabular-nums">{{ gauge.data.lastCompaction ? $t('w4b.context.dropped', { count: gauge.data.lastCompaction.droppedMessages }) : '–' }}</dd>
      </dl>
      <p class="mt-2 text-xs text-muted-foreground">{{ $t('w4b.context.explain') }}</p>
    </template>
  </section>

  <section aria-labelledby="ctx-belongings" data-context-belongings :data-state="belongings.status">
    <h4 id="ctx-belongings" class="mb-2 text-xs font-semibold uppercase tracking-label text-muted-foreground">{{ $t('w4b.context.belongings') }}</h4>
    <p v-if="belongings.status === 'loading'" class="text-sm text-muted-foreground" role="status">{{ $t('common.loading') }}</p>
    <p v-else-if="belongings.status === 'unsupported'" class="text-sm text-muted-foreground">{{ $t('w4b.context.unsupported') }}</p>
    <div v-else-if="belongings.status === 'error'" class="flex flex-wrap items-center gap-2" role="alert">
      <span class="text-sm text-destructive">{{ $t(belongings.offline ? 'w4b.context.offline' : 'w4b.context.error') }}</span>
      <button type="button" class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="refreshBelongings">
        <AppIcon name="retry" size="sm" />{{ $t('w4b.speech.retry') }}
      </button>
    </div>
    <template v-else>
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt class="text-muted-foreground">{{ $t('w4b.context.project') }}</dt><dd class="min-w-0 truncate">{{ belongings.data.projectName ?? $t('w4b.context.noProject') }}</dd>
        <dt class="text-muted-foreground">{{ $t('w4b.context.summaries') }}</dt><dd class="tabular-nums">{{ belongings.data.summaries }}</dd>
        <dt class="text-muted-foreground">{{ $t('w4b.context.toolCalls') }}</dt><dd class="tabular-nums">{{ belongings.data.toolCalls }}</dd>
      </dl>
      <h5 class="mb-1 mt-3 text-sm font-medium">{{ $t('w4b.context.facts', { count: belongings.data.factsTotal ?? belongings.data.facts.length }) }}</h5>
      <ul v-if="belongings.data.facts.length" class="space-y-1 text-sm" data-context-facts>
        <li v-for="fact in belongings.data.facts.slice(0, 8)" :key="fact.id" class="rounded-md bg-muted px-2 py-1">{{ fact.text }}</li>
        <li v-if="(belongings.data.factsTotal ?? belongings.data.facts.length) > 8" class="px-2 text-muted-foreground">{{ $t('w4b.context.moreFacts', { count: (belongings.data.factsTotal ?? belongings.data.facts.length) - 8 }) }}</li>
      </ul>
      <p v-else class="text-sm text-muted-foreground" data-context-facts-empty>{{ $t('w4b.context.noFacts') }}</p>
    </template>
  </section>

  <!-- W5b: messages the agent fetched back into this strand (recall_message
       or the automatic strand context). Same request as the gauge, so its
       loading and error states are the gauge's. A click jumps to the message. -->
  <section aria-labelledby="ctx-recalled" data-context-recalled :data-state="recalled.status">
    <h4 id="ctx-recalled" class="mb-2 text-xs font-semibold uppercase tracking-label text-muted-foreground">{{ $t('context.recalled.title') }}</h4>
    <p v-if="recalled.status === 'loading'" class="text-sm text-muted-foreground" role="status">{{ $t('context.recalled.loading') }}</p>
    <p v-else-if="recalled.status === 'unsupported'" class="text-sm text-muted-foreground">{{ $t('w4b.context.unsupported') }}</p>
    <div v-else-if="recalled.status === 'error'" class="flex flex-wrap items-center gap-2" role="alert">
      <span class="text-sm text-destructive">{{ $t('context.recalled.error') }}</span>
      <button type="button" class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-recalled-retry @click="refreshGauge">
        <AppIcon name="retry" size="sm" />{{ $t('w4b.speech.retry') }}
      </button>
    </div>
    <p v-else-if="!recalled.data.length" class="text-sm text-muted-foreground" data-recalled-empty>{{ $t('context.recalled.empty') }}</p>
    <ul v-else class="space-y-1" data-recalled-list>
      <li v-for="item in recalled.data" :key="`${item.source}-${item.messageId}`">
        <NuxtLink :to="messageRoute(item.strandId, item.messageId)" class="flex min-h-11 min-w-0 flex-col gap-1 rounded-lg px-2 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :data-recalled-message="item.messageId"
          :aria-label="$t('context.recalled.open', { role: roleLabel(item.role), excerpt: item.excerpt })">
          <span class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span class="font-semibold">{{ roleLabel(item.role) }}</span>
            <span>·</span>
            <span>{{ $t(item.source === 'recall' ? 'context.recalled.byRecall' : 'context.recalled.byContext') }}</span>
            <time v-if="item.recalledAt" class="ml-auto shrink-0 tabular-nums" :datetime="item.recalledAt">{{ when(item.recalledAt) }}</time>
          </span>
          <span class="line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]">{{ item.excerpt || $t('context.recalled.noText') }}</span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ContextRing from './ContextRing.vue'
import { useStrandContext } from '~/composables/useStrandContext'
import { formatTokens, gaugeBand, gaugePercent, type StrandContextView } from '~/utils/contextGauge'
import { messageRoute } from '~/api/strandW5b'
import { parseBackendTimestamp } from '~/utils/datetime'

const props = defineProps<{ strandId: string; projectId?: string | null }>()
const { t, locale } = useI18n()
const ctx = useStrandContext(() => props.strandId, () => props.projectId)
ctx.watchGauge()
ctx.watchBelongings()
const gauge = computed(() => ctx.gauge())
const belongings = computed(() => ctx.belongings())
const recalled = computed(() => ctx.recalled())
function roleLabel(role: string): string {
  return role === 'assistant' ? t('context.recalled.roleAssistant') : t('context.recalled.roleUser')
}
function when(value: string): string {
  const date = parseBackendTimestamp(value)
  return date ? date.toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' }) : ''
}
const refreshGauge = () => ctx.refreshGauge()
const refreshBelongings = () => ctx.refreshBelongings()

function bandOf(view: StrandContextView) {
  return gaugeBand(view.ratio)
}

function ringLabel(view: StrandContextView): string {
  const percent = gaugePercent(view.ratio)
  if (percent === null) return t('w4b.context.ringUnknown')
  return t('w4b.context.ringLabel', { percent, window: formatTokens(view.contextWindow) })
}
</script>
