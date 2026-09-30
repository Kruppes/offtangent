<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- Header with back button -->
    <!-- Mobile left padding matches the layout header so the back icon sits
         directly below the hamburger button. -->
    <div class="flex-shrink-0 border-b border-border py-2 pl-1 pr-3 md:px-5 md:py-3">
      <div class="flex items-center gap-2 md:gap-3">
        <Button
          variant="ghost"
          class="min-h-[44px] min-w-[44px] shrink-0 gap-1.5 p-0 md:w-auto md:px-3 md:text-xs"
          :title="$t('taskViewer.back')"
          :aria-label="$t('taskViewer.back')"
          @click="$emit('back')"
        >
          <AppIcon name="arrowLeft" size="sm" />
          <span class="hidden md:inline">{{ $t('taskViewer.back') }}</span>
        </Button>

        <Separator orientation="vertical" class="hidden h-5 md:block" />

        <div class="flex min-w-0 flex-1 items-center gap-2">
          <h2 class="truncate text-sm font-semibold">{{ taskInfo?.name ?? '—' }}</h2>
          <Badge v-if="taskInfo?.status" :variant="taskStatusVariant(taskInfo.status)">
            {{ $t(`tasks.status.${taskInfo.status}`) }}
          </Badge>
          <Badge v-if="isLive" variant="default" class="gap-1">
            <span class="relative flex h-2 w-2">
              <span class="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-success opacity-75" />
              <span class="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            {{ $t('taskViewer.live') }}
          </Badge>
        </div>

        <Button
          v-if="isLive"
          variant="outline"
          size="sm"
          class="gap-1.5"
          :class="{ 'text-muted-foreground': !autoScroll }"
          role="checkbox"
          :aria-checked="autoScroll"
          :title="$t('taskViewer.autoScrollHint')"
          @click="toggleAutoScroll"
        >
          <AppIcon :name="autoScroll ? 'squareCheck' : 'square'" size="sm" />
          <span class="hidden sm:inline">{{ $t('taskViewer.autoScroll') }}</span>
        </Button>

        <!-- Edit & Restart button. Only shown for terminal states. For
             `running` / `paused` we surface a hint in the button's tooltip
             so the user knows to kill or resume first. -->
        <Button
          v-if="!editing && canRestart"
          variant="outline"
          size="sm"
          class="gap-1.5"
          :title="$t('taskViewer.restartButtonHint')"
          @click="startEdit"
        >
          <AppIcon name="refresh" size="sm" />
          <span class="hidden sm:inline">{{ $t('taskViewer.restartButton') }}</span>
        </Button>
        <Button
          v-else-if="!editing && taskInfo?.status && !canRestart"
          variant="outline"
          size="sm"
          class="gap-1.5"
          disabled
          :title="$t(`taskViewer.restartDisabled.${taskInfo.status}`)"
        >
          <AppIcon name="refresh" size="sm" />
          <span class="hidden sm:inline">{{ $t('taskViewer.restartButton') }}</span>
        </Button>
      </div>
    </div>

    <div v-if="taskInfo" class="flex flex-wrap gap-x-4 gap-y-1 border-b border-border px-5 py-2 text-xs tabular-nums text-muted-foreground">
      <span>{{ [taskInfo.provider, taskInfo.model].filter(Boolean).join(' · ') }}</span>
      <span :title="$t('tasks.columns.tokens')">↑ {{ taskInfo.promptTokens ?? 0 }} · ↓ {{ taskInfo.completionTokens ?? 0 }}</span>
      <span :title="$t('tasks.columns.cost')">${{ (taskInfo.estimatedCost ?? 0).toFixed(4) }}</span>
    </div>

    <Alert v-if="error && events.length > 0" variant="destructive" class="m-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <!-- Loading state -->
    <div v-if="loading" class="flex flex-1 flex-col items-center justify-center gap-3">
      <div class="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      <span class="text-sm text-muted-foreground">{{ $t('taskViewer.loading') }}</span>
    </div>

    <!-- Error state -->
    <Alert v-else-if="error && events.length === 0" variant="destructive" class="m-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <!-- Empty state -->
    <div
      v-else-if="events.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center"
    >
      <AppIcon name="clock" size="xl" class="opacity-40" />
      <p class="text-sm text-muted-foreground">{{ $t('taskViewer.noEvents') }}</p>
    </div>

    <!-- Events list -->
    <div
      v-else
      ref="eventsContainer"
      class="flex flex-1 flex-col gap-1 overflow-y-auto px-5 py-3"
      @scroll="onEventsScroll"
    >
      <!-- Edit & Restart form (replaces the read-only Prompt block while editing) -->
      <div v-if="editing" class="rounded-lg border border-primary/50 bg-card px-5 py-4">
        <div class="mb-4 flex items-center gap-2">
          <AppIcon name="refresh" size="sm" class="text-primary" />
          <h3 class="text-sm font-semibold">{{ $t('taskViewer.restartFormTitle') }}</h3>
        </div>

        <!-- Warning when restarting a system-triggered task (cronjob / heartbeat / consolidation).
             The new run will be stored as a regular user-triggered task and will
             not be re-attached to its original schedule. -->
        <Alert
          v-if="showRetriggerNotice"
          variant="default"
          class="mb-4 border-amber-500/40 bg-amber-500/5 text-amber-900 dark:text-amber-200"
        >
          <AlertDescription class="text-xs">
            {{ $t('taskViewer.restartTriggerNotice', { trigger: $t(`tasks.trigger.${taskInfo?.triggerType ?? 'user'}`) }) }}
          </AlertDescription>
        </Alert>

        <Alert v-if="restartError" variant="destructive" class="mb-4">
          <AlertDescription>{{ restartError }}</AlertDescription>
        </Alert>

        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="restart-name">{{ $t('taskViewer.fieldName') }}</Label>
            <Input id="restart-name" v-model="form.name" :disabled="submitting" />
          </div>

          <div class="space-y-2">
            <Label for="restart-prompt">{{ $t('taskViewer.fieldPrompt') }}</Label>
            <textarea
              id="restart-prompt"
              v-model="form.prompt"
              :disabled="submitting"
              rows="10"
              class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono"
            />
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="restart-provider">{{ $t('taskViewer.fieldProvider') }}</Label>
              <Select v-model="form.providerComposite" :disabled="submitting">
                <SelectTrigger id="restart-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{{ $t('taskViewer.fieldProviderDefault') }}</SelectItem>
                  <SelectItem
                    v-for="opt in providerModelOptions"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-2">
              <Label for="restart-duration">{{ $t('taskViewer.fieldMaxDuration') }}</Label>
              <Input
                id="restart-duration"
                v-model.number="form.maxDurationMinutes"
                type="number"
                min="1"
                :disabled="submitting"
              />
            </div>
          </div>
        </div>

        <div class="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" :disabled="submitting" @click="cancelEdit">
            {{ $t('common.cancel') }}
          </Button>
          <Button :disabled="submitting || !canSubmit" class="gap-1.5" @click="submitRestart">
            <AppIcon name="refresh" size="sm" :class="{ 'animate-spin': submitting }" />
            {{ $t('taskViewer.restartSubmit') }}
          </Button>
        </div>
      </div>

      <!-- Task prompt (read-only, hidden while editing) -->
      <TaskEventCard
        v-if="!editing && taskInfo?.prompt"
        icon="send"
        icon-class="text-primary"
        :timestamp="firstEventTimestamp ? formatTime(firstEventTimestamp) : undefined"
      >
        <template #header>
          <span class="text-xs font-medium text-primary">Prompt</span>
        </template>
        <p class="text-sm text-foreground whitespace-pre-wrap">{{ taskInfo.prompt }}</p>
      </TaskEventCard>

      <template v-for="(event, idx) in groupedEvents" :key="idx">
        <!-- Tool call event -->
        <TaskEventCard
          v-if="event.type === 'tool_call_end' || event.type === 'tool_call_start'"
          collapsible
          icon="wrench"
          :icon-class="event.toolIsError ? 'text-destructive' : undefined"
          :meta="event.durationMs != null ? formatDurationMs(event.durationMs) : undefined"
          :timestamp="formatTime(event.timestamp)"
          :expanded="isExpanded(`tool-${idx}`)"
          @toggle="toggleExpanded(`tool-${idx}`)"
        >
          <template #header>
            <span class="text-xs font-medium" :class="event.toolIsError ? 'text-destructive' : 'text-foreground'">
              {{ formatToolName(event.toolName ?? 'unknown') }}
            </span>
            <span
              v-if="getToolCallSummary(event.toolName ?? '', event.toolArgs)"
              class="hidden min-w-0 truncate font-mono text-xs text-muted-foreground sm:inline"
              :title="getToolCallSummary(event.toolName ?? '', event.toolArgs)!"
            >
              {{ getToolCallSummary(event.toolName ?? '', event.toolArgs) }}
            </span>
            <Badge v-if="event.toolIsError" variant="destructive" class="text-[10px] px-1.5 py-0">
              {{ $t('taskViewer.error') }}
            </Badge>
          </template>

          <div class="space-y-3">
            <div v-if="event.toolArgs">
              <p class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {{ $t('taskViewer.arguments') }}
              </p>
              <div class="rounded border border-border bg-background p-2.5 text-xs">
                <ToolDataDisplay :data="event.toolArgs" />
              </div>
            </div>

            <div v-if="event.type === 'tool_call_end' && event.toolResult !== undefined">
              <p class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {{ $t('taskViewer.result') }}
              </p>
              <div class="max-h-[300px] overflow-y-auto rounded border border-border bg-background p-2.5 text-xs">
                <ToolDataDisplay :data="event.toolResult" :is-error="event.toolIsError" />
              </div>
            </div>
          </div>
        </TaskEventCard>

        <!-- Thinking -->
        <TaskEventCard
          v-if="event.type === 'text_delta' && event.thinking"
          collapsible
          icon="sparkles"
          icon-class="text-muted-foreground/50"
          :timestamp="formatTime(event.timestamp)"
          :expanded="isExpanded(`thinking-${idx}`)"
          @toggle="toggleExpanded(`thinking-${idx}`)"
        >
          <template #header>
            <span class="text-xs font-medium text-muted-foreground">
              {{ $t('taskViewer.thinking') }}
            </span>
          </template>

          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="prose-chat text-xs text-muted-foreground" v-html="renderMarkdown(event.thinking.trim())" />
        </TaskEventCard>

        <!-- Agent text (structured or plain) -->
        <template v-if="event.type === 'text_delta' && event.text">
          <TaskEventCard
            v-if="parseStructuredResponse(event.text)"
            :icon="parseStructuredResponse(event.text)!.status === 'completed' ? 'check' : 'close'"
            :icon-class="parseStructuredResponse(event.text)!.status === 'completed' ? 'text-green-500' : 'text-destructive'"
            :timestamp="formatTime(event.timestamp)"
          >
            <template #header>
              <span
                class="text-xs font-medium"
                :class="parseStructuredResponse(event.text)!.status === 'completed' ? 'text-green-500' : 'text-destructive'"
              >
                {{ parseStructuredResponse(event.text)!.statusLabel }}
              </span>
            </template>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="prose-chat text-sm" v-html="renderMarkdown(parseStructuredResponse(event.text)!.summary)" />
          </TaskEventCard>

          <TaskEventCard v-else icon="bot" :timestamp="formatTime(event.timestamp)">
            <template #header>
              <span class="text-xs font-medium text-muted-foreground">
                {{ $t('taskViewer.agentResponse') }}
              </span>
            </template>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="prose-chat text-sm" v-html="renderMarkdown(event.text)" />
          </TaskEventCard>
        </template>

        <!-- Status change event -->
        <TaskEventCard
          v-if="event.type === 'status_change'"
          icon="info"
          :timestamp="formatTime(event.timestamp)"
        >
          <template #header>
            <Badge :variant="taskStatusVariant(event.status ?? '')">
              {{ $t(`tasks.status.${event.status}`) }}
            </Badge>
            <span v-if="event.statusMessage" class="text-sm text-muted-foreground truncate">
              {{ event.statusMessage }}
            </span>
          </template>
        </TaskEventCard>
      </template>

      <!-- Auto-scroll anchor -->
      <div ref="scrollAnchor" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TaskEventItem } from '~/api/tasks'
import { buildProviderModelOptions } from '~/utils/providerModelOptions'
import TaskEventCard from '~/features/tasks/components/TaskEventCard.vue'
import { useTaskEvents } from '~/features/tasks/composables/useTaskEvents'
import { useTasksApi } from '~/api/tasks'
import { formatToolName, getToolCallSummary } from '~/utils/toolNameFormat'
import { useProviders } from '~/composables/useProviders'
import { taskStatusVariant } from '~/features/tasks/utils/taskFormat'

const props = defineProps<{
  taskId: string
}>()

const emit = defineEmits<{
  back: []
  /** Fired after a successful restart — carries the new task's id so the
   *  parent can switch the viewer to the new task. */
  restarted: [taskId: string]
}>()

const { renderMarkdown } = useMarkdown()
const { formatTime } = useFormat()
const tasksApi = useTasksApi()
const { providers, fetchProviders } = useProviders()

const {
  events,
  taskInfo,
  loading,
  error,
  isLive,
  loadTaskEvents,
  disconnect,
} = useTaskEvents()

const expandedItems = ref(new Set<string>())

// —— Edit & Restart form state ——
//
// `editing` is flipped by the header Edit button. While true, the read-only
// Prompt block is hidden and an editable form is rendered in its place.
const editing = ref(false)
const submitting = ref(false)
const restartError = ref<string | null>(null)
const form = reactive({
  name: '',
  prompt: '',
  providerComposite: '' as string, // `providerId:modelId` or '' = default
  // Use `''` as the empty sentinel so the Input component's v-model stays
  // happy (it rejects `null`). Converted to undefined at submit time.
  maxDurationMinutes: '' as number | '',
})

/** Only terminal tasks can be restarted. `running` / `paused` must be
 *  killed or resumed first. Agreed behaviour. */
const canRestart = computed(() => {
  const s = taskInfo.value?.status
  return s === 'completed' || s === 'failed'
})

const canSubmit = computed(() =>
  form.name.trim().length > 0 && form.prompt.trim().length > 0,
)

/** Show a notice when restarting a task that wasn't user-triggered. The
 *  new run will be a plain `user` task without cron/heartbeat binding. */
const showRetriggerNotice = computed(() => {
  const t = taskInfo.value?.triggerType
  return t === 'cronjob' || t === 'heartbeat' || t === 'consolidation'
})

/** Flattened provider+model options, same pattern as CronjobFormDialog. */
const providerModelOptions = computed(() => buildProviderModelOptions(providers.value))

/** Map the task's stored (provider, model) strings onto the composite
 *  `providerId:modelId` used by the select. Falls back to '' when the
 *  stored provider is unknown (e.g. deleted) — the user can then pick a
 *  fresh one or leave it on Default. */
function deriveCompositeFromTask(): string {
  const provider = taskInfo.value?.provider
  const model = taskInfo.value?.model
  if (!provider) return ''
  const match = providers.value.find(
    p => p.id === provider || p.name.toLowerCase() === provider.toLowerCase(),
  )
  if (!match) return ''
  const modelId = model && match.enabledModels?.includes(model)
    ? model
    : match.enabledModels?.[0] ?? ''
  return `${match.id}:${modelId}`
}

async function startEdit() {
  // Ensure providers are loaded before we try to map the stored provider
  // onto the select value — otherwise the mapping would silently fall back
  // to '' and look like "default" even though the task had a pinned provider.
  if (providers.value.length === 0) {
    try {
      await fetchProviders()
    } catch {
      // If we can't load providers, we still allow editing — the user can
      // type Name/Prompt and submit with default provider.
    }
  }

  form.name = taskInfo.value?.name ?? ''
  form.prompt = taskInfo.value?.prompt ?? ''
  form.maxDurationMinutes = taskInfo.value?.maxDurationMinutes ?? ''
  form.providerComposite = taskInfo.value?.isDefaultModel
    ? ''
    : deriveCompositeFromTask()
  restartError.value = null
  editing.value = true
}

function cancelEdit() {
  if (submitting.value) return
  editing.value = false
  restartError.value = null
}

async function submitRestart() {
  if (!canSubmit.value || submitting.value) return

  restartError.value = null
  submitting.value = true

  try {
    // Split the composite `providerId:modelId` back into separate fields
    // the way the backend expects (explicit provider + model). An empty
    // composite means "use configured default" — we send neither field.
    let providerId: string | undefined
    let modelId: string | undefined
    const composite = form.providerComposite.trim()
    if (composite) {
      const colonIdx = composite.indexOf(':')
      if (colonIdx === -1) {
        providerId = composite
      } else {
        providerId = composite.slice(0, colonIdx)
        modelId = composite.slice(colonIdx + 1) || undefined
      }
    }

    const payload = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      provider: providerId,
      model: modelId,
      maxDurationMinutes:
        typeof form.maxDurationMinutes === 'number' && form.maxDurationMinutes > 0
          ? form.maxDurationMinutes
          : undefined,
    }

    const response = await tasksApi.restartTask(props.taskId, payload)
    editing.value = false
    emit('restarted', response.task.id)
  } catch (err) {
    restartError.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}

const firstEventTimestamp = computed(() => {
  return events.value.length > 0 ? events.value[0]!.timestamp : undefined
})

function isExpanded(key: string): boolean {
  return expandedItems.value.has(key)
}

function toggleExpanded(key: string) {
  const next = new Set(expandedItems.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expandedItems.value = next
}

const groupedEvents = computed(() => {
  const result: TaskEventItem[] = []
  let pendingText: TaskEventItem | null = null

  for (const event of events.value) {
    if (event.type === 'text_delta' && event.text) {
      if (pendingText && pendingText.type === 'text_delta') {
        pendingText = Object.assign({}, pendingText, {
          text: (pendingText.text ?? '') + event.text,
        })
      } else {
        if (pendingText) result.push(pendingText)
        pendingText = Object.assign({}, event)
      }
    } else {
      if (pendingText) {
        result.push(pendingText)
        pendingText = null
      }
      result.push(event)
    }
  }

  if (pendingText) result.push(pendingText)

  return result
})

const eventsContainer = ref<HTMLElement | null>(null)
const scrollAnchor = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
let lastScrollTop = 0

function scrollToBottom() {
  scrollAnchor.value?.scrollIntoView({ behavior: 'smooth' })
}

// Programmatic scrolling only ever moves downwards, so a decreasing
// scrollTop is a reliable signal of user intent to stop following.
function onEventsScroll() {
  const el = eventsContainer.value
  if (!el) return
  if (el.scrollTop < lastScrollTop) {
    autoScroll.value = false
  }
  lastScrollTop = el.scrollTop
}

function toggleAutoScroll() {
  autoScroll.value = !autoScroll.value
  if (autoScroll.value) {
    nextTick(scrollToBottom)
  }
}

watch(() => events.value.length, () => {
  if (isLive.value && autoScroll.value) {
    nextTick(scrollToBottom)
  }
})

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function parseStructuredResponse(text: string): { status: string; statusLabel: string; summary: string } | null {
  const match = text.match(/^STATUS:\s*(\S+)\s*\nSUMMARY:\s*\n?(.*)/s)
  if (!match) return null

  const rawStatus = match[1]!.toLowerCase()
  const summary = match[2]!.trim()
  if (!summary) return null

  const statusLabel = rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1)
  return { status: rawStatus, statusLabel, summary }
}

onMounted(() => {
  loadTaskEvents(props.taskId)
})

watch(() => props.taskId, (newId) => {
  disconnect()
  expandedItems.value.clear()
  autoScroll.value = true
  lastScrollTop = 0
  // Any pending edit belongs to the previous task — drop it before the new
  // task loads so the form doesn't end up carrying stale values.
  editing.value = false
  restartError.value = null
  loadTaskEvents(newId)
})

onUnmounted(() => {
  disconnect()
})
</script>
