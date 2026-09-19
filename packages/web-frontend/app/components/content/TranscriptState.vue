<template>
  <div v-if="state === 'error'" role="alert" class="flex flex-1 flex-col items-center justify-center gap-3 text-center" data-transcript-state="error">
    <p class="text-sm text-muted-foreground">{{ $t('threads.historyErrorDescription') }}</p>
    <button type="button" class="min-h-11 rounded-md border border-border px-4 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" @click="$emit('retry')">{{ $t('common.refresh') }}</button>
  </div>
  <div v-else-if="state === 'loading'" role="status" :aria-label="$t('w4Content.loading')" class="space-y-3" data-transcript-state="loading">
    <span class="sr-only">{{ $t('w4Content.loading') }}</span>
    <div class="h-4 w-48 animate-pulse rounded bg-muted" aria-hidden="true" />
    <div class="h-4 w-64 max-w-full animate-pulse rounded bg-muted" aria-hidden="true" />
  </div>
  <div v-else-if="state === 'empty'" class="flex flex-1 items-center justify-center text-sm text-muted-foreground" data-transcript-state="empty">{{ $t('chat.noMessages') }}</div>
  <slot v-else />
</template>
<script setup lang="ts">
defineProps<{ state: 'error' | 'loading' | 'empty' | 'ready' }>()
defineEmits<{ retry: [] }>()
</script>
