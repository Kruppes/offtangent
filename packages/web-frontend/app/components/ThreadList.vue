<script setup lang="ts">
import type { Thread } from '~/api/threads'
import type { SessionActivity } from '~/composables/useChat'
import type { ThreadGroup } from '~/features/threads/threadDisplay'

/*
 * The inbox list: loading skeletons, error state with retry, empty state with a
 * call to action, otherwise the grouped rows (pinned first).
 */
defineProps<{
  groups: ThreadGroup[]
  activity: Record<string, SessionActivity>
  loading?: boolean
  error?: string | null
  activeId?: string | null
  editingId?: string | null
}>()

const emit = defineEmits<{
  open: [thread: Thread]
  startRename: [thread: Thread]
  rename: [thread: Thread, title: string]
  cancelRename: []
  pin: [thread: Thread, pinned: boolean]
  archive: [thread: Thread, archived: boolean]
  retry: []
  newThread: []
}>()
</script>

<template>
  <!-- Error state -->
  <div v-if="error && !loading" class="flex flex-col items-center justify-center gap-4 px-4 py-12 text-center">
    <AppIcon name="warning" class="h-9 w-9 text-destructive/70" />
    <div class="max-w-sm space-y-1">
      <p class="text-sm font-semibold text-foreground">{{ $t('threads.errorTitle') }}</p>
      <p class="break-words text-sm text-muted-foreground">{{ error }}</p>
    </div>
    <Button variant="outline" class="min-h-[44px] gap-2" @click="emit('retry')">
      <AppIcon name="refresh" class="h-4 w-4" />
      {{ $t('threads.retry') }}
    </Button>
  </div>

  <!-- Loading skeletons -->
  <div v-else-if="loading && groups.length === 0" class="flex flex-col gap-2">
    <div
      v-for="n in 6"
      :key="n"
      class="flex min-h-[64px] items-start gap-3 rounded-xl border border-border bg-card px-3 py-3"
    >
      <Skeleton class="h-5 w-14 rounded-full" />
      <div class="flex-1 space-y-2">
        <Skeleton class="h-4 w-1/2" />
        <Skeleton class="h-3 w-4/5" />
      </div>
      <Skeleton class="h-4 w-8" />
    </div>
  </div>

  <!-- Empty state -->
  <div v-else-if="groups.length === 0" class="flex flex-col items-center justify-center gap-4 px-4 py-14 text-center">
    <AppIcon name="inbox" class="h-10 w-10 text-muted-foreground/40" />
    <div class="max-w-sm space-y-1">
      <p class="text-sm font-semibold text-foreground">{{ $t('threads.emptyTitle') }}</p>
      <p class="text-sm text-muted-foreground">{{ $t('threads.emptyDescription') }}</p>
    </div>
    <Button class="min-h-[44px] gap-2" @click="emit('newThread')">
      <AppIcon name="add" class="h-4 w-4" />
      {{ $t('threads.newThread') }}
    </Button>
  </div>

  <!-- Rows -->
  <div v-else class="flex flex-col gap-5">
    <section v-for="group in groups" :key="group.key" class="flex flex-col gap-2">
      <h2 class="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ group.key === 'pinned' ? $t('threads.groupPinned') : $t('threads.groupRecent') }}
      </h2>
      <ThreadRow
        v-for="thread in group.threads"
        :key="thread.id"
        :thread="thread"
        :activity="activity[thread.id]"
        :active="thread.id === activeId"
        :editing="thread.id === editingId"
        @open="emit('open', $event)"
        @start-rename="emit('startRename', $event)"
        @rename="(t, title) => emit('rename', t, title)"
        @cancel-rename="emit('cancelRename')"
        @pin="(t, pinned) => emit('pin', t, pinned)"
        @archive="(t, archived) => emit('archive', t, archived)"
      />
    </section>
  </div>
</template>
