<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useVoiceRepliesApi } from '../voiceRepliesApi'
import { createVoiceReplies, type VoiceRepliesController } from '../voiceReplies'

/**
 * Per-user voice-replies switch (GET/PUT /api/speech/voice-replies). It is
 * not part of the shared settings form: it belongs to the signed-in account
 * and saves on change, with its own loading, error and success state.
 * `controller` exists for tests; the page creates its own.
 */
const props = defineProps<{ controller?: VoiceRepliesController }>()
const { enabled, state, saving, feedback, load, toggle, dispose } = props.controller ?? createVoiceReplies(useVoiceRepliesApi())

onMounted(() => { if (state.value === 'loading') void load() })
onBeforeUnmount(dispose)
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="settings-voice-replies">
    <div v-if="state === 'loading'" class="rounded-lg border border-border px-4 py-3" aria-busy="true">
      <Skeleton class="mb-2 h-4 w-32" />
      <Skeleton class="h-3 w-64 max-w-full" />
    </div>
    <div v-else-if="state === 'error'" role="alert" class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 px-4 py-3">
      <span class="text-sm text-foreground">{{ $t('settings.voiceReplies.loadFailed') }}</span>
      <Button type="button" variant="outline" class="min-h-11" @click="load">
        <AppIcon name="retry" size="sm" />
        {{ $t('settings.retry') }}
      </Button>
    </div>
    <div v-else class="flex min-h-11 items-center justify-between rounded-lg border border-border px-4 py-3">
      <div class="flex flex-col gap-1 pr-4">
        <Label for="voice-replies-enabled" class="cursor-pointer">{{ $t('settings.voiceReplies.label') }}</Label>
        <p id="voice-replies-hint" class="measure text-help text-muted-foreground">{{ $t('settings.voiceReplies.hint') }}</p>
      </div>
      <Switch
        id="voice-replies-enabled"
        name="voice-replies-enabled"
        :checked="enabled"
        :disabled="saving"
        aria-describedby="voice-replies-hint"
        @update:checked="toggle"
      />
    </div>
    <p v-if="feedback === 'saved'" role="status" aria-live="polite" class="text-xs text-success" data-testid="voice-replies-saved">
      {{ $t('settings.voiceReplies.saved') }}
    </p>
    <p v-else-if="feedback === 'failed'" role="alert" class="text-xs text-destructive" data-testid="voice-replies-failed">
      {{ $t('settings.voiceReplies.saveFailed') }}
    </p>
  </div>
</template>
