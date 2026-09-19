<template>
  <button
    type="button"
    class="flex w-full flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/50"
    @click="$emit('open')"
  >
    <div class="flex items-start gap-2">
      <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ task.name }}</span>
      <Badge :variant="taskStatusVariant(task.status)" class="shrink-0">
        {{ $t(`tasks.status.${task.status}`) }}
      </Badge>
      <Button
        v-if="task.status === 'running'"
        variant="ghost"
        size="sm"
        class="-my-1 -mr-2 h-7 w-7 shrink-0 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
        :title="$t('tasks.killButton')"
        @click.stop="$emit('kill')"
      >
        <AppIcon name="kill" size="sm" />
      </Button>
    </div>

    <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <Badge variant="outline" class="shrink-0">
        {{ $t(`tasks.trigger.${task.triggerType}`) }}
      </Badge>
      <span v-if="triggerModel" class="truncate" :title="triggerModel">{{ triggerModel }}</span>
    </div>

    <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      <div v-for="cell in statCells" :key="cell.label" class="min-w-0">
        <dt class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {{ cell.label }}
        </dt>
        <dd class="truncate tabular-nums text-foreground">
          {{ cell.value }}
          <span v-if="cell.hint" class="text-muted-foreground">{{ cell.hint }}</span>
        </dd>
      </div>
    </dl>
  </button>
</template>

<script setup lang="ts">
import type { Task } from '~/api/tasks'
import {
  cacheSummary,
  formatTaskDuration,
  formatTaskTriggerModel,
  hasCacheTokens,
  taskStatusVariant,
} from '~/features/tasks/utils/taskFormat'

const props = defineProps<{
  task: Task
}>()

defineEmits<{
  open: []
  kill: []
}>()

const { t } = useI18n()
const { formatNumber, formatCurrency, formatTimestamp } = useFormat()

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => { ticker = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => clearInterval(ticker))

const triggerModel = computed(() => formatTaskTriggerModel(props.task, t))

const statCells = computed(() => [
  { label: t('tasks.columns.duration'), value: formatTaskDuration(props.task, now.value) },
  {
    label: t('tasks.columns.tokens'),
    value: `↑ ${formatNumber(props.task.promptTokens)} · ↓ ${formatNumber(props.task.completionTokens)}`,
    hint: hasCacheTokens(props.task) ? `(${cacheSummary(props.task)})` : undefined,
  },
  { label: t('tasks.columns.cost'), value: formatCurrency(props.task.estimatedCost) },
  { label: t('tasks.columns.created'), value: formatTimestamp(props.task.createdAt) },
])
</script>
