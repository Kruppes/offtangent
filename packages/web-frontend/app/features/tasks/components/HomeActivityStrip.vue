<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useTasksApi, type Task } from '~/api/tasks'
import { useStrandTasksApi } from '~/api/strandTasks'
import { isTaskDismissable, useTaskDismissals } from '../composables/useTaskDismissals'
import { taskDisplayStatus } from '../utils/taskFormat'

/**
 * Home activity strip: the newest tasks of the viewer's strands, so finished
 * work can be acknowledged without opening the strand or the task list. Same
 * server contract as the strand dock and the global list
 * (`POST /api/strands/:id/activity/dismiss|undismiss`). Running and paused
 * tasks stay visible and offer no dismiss; a 409 (a task went live again)
 * reloads the strip and says why nothing was hidden.
 */
const HOME_ACTIVITY_FETCH = 20
const HOME_ACTIVITY_VISIBLE = 5

const tasksApi = useTasksApi()
const tasks = ref<Task[]>([])
const loading = ref(true)
const loadError = ref(false)
const undoButton = ref<HTMLButtonElement | null>(null)
let undoTimer: ReturnType<typeof setTimeout> | null = null

async function load(): Promise<void> {
  loading.value = true
  loadError.value = false
  try {
    const res = await tasksApi.listTasks({ limit: HOME_ACTIVITY_FETCH })
    // Only tasks of the viewer's strands: cronjob and heartbeat runs have no
    // strand to acknowledge in and belong to the task list.
    tasks.value = res.tasks.filter(task => !!task.strandId)
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

const ack = useTaskDismissals(tasks, useStrandTasksApi(), { onConflict: () => { void load() } })

const rows = computed(() => ack.visible(tasks.value).slice(0, HOME_ACTIVITY_VISIBLE))

function withAck(task: Task): Task {
  return { ...task, dismissedAt: ack.dismissedAtOf(task) }
}

const status = computed(() => {
  if (ack.error.value) return 'tasks.ack.dismissError'
  if (ack.conflict.value) return 'tasks.ack.dismissConflict'
  return ''
})

function armUndo(): void {
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = setTimeout(() => { ack.lastDismissed.value = null }, 10_000)
  void nextTick(() => undoButton.value?.focus())
}

async function dismissOne(task: Task): Promise<void> {
  if (await ack.dismiss([task])) armUndo()
}

async function undo(): Promise<void> {
  if (undoTimer) clearTimeout(undoTimer)
  await ack.undo()
}

onMounted(load)
onBeforeUnmount(() => { if (undoTimer) clearTimeout(undoTimer) })
</script>

<template>
  <section class="mx-auto w-full max-w-4xl space-y-2 px-4 pb-6 md:px-6" data-testid="home-activity" aria-labelledby="home-activity-heading">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 id="home-activity-heading" class="text-lg font-semibold">
        {{ $t('home.activity.title') }}
      </h2>
      <NuxtLink to="/tasks" class="inline-flex min-h-11 items-center rounded-md px-2 text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {{ $t('home.activity.allTasks') }}
      </NuxtLink>
    </div>

    <p v-if="loading && tasks.length === 0" role="status" class="text-sm text-muted-foreground" data-testid="home-activity-loading">
      {{ $t('home.activity.loading') }}
    </p>
    <p v-else-if="loadError" role="alert" class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="home-activity-error">
      {{ $t('home.activity.error') }}
      <Button variant="outline" type="button" class="min-h-11" @click="load">
        {{ $t('common.retry') }}
      </Button>
    </p>
    <template v-else>
      <!-- One fixed 44 px slot: the outcome line and "Undo" take turns, so a
           hidden row never shifts the controls under the pointer. -->
      <div
        v-if="ack.lastDismissed.value || status || ack.hidden.value.length > 0"
        class="flex min-h-11 flex-wrap items-center gap-x-2"
        data-testid="home-activity-toolbar"
      >
        <p role="status" aria-live="polite" class="min-w-0 flex-1 text-sm text-muted-foreground" data-testid="home-activity-status">
          {{ status ? $t(status) : ack.lastDismissed.value ? $t('tasks.ack.dismissed', { count: ack.lastDismissed.value.length }) : '' }}
        </p>
        <button
          v-if="ack.lastDismissed.value"
          ref="undoButton"
          type="button"
          class="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg px-2 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground"
          :disabled="ack.busy.value"
          data-testid="home-activity-undo"
          @click="undo"
        >
          {{ $t('tasks.ack.undo') }}
        </button>
        <button
          v-if="ack.hidden.value.length > 0"
          type="button"
          class="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-sm text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-expanded="ack.showHidden.value"
          data-testid="home-activity-show-hidden"
          @click="ack.showHidden.value = !ack.showHidden.value"
        >
          {{ ack.showHidden.value ? $t('tasks.ack.hideHidden') : $t('tasks.ack.showHidden', { count: ack.hidden.value.length }) }}
        </button>
      </div>

      <p v-if="rows.length === 0" class="text-sm text-muted-foreground" data-testid="home-activity-empty">
        {{ $t('home.activity.empty') }}
      </p>
      <ul v-else class="space-y-2" :aria-busy="ack.busy.value">
        <li
          v-for="task in rows"
          :key="task.id"
          class="flex items-center gap-2 rounded-xl border bg-card p-2 pl-3 [overflow-wrap:anywhere]"
          :data-dismissed="ack.dismissedAtOf(task) ? 'true' : undefined"
          data-testid="home-activity-row"
        >
          <NuxtLink :to="`/tasks/${encodeURIComponent(task.id)}`" class="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span class="font-medium">{{ task.name }}</span>
            <span class="text-sm text-muted-foreground">{{ $t(`tasks.status.${taskDisplayStatus(task)}`) }}</span>
          </NuxtLink>
          <button
            v-if="isTaskDismissable(withAck(task))"
            type="button"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground"
            :disabled="ack.busy.value"
            :title="$t('tasks.ack.dismiss')"
            :aria-label="$t('tasks.ack.dismissOne', { name: task.name })"
            data-testid="home-activity-dismiss"
            :data-ack-id="task.id"
            @click="dismissOne(task)"
          >
            <AppIcon name="check" size="sm" />
          </button>
          <button
            v-else-if="ack.dismissedAtOf(task)"
            type="button"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground"
            :disabled="ack.busy.value"
            :title="$t('tasks.ack.restore')"
            :aria-label="$t('tasks.ack.restoreOne', { name: task.name })"
            data-testid="home-activity-restore"
            @click="ack.restoreTask(task)"
          >
            <AppIcon name="eye" size="sm" />
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>
