<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('tasks.title')" :subtitle="$t('tasks.subtitle')" />

    <!-- Filter toolbar. On mobile the fields live in a popover so the list
         gets the screen; the badge shows how many filters deviate from default. -->
    <div class="flex-shrink-0 border-b border-border px-3 py-2 md:px-5 md:py-3">
      <div class="flex items-center gap-2 md:hidden">
        <Popover>
          <PopoverTrigger as-child>
            <Button variant="outline" class="flex-1 justify-start gap-2">
              <AppIcon name="filter" size="sm" />
              {{ $t('tasks.filters.button') }}
              <Badge v-if="activeFilterCount > 0" variant="default" class="ml-auto px-2 py-0 text-2xs">
                {{ activeFilterCount }}
              </Badge>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" class="flex w-[calc(100vw-1.5rem)] max-w-sm flex-col gap-2">
            <TaskFilterFields
              v-model:status="filters.status"
              v-model:trigger-type="filters.triggerType"
              v-model:provider-filter="filters.providerFilter"
              v-model:created-from="filters.createdFrom"
              v-model:created-to="filters.createdTo"
              :has-default-provider-option="hasDefaultProviderFilter"
              :provider-model-options="providerModelFilterOptions"
              @change="onFilterChange"
            />
          </PopoverContent>
        </Popover>

        <Button
          variant="outline"
          size="icon"
          :disabled="loading"
          :title="$t('tasks.refresh')"
          @click="loadTasks(pagination.page)"
        >
          <AppIcon name="refresh" size="sm" />
        </Button>
      </div>

      <div class="hidden flex-col gap-2 md:flex lg:flex-row lg:items-center">
        <div class="flex flex-1 flex-wrap items-end gap-2">
          <TaskFilterFields
            v-model:status="filters.status"
            v-model:trigger-type="filters.triggerType"
            v-model:provider-filter="filters.providerFilter"
            v-model:created-from="filters.createdFrom"
            v-model:created-to="filters.createdTo"
            :has-default-provider-option="hasDefaultProviderFilter"
            :provider-model-options="providerModelFilterOptions"
            @change="onFilterChange"
          />
        </div>

        <Button variant="outline" :disabled="loading" class="gap-2" @click="loadTasks(pagination.page)">
          <AppIcon name="refresh" class="h-4 w-4" />
          {{ $t('tasks.refresh') }}
        </Button>
      </div>
    </div>

    <!-- Content area -->
    <div ref="listRegion" class="flex flex-1 flex-col overflow-y-auto">
      <!-- Error banner -->
      <Alert v-if="error" variant="destructive" class="m-4 mb-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button
            type="button"
            class="-my-3 ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="$t('aria.closeAlert')"
            @click="error = null"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Loading skeleton -->
      <div v-if="loading && tasks.length === 0" class="space-y-3 p-6">
        <Skeleton v-for="i in 5" :key="i" class="h-14 rounded-lg" />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="tasks.length === 0"
        class="flex flex-1 flex-col items-start justify-center gap-3 p-10 text-left"
      >
        <AppIcon name="tasks" size="xl" />
        <h2 class="text-base font-semibold text-foreground">{{ $t('tasks.emptyTitle') }}</h2>
        <p class="max-w-md text-sm text-muted-foreground">{{ $t('tasks.emptyDescription') }}</p>
      </div>

      <template v-else>
        <!-- W7: acknowledge finished tasks (strand contract, grouped per
             strand). One fixed 44 px slot: "hide all" and the undo line take
             turns, so hiding never shifts the list. -->
        <div
          v-if="ack.dismissable.value.length > 0 || ack.lastDismissed.value || ack.error.value || ack.conflict.value || ack.hidden.value.length > 0"
          class="flex min-h-11 flex-wrap items-center gap-x-2 px-3 pt-2 md:px-5"
          data-testid="tasks-ack-toolbar"
        >
          <p
            role="status"
            aria-live="polite"
            class="min-w-0 flex-1 truncate text-sm text-muted-foreground"
            data-testid="tasks-ack-status"
          >{{ ackStatus }}</p>
          <button
            v-if="ack.lastDismissed.value"
            ref="undoButton"
            type="button"
            class="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground disabled:[&_svg]:text-border"
            :disabled="ack.busy.value"
            data-testid="tasks-ack-undo"
            @click="undoAck"
          >{{ $t('tasks.ack.undo') }}</button>
          <button
            v-else-if="ack.dismissable.value.length > 0"
            type="button"
            class="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground disabled:[&_svg]:text-border disabled:bg-muted"
            :disabled="ack.busy.value"
            :aria-busy="ack.busy.value"
            data-testid="tasks-ack-all"
            @click="dismissAll"
          >
            <AppIcon name="check" size="sm" />
            {{ $t('tasks.ack.dismissAll', { count: ack.dismissable.value.length }) }}
          </button>
          <button
            v-if="ack.hidden.value.length > 0"
            type="button"
            class="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-sm text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-expanded="ack.showHidden.value"
            data-testid="tasks-ack-show-hidden"
            @click="ack.showHidden.value = !ack.showHidden.value"
          >{{ ack.showHidden.value ? $t('tasks.ack.hideHidden') : $t('tasks.ack.showHidden', { count: ack.hidden.value.length }) }}</button>
        </div>

        <p v-if="visibleTasks.length === 0" class="measure px-3 py-4 text-sm text-muted-foreground md:px-5" data-testid="tasks-all-hidden">
          {{ $t('tasks.ack.allHidden') }}
        </p>

        <!-- Mobile card list -->
        <div class="flex flex-col gap-2 p-3 md:hidden">
          <TaskListCard
            v-for="task in visibleTasks"
            :key="task.id"
            :task="task"
            :dismissable="isTaskDismissable(withAck(task))"
            :restorable="!!ack.dismissedAtOf(task) && !!task.strandId"
            :busy="ack.busy.value"
            @open="openViewer(task.id)"
            @kill="confirmKill(task)"
            @dismiss="dismissOne(task)"
            @restore="ack.restoreTask(task)"
          />
        </div>

        <!-- Desktop table -->
        <div class="hidden overflow-x-auto md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead
                  class="cursor-pointer select-none hover:text-foreground"
                  @click="sortBy('name')"
                >
                  <span class="inline-flex items-center gap-1">
                    {{ $t('tasks.columns.name') }}
                    <SortIndicator :field="'name'" :sort-field="sortField" :sort-direction="sortDirection" />
                  </span>
                </TableHead>
                <TableHead>{{ $t('tasks.columns.status') }}</TableHead>
                <TableHead>{{ $t('tasks.columns.trigger') }}</TableHead>
                <TableHead
                  class="cursor-pointer select-none text-right hover:text-foreground"
                  @click="sortBy('duration')"
                >
                  <span class="inline-flex items-center justify-end gap-1">
                    {{ $t('tasks.columns.duration') }}
                    <SortIndicator :field="'duration'" :sort-field="sortField" :sort-direction="sortDirection" />
                  </span>
                </TableHead>
                <TableHead
                  class="cursor-pointer select-none text-right hover:text-foreground"
                  @click="sortBy('promptTokens')"
                >
                  <span class="inline-flex items-center justify-end gap-1">
                    {{ $t('tasks.columns.tokens') }}
                    <SortIndicator :field="'promptTokens'" :sort-field="sortField" :sort-direction="sortDirection" />
                  </span>
                </TableHead>
                <TableHead
                  class="cursor-pointer select-none text-right hover:text-foreground"
                  @click="sortBy('estimatedCost')"
                >
                  <span class="inline-flex items-center justify-end gap-1">
                    {{ $t('tasks.columns.cost') }}
                    <SortIndicator :field="'estimatedCost'" :sort-field="sortField" :sort-direction="sortDirection" />
                  </span>
                </TableHead>
                <TableHead
                  class="cursor-pointer select-none text-right hover:text-foreground"
                  @click="sortBy('createdAt')"
                >
                  <span class="inline-flex items-center justify-end gap-1">
                    {{ $t('tasks.columns.created') }}
                    <SortIndicator :field="'createdAt'" :sort-field="sortField" :sort-direction="sortDirection" />
                  </span>
                </TableHead>
                <TableHead class="w-[70px]"><span class="sr-only">{{ $t('tasks.actionsColumn') }}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="task in visibleTasks"
                :key="task.id"
                class="cursor-pointer"
                :data-dismissed="ack.dismissedAtOf(task) ? 'true' : undefined"
                @click="openViewer(task.id)"
              >
                <TableCell class="max-w-[240px] truncate font-medium">
                  {{ task.name }}
                </TableCell>
                <TableCell>
                  <Badge :variant="taskStatusVariant(taskDisplayStatus(task))">
                    {{ $t(`tasks.status.${taskDisplayStatus(task)}`) }}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div class="flex flex-col items-start gap-1">
                    <Badge variant="outline">
                      {{ $t(`tasks.trigger.${task.triggerType}`) }}
                    </Badge>
                    <span
                      v-if="formatTaskTriggerModel(task, t)"
                      class="text-xs text-muted-foreground"
                      :title="formatTaskRoutingTooltip(task, t) ?? (task.isDefaultModel ? $t('tasks.triggerModelDefaultTooltip') : undefined)"
                    >
                      {{ formatTaskTriggerModel(task, t) }}
                    </span>
                  </div>
                </TableCell>
                <TableCell class="text-right tabular-nums text-muted-foreground">
                  {{ formatTaskDuration(task) }}
                </TableCell>
                <TableCell class="text-right tabular-nums text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <div class="flex flex-col items-end">
                        <span>{{ formatNumber(task.promptTokens + task.completionTokens) }}</span>
                        <span
                          v-if="hasCacheTokens(task)"
                          class="text-xs text-muted-foreground"
                        >
                          {{ cacheSummary(task) }}
                        </span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="left" class="max-w-none px-3 py-2">
                      <div class="grid grid-cols-[auto_auto] gap-x-5 gap-y-1 tabular-nums">
                        <span>{{ $t('tasks.tokensTooltip.input') }}</span>
                        <span class="text-right">{{ formatNumber(task.promptTokens) }}</span>
                        <span>{{ $t('tasks.tokensTooltip.output') }}</span>
                        <span class="text-right">{{ formatNumber(task.completionTokens) }}</span>
                        <span>{{ $t('tasks.tokensTooltip.cacheRead') }}</span>
                        <span class="text-right">{{ formatNumber(task.cacheRead) }}</span>
                        <span>{{ $t('tasks.tokensTooltip.cacheWrite') }}</span>
                        <span class="text-right">{{ formatNumber(task.cacheWrite) }}</span>
                        <template v-if="cacheHitRate(task) !== null">
                          <span class="col-span-2 my-1 border-t border-background" />
                          <span>{{ $t('tasks.tokensTooltip.cacheHitRate') }}</span>
                          <span class="text-right">{{ cacheHitRate(task)!.toFixed(1) }}%</span>
                        </template>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell class="text-right tabular-nums text-muted-foreground">
                  {{ formatCurrency(task.estimatedCost) }}
                </TableCell>
                <TableCell class="text-right text-sm text-muted-foreground">
                  {{ formatTimestamp(task.createdAt) }}
                </TableCell>
                <TableCell class="text-right">
                  <Button
                    v-if="task.status === 'running'"
                    variant="ghost"
                    size="sm"
                    class="h-8 w-8 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    :title="$t('tasks.killButton')"
                    :aria-label="$t('tasks.killButton')"
                    @click.stop="confirmKill(task)"
                  >
                    <AppIcon name="kill" size="sm" />
                  </Button>
                  <Button
                    v-else-if="isTaskDismissable(withAck(task))"
                    variant="ghost"
                    size="sm"
                    class="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                    :disabled="ack.busy.value"
                    :title="$t('tasks.ack.dismiss')"
                    :aria-label="$t('tasks.ack.dismissOne', { name: task.name })"
                    data-testid="tasks-ack-one"
                    :data-ack-id="task.id"
                    @click.stop="dismissOne(task)"
                  >
                    <AppIcon name="check" size="sm" />
                  </Button>
                  <Button
                    v-else-if="ack.dismissedAtOf(task) && task.strandId"
                    variant="ghost"
                    size="sm"
                    class="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                    :disabled="ack.busy.value"
                    :title="$t('tasks.ack.restore')"
                    :aria-label="$t('tasks.ack.restoreOne', { name: task.name })"
                    data-testid="tasks-ack-restore"
                    @click.stop="ack.restoreTask(task)"
                  >
                    <AppIcon name="eye" size="sm" />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <!-- Pagination -->
        <div
          v-if="pagination.totalPages > 1"
          class="flex items-center justify-between border-t border-border px-4 py-3"
        >
          <span class="text-sm text-muted-foreground">
            {{ pagination.total }} tasks · Page {{ pagination.page }} of {{ pagination.totalPages }}
          </span>
          <div class="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              :disabled="pagination.page <= 1"
              @click="loadTasks(pagination.page - 1)"
            >
              <AppIcon name="arrowLeft" size="sm" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="pagination.page >= pagination.totalPages"
              @click="loadTasks(pagination.page + 1)"
            >
              <AppIcon name="arrowRight" size="sm" />
            </Button>
          </div>
        </div>
      </template>
    </div>

    <!-- Kill confirmation dialog -->
    <ConfirmDialog
      :open="killDialog.open"
      :title="$t('tasks.killConfirmTitle')"
      :description="$t('tasks.killConfirmDescription')"
      :confirm-label="$t('tasks.killButton')"
      :loading="killDialog.loading"
      destructive
      @confirm="executeKill"
      @cancel="killDialog.open = false"
    />
  </div>
</template>

<script setup lang="ts">
import type { Task } from '~/api/tasks'
import TaskFilterFields from '~/features/tasks/components/TaskFilterFields.vue'
import TaskListCard from '~/features/tasks/components/TaskListCard.vue'
import {
  cacheHitRate,
  cacheSummary,
  formatTaskDuration,
  formatTaskTriggerModel,
  formatTaskRoutingTooltip,
  hasCacheTokens,
  taskDisplayStatus,
  taskStatusVariant,
} from '~/features/tasks/utils/taskFormat'
import {
  encodeTaskProviderModelFilter,
  useTasksList,
} from '~/features/tasks/composables/useTasksList'
import { isTaskDismissable, useTaskDismissals } from '~/features/tasks/composables/useTaskDismissals'
import { useStrandTasksApi } from '~/api/strandTasks'
import { focusRestored } from '~/utils/focusRestored'

const { t } = useI18n()
const { formatNumber, formatCurrency, formatTimestamp } = useFormat()

function openViewer(taskId: string) {
  navigateTo(`/tasks/${taskId}`)
}

const {
  tasks,
  providerOptions,
  sortedTasks,
  loading,
  error,
  pagination,
  filters,
  activeFilterCount,
  sortField,
  sortDirection,
  loadTasks,
  killTask,
  sortBy,
  startPolling,
  stopPolling,
} = useTasksList()

// ── W7: acknowledge finished tasks (strand contract, grouped per strand) ──
const ack = useTaskDismissals(tasks, useStrandTasksApi(), { onConflict: () => { void loadTasks(pagination.value.page) } })
const visibleTasks = computed(() => ack.visible(sortedTasks.value))
const undoButton = ref<HTMLButtonElement | null>(null)
const listRegion = ref<HTMLElement | null>(null)
let undoTimer: ReturnType<typeof setTimeout> | null = null

function withAck(task: Task): Task {
  return { ...task, dismissedAt: ack.dismissedAtOf(task) }
}

const ackStatus = computed(() => {
  if (ack.error.value) return t('tasks.ack.dismissError')
  if (ack.conflict.value) return t('tasks.ack.dismissConflict')
  if (ack.lastDismissed.value) return t('tasks.ack.dismissed', { count: ack.lastDismissed.value.length })
  return ''
})

function armUndo(): void {
  if (undoTimer) clearTimeout(undoTimer)
  // Same as the dock: long enough to read and reach with the keyboard; the
  // hidden group keeps every entry restorable afterwards anyway.
  undoTimer = setTimeout(() => { ack.lastDismissed.value = null }, 10_000)
  // Keyboard users land on "Undo" instead of on <body> when their row goes.
  void nextTick(() => undoButton.value?.focus())
}

async function dismissOne(task: Task): Promise<void> {
  if (await ack.dismiss([task])) armUndo()
}
async function dismissAll(): Promise<void> {
  if (await ack.dismiss(ack.dismissable.value)) armUndo()
}
async function undoAck(): Promise<void> {
  if (undoTimer) clearTimeout(undoTimer)
  const ids = (ack.lastDismissed.value ?? []).map(entry => entry.id)
  // W7: Undo vanishes with the restore; focus the restored task's dismiss
  // button (or the list) instead of dropping keyboard focus on <body>.
  if (await ack.undo()) void nextTick(() => focusRestored(listRegion.value, ids))
}

const hasDefaultProviderFilter = computed(() =>
  providerOptions.value.some(option => option.isDefaultModel === true),
)

const providerModelFilterOptions = computed(() => {
  const seen = new Set<string>()

  return providerOptions.value
    .filter((option): option is { provider: string; model: string; isDefaultModel: boolean | null } =>
      Boolean(option.provider && option.model),
    )
    .map((option) => ({
      value: encodeTaskProviderModelFilter(option.provider, option.model),
      label: `${option.provider} (${option.model})`,
    }))
    .filter((option) => {
      if (seen.has(option.value)) return false
      seen.add(option.value)
      return true
    })
})

const killDialog = reactive({
  open: false,
  loading: false,
  taskId: null as string | null,
})

function confirmKill(task: Task) {
  killDialog.taskId = task.id
  killDialog.open = true
}

async function executeKill() {
  if (!killDialog.taskId) return

  killDialog.loading = true
  await killTask(killDialog.taskId)
  killDialog.loading = false
  killDialog.open = false
  killDialog.taskId = null
}

function onFilterChange() {
  loadTasks(1)
}

onMounted(async () => {
  await loadTasks()
  startPolling(5000)
})

onUnmounted(() => {
  stopPolling()
  if (undoTimer) clearTimeout(undoTimer)
})
</script>
