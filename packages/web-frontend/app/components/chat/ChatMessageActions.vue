<template>
  <!-- Actions of one answer. Desktop (fine pointer): shown while the row is
       hovered or holds focus; the row keeps its height either way, so nothing
       moves. Touch: always visible, every target 44 px high. -->
  <div
    role="toolbar"
    :aria-label="$t('w4a.actions.label')"
    class="mt-1 flex flex-wrap items-center gap-1 transition-opacity motion-reduce:transition-none pointer-fine:group-hover/msg:opacity-100 pointer-fine:group-focus-within/msg:opacity-100"
    :class="status === 'idle' ? 'pointer-fine:opacity-0' : ''"
    data-message-actions
  >
    <button
      type="button"
      class="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:min-h-8"
      data-action="copy"
      @click="copy"
    >
      <AppIcon :name="status === 'copied' ? 'check' : 'copy'" size="sm" />
      <span>{{ $t('w4a.actions.copy') }}</span>
    </button>
    <!-- W4b docks read-aloud and the audio summary here; a slot without
         content renders nothing, so no dead button ever shows. -->
    <slot />
    <span class="sr-only" role="status" aria-live="polite" data-copy-status>{{ status === 'copied' ? $t('w4a.actions.copied') : status === 'failed' ? $t('w4a.actions.copyFailed') : '' }}</span>
    <span v-if="status !== 'idle'" aria-hidden="true" class="text-sm" :class="status === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
      {{ status === 'copied' ? $t('w4a.actions.copied') : $t('w4a.actions.copyFailed') }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

/** Message actions: copy the answer as Markdown, plus a slot for later actions. */
const props = defineProps<{ markdown: string }>()

const status = ref<'idle' | 'copied' | 'failed'>('idle')
let reset: ReturnType<typeof setTimeout> | undefined

async function copy() {
  clearTimeout(reset)
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(props.markdown)
    status.value = 'copied'
  } catch {
    status.value = 'failed'
  }
  reset = setTimeout(() => { status.value = 'idle' }, 2000)
}

onBeforeUnmount(() => clearTimeout(reset))
</script>
