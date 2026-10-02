<template>
  <!-- W5b "Fork here": branches the strand at this message into a new strand
       (POST /api/strands/:id/fork) and opens it. The agent does not start;
       the new strand holds the message as its seed. -->
  <span class="inline-flex flex-wrap items-center gap-1" data-message-fork>
    <button
      type="button"
      class="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 pointer-fine:min-h-8"
      data-action="fork"
      :disabled="state === 'loading'"
      :aria-busy="state === 'loading'"
      :aria-label="$t('fork.actionLabel')"
      @click="fork"
    >
      <AppIcon :name="state === 'loading' ? 'loader' : 'gitBranch'" size="sm" :class="state === 'loading' ? 'motion-safe:animate-spin' : ''" />
      <span>{{ state === 'loading' ? $t('fork.working') : $t('fork.action') }}</span>
    </button>
    <span v-if="state === 'error'" role="alert" class="text-sm text-destructive" data-fork-error>{{ errorText }}</span>
    <span class="sr-only" role="status" aria-live="polite">{{ state === 'done' ? $t('fork.done') : '' }}</span>
  </span>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ApiError } from '~/composables/useApi'
import { useStrandW5bApi } from '~/api/strandW5b'

const props = defineProps<{ strandId: string; messageId: number }>()
const { t } = useI18n()
const router = useRouter()
const api = useStrandW5bApi()
const state = ref<'idle' | 'loading' | 'error' | 'done'>('idle')
const errorText = ref('')

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return t('fork.errorRate')
    if (error.status === 409) return t('fork.errorArchived')
    if (error.status === 404) return t('fork.errorNotFound')
    if (error.status === 0) return t('fork.errorOffline')
  }
  return t('fork.error')
}

/**
 * W6b: this button unmounts with the old strand. Put the keyboard focus on
 * the composer of the new strand (where the next step happens), falling back
 * to the main landmark, instead of leaving it on <body>.
 */
function focusNewStrand(tries = 20) {
  if (typeof document === 'undefined') return
  const field = document.querySelector<HTMLElement>('#main-content textarea:not([disabled])')
  if (field) { field.focus(); return }
  if (tries > 0) { requestAnimationFrame(() => focusNewStrand(tries - 1)); return }
  document.getElementById('main-content')?.focus()
}

async function fork() {
  if (state.value === 'loading') return
  state.value = 'loading'
  errorText.value = ''
  try {
    const result = await api.fork(props.strandId, props.messageId)
    state.value = 'done'
    await router.push(`/strands/${encodeURIComponent(result.strandId)}`)
    focusNewStrand()
  } catch (error) {
    errorText.value = messageFor(error)
    state.value = 'error'
  }
}
</script>
