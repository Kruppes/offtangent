<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Project, CreateProjectInput } from '~/api/projects'
import { projectColor, useProjects } from './useProjects'
import ProjectFormDialog from './ProjectFormDialog.vue'

const props = defineProps<{ projectId?: string }>()
const { items, visible, archived, loading, loadError, saving, mutationError, load, refreshCounts, save, setArchived } = useProjects()
const selected = computed(() => items.value.find(p => p.id === props.projectId))
const editing = ref<Project | null>(null)
const formOpen = ref(false)
const archiveTarget = ref<Project | null>(null)
function openForm(project: Project | null = null) {
  mutationError.value = null
  editing.value = project
  formOpen.value = true
}
async function submit(payload: CreateProjectInput) {
  if (await save(payload, editing.value?.id)) {
    formOpen.value = false
    if (!editing.value) archived.value = false
  }
}
async function confirmArchive() {
  if (archiveTarget.value && await setArchived(archiveTarget.value)) archiveTarget.value = null
}
onMounted(load)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <PageHeader :title="projectId ? (selected?.name ?? $t('projectsW3.detail')) : $t('projects.title')" :subtitle="$t('projects.subtitle')" />
    <div :class="projectId ? 'max-h-[35dvh] shrink-0 overflow-y-auto px-3 py-3 md:px-6' : 'min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-3 md:px-6 md:pb-8'">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <NuxtLink v-if="projectId" to="/projects" class="inline-flex min-h-[44px] min-w-[44px] w-fit items-center rounded-md px-2 text-primary underline focus-visible:outline-2 focus-visible:outline-ring">{{ $t('projectsW3.back') }}</NuxtLink>
        <h1 class="text-xl font-bold tracking-tight md:hidden">{{ projectId ? (selected?.name ?? $t('projectsW3.detail')) : $t('projects.title') }}</h1>
        <div v-if="loading" role="status" :aria-label="$t('common.loading')" aria-busy="true" class="space-y-3">
          <div v-for="n in 3" :key="n" aria-hidden="true" class="h-24 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        </div>
        <Alert v-else-if="loadError" variant="destructive" role="alert" class="flex flex-wrap items-center gap-3">
          <AlertDescription class="flex-1">{{ $t('projects.error') }}</AlertDescription>
          <Button variant="outline" class="min-h-[44px]" @click="load">{{ $t('common.retry') }}</Button>
        </Alert>
        <p v-else-if="projectId && !selected" role="status" class="rounded-lg border p-6 text-muted-foreground">{{ $t('projectsW3.notFound') }}</p>
        <template v-else>
          <div v-if="!projectId" class="flex flex-wrap items-center justify-between gap-3">
            <div role="group" :aria-label="$t('projectsW3.filter')" class="flex gap-2">
              <Button :variant="!archived ? 'default' : 'outline'" :aria-pressed="!archived" class="min-h-[44px]" @click="archived = false">{{ $t('projectsW3.active') }}</Button>
              <Button :variant="archived ? 'default' : 'outline'" :aria-pressed="archived" class="min-h-[44px]" @click="archived = true">{{ $t('projectsW3.archived') }}</Button>
            </div>
            <Button class="min-h-[44px]" @click="openForm()">{{ $t('projectsW3.create') }}</Button>
          </div>
          <p v-if="!projectId && !visible.length" role="status" class="rounded-lg border p-6 text-center text-muted-foreground">{{ $t(archived ? 'projectsW3.emptyArchived' : 'projects.empty') }}</p>
          <ul class="space-y-3">
            <li v-for="item in projectId ? (selected ? [selected] : []) : visible" :key="item.id" class="rounded-lg border bg-card p-4 text-card-foreground [overflow-wrap:anywhere]">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                  <h2 class="flex items-center gap-2 font-medium">
                    <span aria-hidden="true" class="h-3 w-3 shrink-0 rounded-full bg-muted ring-1 ring-border" :style="{ backgroundColor: projectColor(item.color) }" />
                    <NuxtLink v-if="!projectId" :to="`/projects/${encodeURIComponent(item.id)}`" class="inline-flex min-h-[44px] min-w-[44px] items-center rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{{ item.name }}</NuxtLink>
                    <span v-else>{{ item.name }}</span>
                  </h2>
                  <p class="text-sm text-muted-foreground">{{ $t('projectsW3.strandCount', { count: item.threadCount }, item.threadCount) }}</p>
                  <p v-if="item.archived" class="text-sm text-muted-foreground">{{ $t('projectsW3.archived') }}</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Button variant="outline" class="min-h-[44px]" :disabled="saving" :aria-label="$t('projectsW3.editNamed', { name: item.name })" @click="openForm(item)">{{ $t('projectsW3.edit') }}</Button>
                  <Button variant="outline" class="min-h-[44px]" :disabled="saving" :aria-label="$t(item.archived ? 'projectsW3.restoreNamed' : 'projectsW3.archiveNamed', { name: item.name })" @click="mutationError = null; archiveTarget = item">{{ $t(item.archived ? 'projectsW3.restore' : 'projectsW3.archive') }}</Button>
                </div>
              </div>
            </li>
          </ul>

        </template>
      </div>
    </div>
    <slot v-if="projectId && selected && !loading" :project="selected" :refresh="refreshCounts" />
    <ProjectFormDialog :open="formOpen" :project="editing" :loading="saving" :error="mutationError" @close="formOpen = false" @submit="submit" />
    <ConfirmDialog :open="!!archiveTarget" :title="$t(archiveTarget?.archived ? 'projectsW3.restore' : 'projectsW3.archive')" :description="mutationError ? $t(`projectsW3.${mutationError}`) : $t(archiveTarget?.archived ? 'projectsW3.restoreHint' : 'projectsW3.archiveHint')" :confirm-label="$t(archiveTarget?.archived ? 'projectsW3.restore' : 'projectsW3.archive')" :destructive="false" :loading="saving" class="[&_button]:min-h-[44px] [&_button]:min-w-[44px]" @cancel="() => { if (!saving) archiveTarget = null }" @confirm="confirmArchive" />
  </div>
</template>
