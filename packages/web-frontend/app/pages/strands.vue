<script setup lang="ts">
/**
 * Strand workspace (W3): the list stays on screen while a strand is open
 * (two and three columns), the phone shows the list OR the strand like the
 * app. `/strands` and `/strands/:id` are children of this page, so a direct
 * strand URL, the browser's back button and reloads keep working, and the
 * list is not re-mounted when you switch strands.
 */
import StrandList from '~/features/strands/StrandList.vue'
import { useShellLayout } from '~/composables/useShellLayout'
import { onShortcut } from '~/composables/useShortcuts'
import { useChat } from '~/composables/useChat'
import { LIST_WIDTH, visiblePanes } from '~/utils/shellLayout'
import { stepIndex } from '~/utils/shortcuts'

const route = useRoute()
const shell = useShellLayout()
const { sessionActivity } = useChat()
const activeId = computed(() => (typeof route.params.id === 'string' ? route.params.id : null))
const panes = computed(() => visiblePanes(shell.tier.value, activeId.value !== null))
const compactList = computed(() => shell.tier.value !== 'one')
const listEl = ref<HTMLElement | null>(null)

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
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 overflow-hidden" data-testid="strand-workspace" :data-tier="shell.tier.value">
    <section
      v-show="panes.list"
      ref="listEl"
      data-testid="strand-list-column"
      class="flex min-h-0 min-w-0 flex-col overflow-hidden"
      :class="compactList ? 'shrink-0 border-r border-border' : 'flex-1'"
      :style="compactList ? { width: `${LIST_WIDTH}px` } : undefined"
      :aria-label="$t('strandsW3.title')"
    >
      <h1 class="text-xl font-semibold" :class="compactList ? 'px-3 pt-3 text-lg' : 'px-3 pt-3 md:px-6'">{{ $t('strandsW3.title') }}</h1>
      <StrandList :compact="compactList" :active-id="activeId" :activity="sessionActivity" />
    </section>
    <div v-if="panes.conversation" class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="strand-conversation-column">
      <NuxtPage />
    </div>
  </div>
</template>
