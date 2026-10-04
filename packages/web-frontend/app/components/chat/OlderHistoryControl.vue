<template>
  <div v-if="state !== 'end'" class="flex justify-center">
    <p v-if="state === 'loading'" role="status" class="flex min-h-11 items-center text-xs text-muted-foreground" :data-older-history="state">{{ $t('chat.olderLoading') }}</p>
    <div v-else-if="state === 'error'" role="alert" class="flex flex-col items-center gap-2 text-center" :data-older-history="state">
      <p class="text-xs text-muted-foreground">{{ $t('chat.olderError') }}</p>
      <button type="button" class="min-h-11 rounded-md border border-border px-4 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" @click="$emit('load')">{{ $t('common.refresh') }}</button>
    </div>
    <button v-else type="button" class="min-h-11 rounded-md border border-border px-4 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" :data-older-history="state" @click="$emit('load')">{{ $t('chat.olderLoad') }}</button>
  </div>
</template>

<script setup lang="ts">
import type { OlderHistoryState } from '~/composables/useChat'

/**
 * Top of a strand transcript: loads the next page towards the start of the
 * strand. Hidden once the start is on screen.
 */
defineProps<{ state: OlderHistoryState }>()
defineEmits<{ load: [] }>()
</script>
