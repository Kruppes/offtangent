<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { takeComposerHandoff } from '~/composables/useComposerHandoff'
import { namedPasteFile, pasteIntent } from '~/composables/chat/useFileDrop'
import { useCapturesApi, type CaptureResult, type CaptureInput, type ApplyCaptureInput, type UploadDescriptor, type ClientPersona, initialCapturePersona, captureClientKey } from '~/api/captures'
import { useNowApi, type NowSet, type NowStrand } from '~/api/now'
import { useModelsApi, type SelectableModel } from '~/api/models'
import { useResurfaceApi, type ResurfaceItem } from '~/api/resurface'
import type { CapturePart } from '~/api/captures'
import CaptureDecision from './CaptureDecision.vue'
import CaptureParts from './CaptureParts.vue'
import { daysSince, isSplit, trayItems, trayTotal, TRAY_PAGE_SIZE, TRAY_STATUSES } from '../captureParts'
import { dictationFields } from '../captureDictation'
import { useCaptureDictation } from '../useCaptureDictation'
const api = useCapturesApi()
const nowApi = useNowApi()
const modelsApi = useModelsApi()
const resurfaceApi = useResurfaceApi()

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const attachments = ref<UploadDescriptor[]>([])
const uploading = ref(false)
const fileAnnouncement = ref(0)
const busy = ref(false)
const error = ref('')
const errorDetail = ref('')
const sending = ref(false)
const refreshing = ref(false)
const resolved = ref<Record<string, NowStrand>>({})
const projects = ref<Record<string, string>>({})
const notice = ref('')
const latest = ref<CaptureResult | null>(null)
/**
 * Set by a handoff that promised its own conversation (a question about a news
 * story). It survives until the draft is sent or replaced, and makes the send
 * ask the server for a new strand instead of letting the router pick one.
 */
const handoffTarget = ref<{ title: string | null } | null>(null)
const tray = ref<CaptureResult[]>([])
/** Resurface row: optional, so its failure never blocks Home. */
const resurface = ref<ResurfaceItem[]>([])
const resurfaceError = ref(false)
const snoozing = ref('')
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
const trayTotalCount = ref<number | null>(null)
/**
 * Dictation (W5d): only the transcript is kept, the capture carries the
 * dictation mark (`kind: 'voice'`), the recording is never stored. Hidden
 * entirely while the server has no STT configured.
 */
const {
  sttEnabled, fetchSttSettings, phase: dictationPhase, error: dictationError, canRetry: dictationCanRetry,
  elapsedMs: dictationElapsed, levels: dictationLevels, busy: dictationBusy, dictated, announcement: dictationAnnouncement,
  micLabel, toggle: toggleDictation, finish: finishDictation, retry: retryDictation, cancel: cancelDictation, dismiss: dismissDictation,
  handleKeydown: handleDictationKeydown,
} = useCaptureDictation(text, textarea)
// Preserve the key for an identical retry after a lost response; changed drafts get a new key.
let pending: { signature: string; key: string } | null = null
/**
 * Auto mode: the server ranks the now set from the user's own activity, so the
 * Add/Replace/Remove/Clear controls have nothing to write (`PUT /api/now`
 * answers 409). One hint line takes their place. A backend without `mode`
 * behaves as before (manual).
 */
const nowAuto = computed(() => now.value?.mode === 'auto')
// A running dictation blocks the send: its words would land in an emptied box.
const canSend = computed(() => !!text.value.trim() && text.value.trim().length <= 20000 && !busy.value && !uploading.value && !dictationBusy.value)
const available = computed(() => candidates.value.filter(s => !now.value?.strands.some(n => n.id === s.id)))
function strandTitle(id?: string | null) {
  return [...(now.value?.strands ?? []), ...candidates.value].find(s => s.id === id)?.title || (id ? resolved.value[id]?.title : undefined)
}
function titleFor(result: CaptureResult) {
  return strandTitle(result.capture.strandId || result.decision.strandId || result.decision.createdStrandId)
}
async function resolveTitles() {
  const results = latest.value ? [latest.value] : []
  const ids = new Set(results.flatMap(r => [r.capture.strandId, r.decision.strandId, r.decision.createdStrandId, ...r.decision.alternatives.map(a => a.strandId)]).filter((id): id is string => !!id))
  await Promise.all([...ids].filter(id => !strandTitle(id)).map(async id => {
    try { resolved.value[id] = await nowApi.strand(id) } catch { /* Deleted/inaccessible destination: keep the proposal label. */ }
  }))
}
async function loadOptions() {
  optionsError.value = false
  await Promise.all([
    modelsApi.listModels().then(v => { models.value = v }).catch(() => { optionsError.value = true }),
    // The picker starts at the server's capture default (W6b); a choice the
    // user already made before the list arrived is kept.
    api.personaOptions().then(v => {
      personas.value = v.personas
      if (!agentId.value) agentId.value = initialCapturePersona(v)
    }).catch(() => { optionsError.value = true }),
  ])
}
/**
 * Home only counts the tray; deciding happens on /unsorted. The count stops
 * at one page per status, `more` turns it into "50+" unless the backend sends
 * the exact `total`.
 */
async function loadTray() {
  const pages = await Promise.all(TRAY_STATUSES.map(status => api.list(status, 0)))
  tray.value = trayItems(pages)
  more.value = pages.some(p => p.captures.length === TRAY_PAGE_SIZE)
  trayTotalCount.value = trayTotal(pages)
}
async function loadResurface() {
  resurfaceError.value = false
  try { resurface.value = await resurfaceApi.list(3) } catch { resurface.value = []; resurfaceError.value = true }
}
async function snooze(item: ResurfaceItem) {
  if (snoozing.value) return
  snoozing.value = item.strandId; notice.value = ''; error.value = ''
  try {
    await resurfaceApi.snooze(item.strandId, 7)
    resurface.value = resurface.value.filter(entry => entry.strandId !== item.strandId)
    notice.value = 'home.resurface.snoozed'
  } catch { error.value = 'home.resurface.snoozeError' }
  finally { snoozing.value = '' }
}
async function load() {
  loading.value = true; loadError.value = false
  void loadResurface()
  try { await Promise.all([loadTray(), nowApi.get().then(v => { now.value = v }), nowApi.candidates().then(v => { candidates.value = v }), nowApi.projects().then(v => { projects.value = Object.fromEntries(v.map(p => [p.id, p.name])) })]) }
  catch { loadError.value = true }
  finally { loading.value = false }
}
/**
 * Home keeps no audio: after a failed transcription only a copy in this tab
 * waits for the next attempt, so the chat wording ("the recording is kept")
 * would promise too much here.
 */
const DICTATION_ERROR_KEYS = { transcribe_error: 'capture.dictation.errors.transcribe_error', offline: 'capture.dictation.errors.offline' } as const
async function send() {
  if (!canSend.value) return
  busy.value = true; sending.value = true; error.value = ''; errorDetail.value = ''; notice.value = ''
  const model = models.value.find(m => JSON.stringify([m.providerId, m.modelId]) === modelKey.value)
  const draft = { text: text.value.trim(), source: 'web' as const, attachments: attachments.value, ...dictationFields(dictated.value), ...(agentId.value ? { agentId: agentId.value } : {}), ...(model ? { modelProviderId: model.providerId, modelId: model.modelId } : {}), ...(handoffTarget.value ? { destination: 'new_strand' as const, ...(handoffTarget.value.title ? { strandTitle: handoffTarget.value.title } : {}) } : {}) }
  const signature = JSON.stringify(draft)
  try {
    if (pending?.signature !== signature) pending = { signature, key: captureClientKey() }
    latest.value = await api.create({ ...draft, clientMessageId: pending.key } satisfies CaptureInput)
    sending.value = false; refreshing.value = true
    text.value = ''; attachments.value = []; fileAnnouncement.value = 0; pending = null; handoffTarget.value = null
    if (latest.value?.code === 'routing_pending') notice.value = 'capture.routingPending'
    await load()
    await resolveTitles()
  } catch { error.value = 'capture.sendError' }
  finally { busy.value = false; sending.value = false; refreshing.value = false }
}
async function uploadFiles(files: File[], pasted = false) {
  if (!files.length || busy.value || uploading.value) return
  uploading.value = true; error.value = ''; errorDetail.value = ''; fileAnnouncement.value = 0
  try {
    attachments.value.push(...await api.upload(files))
    if (pasted) fileAnnouncement.value = files.length
  } catch (e) {
    errorDetail.value = e instanceof Error ? e.message : ''
    const status = (e as { status?: number }).status
    error.value = status === 413 ? 'capture.uploadTooLarge' : status === 507 ? 'capture.uploadStorage' : status === 400 ? 'capture.uploadLimit' : 'capture.uploadError'
  } finally { uploading.value = false }
}
function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  return uploadFiles(files)
}
function handlePaste(event: ClipboardEvent) {
  const intent = pasteIntent(event.clipboardData)
  if (intent.kind !== 'files') return
  event.preventDefault()
  if (busy.value || uploading.value) return
  void uploadFiles(intent.files.map(namedPasteFile), true)
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
/** One part of a split capture: keep, move, undo; or route the whole text as one. */
async function actPart(run: () => Promise<CaptureResult>, message = '') {
  if (busy.value) return
  busy.value = true; errorDetail.value = ''; error.value = ''; notice.value = ''
  try {
    latest.value = await run()
    notice.value = message
    await load()
    await resolveTitles()
  } catch { error.value = 'capture.actionError' }
  finally { busy.value = false }
}
function keepPart(result: CaptureResult, part: CapturePart) { void actPart(() => api.apply(result.capture.id, { decisionId: part.decision.id, partIndex: part.index }), 'home.parts.kept') }
function movePart(result: CaptureResult, part: CapturePart, strandId: string) { void actPart(() => api.apply(result.capture.id, { decisionId: part.decision.id, action: 'append', strandId, partIndex: part.index }), 'home.parts.moved') }
function undoPart(result: CaptureResult, part: CapturePart) { void actPart(() => api.undo(result.capture.id, part.index), 'home.parts.undone') }
function keepAsOne(result: CaptureResult) { void actPart(() => api.keepAsOne(result.capture.id), 'home.parts.keptAsOne') }
const moveTargets = computed(() => [...(now.value?.strands ?? []), ...candidates.value.filter(c => !now.value?.strands.some(n => n.id === c.id))].map(s => ({ id: s.id, title: s.title })))
const trayCount = computed(() => trayTotalCount.value !== null ? String(trayTotalCount.value) : more.value ? `${tray.value.length}+` : String(tray.value.length))
function resurfaceAge(item: ResurfaceItem) { return daysSince(item.lastActivity, Date.now()) ?? 0 }
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
/**
 * A screen that handed something to the composer ("Use in question" on a news
 * story) put the text in the handoff; it is taken exactly once and lands in
 * the box unsent, with the cursor at its end so the reader's question goes
 * below the snapshot.
 */
function applyHandoff() {
  const handoff = takeComposerHandoff()
  if (!handoff) return
  text.value = handoff.text
  handoffTarget.value = handoff.newStrand ? { title: handoff.title } : null
  notice.value = handoff.newStrand ? 'capture.contextAddedNewStrand' : 'capture.contextAdded'
  void nextTick(() => {
    const element = textarea.value
    // Guarded: under SSR and in the unit renderer this is not a DOM node.
    if (!element || typeof element.focus !== 'function') return
    element.focus()
    element.selectionStart = element.selectionEnd = element.value.length
    element.scrollTop = element.scrollHeight
  })
}
onMounted(() => {
  void load(); void loadOptions(); void fetchSttSettings()
  applyHandoff()
  if (!text.value && typeof window !== 'undefined' && window.matchMedia?.('(min-width: 768px) and (pointer: fine)').matches) textarea.value?.focus()
})
</script>
<template>
  <div class="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6">
    <header><h1 class="text-2xl font-semibold">{{ $t('capture.title') }}</h1><p class="measure mt-1 text-muted-foreground">{{ $t('capture.subtitle') }}</p></header>
    <form class="space-y-3 rounded-xl border bg-card p-4" @submit.prevent="send" @keydown="handleDictationKeydown">
      <label for="capture-text" class="block font-medium">{{ $t('capture.prompt') }}</label>
      <textarea id="capture-text" ref="textarea" v-model="text" :disabled="busy" rows="4" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 w-full resize-y rounded-md border border-input bg-background p-3" :placeholder="$t('capture.placeholder')" @paste="handlePaste" @keydown="(e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); send() } }" />
      <DictationBar
        v-if="sttEnabled && dictationPhase !== 'idle'"
        :phase="dictationPhase"
        :elapsed-ms="dictationElapsed"
        :levels="dictationLevels"
        :error="dictationError"
        :can-retry="dictationCanRetry"
        :error-keys="DICTATION_ERROR_KEYS"
        @cancel="cancelDictation"
        @finish="finishDictation"
        @retry="retryDictation"
        @dismiss="dismissDictation"
      />
      <p class="sr-only" aria-live="polite" data-testid="capture-dictation-announcement">{{ dictationAnnouncement ? $t(dictationAnnouncement) : '' }}</p>
      <p v-if="dictated" data-testid="capture-dictated" class="measure flex items-start gap-2 text-sm text-muted-foreground"><AppIcon name="mic" class="mt-1 shrink-0" aria-hidden="true" /><span>{{ $t('capture.dictation.marked') }}</span></p>
      <p class="sr-only" aria-live="polite">{{ fileAnnouncement ? $t('capture.filesAttached', { count: fileAnnouncement }) : '' }}</p>
      <p class="measure text-sm text-muted-foreground">{{ $t('capture.textLimit', { count: text.length }) }}</p>
      <div class="flex flex-wrap gap-3">
        <label class="flex min-w-0 flex-1 flex-col gap-1">{{ $t('capture.persona') }}<select v-model="agentId" :disabled="busy" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-11 max-w-full rounded-md border border-input bg-background px-2"><option value="">{{ $t('capture.automatic') }}</option><option v-for="p in personas" :key="p.id" :value="p.id">{{ p.displayName }}</option></select></label>
        <label class="flex min-w-0 flex-1 flex-col gap-1">{{ $t('capture.model') }}<select v-model="modelKey" :disabled="busy" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-11 max-w-full rounded-md border border-input bg-background px-2"><option value="">{{ $t('capture.automatic') }}</option><option v-for="m in models" :key="JSON.stringify([m.providerId, m.modelId])" :value="JSON.stringify([m.providerId, m.modelId])" :disabled="!m.selectable">{{ m.providerName }} · {{ m.displayName }}</option></select></label>
      </div>
      <p v-if="optionsError" role="alert">{{ $t('capture.optionsError') }} <Button variant="outline" type="button" class="min-h-11 border rounded-md px-3" @click="loadOptions">{{ $t('common.retry') }}</Button></p>
      <ul v-if="attachments.length" class="flex flex-wrap gap-2"><li v-for="(file, i) in attachments" :key="file.relativePath" class="flex max-w-full items-center gap-2 rounded-md bg-muted pl-3"><span class="break-all">{{ file.originalName }}</span><Button variant="outline" type="button" class="min-h-11 min-w-11 px-3" :disabled="busy || uploading" :aria-label="$t('capture.removeFile', { name: file.originalName })" @click="attachments.splice(i, 1)">×</Button></li></ul>
      <label class="block">{{ $t('capture.attach') }}<input type="file" multiple class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 block min-h-11 w-full py-2 text-base sm:text-sm file:min-h-11 file:rounded-md file:border file:bg-muted file:px-3 file:text-foreground" :disabled="busy || uploading" @change="upload" /></label>
      <p class="measure text-sm text-muted-foreground">{{ $t('capture.uploadPolicy') }}</p>
      <p v-if="uploading" role="status">{{ $t('capture.uploading') }}</p>
      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" data-testid="send" class="min-h-11 rounded-md bg-primary px-5 text-primary-foreground disabled:text-muted-foreground disabled:[&_svg]:text-border disabled:bg-muted" :disabled="!canSend">{{ $t(sending ? 'capture.sending' : 'capture.send') }}</Button>
        <button
          v-if="sttEnabled"
          type="button"
          data-testid="capture-dictation-mic"
          class="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:text-muted-foreground disabled:[&_svg]:text-border"
          :class="dictationPhase === 'recording' || dictationPhase === 'starting'
            ? 'border-destructive bg-destructive/10 text-destructive'
            : dictationPhase === 'transcribing' ? 'border-primary bg-primary-subtle text-primary' : 'border-input bg-background text-foreground hover:bg-muted'"
          :title="$t(micLabel)"
          :aria-label="$t(micLabel)"
          :aria-pressed="dictationPhase === 'recording'"
          :disabled="busy"
          :aria-disabled="dictationPhase === 'transcribing' || dictationPhase === 'starting' ? 'true' : undefined"
          @click="toggleDictation"
        >
          <AppIcon :name="dictationPhase === 'transcribing' ? 'loader' : dictationPhase === 'recording' ? 'square' : 'mic'" :class="dictationPhase === 'transcribing' ? 'motion-safe:animate-spin' : ''" aria-hidden="true" />
          <span>{{ $t(dictationPhase === 'recording' ? 'capture.dictation.stopShort' : 'capture.dictation.startShort') }}</span>
        </button>
        <span class="text-sm text-muted-foreground">{{ $t('capture.shortcut') }}<template v-if="sttEnabled"> · {{ $t('capture.dictation.shortcut') }}</template></span>
      </div>
    </form>
    <p v-if="sending || refreshing" role="status">{{ $t(sending ? 'capture.routingWait' : 'capture.refreshing') }}</p>
    <p v-if="error" role="alert" class="rounded-md border border-destructive p-3">{{ $t(error) }} <span v-if="errorDetail">{{ errorDetail }}</span></p>
    <p v-if="notice" role="status" class="rounded-md bg-muted p-3">{{ $t(notice) }}</p>
    <section v-if="latest" aria-live="polite" class="space-y-2"><h2 class="font-semibold">{{ $t('capture.latest') }}</h2><CaptureDecision :result="latest" :strand-title="titleFor(latest)" :title-for-id="strandTitle" :busy="busy" @undo="act(latest!)" @apply="act(latest!, $event)" @dismiss="discard(latest!)"><CaptureParts v-if="isSplit(latest)" :result="latest" :busy="busy" :strands="moveTargets" :title-for-id="strandTitle" @keep="keepPart(latest!, $event)" @move="(part, id) => movePart(latest!, part, id)" @undo="undoPart(latest!, $event)" @keep-as-one="keepAsOne(latest!)" /></CaptureDecision></section>
    <div v-if="loading" role="status" class="space-y-4" data-testid="skeleton"><span class="sr-only">{{ $t('common.loading') }}</span><div v-for="i in 3" :key="i" class="h-24 animate-pulse rounded-xl bg-muted" /></div>
    <section v-else-if="loadError" role="alert" class="rounded-xl border p-4"><p>{{ $t('capture.loadError') }}</p><Button variant="outline" class="mt-2 min-h-11 rounded-md border px-3" @click="load">{{ $t('common.retry') }}</Button></section>
    <template v-else>
      <section class="space-y-3" data-testid="now">
        <h2 class="text-lg font-semibold">{{ $t('capture.now') }} <span v-if="now" class="text-sm text-muted-foreground">{{ now.strands.length }} / {{ now.max }}</span></h2>
        <p v-if="!now?.strands.length" class="measure text-muted-foreground">{{ $t('capture.nowEmpty') }}</p>
        <ul v-else class="space-y-2"><li v-for="s in now.strands" :key="s.id" class="flex items-center justify-between gap-2 rounded-xl border bg-card p-3"><NuxtLink :to="`/strands/${encodeURIComponent(s.id)}`" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 flex min-h-11 min-w-0 flex-col justify-center break-words"><span>{{ s.title || $t('capture.untitled') }}</span><span class="text-sm text-muted-foreground">{{ (s.projectId && projects[s.projectId]) || $t('capture.noProject') }}</span><time v-if="s.lastActivity" :datetime="s.lastActivity" class="text-sm text-muted-foreground">{{ $t('capture.lastActivity') }} {{ new Date(s.lastActivity).toLocaleString() }}</time></NuxtLink><Button v-if="!nowAuto" variant="outline" class="min-h-11 shrink-0 rounded-md border px-3" :disabled="busy" :aria-label="$t('capture.removeNow', { name: s.title || $t('capture.untitled') })" @click="changeNow(now!.strands.filter(n => n.id !== s.id).map(n => n.id))">{{ $t('capture.remove') }}</Button></li></ul>
        <p v-if="nowAuto" class="measure text-sm text-muted-foreground" data-testid="now-auto-hint">{{ $t('capture.nowAutoHint') }}</p>
        <div v-if="now && !nowAuto" class="flex flex-wrap gap-2">
          <label class="w-full min-w-0 sm:w-auto sm:flex-1">{{ $t('capture.target') }}<select v-model="target" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 block min-h-11 w-full rounded-md border border-input bg-background px-2" :disabled="busy"><option value="">{{ $t('capture.chooseStrand') }}</option><option v-for="s in available" :key="s.id" :value="s.id">{{ s.title || $t('capture.untitled') }}</option></select></label>
          <label class="w-full min-w-0 sm:w-auto sm:flex-1">{{ $t('capture.replace') }}<select v-model="replaceId" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 block min-h-11 w-full rounded-md border border-input bg-background px-2" :disabled="busy"><option value="">{{ $t('capture.add') }}</option><option v-for="s in now.strands" :key="s.id" :value="s.id">{{ s.title || $t('capture.untitled') }}</option></select></label>
          <Button variant="outline" class="min-h-11 self-end rounded-md border px-3" :disabled="busy || !target || (!replaceId && now.strands.length >= now.max) || now.strands.length > now.max" @click="addNow">{{ $t('capture.updateNow') }}</Button>
          <Button v-if="now.strands.length" variant="outline" class="min-h-11 self-end rounded-md border px-3" :disabled="busy" @click="changeNow([])">{{ $t('capture.clearNow') }}</Button>
        </div>
        <p v-if="now && !nowAuto && now.strands.length >= now.max" class="measure text-sm text-muted-foreground">{{ $t('capture.nowFull') }}</p>
      </section>
      <section class="space-y-2" data-testid="unsorted-hint" aria-labelledby="home-unsorted-heading">
        <h2 id="home-unsorted-heading" class="text-lg font-semibold">{{ $t('capture.unsorted') }}</h2>
        <p v-if="!tray.length" class="rounded-xl border p-4 text-muted-foreground">{{ $t('capture.empty') }}</p>
        <NuxtLink v-else to="/unsorted" data-testid="unsorted-link" class="flex min-h-11 items-center justify-between gap-3 rounded-xl border bg-card p-4 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span class="min-w-0">{{ $t('home.unsortedHint', { count: trayCount }) }}</span>
          <span class="shrink-0 rounded-full bg-primary px-2 py-1 text-sm font-semibold text-primary-foreground" aria-hidden="true">{{ trayCount }}</span>
        </NuxtLink>
      </section>
      <section v-if="resurface.length || resurfaceError" class="space-y-2" data-testid="resurface" aria-labelledby="home-resurface-heading">
        <h2 id="home-resurface-heading" class="text-lg font-semibold">{{ $t('home.resurface.title') }}</h2>
        <p v-if="resurfaceError" role="alert" class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{{ $t('home.resurface.error') }} <Button variant="outline" type="button" class="min-h-11" @click="loadResurface">{{ $t('common.retry') }}</Button></p>
        <ul v-else class="space-y-2">
          <li v-for="item in resurface" :key="item.strandId" class="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 [overflow-wrap:anywhere]" data-testid="resurface-item">
            <NuxtLink :to="`/strands/${encodeURIComponent(item.strandId)}`" class="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span class="font-medium">{{ item.title || $t('capture.untitled') }}</span>
              <span class="text-sm text-muted-foreground">{{ $t('home.resurface.ago', { count: resurfaceAge(item) }) }} · {{ $t(`home.resurface.reason.${item.reason}`) }}</span>
            </NuxtLink>
            <Button variant="outline" type="button" class="min-h-11 shrink-0" :disabled="!!snoozing" :aria-label="$t('home.resurface.snoozeLabel', { name: item.title || $t('capture.untitled') })" @click="snooze(item)">{{ $t('home.resurface.snooze') }}</Button>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
