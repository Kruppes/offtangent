<template>
  <div v-if="attachments?.length" :class="containerClass">
    <div
      v-for="attachment in attachments"
      :key="attachment.relativePath"
      :class="mediaOf(attachment) === 'image' ? 'group relative overflow-hidden rounded-lg' : ''"
      :data-attachment-media="mediaOf(attachment)"
    >
      <!-- Image: inline, opens in the lightbox. -->
      <template v-if="mediaOf(attachment) === 'image'">
        <button
          type="button"
          class="block w-full rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          :aria-label="$t('w4b.media.openImage', { name: attachment.originalName })"
          data-lightbox-open
          @click="lightbox = attachment"
        >
          <img
            :src="resolveUrl(attachment.urlPath)"
            :alt="attachment.originalName"
            loading="lazy"
            class="block max-h-72 rounded-lg object-contain"
          />
        </button>
        <!-- Hover overlay with actions -->
        <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 rounded-b-lg bg-gradient-to-t from-black/60 via-black/30 to-transparent px-2.5 pb-2 pt-8 opacity-0 transition-opacity duration-200 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          <span class="truncate text-xs text-white/90">{{ attachment.originalName }}</span>
          <div class="flex shrink-0 items-center gap-1">
            <a
              :href="resolveUrl(attachment.urlPath)"
              target="_blank"
              rel="noopener"
              class="flex h-7 w-7 items-center justify-center rounded-md bg-white/15 text-white/90 backdrop-blur-sm transition-colors hover:bg-white/25"
              :title="$t('chat.attachments.openOriginal')"
              :aria-label="$t('chat.attachments.openOriginal')"
            >
              <AppIcon name="externalLink" :size="14" />
            </a>
            <a
              :href="resolveUrl(attachment.urlPath, true)"
              class="flex h-7 w-7 items-center justify-center rounded-md bg-white/15 text-white/90 backdrop-blur-sm transition-colors hover:bg-white/25"
              :title="$t('chat.attachments.download')"
              :aria-label="$t('chat.attachments.download')"
            >
              <AppIcon name="download" :size="14" />
            </a>
          </div>
        </div>
      </template>

      <!-- Audio: the shared player (one sound at a time, no autoplay). A
           recording on a user message is the kept dictation. -->
      <VoiceNoteBubble
        v-else-if="mediaOf(attachment) === 'audio'"
        :url="attachment.urlPath"
        :kind="isDictation(attachment, role) ? 'dictation' : 'file'"
        :name="isDictation(attachment, role) ? '' : attachment.originalName"
      />

      <!-- Video: native controls, metadata only, never autoplay. -->
      <figure v-else-if="mediaOf(attachment) === 'video'" class="w-full max-w-md">
        <video
          class="block max-h-80 w-full rounded-lg bg-black"
          :src="resolveUrl(attachment.urlPath)"
          controls
          preload="metadata"
          playsinline
          :aria-label="attachment.originalName"
          data-attachment-video
        />
        <figcaption class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span class="min-w-0 truncate">{{ attachment.originalName }}</span>
          <span class="tabular-nums">{{ formatBytes(attachment.size) }}</span>
          <a :href="resolveUrl(attachment.urlPath, true)" class="ml-auto inline-flex min-h-11 items-center gap-1 rounded-md px-2 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary pointer-fine:min-h-8">
            <AppIcon name="download" :size="14" />{{ $t('chat.attachments.download') }}
          </a>
        </figcaption>
      </figure>

      <!-- PDF: a card first; the preview loads only on request, in an
           <object> whose fallback offers open and download. -->
      <div v-else-if="mediaOf(attachment) === 'pdf'" class="w-full max-w-xl rounded-lg border border-border bg-muted/30" data-attachment-pdf>
        <div class="flex items-center gap-3 px-3 py-2">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <AppIcon name="file" class="h-4 w-4 text-muted-foreground" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-foreground">{{ attachment.originalName }}</p>
            <p class="text-xs tabular-nums text-muted-foreground">PDF · {{ formatBytes(attachment.size) }}</p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1">
          <button
            type="button"
            class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:min-h-8"
            :aria-expanded="pdfOpen.has(attachment.relativePath)"
            data-pdf-toggle
            @click="togglePdf(attachment.relativePath)"
          >
            <AppIcon :name="pdfOpen.has(attachment.relativePath) ? 'eyeOff' : 'eye'" :size="14" />
            {{ pdfOpen.has(attachment.relativePath) ? $t('w4b.media.hidePreview') : $t('w4b.media.showPreview') }}
          </button>
          <a :href="resolveUrl(attachment.urlPath)" target="_blank" rel="noopener" class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:min-h-8">
            <AppIcon name="externalLink" :size="14" />{{ $t('chat.attachments.openOriginal') }}
          </a>
          <a :href="resolveUrl(attachment.urlPath, true)" class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:min-h-8">
            <AppIcon name="download" :size="14" />{{ $t('chat.attachments.download') }}
          </a>
        </div>
        <object
          v-if="pdfOpen.has(attachment.relativePath)"
          :data="resolveUrl(attachment.urlPath)"
          type="application/pdf"
          class="block h-[28rem] max-h-[70dvh] w-full rounded-b-lg border-t border-border bg-background"
          :aria-label="attachment.originalName"
          data-pdf-preview
        >
          <p class="p-3 text-sm text-muted-foreground">{{ $t('w4b.media.pdfFallback') }}</p>
        </object>
      </div>

      <!-- Any other file: a download card. -->
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

    <!-- Lightbox: one image, full size, Escape / close button / overlay. -->
    <DialogRoot :open="!!lightbox" @update:open="value => { if (!value) lightbox = null }">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-scrim" />
        <DialogContent
          class="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-overlay focus:outline-none sm:inset-6"
          data-lightbox
        >
          <div class="flex shrink-0 items-center gap-1 border-b border-border py-1 pl-4 pr-1">
            <DialogTitle class="min-w-0 flex-1 truncate text-sm font-medium">{{ lightbox?.originalName }}</DialogTitle>
            <DialogDescription class="sr-only">{{ $t('w4b.media.lightboxHint') }}</DialogDescription>
            <a v-if="lightbox" :href="resolveUrl(lightbox.urlPath)" target="_blank" rel="noopener" class="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary" :aria-label="$t('chat.attachments.openOriginal')">
              <AppIcon name="externalLink" size="sm" />
            </a>
            <a v-if="lightbox" :href="resolveUrl(lightbox.urlPath, true)" class="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary" :aria-label="$t('chat.attachments.download')">
              <AppIcon name="download" size="sm" />
            </a>
            <DialogClose class="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary" :aria-label="$t('common.close')">
              <AppIcon name="close" size="sm" />
            </DialogClose>
          </div>
          <div class="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-2">
            <img v-if="lightbox" :src="resolveUrl(lightbox.urlPath)" :alt="lightbox.originalName" class="max-h-full max-w-full object-contain" />
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>

<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import VoiceNoteBubble from './audio/VoiceNoteBubble.vue'
import type { ChatAttachment } from '~/composables/useChat'
import { attachmentMedia, isDictation, type AttachmentMedia } from '~/utils/attachmentMedia'

const props = defineProps<{
  attachments: ChatAttachment[]
  /** Role of the message; an audio file on a user message is its dictation. */
  role?: string
}>()

const config = useRuntimeConfig()
const { getAccessToken } = useAuth()

const lightbox = ref<ChatAttachment | null>(null)
const pdfOpen = ref(new Set<string>())

function mediaOf(attachment: ChatAttachment): AttachmentMedia {
  return attachmentMedia(attachment)
}

function togglePdf(key: string) {
  const next = new Set(pdfOpen.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  pdfOpen.value = next
}

const imageCount = computed(() => props.attachments.filter(a => a.kind === 'image').length)

const containerClass = computed(() => {
  if (imageCount.value >= 2 && imageCount.value === props.attachments.length) {
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
