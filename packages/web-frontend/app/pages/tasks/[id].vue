<template>
  <div class="h-full min-h-0 task-detail">
    <TaskEventsViewer :task-id="taskId" @back="navigateTo(user?.role === 'admin' ? '/tasks' : '/strands')" @restarted="onTaskRestarted" />
  </div>
</template>

<script setup lang="ts">
import TaskEventsViewer from '~/features/tasks/components/TaskEventsViewer.vue'
const route = useRoute()
const { user } = useAuth()
const taskId = computed(() => String(route.params.id))
// Single-task endpoints enforce ownership for members and return 404 for
// foreign tasks. Do not hide a member's own delegated task behind admin UI.
function onTaskRestarted(newTaskId: string) { navigateTo(`/tasks/${newTaskId}`) }
</script>

<style scoped>
.task-detail :deep(button), .task-detail :deep(input), .task-detail :deep(select), .task-detail :deep(textarea), .task-detail :deep(summary) {
  min-height: 44px;
  min-width: 44px;
}
</style>
