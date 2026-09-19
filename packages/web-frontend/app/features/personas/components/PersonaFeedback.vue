<!--
  The two banners every write surface needs: what went wrong (with a way out)
  and what went right. Split into its own component because the list and the
  editor both need them and an inconsistent error box is how a user learns not
  to trust the screen.

  `role="alert"` on the error, `role="status"` on the success: a failure
  interrupts a screen reader, a confirmation does not.
-->
<template>
  <div v-if="error || success" class="mb-4 flex flex-col gap-2">
    <Alert v-if="error" variant="destructive" role="alert">
      <AlertDescription class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span class="min-w-0 break-words">{{ error }}</span>
        <span class="flex shrink-0 gap-1">
          <Button variant="outline" size="sm" class="min-h-11" @click="emit('retry')">{{ retryLabel }}</Button>
          <button
            type="button"
            class="flex h-11 w-11 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="$t('aria.closeAlert')"
            @click="emit('dismissError')"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </span>
      </AlertDescription>
    </Alert>

    <Alert v-if="success" variant="success" role="status">
      <AlertDescription class="flex items-center justify-between gap-2">
        <span class="min-w-0 break-words">{{ success }}</span>
        <button
          type="button"
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="$t('aria.closeAlert')"
          @click="emit('dismissSuccess')"
        >
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </AlertDescription>
    </Alert>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  error: string | null
  success: string | null
  retryLabel: string
}>()

const emit = defineEmits<{ retry: []; dismissError: []; dismissSuccess: [] }>()
</script>
