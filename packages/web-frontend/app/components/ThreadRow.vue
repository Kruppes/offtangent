<script setup lang="ts">
import type { Thread } from '~/api/threads'
import type { SessionActivity } from '~/composables/useChat'
import { formatRelativeTime, threadExcerpt, threadFallbackTitle } from '~/features/threads/threadDisplay'

/*
 * One row of the inbox: persona badge, title (or the excerpt of the last
 * message as fallback), last message excerpt, relative time and the live
 * running/queued indicator of that thread's turn.
 *
 * Renaming happens inline: Enter submits, Escape cancels, and on touch the
 * two icon buttons do the same without a keyboard.
 */
const props = defineProps<{
  thread: Thread
  activity?: SessionActivity
  active?: boolean
  editing?: boolean
}>()

const emit = defineEmits<{
  open: [thread: Thread]
  startRename: [thread: Thread]
  rename: [thread: Thread, title: string]
  cancelRename: []
  pin: [thread: Thread, pinned: boolean]
  archive: [thread: Thread, archived: boolean]
}>()

const { t } = useI18n()

const draftTitle = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

const displayTitle = computed(() =>
  props.thread.title?.trim()
  || threadFallbackTitle(props.thread)
  || t('threads.untitled'))

const excerpt = computed(() => threadExcerpt(props.thread))
const relativeTime = computed(() => formatRelativeTime(props.thread.lastActivity))

watch(() => props.editing, (editing) => {
  if (!editing) return
  draftTitle.value = props.thread.title ?? ''
  nextTick(() => {
    titleInput.value?.focus()
    titleInput.value?.select()
  })
}, { immediate: true })

function submitRename() {
  emit('rename', props.thread, draftTitle.value)
}
</script>

<template>
  <!--
    A row is a div, not a button, because it contains its own controls (menu,
    rename input). Keyboard users get the same behaviour through role/tabindex
    plus Enter and Space.
  -->
  <div
    class="group flex min-h-[64px] w-full items-start gap-3 rounded-xl border px-3 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :class="[
      active
        ? 'border-primary/40 bg-primary/[0.07]'
        : 'border-border bg-card hover:border-border hover:bg-accent/40',
      editing ? '' : 'cursor-pointer',
    ]"
    :role="editing ? undefined : 'button'"
    :tabindex="editing ? undefined : 0"
    @click="editing ? undefined : emit('open', thread)"
    @keydown.enter="editing ? undefined : emit('open', thread)"
    @keydown.space.prevent="editing ? undefined : emit('open', thread)"
  >
    <!-- Persona badge -->
    <Badge variant="muted" class="mt-0.5 shrink-0 uppercase tracking-wide">
      {{ thread.agentId }}
    </Badge>

    <div class="min-w-0 flex-1">
      <!-- Inline rename -->
      <div v-if="editing" class="flex items-center gap-1.5" @click.stop>
        <input
          ref="titleInput"
          v-model="draftTitle"
          type="text"
          class="h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          :placeholder="$t('threads.titlePlaceholder')"
          :aria-label="$t('threads.renameThread')"
          @keydown.enter.prevent="submitRename"
          @keydown.esc.prevent="emit('cancelRename')"
        >
        <button
          type="button"
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-primary hover:bg-primary/10"
          :aria-label="$t('common.save')"
          @click="submitRename"
        >
          <AppIcon name="check" class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          :aria-label="$t('common.cancel')"
          @click="emit('cancelRename')"
        >
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </div>

      <template v-else>
        <div class="flex items-center gap-2">
          <AppIcon v-if="thread.pinned" name="pin" class="h-3.5 w-3.5 shrink-0 text-primary" />
          <p class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{{ displayTitle }}</p>
          <span class="shrink-0 text-[11px] text-muted-foreground">{{ relativeTime }}</span>
        </div>

        <p v-if="excerpt" class="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {{ excerpt }}
        </p>
        <p v-else class="mt-0.5 text-xs italic text-muted-foreground/70">{{ $t('threads.noMessagesYet') }}</p>

        <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            v-if="activity?.state === 'running'"
            class="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success"
          >
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            {{ $t('threads.running') }}
          </span>
          <span
            v-else-if="activity?.state === 'queued'"
            class="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning"
          >
            <AppIcon name="clock" class="h-3 w-3" />
            {{ activity.position ? $t('threads.queuedWithPosition', { position: activity.position }) : $t('threads.queued') }}
          </span>
          <span
            v-if="thread.archived"
            class="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            {{ $t('threads.archived') }}
          </span>
        </div>
      </template>
    </div>

    <!-- Row actions -->
    <div v-if="!editing" class="shrink-0" @click.stop>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            :aria-label="$t('threads.threadActions')"
          >
            <AppIcon name="moreVertical" class="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-48">
          <DropdownMenuItem @click="emit('startRename', thread)">
            <AppIcon name="edit" size="sm" />
            {{ $t('threads.rename') }}
          </DropdownMenuItem>
          <DropdownMenuItem @click="emit('pin', thread, !thread.pinned)">
            <AppIcon name="pin" size="sm" />
            {{ thread.pinned ? $t('threads.unpin') : $t('threads.pin') }}
          </DropdownMenuItem>
          <DropdownMenuItem @click="emit('archive', thread, !thread.archived)">
            <AppIcon name="archive" size="sm" />
            {{ thread.archived ? $t('threads.unarchive') : $t('threads.archive') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
