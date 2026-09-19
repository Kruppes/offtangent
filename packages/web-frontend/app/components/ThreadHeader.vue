<script setup lang="ts">
import type { Thread } from '~/api/threads'
import type { SessionActivity } from '~/composables/useChat'
import { threadFallbackTitle } from '~/features/threads/threadDisplay'
import type { EffectiveModel } from '~/api/models'

/*
 * Header of the thread view: back to the inbox, persona badge, inline title
 * editing (Enter submits, Escape cancels), pin and archive.
 */
const props = defineProps<{
  thread: Thread | null
  agentId?: string | null
  activity?: SessionActivity
  saving?: boolean
  effectiveModel?: EffectiveModel | null
  modelLoading?: boolean
}>()

const emit = defineEmits<{
  back: []
  rename: [title: string]
  pin: [pinned: boolean]
  archive: [archived: boolean]
  chooseModel: []
}>()

const { t } = useI18n()

const editing = ref(false)
const draftTitle = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

const displayTitle = computed(() => {
  if (!props.thread) return t('threads.threadFallbackTitle')
  return props.thread.title?.trim()
    || threadFallbackTitle(props.thread)
    || t('threads.untitled')
})

const personaLabel = computed(() => props.thread?.agentId || props.agentId || '')

function startEditing() {
  if (!props.thread) return
  draftTitle.value = props.thread.title ?? ''
  editing.value = true
  nextTick(() => {
    titleInput.value?.focus()
    titleInput.value?.select()
  })
}

function submit() {
  editing.value = false
  emit('rename', draftTitle.value)
}

function cancel() {
  editing.value = false
}
</script>

<template>
  <div class="flex shrink-0 items-center gap-2 border-b border-border bg-background px-2 py-2 md:px-4">
    <button
      type="button"
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      :aria-label="$t('threads.backToInbox')"
      @click="emit('back')"
    >
      <AppIcon name="arrowLeft" class="h-5 w-5" />
    </button>

    <Badge v-if="personaLabel" variant="muted" class="shrink-0 uppercase tracking-wide">
      {{ personaLabel }}
    </Badge>

    <!-- Title: click to rename inline -->
    <div class="min-w-0 flex-1">
      <div v-if="editing" class="flex items-center gap-1.5">
        <input
          ref="titleInput"
          v-model="draftTitle"
          type="text"
          class="h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          :placeholder="$t('threads.titlePlaceholder')"
          :aria-label="$t('threads.renameThread')"
          @keydown.enter.prevent="submit"
          @keydown.esc.prevent="cancel"
        >
        <button
          type="button"
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-primary hover:bg-primary/10"
          :aria-label="$t('common.save')"
          @click="submit"
        >
          <AppIcon name="check" class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          :aria-label="$t('common.cancel')"
          @click="cancel"
        >
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </div>

      <button
        v-else
        type="button"
        class="flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-muted/60"
        :title="$t('threads.renameThread')"
        @click="startEditing"
      >
        <AppIcon v-if="thread?.pinned" name="pin" class="h-3.5 w-3.5 shrink-0 text-primary" />
        <span class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{{ displayTitle }}</span>
        <span
          v-if="activity?.state === 'running'"
          class="hidden shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success sm:inline-flex"
        >
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          {{ $t('threads.running') }}
        </span>
        <AppIcon name="edit" class="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      </button>
    </div>

    <button
      v-if="thread"
      type="button"
      class="flex min-h-11 max-w-32 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      :aria-label="$t('threads.chooseModel')"
      @click="emit('chooseModel')"
    >
      <Skeleton v-if="modelLoading" class="h-4 w-16" />
      <template v-else>
        <span class="truncate">{{ effectiveModel?.modelId || $t('threads.noModel') }}</span>
        <span class="text-muted-foreground">{{ effectiveModel?.source === 'strand' ? $t('threads.modelPinned') : $t('threads.modelInherited') }}</span>
      </template>
    </button>

    <!-- Pin toggle -->
    <button
      v-if="thread"
      type="button"
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted"
      :class="thread.pinned ? 'text-primary' : 'text-muted-foreground hover:text-foreground'"
      :disabled="saving"
      :aria-label="thread.pinned ? $t('threads.unpin') : $t('threads.pin')"
      @click="emit('pin', !thread.pinned)"
    >
      <AppIcon :name="thread.pinned ? 'pinOff' : 'pin'" class="h-4 w-4" />
    </button>

    <!-- Archive -->
    <button
      v-if="thread"
      type="button"
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      :disabled="saving"
      :aria-label="thread.archived ? $t('threads.unarchive') : $t('threads.archive')"
      @click="emit('archive', !thread.archived)"
    >
      <AppIcon :name="thread.archived ? 'unarchive' : 'archive'" class="h-4 w-4" />
    </button>
  </div>
</template>
