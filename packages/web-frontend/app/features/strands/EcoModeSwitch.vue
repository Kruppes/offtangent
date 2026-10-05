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
// Per-strand context window (plan 2026-10-05-ollama-native-context). Separate
// from the switch: changing it never toggles Eco and never rewrites history.
const cwSaving = ref(false)
const cwError = ref(false)
const cw = computed(() => status.value?.contextWindow)
async function setContextWindow(event: Event) {
  if (!status.value || !cw.value || cwSaving.value || props.disabled) return
  const raw = (event.target as HTMLSelectElement).value
  const next = raw === '' ? null : Number(raw)
  if (next !== null && !cw.value.presets.includes(next)) return
  cwSaving.value = true
  cwError.value = false
  try {
    const result = await api.setContextWindow(props.strandId, next)
    if (result) status.value = result
    announce.value = t('eco.cwSaved')
  } catch { cwError.value = true }
  finally { cwSaving.value = false }
}
const kLabel = (n: number) => `${Math.round(n / 1024)}k`
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
      <div v-if="cw" class="flex w-full min-w-0 flex-wrap items-center gap-2" data-testid="eco-context-window">
        <label :for="`eco-cw-${strandId}`" class="text-sm">{{ t('eco.cwLabel') }}</label>
        <select :id="`eco-cw-${strandId}`" data-testid="eco-cw-select"
          class="min-h-11 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          :value="cw.choice === null ? '' : String(cw.choice)" :disabled="cwSaving || disabled || !cw.supported || (cw.baselineSource === 'runner_max' && cw.choice === null)"
          :aria-describedby="`eco-cw-hint-${strandId}`" @change="setContextWindow">
          <option value="">{{ t('eco.cwUnchanged') }}</option>
          <option v-for="p in cw.presets" :key="p" :value="String(p)">{{ kLabel(p) }}</option>
        </select>
        <span :id="`eco-cw-hint-${strandId}`" class="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="eco-cw-state">
          {{ t(`eco.cwState.${cw.state}`) }}
          <span v-if="cw.facts === 'pending'"> · {{ t('eco.cwFactsPending') }}</span>
          <span v-if="cw.choice !== null"> · {{ t('eco.cwNotGuaranteed') }}</span>
        </span>
        <span v-if="cw.effective !== undefined" class="text-xs text-muted-foreground" data-testid="eco-cw-effective">
          {{ cw.effective === null ? t('eco.cwEffectiveNone') : t('eco.cwEffective', { tokens: kLabel(cw.effective) }) }}
        </span>
        <span v-if="cw.baseline" class="text-xs text-muted-foreground" data-testid="eco-cw-baseline">
          {{ t('eco.cwBaseline', { tokens: kLabel(cw.baseline), source: t(`eco.cwBaselineSource.${cw.baselineSource ?? 'modelfile'}`) }) }}
        </span>
        <span v-else-if="cw.baseline === null && cw.supported" class="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="eco-cw-baseline-missing">
          {{ t('eco.cwBaselineMissing') }}
        </span>
        <p v-if="cwError" role="alert" class="text-sm">{{ t('eco.cwSaveError') }}</p>
      </div>
      <span class="sr-only" role="status" aria-live="polite">{{ announce }}</span>
    </template>
  </div>
</template>
