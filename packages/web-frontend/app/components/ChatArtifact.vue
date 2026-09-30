<template>
  <section ref="container" class="my-3 overflow-hidden rounded-lg border border-border bg-background">
    <header class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <h3 class="min-w-0 flex-1 truncate text-sm font-medium">{{ detail?.artifact.title ?? title ?? $t('chat.artifact.title') }}</h3>
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
      <button v-if="document" type="button" class="min-h-[44px] rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" @click="fullscreen">
        {{ $t('chat.artifact.fullscreen') }}
      </button>
      <a v-if="downloadUrl" :href="downloadUrl" :download="filename" class="inline-flex min-h-[44px] items-center rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
        {{ $t('chat.attachments.download') }}
      </a>
    </header>
    <p v-if="outdated" class="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground" role="status">
      {{ $t('chat.artifact.outdated') }}
      <button type="button" class="min-h-[44px] rounded px-2 underline hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" @click="goTo(revisions[revisions.length - 1])">
        {{ $t('chat.artifact.showLatest') }}
      </button>
    </p>
    <p v-if="error" class="px-3 py-2 text-sm text-destructive" role="alert">{{ error }}</p>
    <p v-else-if="!document" class="px-3 py-2 text-sm text-muted-foreground" role="status">{{ $t('common.loading') }}</p>
    <iframe
      v-if="document"
      :srcdoc="document"
      :title="detail?.artifact.title ?? title ?? $t('chat.artifact.title')"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      credentialless
      allow="accelerometer 'none'; camera 'none'; geolocation 'none'; gyroscope 'none'; microphone 'none'; payment 'none'; usb 'none'"
      class="h-[min(60vh,36rem)] w-full border-0"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useArtifactsApi, type ArtifactDetail, type ViewRevisionRef } from '~/api/artifacts'

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

watch(activeId, async id => {
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

async function fullscreen() {
  try { await container.value?.requestFullscreen() }
  catch (err) { error.value = err instanceof Error ? err.message : String(err) }
}

onBeforeUnmount(() => { generation++; revokeDownload() })
</script>

<style scoped>
section:fullscreen {
  display: flex;
  flex-direction: column;
}
section:fullscreen iframe {
  flex: 1;
  height: auto;
}
</style>
