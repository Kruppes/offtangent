<script setup lang="ts">
/**
 * Keeps the strand's task tree current while the dock (and with it the
 * activity panel) is closed, so the strand head can still say "N tasks
 * running" after a page load mid-wave or a reconnect. Renders nothing; the
 * data source is the panel's own (`useStrandTasks`), unchanged.
 */
import { useStrandTasks } from '../composables/useStrandTasks'

const props = defineProps<{ strandId: string | null }>()
useStrandTasks(() => props.strandId)
</script>

<template>
  <span hidden />
</template>
