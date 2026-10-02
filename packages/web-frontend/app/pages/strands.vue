<script setup lang="ts">
/**
 * Strand workspace. `/strands` without an open strand is the full-width
 * overview (W4d): large search, filter chips, sort, time groups, wide rows.
 * `/strands/:id` shrinks the same list to the 304 px side column next to the
 * conversation and the dock (W3/W4c); on the phone the strand replaces the
 * list. Both routes are children of this page, so the list (and what it has
 * loaded) is not re-mounted when a strand opens or closes, and the overview's
 * URL query stays on in the side column.
 *
 * The overview <-> strand change is animated by
 * `plugins/strandViewTransition.client.ts`; this page only names the
 * conversation column and moves the focus afterwards: into the composer on
 * open, back onto the row of the strand that was open on close.
 */
import StrandList from '~/features/strands/StrandList.vue'
import { useShellLayout } from '~/composables/useShellLayout'
import { onShortcut } from '~/composables/useShortcuts'
import { useChat } from '~/composables/useChat'
import { countLive } from '~/features/threads/taskActivity'
import { LIST_WIDTH, listMode, visiblePanes } from '~/utils/shellLayout'
import { overviewQueryOf } from '~/utils/strandOverview'
import { stepIndex } from '~/utils/shortcuts'

const route = useRoute()
const shell = useShellLayout()
const { sessionActivity, strandTasks } = useChat()
const activeId = computed(() => (typeof route.params.id === 'string' ? route.params.id : null))
const panes = computed(() => visiblePanes(shell.tier.value, activeId.value !== null))
const mode = computed(() => listMode(shell.tier.value, activeId.value !== null))
const compactList = computed(() => mode.value === 'side')
const listEl = ref<HTMLElement | null>(null)
const liveTasks = computed(() => Object.fromEntries(Object.entries(strandTasks.value).map(([id, state]) => [id, countLive(state)])))
const overviewLink = computed(() => ({ path: '/strands', query: overviewQueryOf(route.query) }))

/** The strand that was open last: its overview row morphs back and gets the focus. */
const lastOpenId = ref<string | null>(activeId.value)

function rowLinks(): HTMLElement[] {
  return listEl.value ? [...listEl.value.querySelectorAll<HTMLElement>('[data-testid="strand-row-link"], [data-testid="strand-row"] > a')] : []
}
function step(direction: 1 | -1) {
  const links = rowLinks()
  if (!panes.value.list || !links.length) return false
  const current = links.indexOf(document.activeElement as HTMLElement)
  const active = links.findIndex(link => link.getAttribute('aria-current') === 'page')
  const next = links[stepIndex(current, links.length, direction, active)]
  next?.focus()
  next?.scrollIntoView({ block: 'nearest' })
}
onShortcut('list.next', () => step(1))
onShortcut('list.previous', () => step(-1))
onShortcut('search.focus', () => {
  const input = listEl.value?.querySelector<HTMLInputElement>('input[type="search"]')
  if (!panes.value.list || !input) return false
  input.focus()
  input.select()
})

// Focus after the change. The composer and the rows can appear a frame or two
// later (page suspense, list render), so look for a short while.
function focusWhenThere(find: () => HTMLElement | null | undefined, frames = 30) {
  const attempt = (left: number) => {
    const el = find()
    if (el) { el.focus({ preventScroll: false }); el.scrollIntoView?.({ block: 'nearest' }); return }
    if (left > 0) requestAnimationFrame(() => attempt(left - 1))
  }
  requestAnimationFrame(() => attempt(frames))
}
watch(activeId, (id, previous) => {
  if (id) lastOpenId.value = id
  if (!import.meta.client) return
  if (id && previous === null && shell.tier.value !== 'one') {
    // Opened from the overview: start typing right away. On the phone the
    // keyboard would cover the strand, so the focus stays with the browser.
    focusWhenThere(() => document.querySelector<HTMLElement>('[data-testid="strand-conversation-column"] textarea'))
  }
  else if (id === null && previous) {
    focusWhenThere(() => listEl.value?.querySelector<HTMLElement>(`[data-strand-id="${CSS.escape(previous)}"] [data-testid="strand-row-link"]`))
  }
})
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 overflow-hidden" data-testid="strand-workspace" :data-tier="shell.tier.value" :data-list-mode="mode">
    <section
      v-show="panes.list"
      ref="listEl"
      data-testid="strand-list-column"
      class="flex min-h-0 min-w-0 flex-col overflow-hidden"
      :class="compactList ? 'shrink-0 border-r border-border' : 'flex-1'"
      :style="compactList ? { width: `${LIST_WIDTH}px` } : undefined"
    >
      <!-- No own label: the list inside is the "Strands" region; two equal labels would be two indistinguishable landmarks. -->
      <div v-if="compactList" class="flex min-h-11 items-center gap-1 px-1 pt-2">
        <NuxtLink :to="overviewLink" data-testid="strand-overview-link" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="$t('strandsW4d.backToOverview')" :title="$t('strandsW4d.backToOverview')">
          <AppIcon name="arrowLeft" />
        </NuxtLink>
        <h1 class="text-lg font-semibold">{{ $t('strandsW3.title') }}</h1>
      </div>
      <div v-else class="px-3 pt-3 md:px-6 md:pt-6">
        <h1 class="mx-auto w-full max-w-4xl text-xl font-semibold" data-testid="strand-overview-title">{{ $t('strandsW3.title') }}</h1>
      </div>
      <StrandList :compact="compactList" :active-id="activeId" :activity="sessionActivity" :live-tasks="liveTasks" :morph-id="lastOpenId" />
    </section>
    <div v-if="panes.conversation" class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [view-transition-name:strand-conversation]" data-testid="strand-conversation-column">
      <NuxtPage />
    </div>
  </div>
</template>
