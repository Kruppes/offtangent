<script setup lang="ts">
import ProjectsView from '~/features/projects/ProjectsView.vue'
import StrandList from '~/features/strands/StrandList.vue'
const route = useRoute()
const projectId = computed(() => String(route.params.id))
</script>

<template>
  <ProjectsView :key="projectId" :project-id="projectId">
    <template #default="{ refresh }"><StrandList :project-id="projectId" @changed="refresh" /></template>
  </ProjectsView>
</template>
