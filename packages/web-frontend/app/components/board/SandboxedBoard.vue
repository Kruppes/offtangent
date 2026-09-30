<script setup lang="ts">
/**
 * The frame for every board whose body is a document the SERVER renders:
 * `html_view.v1` (the payload IS the document) and any kind that has a
 * renderer file under `<DATA_DIR>/board-renderers/`. Both arrive the same
 * way — as a `content` block with a URL — so both use this one component; a
 * new board kind needs no new component here.
 *
 * The document runs in an iframe loaded from `/api/boards/:key/content?t=…`.
 * That response carries `Content-Security-Policy: … sandbox allow-scripts`, so
 * the page sits in an opaque origin with no network, no cookies, no storage and
 * no way to navigate the top frame — even if this component forgot an
 * attribute. The `sandbox` attribute here is the second lock, not the only one,
 * and `allow-same-origin` is never part of it.
 *
 * A revision from the history gets its own content URL, so an older revision
 * shows the document as it was published.
 *
 * Links: the document cannot open a window (no `allow-popups`, and it stays
 * that way). The injected bridge posts `offtangent.open-link` to this frame's
 * parent instead, and this component decides — see `boardLinkFromMessage`,
 * which accepts nothing but an http(s) URL from exactly this iframe.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BoardContentRef } from '~/api/boards'
import { HTML_VIEW_ALLOW, HTML_VIEW_SANDBOX, boardLinkFromMessage, htmlViewHeight, htmlViewSrc } from '~/utils/boardHtmlView'
import { useTheme } from '~/composables/useTheme'

const props = defineProps<{ content?: BoardContentRef; title: string; summary: string | null }>()

const { isDark } = useTheme()
const frame = ref<HTMLElement | null>(null)
const iframe = ref<HTMLIFrameElement | null>(null)
const frameWidth = ref(0)
const src = computed(() => htmlViewSrc(props.content, isDark.value))
const height = computed(() => htmlViewHeight(props.content, frameWidth.value))
const sandbox = computed(() => props.content?.embed?.iframeSandbox || HTML_VIEW_SANDBOX)
// The iframe attribute is a fixed union, the board payload only says "string";
// mirror the union locally so the template stays type checked.
type ReferrerPolicyAttr =
  | '' | 'no-referrer' | 'no-referrer-when-downgrade' | 'origin' | 'origin-when-cross-origin'
  | 'same-origin' | 'strict-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url'
const referrerPolicy = computed(
  () => (props.content?.embed?.iframeReferrerPolicy || 'no-referrer') as ReferrerPolicyAttr,
)

let observer: ResizeObserver | null = null

/**
 * The host half of the link bridge. `window.open` runs here, in the app's
 * origin, with `noopener,noreferrer` so the new tab gets no handle back and
 * no referrer. The user gesture propagates from the iframe to this frame, so
 * a real click passes the popup blocker while a scripted one does not.
 */
function onMessage(event: MessageEvent) {
  const url = boardLinkFromMessage(event, iframe.value?.contentWindow, navigator.userActivation)
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  if (!frame.value || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(entries => { frameWidth.value = entries[0]?.contentRect.width ?? 0 })
  observer.observe(frame.value)
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  observer?.disconnect()
  observer = null
})

async function fullscreen() {
  try { await frame.value?.requestFullscreen() } catch { /* a refused request is not an error worth a banner */ }
}
</script>

<template>
  <div class="flex flex-col gap-4 [overflow-wrap:anywhere]">
    <section ref="frame" class="overflow-hidden rounded-lg border bg-card">
      <header class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 class="min-w-0 flex-1 truncate text-sm font-medium">{{ title }}</h2>
        <button v-if="src" type="button" class="min-h-[44px] rounded px-2 text-xs hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" @click="fullscreen">
          {{ $t('boards.htmlView.fullscreen') }}
        </button>
      </header>
      <!--
        `:src`, never `srcdoc`: srcdoc inherits the embedder's CSP and loses the
        header sandbox, which is where the real guarantee lives.
      -->
      <iframe
        v-if="src"
        ref="iframe"
        :key="src"
        :src="src"
        :title="title"
        :sandbox="sandbox"
        :referrerpolicy="referrerPolicy"
        credentialless
        loading="lazy"
        :allow="HTML_VIEW_ALLOW"
        class="w-full border-0 bg-white"
        :style="{ height: `${height}px` }"
      />
      <p v-else class="px-3 py-4 text-sm text-muted-foreground" role="status">{{ $t('boards.htmlView.unavailable') }}</p>
    </section>
    <p v-if="summary" class="text-sm text-muted-foreground">{{ summary }}</p>
  </div>
</template>

<style scoped>
section:fullscreen {
  display: flex;
  flex-direction: column;
}
section:fullscreen iframe {
  flex: 1;
  height: auto !important;
}
</style>
