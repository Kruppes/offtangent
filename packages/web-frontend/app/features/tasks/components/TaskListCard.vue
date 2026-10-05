<template>
  <!-- One card, two controls side by side (never nested): the title button
       stretches over the whole card, the kill button sits above it. -->
  <div
    data-testid="task-list-card"
    class="relative flex w-full flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-muted"
  >
    <div class="flex items-start gap-2">
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left text-sm font-medium after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none"
        @click="$emit('open')"
      >{{ task.name }}</button>
      <Badge :variant="taskStatusVariant(displayStatus)" class="shrink-0">
        {{ $t(`tasks.status.${displayStatus}`) }}
      </Badge>
      <Button
        v-if="task.status === 'running'"
        variant="ghost"
        size="sm"
        class="relative z-10 -my-1 -mr-2 h-7 w-7 shrink-0 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive max-md:-my-2 max-md:h-11 max-md:w-11"
        :title="$t('tasks.killButton')"
        :aria-label="$t('tasks.killButton')"
        @click.stop="$emit('kill')"
      >
        <AppIcon name="kill" size="sm" />
      </Button>
      <Button
        v-else-if="dismissable || restorable"
        variant="ghost"
        size="sm"
        class="relative z-10 -my-1 -mr-2 h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground max-md:-my-2 max-md:h-11 max-md:w-11"
        :disabled="busy"
        :title="restorable ? $t('tasks.ack.restore') : $t('tasks.ack.dismiss')"
        :aria-label="restorable ? $t('tasks.ack.restoreOne', { name: task.name }) : $t('tasks.ack.dismissOne', { name: task.name })"
        :data-testid="restorable ? 'tasks-ack-restore' : 'tasks-ack-one'"
        :data-ack-id="task.id"
        @click.stop="restorable ? $emit('restore') : $emit('dismiss')"
      >
        <AppIcon :name="restorable ? 'eye' : 'check'" size="sm" />
      </Button>
    </div>

    <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <Badge variant="outline" class="shrink-0">
        {{ $t(`tasks.trigger.${task.triggerType}`) }}
      </Badge>
      <span v-if="triggerModel" class="truncate" :title="routingTooltip ?? triggerModel">{{ triggerModel }}</span>
    </div>

    <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
      <div v-for="cell in statCells" :key="cell.label" class="min-w-0">
        <dt class="text-2xs font-medium uppercase tracking-label text-muted-foreground">
          {{ cell.label }}
        </dt>
        <dd class="truncate tabular-nums text-foreground">
          {{ cell.value }}
          <span v-if="cell.hint" class="text-muted-foreground" :title="cell.title">{{ cell.hint }}</span>
        </dd>
      </div>
    </dl>
  </div>
</template>

<script setup lang="ts">
import type { Task } from '~/api/tasks'
import {
  cacheSummary,
  formatTaskDuration,
  formatTaskTriggerModel,
  formatTaskRoutingTooltip,
  taskDisplayStatus,
  taskStatusVariant,
} from '~/features/tasks/utils/taskFormat'

const props = defineProps<{
  task: Task
  /** W7: finished task of the viewer's strand, not yet acknowledged. */
  dismissable?: boolean
  /** W7: acknowledged task, shown in the opened hidden group. */
  restorable?: boolean
  busy?: boolean
}>()

defineEmits<{
  open: []
  kill: []
  dismiss: []
  restore: []
}>()

const { t } = useI18n()
const { formatNumber, formatCurrency, formatTimestamp } = useFormat()

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => { ticker = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => clearInterval(ticker))

const triggerModel = computed(() => formatTaskTriggerModel(props.task, t))
const routingTooltip = computed(() => formatTaskRoutingTooltip(props.task, t))
// A task waiting for a free concurrency slot is stored as running without a
// start time — show it as queued instead of pretending it works.
const displayStatus = computed(() => taskDisplayStatus(props.task))

const statCells = computed(() => [
  { label: t('tasks.columns.duration'), value: formatTaskDuration(props.task, now.value) },
  {
    label: t('tasks.columns.tokens'),
    value: `↑ ${formatNumber(props.task.promptTokens)} · ↓ ${formatNumber(props.task.completionTokens)}`,
    hint: `(${cacheSummary(props.task)})`,
    title: t('tasks.cachedInput.formula'),
  },
  { label: t('tasks.columns.cost'), value: formatCurrency(props.task.estimatedCost) },
  { label: t('tasks.columns.created'), value: formatTimestamp(props.task.createdAt) },
])
</script>
