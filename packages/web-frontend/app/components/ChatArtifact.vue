<template>
  <section ref="container" class="my-3 overflow-hidden rounded-lg border border-border bg-background">
    <header class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <h3 class="min-w-0 flex-1 truncate text-sm font-medium">{{ detail?.artifact.title ?? title ?? $t('chat.artifact.title') }}</h3>
      <button v-if="document" type="button" class="min-h-[44px] rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" @click="fullscreen">
        {{ $t('chat.artifact.fullscreen') }}
      </button>
      <a v-if="downloadUrl" :href="downloadUrl" :download="filename" class="inline-flex min-h-[44px] items-center rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
        {{ $t('chat.attachments.download') }}
      </a>
    </header>
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
import { useArtifactsApi, type ArtifactDetail } from '~/api/artifacts'

const props = defineProps<{ artifactId: string; title?: string }>()
const { loadArtifact } = useArtifactsApi()
const container = ref<HTMLElement | null>(null)
const detail = ref<ArtifactDetail | null>(null)
const document = ref('')
const downloadUrl = ref('')
const error = ref<string | null>(null)
let generation = 0
const filename = computed(() => `${(detail.value?.artifact.title ?? 'artifact').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 60)}.${detail.value?.artifact.kind ?? 'html'}`)

function revokeDownload() {
  if (downloadUrl.value) URL.revokeObjectURL(downloadUrl.value)
  downloadUrl.value = ''
}

watch(() => props.artifactId, async id => {
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
