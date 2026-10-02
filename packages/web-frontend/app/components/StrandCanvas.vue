<template>
  <!-- Wide window: the canvas is a side panel, closed it is the same object
       turned 90 degrees (SPEC 2.8). Narrow: it slides down over the chat
       (SPEC 2.9) — the app behaviour, in CSS pixels. -->
  <aside
    v-if="views.length > 0"
    ref="shellEl"
    :class="wide
      ? 'relative flex h-full shrink-0 border-l border-border bg-background'
      : 'absolute inset-x-0 top-0 z-30 flex flex-col border-b border-border bg-background shadow-overlay'"
    :style="shellStyle"
    data-testid="strand-canvas"
    :aria-expanded="isOpen ? 'true' : 'false'"
  >
    <!-- Splitter, wide + open only. Double click resets to the default width. -->
    <div
      v-if="wide && isOpen"
      class="w-2 shrink-0 cursor-col-resize bg-border/40 hover:bg-border"
      role="separator"
      aria-orientation="vertical"
      :aria-label="$t('canvas.resize')"
      data-testid="canvas-splitter"
      @pointerdown="startDrag"
      @dblclick="resetWidth"
    />

    <!-- Closed, wide: 36 px rail on the right edge, title rotated. -->
    <button
      v-if="wide && !isOpen"
      type="button"
      class="flex w-9 flex-col items-center gap-2 py-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="canvas-rail"
      :aria-label="$t('canvas.open')"
      @click="openCanvas()"
    >
      <span v-if="hasUnseen" class="mt-1 h-2 w-2 rounded-full bg-primary" data-testid="canvas-badge" :aria-label="$t('canvas.unseen')" />
      <span class="[writing-mode:vertical-rl] whitespace-nowrap py-2 text-muted-foreground">{{ railTitle }}</span>
      <span aria-hidden="true">&lsaquo;</span>
    </button>

    <!-- Closed, narrow: the handle rail under the strand header. -->
    <button
      v-else-if="!wide && !isOpen"
      type="button"
      class="flex h-9 w-full items-center gap-2 px-3 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="canvas-rail"
      :aria-label="$t('canvas.open')"
      @click="openCanvas()"
    >
      <span v-if="hasUnseen" class="h-2 w-2 rounded-full bg-primary" data-testid="canvas-badge" :aria-label="$t('canvas.unseen')" />
      <span class="min-w-0 flex-1 truncate text-left text-muted-foreground">{{ railTitle }}</span>
      <span aria-hidden="true">&rsaquo;</span>
    </button>

    <div v-else class="flex min-w-0 flex-1 flex-col" data-testid="canvas-open">
      <header class="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 class="min-w-0 flex-1 truncate text-sm font-medium">{{ activeView?.title }}</h2>
        <button
          type="button"
          class="min-h-[44px] rounded px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="$t('canvas.close')"
          data-testid="canvas-close"
          @click="close()"
        >&times;</button>
      </header>

      <div class="min-h-0 flex-1 overflow-auto">
        <ChatArtifact
          v-if="activeArtifactId"
          :key="activeArtifactId"
          :artifact-id="activeArtifactId"
          :title="activeView?.title"
          :strand-id="strandId"
          :view-key="activeView?.viewKey"
          :revision="openRevision"
          :latest-revision="activeView?.latestRevision"
        />
      </div>

      <!-- Tabs stay at the bottom of the panel on both axes (SPEC 2.8). -->
      <nav v-if="views.length > 1" class="flex gap-1 overflow-x-auto border-t border-border px-2 py-1.5" :aria-label="$t('canvas.views')">
        <button
          v-for="view in views"
          :key="view.viewKey"
          type="button"
          class="h-9 shrink-0 rounded-md px-3 text-xs"
          :class="view.viewKey === openViewKey ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'"
          :aria-current="view.viewKey === openViewKey ? 'true' : undefined"
          @click="openCanvas(view.viewKey)"
        >
          <span v-if="unseen.includes(view.viewKey)" class="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle" />
          {{ view.title }}
        </button>
      </nav>
    </div>
  </aside>
</template>

<script setup lang="ts">
/**
 * The canvas shell of one strand (interaction spec 2.8 / 2.9).
 *
 * The component owns the CHROME only — rail, splitter, tabs, badge. What a
 * revision looks like is `ChatArtifact`, unchanged: two renderers of the same
 * sandboxed document would drift in exactly the place where drift is a
 * security bug.
 *
 * The state (which views exist, which one is open, which revisions are unseen)
 * lives in `useStrandCanvas` because the live frame has to reach it whether or
 * not this component is mounted.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ChatArtifact from './ChatArtifact.vue'
import { useArtifactsApi } from '~/api/artifacts'
import { useStrandCanvas } from '~/composables/useStrandCanvas'
import { onShortcut } from '~/composables/useShortcuts'

const props = defineProps<{ strandId: string | null }>()

const DEFAULT_WIDTH = 440
const MIN_WIDTH = 360
const MAX_WIDTH = 720
/** Below this the layout is the narrow one, whatever the panel would like. */
const WIDE_BREAKPOINT = 1024
/** The chat never gets less than this (SPEC 2.8). */
const MIN_CHAT_WIDTH = 420

const { loadStrandViews } = useArtifactsApi()
const canvas = useStrandCanvas(() => props.strandId)
const { views, openViewKey, openRevision, unseen, hasUnseen } = canvas

const width = ref(DEFAULT_WIDTH)
const windowWidth = ref(WIDE_BREAKPOINT)
const isOpen = computed(() => openViewKey.value !== null)
/** Width of the row the canvas shares with the chat (the shell's columns take the rest of the window). */
const rowWidth = ref(WIDE_BREAKPOINT)
const shellEl = ref<HTMLElement | null>(null)
const wide = computed(() => windowWidth.value >= WIDE_BREAKPOINT && rowWidth.value - width.value >= MIN_CHAT_WIDTH)
const activeView = computed(() => views.value.find(view => view.viewKey === openViewKey.value) ?? null)
const railTitle = computed(() => activeView.value?.title ?? views.value[0]?.title ?? '')
const activeArtifactId = computed(() => {
  const view = activeView.value
  if (!view) return null
  const revision = view.revisions.find(entry => entry.revision === openRevision.value)
  return (revision ?? view.revisions[view.revisions.length - 1])?.artifactId ?? null
})
const shellStyle = computed(() => (wide.value && isOpen.value ? { width: `${width.value}px` } : {}))

function openCanvas(viewKey?: string): void {
  const key = viewKey ?? openViewKey.value ?? views.value[0]?.viewKey
  if (key) canvas.open(key)
}

function close(): void {
  canvas.close()
}

function storageKey(): string | null {
  return props.strandId ? `canvas.width` : null
}

function startDrag(event: PointerEvent): void {
  event.preventDefault()
  const startX = event.clientX
  const startWidth = width.value
  const move = (moveEvent: PointerEvent): void => {
    const next = startWidth - (moveEvent.clientX - startX)
    width.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(next)))
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    const key = storageKey()
    if (key) window.localStorage.setItem(key, String(width.value))
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function resetWidth(): void {
  width.value = DEFAULT_WIDTH
  const key = storageKey()
  if (key) window.localStorage.setItem(key, String(DEFAULT_WIDTH))
}

// Ctrl/Cmd + J toggles, Esc closes (SPEC 2.8) — bound through the shell's
// central shortcut composable instead of an own window listener.
onShortcut('canvas.toggle', () => {
  if (!views.value.length) return false
  if (isOpen.value) close()
  else openCanvas()
})
onShortcut('dismiss', () => {
  if (!isOpen.value) return false
  close()
})

async function reload(): Promise<void> {
  if (!props.strandId) {
    canvas.setViews([])
    return
  }
  try {
    canvas.setViews(await loadStrandViews(props.strandId))
  } catch {
    // A canvas that cannot be listed stays empty; the chat is unaffected.
  }
}

function onResize(): void {
  windowWidth.value = window.innerWidth
  rowWidth.value = shellEl.value?.parentElement?.clientWidth ?? window.innerWidth
}
let rowObserver: ResizeObserver | null = null
watch(shellEl, (el) => {
  rowObserver?.disconnect()
  rowObserver = null
  if (!el?.parentElement || typeof ResizeObserver === 'undefined') return
  rowObserver = new ResizeObserver(onResize)
  rowObserver.observe(el.parentElement)
  onResize()
})

onMounted(() => {
  const key = storageKey()
  const stored = key ? Number(window.localStorage.getItem(key)) : NaN
  if (Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH) width.value = stored
  onResize()
  window.addEventListener('resize', onResize)
  void reload()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  rowObserver?.disconnect()
})

watch(() => props.strandId, () => { void reload() })
</script>
