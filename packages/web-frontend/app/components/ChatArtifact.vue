<template>
  <!-- Inline artifact (W4a): the canvas runs right in the strand, in the same
       sandbox as before (srcdoc + own CSP, scripts only, no shared origin
       with the app). Lazy: the frame mounts when it comes near the
       viewport and is unloaded again far away, so a strand with many
       artifacts never runs many frames. The body has a fixed height in every
       state, so loading never shifts the text around it. Frame without
       shadow, 1 px hairline, container radius. -->
  <section
    ref="container"
    class="my-3 w-full overflow-hidden rounded-lg border border-border bg-background"
    data-artifact-frame
    :data-frame-state="frameState"
    :data-load-state="loadState"
    :aria-label="displayTitle || $t('chat.artifact.title')"
  >
    <header class="flex flex-wrap items-center gap-x-2 border-b border-border px-3 py-1">
      <h3 class="min-w-0 flex-1 truncate text-sm font-semibold">{{ displayTitle || $t('chat.artifact.title') }}</h3>
      <span class="text-xs text-muted-foreground" :title="$t('w4a.artifact.sandboxHint')">{{ $t('w4a.artifact.sandbox') }}</span>
      <!-- Revision switcher: only for an artifact that belongs to a living
           view, and only once the history is known. -->
      <div v-if="revisions.length > 1" class="flex items-center gap-1" role="group" :aria-label="$t('chat.artifact.revisions')">
        <button
          type="button"
          class="min-h-[44px] min-w-[44px] rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          :disabled="!previousRevision"
          :aria-label="$t('chat.artifact.previousRevision')"
          @click="goTo(previousRevision)"
        >&lsaquo;</button>
        <span class="tabular-nums text-xs text-muted-foreground" data-testid="artifact-revision">
          {{ $t('chat.artifact.revisionOf', { revision: activeRevision ?? '?', total: latestRevision }) }}
        </span>
        <button
          type="button"
          class="min-h-[44px] min-w-[44px] rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          :disabled="!nextRevision"
          :aria-label="$t('chat.artifact.nextRevision')"
          @click="goTo(nextRevision)"
        >&rsaquo;</button>
      </div>
      <button
        v-if="sourceText"
        type="button"
        class="min-h-[44px] rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        :aria-expanded="showSource"
        :aria-controls="sourceId"
        data-artifact-source-toggle
        @click="showSource = !showSource"
      >
        {{ showSource ? $t('w4a.artifact.hideSource') : $t('w4a.artifact.showSource') }}
      </button>
      <button v-if="document" type="button" class="min-h-[44px] rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" @click="fullscreen">
        {{ $t('chat.artifact.fullscreen') }}
      </button>
      <a v-if="downloadUrl" :href="downloadUrl" :download="filename" class="inline-flex min-h-[44px] items-center rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
        {{ $t('chat.attachments.download') }}
      </a>
    </header>
    <p v-if="outdated" class="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground" role="status">
      {{ $t('chat.artifact.outdated') }}
      <button type="button" class="min-h-[44px] rounded px-2 underline hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" @click="goTo(revisions[revisions.length - 1])">
        {{ $t('chat.artifact.showLatest') }}
      </button>
    </p>
    <div class="artifact-body relative" :style="{ height: `${FRAME_HEIGHT_PX}px` }" data-artifact-body>
      <div v-if="loadState === 'error'" class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center" role="alert" data-artifact-error>
        <p class="text-sm text-destructive">{{ $t('w4a.artifact.error') }}</p>
        <p v-if="error" class="max-w-full truncate text-xs text-muted-foreground">{{ error }}</p>
        <button
          type="button"
          class="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          data-artifact-retry
          @click="retry"
        >
          <AppIcon name="retry" size="sm" />
          {{ $t('w4a.artifact.retry') }}
        </button>
      </div>
      <iframe
        v-else-if="frameState === 'active' && document"
        :srcdoc="document"
        :title="displayTitle || $t('chat.artifact.title')"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        credentialless
        allow="accelerometer 'none'; camera 'none'; geolocation 'none'; gyroscope 'none'; microphone 'none'; payment 'none'; usb 'none'"
        class="block h-full w-full border-0"
      />
      <div v-else class="flex h-full items-center justify-center gap-2 bg-muted px-4 text-sm text-muted-foreground" role="status" data-artifact-placeholder>
        <AppIcon v-if="loadState === 'loading'" name="loader" size="sm" class="animate-spin motion-reduce:animate-none" />
        <span>{{ loadState === 'loading' ? $t('w4a.artifact.loading') : frameState === 'parked' ? $t('w4a.artifact.paused') : $t('w4a.artifact.placeholder') }}</span>
      </div>
    </div>
    <!-- The source of an inline (fenced) artifact, as plain text: the code
         block is not repeated in the message above. -->
    <pre v-if="sourceText && showSource" :id="sourceId" class="max-h-80 overflow-auto border-t border-border bg-muted px-3 py-2 text-xs" tabindex="0" data-artifact-source><code>{{ sourceText }}</code></pre>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useArtifactsApi, type ArtifactDetail, type ViewRevisionRef } from '~/api/artifacts'
import { FRAME_HEIGHT_PX, FRAME_KEEP_MARGIN_PX, FRAME_MOUNT_MARGIN_PX, nextFrameState, type FrameState } from '~/utils/inlineArtifacts'

/**
 * `viewKey`/`revision`/`latestRevision` come straight off the `ArtifactRef` of
 * the message. They are what makes this card a LIVING view: the same key
 * delivered again is a new revision, and a card that sits on an older one says
 * so and can jump to the newest without leaving the message it belongs to.
 */
const props = defineProps<{
  artifactId: string
  title?: string
  strandId?: string | null
  viewKey?: string | null
  revision?: number | null
  latestRevision?: number | null
  kind?: string
  /** Fenced source of an inline artifact; shown on request, as text. */
  sourceText?: string
}>()
const { loadArtifact, loadStrandViews } = useArtifactsApi()
const container = ref<HTMLElement | null>(null)
const detail = ref<ArtifactDetail | null>(null)
const document = ref('')
const downloadUrl = ref('')
const error = ref<string | null>(null)
/** The revision currently shown; starts at the one the message carries. */
const activeId = ref(props.artifactId)
const revisions = ref<ViewRevisionRef[]>([])
let generation = 0
const sourceId = `artifact-src-${useId()}`
const showSource = ref(false)
/** Lazy window of the frame (see `nextFrameState`). */
const frameState = ref<FrameState>('idle')
/** Bumped by "Reload" to fetch the same id again. */
const attempt = ref(0)
const displayTitle = computed(() => detail.value?.artifact.title ?? props.title ?? '')
const loadState = computed(() => error.value ? 'error' : document.value ? 'ready' : frameState.value === 'idle' ? 'idle' : 'loading')

const activeRevision = computed(() =>
  revisions.value.find(entry => entry.artifactId === activeId.value)?.revision
  ?? detail.value?.artifact.revision
  ?? props.revision
  ?? null)
const latestRevision = computed(() =>
  revisions.value.length > 0
    ? revisions.value[revisions.value.length - 1]!.revision
    : detail.value?.artifact.latestRevision ?? props.latestRevision ?? null)
const outdated = computed(() => {
  const current = activeRevision.value
  const latest = latestRevision.value
  return current !== null && latest !== null && current < latest && revisions.value.length > 1
})
const previousRevision = computed(() => neighbour(-1))
const nextRevision = computed(() => neighbour(1))

function neighbour(step: number): ViewRevisionRef | null {
  const index = revisions.value.findIndex(entry => entry.artifactId === activeId.value)
  if (index < 0) return null
  return revisions.value[index + step] ?? null
}

/** Switching a revision is switching the artifact id — nothing else changes. */
function goTo(entry: ViewRevisionRef | null | undefined) {
  if (!entry || entry.artifactId === activeId.value) return
  activeId.value = entry.artifactId
}
const filename = computed(() => `${(detail.value?.artifact.title ?? 'artifact').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 60)}.${detail.value?.artifact.kind ?? 'html'}`)

function revokeDownload() {
  if (downloadUrl.value) URL.revokeObjectURL(downloadUrl.value)
  downloadUrl.value = ''
}

// The message can be replaced (history reload, edit) — follow it back to the
// revision the row actually carries.
watch(() => props.artifactId, id => { activeId.value = id })

/**
 * The revision history of the view this artifact belongs to. Fetched once per
 * (strand, key): without it the card has no list to page through, and a card
 * that is not part of a view never asks.
 */
watch([() => props.viewKey, () => props.strandId], async ([viewKey, strandId]) => {
  revisions.value = []
  if (!viewKey || !strandId) return
  try {
    const views = await loadStrandViews(strandId)
    revisions.value = views.find(view => view.viewKey === viewKey)?.revisions ?? []
  } catch {
    // A missing history only costs the switcher, never the canvas itself.
    revisions.value = []
  }
}, { immediate: true })

// Fetch on first approach (and again after a revision switch or "Reload"),
// never for a frame that was not near the viewport yet. A parked frame keeps
// its document, so coming back only remounts the sandbox.
watch([activeId, attempt, () => frameState.value !== 'idle'], async ([id, , wanted], previous) => {
  if (!wanted) return
  const sameDocument = previous && previous[0] === id && previous[1] === attempt.value && document.value
  if (sameDocument) return
  const current = ++generation
  revokeDownload()
  document.value = ''
  detail.value = null
  error.value = null
  try {
    const loaded = await loadArtifact(id)
    if (current !== generation) return
    detail.value = loaded.detail
    document.value = loaded.document
    downloadUrl.value = URL.createObjectURL(loaded.blob)
  } catch (err) {
    if (current === generation) error.value = err instanceof Error ? err.message : String(err)
  }
}, { immediate: true })

function retry() {
  error.value = null
  attempt.value++
}

const observers: IntersectionObserver[] = []
onMounted(() => {
  const target = container.value
  if (!target || typeof IntersectionObserver === 'undefined') {
    // No observer (old engine, test DOM): behave like before, run at once.
    frameState.value = 'active'
    return
  }
  // The transcript scrolls inside its own container; margins only work
  // relative to that root, not to the window.
  const root = target.closest<HTMLElement>('[data-transcript-scroll]')
  let near = false
  let keep = false
  const update = () => { frameState.value = nextFrameState(frameState.value, near, keep) }
  const watchMargin = (margin: number, set: (value: boolean) => void) => {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) set(entry.isIntersecting)
      update()
    }, { root, rootMargin: `${margin}px 0px` })
    observer.observe(target)
    observers.push(observer)
  }
  watchMargin(FRAME_MOUNT_MARGIN_PX, value => { near = value })
  watchMargin(FRAME_KEEP_MARGIN_PX, value => { keep = value })
})

async function fullscreen() {
  try { await container.value?.requestFullscreen() }
  catch (err) { error.value = err instanceof Error ? err.message : String(err) }
}

onBeforeUnmount(() => {
  generation++
  revokeDownload()
  for (const observer of observers) observer.disconnect()
})
</script>

<style scoped>
section:fullscreen {
  display: flex;
  flex-direction: column;
}
section:fullscreen .artifact-body {
  flex: 1;
  height: auto !important;
}
</style>
