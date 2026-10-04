<script setup lang="ts">
/**
 * Eco mode switch of one strand (plan 2026-10-04-eco-implementation).
 * Default off; switching off is the rollback. Hidden while the server does not
 * report an eco status (older server): no switch without effect.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ecoSavedPercent, useStrandEcoApi, type StrandEcoStatus } from '~/api/strandEco'

const props = defineProps<{ strandId: string; disabled?: boolean }>()
const { t } = useI18n()
const api = useStrandEcoApi()
const status = ref<StrandEcoStatus | null>(null)
const state = ref<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
const saving = ref(false)
const saveError = ref(false)
const announce = ref('')

async function load() {
  state.value = 'loading'
  try {
    status.value = await api.get(props.strandId)
    state.value = status.value ? 'ready' : 'unavailable'
  } catch { state.value = 'error' }
}
async function toggle() {
  if (!status.value || saving.value || props.disabled) return
  const next = !status.value.enabled
  saving.value = true
  saveError.value = false
  try {
    const result = await api.set(props.strandId, next)
    if (result) status.value = result
    else status.value = { ...status.value, enabled: next }
    announce.value = t(next ? 'eco.turnedOn' : 'eco.turnedOff')
  } catch { saveError.value = true }
  finally { saving.value = false }
}
const saved = computed(() => ecoSavedPercent(status.value?.last ?? null))
const budgetLabel = computed(() => {
  const budget = status.value?.inputBudgetTokens
  return typeof budget === 'number' ? t('eco.budget', { tokens: `~${Math.round(budget / 1000)}k` }) : null
})
watch(() => props.strandId, () => { void load() })
onMounted(() => { void load() })
</script>

<template>
  <div v-if="state !== 'unavailable'" class="flex min-w-0 flex-wrap items-center gap-2" data-testid="eco-mode">
    <p v-if="state === 'loading'" role="status" class="text-sm text-muted-foreground">{{ t('eco.loading') }}</p>
    <p v-else-if="state === 'error'" role="alert" class="flex flex-wrap items-center gap-2 text-sm">
      {{ t('eco.loadError') }}
      <Button class="min-h-11" variant="outline" type="button" @click="load">{{ t('strandDetail.retry') }}</Button>
    </p>
    <template v-else-if="status">
      <Button class="min-h-11" variant="ghost" type="button" role="switch" data-testid="eco-toggle"
        :aria-checked="status.enabled" :disabled="saving || disabled" :aria-describedby="`eco-hint-${strandId}`" @click="toggle">
        {{ t('eco.label') }}: {{ t(status.enabled ? 'eco.on' : 'eco.off') }}
      </Button>
      <span :id="`eco-hint-${strandId}`" class="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <template v-if="status.enabled">
          <span v-if="budgetLabel">{{ budgetLabel }}</span>
          <span v-if="status.contextFallback"> · {{ t('eco.fallback') }}</span>
          <span v-if="status.observedContextLimitTokens" data-testid="eco-observed"> · {{ t('eco.observed', { limit: status.observedContextLimitTokens }) }}</span>
          <span v-if="saved !== null"> · {{ t('eco.saved', { percent: saved }) }}</span>
          <span v-else> · {{ t('eco.noData') }}</span>
          <span v-if="status.last?.degraded" class="font-medium text-foreground" data-testid="eco-degraded"> · {{ t('eco.degraded') }}</span>
        </template>
        <template v-else>{{ t('eco.hint') }}</template>
      </span>
      <p v-if="saveError" role="alert" class="text-sm">{{ t('eco.saveError') }}</p>
      <span class="sr-only" role="status" aria-live="polite">{{ announce }}</span>
    </template>
  </div>
</template>
