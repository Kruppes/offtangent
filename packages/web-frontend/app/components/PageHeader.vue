<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'

/*
 * Responsive page header / toolbar.
 *
 * Desktop:
 *   Renders a horizontal bar directly below the layout header containing
 *   title + optional subtitle on the left and slotted actions on the right.
 *   When no title/subtitle is provided the bar collapses to a slim toolbar
 *   (chat-style). When nothing at all is provided the bar disappears.
 *
 * Mobile (< md):
 *   The bar itself is hidden entirely to avoid a double-header. Any content
 *   inside the `actions` slot is teleported into `#page-toolbar-actions`
 *   in the layout header, so page-specific actions end up next to the
 *   hamburger menu. This keeps a single source of truth per page without
 *   duplicating the slot content (important for stateful children like
 *   Popovers where duplicate rendering would split state).
 */
interface Props {
  title?: string
  subtitle?: string
}

defineProps<Props>()
const slots = useSlots()

const isMobile = useMediaQuery('(max-width: 767px)')

// Teleport target lives in the layout header, which is always mounted
// before any page — safe to teleport as soon as we hit the client.
const teleportReady = ref(false)
onMounted(() => { teleportReady.value = true })
</script>

<template>
  <!--
    Desktop bar. Hidden via `md:` classes on mobile so the slot only
    renders once (teleport is disabled on desktop, so the actions stay
    inline here).

    Layout: [ title/subtitle OR default slot ]   <spacer>   [ actions ]
    The default slot is useful for pages that want free-form left-side
    content instead of a big h1 (e.g. the chat status indicator).
  -->
  <div
    v-if="title || subtitle || slots.default || slots.actions"
    class="hidden shrink-0 border-b border-border px-6 md:block"
    :class="title || subtitle ? 'py-4' : 'py-2'"
  >
    <div class="flex items-center justify-between gap-4">
      <div class="flex min-w-0 items-center gap-3">
        <div v-if="title || subtitle" class="min-w-0">
          <h1 v-if="title" class="text-2xl font-bold tracking-tight text-foreground">{{ title }}</h1>
          <p v-if="subtitle" class="mt-1 text-sm text-muted-foreground">{{ subtitle }}</p>
        </div>
        <!-- Free-form left-side content, desktop-only (never teleported). -->
        <slot />
      </div>
      <Teleport
        v-if="slots.actions && teleportReady"
        to="#page-toolbar-actions"
        :disabled="!isMobile"
      >
        <div class="flex shrink-0 items-center gap-2">
          <slot name="actions" />
        </div>
      </Teleport>
    </div>
  </div>
</template>
