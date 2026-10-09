<script setup lang="ts">
/**
 * Eco mode switch of one strand (plan 2026-10-04-eco-implementation).
 * Default off; switching off is the rollback. Hidden while the server does not
 * report an eco status (older server): no switch without effect.
 *
 * Compact header layout (plan 2026-10-06-eco-header): the component renders
 * inline into the header's status row. Compact mode shows an MDI leaf switch
 * and moves the native context picker into its reachable info panel; every long explanation lives in an info
 * panel that is the controls' aria-describedby target, shown on tap/Enter
 * (mobile), on keyboard focus of the info button and as hover `title`.
 * The context-window picker exists only when the server reports the strand's
 * EFFECTIVE model as native Ollama (/api/chat, `supported`), and only for the
 * model the status was read for (`modelKey`): during a model switch it is
 * hidden instead of showing the previous model's state.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ecoSavedPercent, useStrandEcoApi, type StrandEcoStatus } from '~/api/strandEco'

const props = defineProps<{
  strandId: string
  disabled?: boolean
  /** Icon-only status-row control; context settings stay in the info popover. */
  compact?: boolean
  /** Identity of the strand's effective model (provider + model). A change re-reads the status; undefined = not tracked. */
  modelKey?: string | null
}>()
const { t } = useI18n()
const api = useStrandEcoApi()
const status = ref<StrandEcoStatus | null>(null)
const state = ref<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
const saving = ref(false)
const saveError = ref(false)
const announce = ref('')

// Only the newest read may land: a slow answer for the previous model must
// never overwrite (or resurrect) the status of the current one. Writes that
// started before a newer read are dropped as well; that read is fresher.
let seq = 0
const loadedFor = ref<string | null | undefined>(undefined)
const reading = ref(false)
async function load(quiet = false) {
  const mine = ++seq
  const key = props.modelKey
  if (!quiet || !status.value) state.value = 'loading'
  reading.value = true
  try {
    const next = await api.get(props.strandId)
    if (mine !== seq) return
    status.value = next
    loadedFor.value = key
    state.value = next ? 'ready' : 'unavailable'
  } catch {
    if (mine !== seq) return
    // A failed quiet re-read keeps Eco but never the old model's window.
    if (quiet && status.value) { status.value = { ...status.value, contextWindow: undefined }; loadedFor.value = key }
    else state.value = 'error'
  } finally { if (mine === seq) reading.value = false }
}
async function toggle(event?: Event) {
  positionInfo(event)
  if (!status.value || saving.value || props.disabled) return
  const next = !status.value.enabled
  saving.value = true
  saveError.value = false
  const mine = seq
  try {
    const result = await api.set(props.strandId, next)
    // A newer read started meanwhile and may predate this write: read again.
    if (mine !== seq || !status.value) { void load(true); return }
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
// Native Ollama (/api/chat) only, decided by the server for the effective
// model, and only once the status belongs to the current model.
const cw = computed(() => {
  const value = status.value?.contextWindow
  return value && value.supported && !reading.value && loadedFor.value === props.modelKey ? value : undefined
})
async function setContextWindow(event: Event) {
  if (!status.value || !cw.value || cwSaving.value || props.disabled) return
  const raw = (event.target as HTMLSelectElement).value
  const next = raw === '' ? null : Number(raw)
  if (next !== null && (!cw.value.presets.includes(next) || mlxFixed.value)) return
  cwSaving.value = true
  cwError.value = false
  const mine = seq
  try {
    const result = await api.setContextWindow(props.strandId, next)
    if (mine !== seq) { void load(true); return }
    if (result) status.value = result
    announce.value = t('eco.cwSaved')
  } catch { cwError.value = true }
  finally { cwSaving.value = false }
}
// MLX runner (window fixed at the model maximum): a preset can never take
// effect and the server refuses it (400 context_window_runner_fixed), so only
// the reset to "Unverändert" of an older stored choice stays selectable.
const mlxFixed = computed(() => cw.value?.baselineSource === 'runner_max')
// /api/show facts could not be refreshed ('stale': last good facts are used)
// or are not available at all ('failed'). Re-reading the status triggers the
// server's bounded background retry; it never blocks and never guesses.
const factsProblem = computed(() => cw.value?.facts === 'stale' || cw.value?.facts === 'failed' ? cw.value.facts : null)
const recheckBusy = ref(false)
async function recheck() {
  if (recheckBusy.value) return
  recheckBusy.value = true
  const mine = seq
  const before = status.value
  try {
    const next = await api.get(props.strandId)
    // A completed write changes the status object without starting a model read.
    // Never let an older facts recheck undo that newer Eco/context-window choice.
    if (next && mine === seq && status.value === before) status.value = next
  } catch { /* keep the shown state; the hint stays */ }
  finally { recheckBusy.value = false }
}
const kLabel = (n: number) => `${Math.round(n / 1024)}k`
const saved = computed(() => ecoSavedPercent(status.value?.last ?? null))
const budgetLabel = computed(() => {
  const budget = status.value?.inputBudgetTokens
  return typeof budget === 'number' ? t('eco.budget', { tokens: `~${Math.round(budget / 1000)}k` }) : null
})
// A stored choice the server does not send (effective null) is marked as
// inactive: no num_ctx promise for a choice without effect.
const cwInactive = computed(() => !!cw.value && cw.value.choice !== null && cw.value.effective === null)
const cwFixed = computed(() => mlxFixed.value && cw.value?.choice === null)
// Info panels: tap/Enter toggles (mobile and keyboard), Escape closes.
const openInfo = ref<'eco' | 'cw' | null>(null)
const infoPosition = ref({ top: '96px', left: '12px' })
function positionInfo(event?: Event) {
  // Fixed positioning escapes the header's scroll/overflow clipping on phones.
  if (props.compact && typeof HTMLElement !== 'undefined' && event?.currentTarget instanceof HTMLElement) {
    const rect = event.currentTarget.getBoundingClientRect()
    const width = Math.min(272, window.innerWidth * 0.75)
    infoPosition.value = {
      top: `${Math.min(rect.bottom + 4, window.innerHeight * 0.5)}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    }
  }
}
function toggleInfo(which: 'eco' | 'cw', event?: Event) {
  positionInfo(event)
  openInfo.value = openInfo.value === which ? null : which
}
function infoKey(event: KeyboardEvent) { if (event.key === 'Escape') openInfo.value = null }
const ecoInfoText = computed(() => {
  const s = status.value
  if (!s) return ''
  if (!s.enabled) return t('eco.hint')
  const parts = [s.last?.degraded ? t('eco.degraded') : null, budgetLabel.value, s.contextFallback ? t('eco.fallback') : null,
    s.observedContextLimitTokens ? t('eco.observed', { limit: s.observedContextLimitTokens }) : null,
    saved.value !== null ? t('eco.saved', { percent: saved.value }) : t('eco.noData')]
  return parts.filter(Boolean).join(' · ')
})
const idBase = computed(() => `eco-${props.strandId.replace(/[^A-Za-z0-9_-]/g, '_')}`)
watch(() => props.strandId, () => { void load() })
watch(() => props.modelKey, (next, prev) => { if (next !== prev) void load(true) })
onMounted(() => { void load() })
</script>

<template>
  <div v-if="state !== 'unavailable'" :class="compact ? 'relative inline-flex shrink-0 items-center' : 'contents'" data-testid="eco-mode">
    <p v-if="state === 'loading'" role="status" :aria-label="t('eco.loading')" :class="compact ? 'inline-flex h-11 w-11 items-center justify-center text-muted-foreground' : 'px-1 text-sm text-muted-foreground'">
      <span v-if="compact" class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      <template v-else>{{ t('eco.loading') }}</template>
    </p>
    <p v-else-if="state === 'error'" role="alert" class="flex flex-wrap items-center gap-2 text-sm">
      <span :class="compact ? 'sr-only' : ''">{{ t('eco.loadError') }}</span>
      <Button :class="compact ? 'min-h-11 min-w-11 px-1' : 'min-h-11'" :aria-label="`${t('eco.loadError')}, ${t('strandDetail.retry')}`" variant="outline" type="button" @click="load()"><template v-if="compact">!</template><template v-else>{{ t('strandDetail.retry') }}</template></Button>
    </p>
    <template v-else-if="status">
      <!-- Eco switch: one short control, the explanation in the info panel. -->
      <span class="inline-flex items-center gap-1">
        <Button :class="compact ? 'min-h-11 min-w-11 px-1 [&_svg]:size-6' : 'min-h-11'" variant="ghost" type="button" role="switch" data-testid="eco-toggle"
          :aria-label="`${t('eco.label')}: ${t(status.enabled ? 'eco.on' : 'eco.off')}`" :title="ecoInfoText" :aria-checked="status.enabled" :disabled="saving || disabled" :aria-describedby="`${idBase}-info`" @click="toggle">
          <svg v-if="compact" data-testid="eco-leaf" :class="status.enabled ? 'text-green-500' : 'text-muted-foreground'" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M17 8C8 10 5.9 16.17 3.82 21.32L5.71 22L6.66 19.7C7.14 19.87 7.64 20 8 20C19 20 22 3 22 3C21 5 14 5.25 9 6.25C4 7.25 2 11.5 2 13.5C2 15.5 3.75 17.25 3.75 17.25C7 8 17 8 17 8Z" />
            <path v-if="!status.enabled" data-testid="eco-leaf-off" d="M3 3L21 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <template v-else>{{ t('eco.label') }}: {{ t(status.enabled ? 'eco.on' : 'eco.off') }}</template>
        </Button>
        <span v-if="status.enabled && status.last?.degraded && !compact" class="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground" data-testid="eco-degraded">{{ t('eco.degraded') }}</span>
        <button type="button" data-testid="eco-info"
          class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-fine:min-h-8 pointer-fine:min-w-8"
          :aria-label="t('eco.infoEco')" :aria-describedby="`${idBase}-info`" :title="ecoInfoText"
          :aria-expanded="openInfo === 'eco'" :aria-controls="`${idBase}-info`" @click="toggleInfo('eco', $event)" @keydown="infoKey">
          <AppIcon name="info" size="sm" />
        </button>
      </span>
      <p v-if="compact && saveError" role="alert" :style="infoPosition" class="fixed z-40 w-48 rounded-md border border-destructive bg-background p-2 text-sm">{{ t('eco.saveError') }}</p>
      <div data-testid="eco-settings" :style="compact ? infoPosition : undefined" :class="compact ? (openInfo ? 'fixed z-40 flex max-h-[50dvh] w-[min(17rem,75vw)] flex-wrap gap-2 overflow-y-auto rounded-md border border-border bg-background p-2 shadow-lg' : 'hidden') : 'contents'">
      <!-- Context window (native Ollama only): short label + select, details in the info panel. -->
      <span v-if="cw" class="inline-flex min-w-0 items-center gap-1" data-testid="eco-context-window">
        <label :for="cwFixed ? undefined : `${idBase}-cw`" :title="t('eco.cwLabel')" class="text-sm text-muted-foreground">{{ t('eco.cwShort') }}</label>
        <span v-if="cwFixed" :id="`${idBase}-cw`" class="rounded-md bg-muted px-2 py-1 text-sm" data-testid="eco-cw-fixed"
          :aria-describedby="`${idBase}-cw-info`">{{ t('eco.cwFixedShort', { tokens: kLabel(cw.baseline ?? 0) }) }}</span>
        <select v-else :id="`${idBase}-cw`" data-testid="eco-cw-select"
          class="min-h-11 max-w-[9rem] rounded-md border border-input bg-background px-2 text-sm text-foreground pointer-fine:min-h-8"
          :value="cw.choice === null ? '' : String(cw.choice)" :disabled="cwSaving || disabled"
          :aria-describedby="`${idBase}-cw-info`" @change="setContextWindow">
          <option value="">{{ t('eco.cwUnchanged') }}</option>
          <option v-for="p in cw.presets" :key="p" :value="String(p)" :disabled="mlxFixed">{{ kLabel(p) }}</option>
        </select>
        <span v-if="cwInactive" class="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground" data-testid="eco-cw-inactive">{{ t('eco.cwInactive') }}</span>
        <span v-else-if="cw.facts === 'pending'" role="status" class="text-xs text-muted-foreground">{{ t('eco.cwFactsShortPending') }}</span>
        <button type="button" data-testid="eco-cw-info"
          class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-fine:min-h-8 pointer-fine:min-w-8"
          :aria-label="t('eco.infoCw')" :aria-describedby="`${idBase}-cw-info`" :title="t(`eco.cwState.${mlxFixed ? 'runner_fixed' : cw.state}`)"
          :aria-expanded="openInfo === 'cw'" :aria-controls="`${idBase}-cw-info`" @click="toggleInfo('cw', $event)" @keydown="infoKey">
          <AppIcon name="info" size="sm" />
        </button>
      </span>
      <span v-if="cw && factsProblem" class="inline-flex min-w-0 items-center gap-1" data-testid="eco-cw-facts-problem">
        <span role="status" class="text-xs text-foreground">{{ t(`eco.cwFactsShort.${factsProblem}`) }}</span>
        <button type="button" data-testid="eco-cw-recheck"
          class="min-h-11 rounded-md border border-input bg-background px-2 text-sm text-foreground pointer-fine:min-h-8"
          :disabled="recheckBusy" @click="recheck">{{ t('eco.cwRecheck') }}</button>
      </span>
      <p v-if="cw && cwError" role="alert" class="text-sm">{{ t('eco.cwSaveError') }}</p>
      <p v-if="saveError && !compact" role="alert" class="text-sm">{{ t('eco.saveError') }}</p>
      <!-- Info panels: always in the DOM as describedby targets; visible when opened. -->
      <span v-if="cw" :id="`${idBase}-cw-info`" data-testid="eco-cw-info-panel"
        :class="openInfo === 'cw' ? 'block' : 'hidden'"
        class="basis-full rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <span data-testid="eco-cw-state">{{ t(`eco.cwState.${mlxFixed ? 'runner_fixed' : cw.state}`) }}</span>
        <span v-if="cw.facts === 'pending'"> · {{ t('eco.cwFactsPending') }}</span>
        <span v-if="mlxFixed && cw.choice !== null"> · {{ t('eco.cwResetOnly') }}</span>
        <span v-else-if="cw.choice !== null"> · {{ t('eco.cwNotGuaranteed') }}</span>
        <span v-if="cw.effective !== undefined" data-testid="eco-cw-effective"> · {{ cw.effective === null ? t('eco.cwEffectiveNone') : t('eco.cwEffective', { tokens: kLabel(cw.effective) }) }}</span>
        <span v-if="cw.baseline" data-testid="eco-cw-baseline"> · {{ t('eco.cwBaseline', { tokens: kLabel(cw.baseline), source: t(`eco.cwBaselineSource.${cw.baselineSource ?? 'modelfile'}`) }) }}</span>
        <span v-else-if="cw.baseline === null" data-testid="eco-cw-baseline-missing"> · {{ t('eco.cwBaselineMissing') }}</span>
        <span v-if="factsProblem"> · {{ t(factsProblem === 'stale' ? 'eco.cwFactsStale' : 'eco.cwFactsFailed') }}</span>
      </span>
      <span :id="`${idBase}-info`" data-testid="eco-info-panel"
        :class="openInfo === 'eco' ? 'block' : 'hidden'"
        class="basis-full rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{{ ecoInfoText }}</span>
      </div>
      <span class="sr-only" role="status" aria-live="polite">{{ announce }}</span>
    </template>
  </div>
</template>
