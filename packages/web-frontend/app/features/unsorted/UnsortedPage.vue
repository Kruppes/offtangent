<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useCapturesApi, type CaptureResult, type ApplyCaptureInput, type CapturePart } from '~/api/captures'
import { useNowApi, type NowStrand } from '~/api/now'
import CaptureDecision from '~/features/capture/components/CaptureDecision.vue'
import CaptureParts from '~/features/capture/components/CaptureParts.vue'
import { isSplit, trayItems, trayTotal, TRAY_PAGE_SIZE, TRAY_STATUSES } from '~/features/capture/captureParts'

/**
 * The unsorted tray as its own page (the app's Unsorted screen): every capture
 * the router was unsure about, with apply, choose, discard, undo, and per part
 * keep / move / keep as one for split captures. The last decision stays on
 * screen with its undo, so nothing vanishes without a way back.
 */
const api = useCapturesApi()
const nowApi = useNowApi()
const tray = ref<CaptureResult[]>([])
const candidates = ref<NowStrand[]>([])
const resolved = ref<Record<string, NowStrand>>({})
const loading = ref(true)
const loadError = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const last = ref<CaptureResult | null>(null)
const more = ref(false)
/** Exact tray size from the backend (`total`), null for an older backend. */
const totalCount = ref<number | null>(null)
const offset = ref(0)

function strandTitle(id?: string | null) {
  if (!id) return undefined
  return candidates.value.find(s => s.id === id)?.title || resolved.value[id]?.title || undefined
}
function titleFor(result: CaptureResult) {
  return strandTitle(result.capture.strandId || result.decision.strandId || result.decision.createdStrandId)
}
const moveTargets = computed(() => candidates.value.map(s => ({ id: s.id, title: s.title })))
async function resolveTitles(results: CaptureResult[]) {
  const ids = new Set(results.flatMap(r => [r.capture.strandId, r.decision.strandId, r.decision.createdStrandId, ...r.decision.alternatives.map(a => a.strandId), ...(r.parts ?? []).map(p => p.decision.strandId)]).filter((id): id is string => !!id))
  await Promise.all([...ids].filter(id => !strandTitle(id)).map(async id => {
    try { resolved.value[id] = await nowApi.strand(id) } catch { /* A deleted destination keeps its proposal label. */ }
  }))
}
async function loadPage(append: boolean) {
  const next = append ? offset.value + 50 : 0
  const pages = await Promise.all(TRAY_STATUSES.map(status => api.list(status, next)))
  const items = trayItems(pages)
  const merged = append ? [...tray.value, ...items.filter(item => !tray.value.some(t => t.capture.id === item.capture.id))] : items
  await resolveTitles([...items, ...(last.value ? [last.value] : [])])
  tray.value = merged
  offset.value = next
  more.value = pages.some(p => p.captures.length === TRAY_PAGE_SIZE)
  totalCount.value = trayTotal(pages)
}
async function load() {
  loading.value = true; loadError.value = false
  try {
    await Promise.all([loadPage(false), nowApi.candidates().then(v => { candidates.value = v }).catch(() => { candidates.value = [] })])
  } catch { loadError.value = true }
  finally { loading.value = false }
}
async function loadMore() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await loadPage(true) } catch { error.value = 'unsorted.loadError' } finally { busy.value = false }
}
/** Every write ends the same way: show its result with undo, then reload the tray. */
async function run(action: () => Promise<CaptureResult>, message: string) {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    last.value = await action()
    notice.value = message
    await loadPage(false)
  } catch { error.value = 'capture.actionError' }
  finally { busy.value = false }
}
function apply(item: CaptureResult, body: ApplyCaptureInput) { void run(() => api.apply(item.capture.id, body), 'unsorted.applied') }
function dismiss(item: CaptureResult) { void run(() => api.dismiss(item.capture.id), 'capture.discarded') }
function undo(item: CaptureResult) { void run(() => api.undo(item.capture.id), 'unsorted.undone') }
function keepPart(item: CaptureResult, part: CapturePart) { void run(() => api.apply(item.capture.id, { decisionId: part.decision.id, partIndex: part.index }), 'home.parts.kept') }
function movePart(item: CaptureResult, part: CapturePart, strandId: string) { void run(() => api.apply(item.capture.id, { decisionId: part.decision.id, action: 'append', strandId, partIndex: part.index }), 'home.parts.moved') }
function undoPart(item: CaptureResult, part: CapturePart) { void run(() => api.undo(item.capture.id, part.index), 'home.parts.undone') }
function keepAsOne(item: CaptureResult) { void run(() => api.keepAsOne(item.capture.id), 'home.parts.keptAsOne') }
onMounted(load)
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
    <header>
      <h1 class="text-xl font-bold tracking-tight md:hidden">{{ $t('unsorted.title') }}</h1>
      <p class="mt-1 text-muted-foreground md:hidden">{{ $t('unsorted.subtitle') }}</p>
    </header>
    <p v-if="error" role="alert" class="rounded-md border border-destructive p-3">{{ $t(error) }}</p>
    <p v-if="notice" role="status" class="rounded-md bg-muted p-3">{{ $t(notice) }}</p>
    <section v-if="last" aria-live="polite" class="space-y-2" data-testid="unsorted-last">
      <h2 class="font-semibold">{{ $t('unsorted.lastDecision') }}</h2>
      <CaptureDecision :result="last" :strand-title="titleFor(last)" :title-for-id="strandTitle" :busy="busy" @undo="undo(last!)" @apply="apply(last!, $event)" @dismiss="dismiss(last!)" />
    </section>
    <div v-if="loading" role="status" class="space-y-4" data-testid="skeleton"><span class="sr-only">{{ $t('common.loading') }}</span><div v-for="i in 3" :key="i" aria-hidden="true" class="h-24 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" /></div>
    <section v-else-if="loadError" role="alert" class="rounded-xl border p-4">
      <p>{{ $t('unsorted.loadError') }}</p>
      <Button variant="outline" class="mt-2 min-h-11" @click="load">{{ $t('common.retry') }}</Button>
    </section>
    <section v-else-if="!tray.length" class="rounded-xl border p-6 text-left" data-testid="unsorted-empty">
      <p class="font-medium">{{ $t('unsorted.emptyTitle') }}</p>
      <p class="measure mt-1 text-sm text-muted-foreground">{{ $t('unsorted.emptyText') }}</p>
      <NuxtLink to="/" class="mt-3 inline-flex min-h-11 items-center rounded-md border px-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ $t('unsorted.toHome') }}</NuxtLink>
    </section>
    <section v-else class="space-y-3" :aria-label="$t('unsorted.listLabel', { count: tray.length })">
      <h2 class="sr-only">{{ $t('unsorted.listLabel', { count: tray.length }) }}</h2>
      <p class="text-sm text-muted-foreground" role="status">{{ $t('unsorted.count', { count: totalCount ?? (more ? `${tray.length}+` : tray.length) }) }}</p>
      <CaptureDecision v-for="item in tray" :key="item.capture.id" :result="item" :strand-title="titleFor(item)" :title-for-id="strandTitle" :busy="busy" @undo="undo(item)" @apply="apply(item, $event)" @dismiss="dismiss(item)">
        <CaptureParts v-if="isSplit(item)" :result="item" :busy="busy" :strands="moveTargets" :title-for-id="strandTitle" @keep="keepPart(item, $event)" @move="(part, id) => movePart(item, part, id)" @undo="undoPart(item, $event)" @keep-as-one="keepAsOne(item)" />
      </CaptureDecision>
      <Button v-if="more" variant="outline" class="min-h-11" :disabled="busy" @click="loadMore">{{ $t('capture.more') }}</Button>
    </section>
  </div>
</template>
