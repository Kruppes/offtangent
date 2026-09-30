<template>
  <div v-if="attachments?.length" :class="containerClass">
    <div
      v-for="attachment in attachments"
      :key="attachment.relativePath"
      :class="attachment.kind === 'image' ? 'group relative overflow-hidden rounded-lg' : ''"
    >
      <!-- Image attachment -->
      <template v-if="attachment.kind === 'image'">
        <a :href="resolveUrl(attachment.urlPath)" target="_blank" rel="noopener" class="block">
          <img
            :src="resolveUrl(attachment.urlPath)"
            :alt="attachment.originalName"
            class="block max-h-72 rounded-lg object-contain"
          />
        </a>
        <!-- Hover overlay with actions -->
        <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 rounded-b-lg bg-gradient-to-t from-black/60 via-black/30 to-transparent px-2.5 pb-2 pt-8 opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100">
          <span class="truncate text-xs text-white/90">{{ attachment.originalName }}</span>
          <div class="flex shrink-0 items-center gap-1">
            <a
              :href="resolveUrl(attachment.urlPath)"
              target="_blank"
              rel="noopener"
              class="flex h-7 w-7 items-center justify-center rounded-md bg-white/15 text-white/90 backdrop-blur-sm transition-colors hover:bg-white/25"
              :title="$t('chat.attachments.openOriginal')"
            >
              <AppIcon name="externalLink" :size="14" />
            </a>
            <a
              :href="resolveUrl(attachment.urlPath, true)"
              class="flex h-7 w-7 items-center justify-center rounded-md bg-white/15 text-white/90 backdrop-blur-sm transition-colors hover:bg-white/25"
              :title="$t('chat.attachments.download')"
            >
              <AppIcon name="download" :size="14" />
            </a>
          </div>
        </div>
      </template>

      <!-- File attachment -->
      <template v-else>
        <a
          :href="resolveUrl(attachment.urlPath, true)"
          class="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 transition-colors hover:bg-muted/60"
        >
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <AppIcon name="file" class="h-4 w-4 text-muted-foreground" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-foreground">{{ attachment.originalName }}</p>
            <p class="text-xs text-muted-foreground">{{ formatBytes(attachment.size) }}</p>
          </div>
          <AppIcon name="download" class="h-4 w-4 shrink-0 text-muted-foreground" />
        </a>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatAttachment } from '~/composables/useChat'

const props = defineProps<{
  attachments: ChatAttachment[]
}>()

const config = useRuntimeConfig()
const { getAccessToken } = useAuth()

const imageCount = computed(() => props.attachments.filter(a => a.kind === 'image').length)

const containerClass = computed(() => {
  if (imageCount.value >= 2) {
    return 'mt-2 grid grid-cols-2 gap-1.5'
  }
  return 'mt-2 flex flex-col gap-1.5'
})

/**
 * /api/uploads requires an access token. <img src> and <a href> cannot send an
 * Authorization header, so the token travels as a query parameter (the backend
 * accepts both). Trade-off accepted for now; signed short-lived upload URLs
 * would be the cleaner fix.
 */
function resolveUrl(urlPath: string, download = false): string {
  const base = `${config.public.apiBase}${urlPath}`
  const params = new URLSearchParams()
  if (download) params.set('download', '1')
  const token = getAccessToken()
  if (token) params.set('token', token)
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
</script>
