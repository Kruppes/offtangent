<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useCapturesApi, type CaptureResult, type CaptureInput, type ApplyCaptureInput, type UploadDescriptor, type ClientPersona, newestDecision } from '~/api/captures'
import { useNowApi, type NowSet, type NowStrand } from '~/api/now'
import { useModelsApi, type SelectableModel } from '~/api/models'
import CaptureDecision from './CaptureDecision.vue'
const api = useCapturesApi()
const nowApi = useNowApi()
const modelsApi = useModelsApi()

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const attachments = ref<UploadDescriptor[]>([])
const uploading = ref(false)
const busy = ref(false)
const error = ref('')
const errorDetail = ref('')
const sending = ref(false)
const refreshing = ref(false)
const resolved = ref<Record<string, NowStrand>>({})
const projects = ref<Record<string, string>>({})
const notice = ref('')
const latest = ref<CaptureResult | null>(null)
const tray = ref<CaptureResult[]>([])
const loading = ref(true)
const loadError = ref(false)
const now = ref<NowSet | null>(null)
const candidates = ref<NowStrand[]>([])
const target = ref('')
const replaceId = ref('')
const models = ref<SelectableModel[]>([])
const personas = ref<ClientPersona[]>([])
const agentId = ref('')
const modelKey = ref('')
const optionsError = ref(false)
const more = ref(false)
const offset = ref(0)
// Preserve the key for an identical retry after a lost response; changed drafts get a new key.
let pending: { signature: string; key: string } | null = null
const canSend = computed(() => !!text.value.trim() && text.value.trim().length <= 20000 && !busy.value && !uploading.value)
const available = computed(() => candidates.value.filter(s => !now.value?.strands.some(n => n.id === s.id)))
function strandTitle(id?: string | null) {
  return [...(now.value?.strands ?? []), ...candidates.value].find(s => s.id === id)?.title || (id ? resolved.value[id]?.title : undefined)
}
function titleFor(result: CaptureResult) {
  return strandTitle(result.capture.strandId || result.decision.strandId || result.decision.createdStrandId)
}
async function resolveTitles() {
  const results = [...tray.value, ...(latest.value ? [latest.value] : [])]
  const ids = new Set(results.flatMap(r => [r.capture.strandId, r.decision.strandId, r.decision.createdStrandId, ...r.decision.alternatives.map(a => a.strandId)]).filter((id): id is string => !!id))
  await Promise.all([...ids].filter(id => !strandTitle(id)).map(async id => {
    try { resolved.value[id] = await nowApi.strand(id) } catch { /* Deleted/inaccessible destination: keep the proposal label. */ }
  }))
}
async function loadOptions() {
  optionsError.value = false
  await Promise.all([
    modelsApi.listModels().then(v => { models.value = v }).catch(() => { optionsError.value = true }),
    api.personas().then(v => { personas.value = v }).catch(() => { optionsError.value = true }),
  ])
}
async function loadTray(append = false) {
  const next = append ? offset.value + 50 : 0
  const pages = await Promise.all((['unsorted', 'needs_review', 'failed'] as const).map(status => api.list(status, next)))
  const items = pages.flatMap(p => p.captures.flatMap(capture => {
    const decision = newestDecision(capture.id, p.decisions)
    return decision ? [{ capture, decision }] : []
  }))
  tray.value = append ? [...tray.value, ...items] : items
  await resolveTitles()
  offset.value = next
  more.value = pages.some(p => p.captures.length === 50)
}
async function load() {
  loading.value = true; loadError.value = false
  try { await Promise.all([loadTray(), nowApi.get().then(v => { now.value = v }), nowApi.candidates().then(v => { candidates.value = v }), nowApi.projects().then(v => { projects.value = Object.fromEntries(v.map(p => [p.id, p.name])) })]) }
  catch { loadError.value = true }
  finally { loading.value = false }
}
async function loadMore() {
  busy.value = true; errorDetail.value = ''; error.value = ''
  try { await loadTray(true) } catch { error.value = 'capture.loadError' } finally { busy.value = false }
}
async function send() {
  if (!canSend.value) return
  busy.value = true; sending.value = true; error.value = ''; errorDetail.value = ''; notice.value = ''
  const model = models.value.find(m => JSON.stringify([m.providerId, m.modelId]) === modelKey.value)
  const draft = { text: text.value.trim(), source: 'web' as const, attachments: attachments.value, ...(agentId.value ? { agentId: agentId.value } : {}), ...(model ? { modelProviderId: model.providerId, modelId: model.modelId } : {}) }
  const signature = JSON.stringify(draft)
  if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
  try {
    latest.value = await api.create({ ...draft, clientMessageId: pending.key } satisfies CaptureInput)
    sending.value = false; refreshing.value = true
    text.value = ''; attachments.value = []; pending = null
    await load()
    await resolveTitles()
  } catch { error.value = 'capture.sendError' }
  finally { busy.value = false; sending.value = false; refreshing.value = false }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  uploading.value = true; error.value = ''; errorDetail.value = ''
  try { attachments.value.push(...await api.upload(files)) }
  catch (e) {
    errorDetail.value = e instanceof Error ? e.message : ''
    const status = (e as { status?: number }).status
    error.value = status === 413 ? 'capture.uploadTooLarge' : status === 507 ? 'capture.uploadStorage' : status === 400 ? 'capture.uploadLimit' : 'capture.uploadError'
  } finally { uploading.value = false }
}
async function act(result: CaptureResult, body?: ApplyCaptureInput) {
  if (busy.value) return
  busy.value = true; errorDetail.value = ''; error.value = ''; notice.value = ''
  try {
    latest.value = body ? await api.apply(result.capture.id, body) : await api.undo(result.capture.id)
    if (!body) notice.value = latest.value.capture.status === 'unsorted' ? 'capture.undone' : 'capture.undoAfterAnswer'
    await load()
  } catch { error.value = 'capture.actionError' }
  finally { busy.value = false }
}
/** Throw a tray card away; the notice carries the undo, the card keeps it too. */
async function discard(result: CaptureResult) {
  if (busy.value) return
  busy.value = true; errorDetail.value = ''; error.value = ''; notice.value = ''
  try {
    latest.value = await api.dismiss(result.capture.id)
    notice.value = 'capture.discarded'
    await load()
  } catch { error.value = 'capture.actionError' }
  finally { busy.value = false }
}
async function changeNow(ids: string[]) {
  if (busy.value) return
  busy.value = true; errorDetail.value = ''; error.value = ''
  try { now.value = await nowApi.replace(ids); target.value = ''; replaceId.value = '' }
  catch { error.value = 'capture.nowError'; try { now.value = await nowApi.get() } catch { /* retain last known data */ } }
  finally { busy.value = false }
}
function addNow() {
  if (!now.value || !target.value) return
  const ids = now.value.strands.map(s => s.id)
  if (replaceId.value) ids.splice(ids.indexOf(replaceId.value), 1, target.value)
  else ids.push(target.value)
  if (ids.length <= now.value.max) void changeNow(ids)
}
onMounted(() => {
  void load(); void loadOptions()
  if (typeof window !== 'undefined' && window.matchMedia?.('(min-width: 768px) and (pointer: fine)').matches) textarea.value?.focus()
})
</script>
<template>
  <main class="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6">
    <header><h1 class="text-2xl font-semibold">{{ $t('capture.title') }}</h1><p class="mt-1 text-muted-foreground">{{ $t('capture.subtitle') }}</p></header>
    <form class="space-y-3 rounded-xl border bg-card p-4" @submit.prevent="send">
      <label for="capture-text" class="block font-medium">{{ $t('capture.prompt') }}</label>
      <textarea id="capture-text" ref="textarea" v-model="text" :disabled="busy" rows="4" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 w-full resize-y rounded-md border border-input bg-background p-3" :placeholder="$t('capture.placeholder')" @keydown="(e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); send() } }" />
      <p class="text-sm text-muted-foreground">{{ $t('capture.textLimit', { count: text.length }) }}</p>
      <div class="flex flex-wrap gap-3">
        <label class="flex min-w-0 flex-1 flex-col gap-1">{{ $t('capture.persona') }}<select v-model="agentId" :disabled="busy" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-11 max-w-full rounded-md border border-input bg-background px-2"><option value="">{{ $t('capture.automatic') }}</option><option v-for="p in personas" :key="p.id" :value="p.id">{{ p.displayName }}</option></select></label>
        <label class="flex min-w-0 flex-1 flex-col gap-1">{{ $t('capture.model') }}<select v-model="modelKey" :disabled="busy" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-11 max-w-full rounded-md border border-input bg-background px-2"><option value="">{{ $t('capture.automatic') }}</option><option v-for="m in models" :key="JSON.stringify([m.providerId, m.modelId])" :value="JSON.stringify([m.providerId, m.modelId])" :disabled="!m.selectable">{{ m.providerName }} · {{ m.displayName }}</option></select></label>
      </div>
      <p v-if="optionsError" role="alert">{{ $t('capture.optionsError') }} <Button variant="outline" type="button" class="min-h-11 border rounded-md px-3" @click="loadOptions">{{ $t('common.retry') }}</Button></p>
      <ul v-if="attachments.length" class="flex flex-wrap gap-2"><li v-for="(file, i) in attachments" :key="file.relativePath" class="flex max-w-full items-center gap-2 rounded-md bg-muted pl-3"><span class="break-all">{{ file.originalName }}</span><Button variant="outline" type="button" class="min-h-11 min-w-11 px-3" :disabled="busy || uploading" :aria-label="$t('capture.removeFile', { name: file.originalName })" @click="attachments.splice(i, 1)">×</Button></li></ul>
      <label class="block">{{ $t('capture.attach') }}<input type="file" multiple class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 block min-h-11 w-full py-2 text-sm file:min-h-11 file:rounded-md file:border file:bg-muted file:px-3 file:text-foreground" :disabled="busy || uploading" @change="upload" /></label>
      <p class="text-sm text-muted-foreground">{{ $t('capture.uploadPolicy') }}</p>
      <p v-if="uploading" role="status">{{ $t('capture.uploading') }}</p>
      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" data-testid="send" class="min-h-11 rounded-md bg-primary px-5 text-primary-foreground disabled:opacity-50" :disabled="!canSend">{{ $t(sending ? 'capture.sending' : 'capture.send') }}</Button>
        <span class="text-sm text-muted-foreground">{{ $t('capture.shortcut') }}</span>
      </div>
    </form>
    <p v-if="sending || refreshing" role="status">{{ $t(sending ? 'capture.routingWait' : 'capture.refreshing') }}</p>
    <p v-if="error" role="alert" class="rounded-md border border-destructive p-3">{{ $t(error) }} <span v-if="errorDetail">{{ errorDetail }}</span></p>
    <p v-if="notice" role="status" class="rounded-md bg-muted p-3">{{ $t(notice) }}</p>
    <section v-if="latest" aria-live="polite" class="space-y-2"><h2 class="font-semibold">{{ $t('capture.latest') }}</h2><CaptureDecision :result="latest" :strand-title="titleFor(latest)" :title-for-id="strandTitle" :busy="busy" @undo="act(latest!)" @apply="act(latest!, $event)" @dismiss="discard(latest!)" /></section>
    <div v-if="loading" role="status" class="space-y-4" data-testid="skeleton"><span class="sr-only">{{ $t('common.loading') }}</span><div v-for="i in 3" :key="i" class="h-24 animate-pulse rounded-xl bg-muted" /></div>
    <section v-else-if="loadError" role="alert" class="rounded-xl border p-4"><p>{{ $t('capture.loadError') }}</p><Button variant="outline" class="mt-2 min-h-11 rounded-md border px-3" @click="load">{{ $t('common.retry') }}</Button></section>
    <template v-else>
      <section class="space-y-3" data-testid="now">
        <h2 class="text-lg font-semibold">{{ $t('capture.now') }} <span v-if="now" class="text-sm text-muted-foreground">{{ now.strands.length }} / {{ now.max }}</span></h2>
        <p v-if="!now?.strands.length" class="text-muted-foreground">{{ $t('capture.nowEmpty') }}</p>
        <ul v-else class="space-y-2"><li v-for="s in now.strands" :key="s.id" class="flex items-center justify-between gap-2 rounded-xl border bg-card p-3"><NuxtLink :to="`/strands/${encodeURIComponent(s.id)}`" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 flex min-h-11 min-w-0 flex-col justify-center break-words"><span>{{ s.title || $t('capture.untitled') }}</span><span class="text-sm text-muted-foreground">{{ (s.projectId && projects[s.projectId]) || $t('capture.noProject') }}</span><time v-if="s.lastActivity" :datetime="s.lastActivity" class="text-sm text-muted-foreground">{{ $t('capture.lastActivity') }} {{ new Date(s.lastActivity).toLocaleString() }}</time></NuxtLink><Button variant="outline" class="min-h-11 shrink-0 rounded-md border px-3" :disabled="busy" :aria-label="$t('capture.removeNow', { name: s.title || $t('capture.untitled') })" @click="changeNow(now!.strands.filter(n => n.id !== s.id).map(n => n.id))">{{ $t('capture.remove') }}</Button></li></ul>
        <div v-if="now" class="flex flex-wrap gap-2">
          <label class="w-full min-w-0 sm:w-auto sm:flex-1">{{ $t('capture.target') }}<select v-model="target" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 block min-h-11 w-full rounded-md border border-input bg-background px-2" :disabled="busy"><option value="">{{ $t('capture.chooseStrand') }}</option><option v-for="s in available" :key="s.id" :value="s.id">{{ s.title || $t('capture.untitled') }}</option></select></label>
          <label class="w-full min-w-0 sm:w-auto sm:flex-1">{{ $t('capture.replace') }}<select v-model="replaceId" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 block min-h-11 w-full rounded-md border border-input bg-background px-2" :disabled="busy"><option value="">{{ $t('capture.add') }}</option><option v-for="s in now.strands" :key="s.id" :value="s.id">{{ s.title || $t('capture.untitled') }}</option></select></label>
          <Button variant="outline" class="min-h-11 self-end rounded-md border px-3" :disabled="busy || !target || (!replaceId && now.strands.length >= now.max) || now.strands.length > now.max" @click="addNow">{{ $t('capture.updateNow') }}</Button>
          <Button variant="outline" v-if="now.strands.length" class="min-h-11 self-end rounded-md border px-3" :disabled="busy" @click="changeNow([])">{{ $t('capture.clearNow') }}</Button>
        </div>
        <p v-if="now && now.strands.length >= now.max" class="text-sm text-muted-foreground">{{ $t('capture.nowFull') }}</p>
      </section>
      <section class="space-y-3"><h2 class="text-lg font-semibold">{{ $t('capture.unsorted') }}</h2><p class="text-sm text-muted-foreground">{{ $t('capture.trayHelp') }}</p><p v-if="!tray.length" class="rounded-xl border p-6 text-muted-foreground">{{ $t('capture.empty') }}</p><CaptureDecision v-for="item in tray" :key="item.capture.id" :result="item" :strand-title="titleFor(item)" :title-for-id="strandTitle" :busy="busy" @undo="act(item)" @apply="act(item, $event)" @dismiss="discard(item)" /><Button variant="outline" v-if="more" class="min-h-11 rounded-md border px-3" :disabled="busy" @click="loadMore">{{ $t('capture.more') }}</Button></section>
    </template>
  </main>
</template>
