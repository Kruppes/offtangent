<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Thread, Project } from '@axiom/core'
import { useModelsApi, type ModelSelection, type SelectableModel } from '~/api/models'
import { useProjectsApi } from '~/api/projects'
import StrandActions from './StrandActions.vue'
import { strandErrorKey, useStrandDetailApi, type StrandDetail } from './detailApi'
const props = defineProps<{ strandId: string }>()
const emit = defineEmits<{ back: []; updated: [strand: StrandDetail]; deleted: [id: string] }>()
const { t } = useI18n()
const api = useStrandDetailApi()
const modelApi = useModelsApi()
const projectApi = useProjectsApi()
const strand = ref<StrandDetail | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const editing = ref(false)
const title = ref('')
const tags = ref('')
const projectId = ref('')
const projects = ref<Project[]>([])
const projectsError = ref(false)
const modelOpen = ref(false)
const modelLoading = ref(false)
const modelError = ref<string | null>(null)
const models = ref<SelectableModel[]>([])
const projectName = computed(() => projects.value.find(p => p.id === strand.value?.projectId)?.name ?? strand.value?.projectId)
function update(patch: Partial<StrandDetail>) {
  if (!strand.value) return
  strand.value = { ...strand.value, ...patch }
  emit('updated', strand.value)
}
async function load() {
  loading.value = true
  error.value = ''
  try { strand.value = await api.get(props.strandId); emit('updated', strand.value) }
  catch (cause) { error.value = t(strandErrorKey(cause)) }
  finally { loading.value = false }
}
async function loadProjects() {
  projectsError.value = false
  try { projects.value = await projectApi.list() }
  catch { projectsError.value = true }
}
function edit() {
  title.value = strand.value?.title ?? ''
  tags.value = strand.value?.tags.join(', ') ?? ''
  projectId.value = strand.value?.projectId ?? ''
  editing.value = true
}
async function mutate(action: () => Promise<Thread>) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try { update(await action()) }
  catch (cause) { error.value = t(strandErrorKey(cause)) }
  finally { saving.value = false }
}
async function save() {
  if (!strand.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    // Each successful write is kept visible if a later independent endpoint fails.
    update(await api.patch(props.strandId, { title: title.value.trim() || null }))
    update(await api.tags(props.strandId, tags.value.split(',').map(tag => tag.trim()).filter(Boolean)))
    if (projectId.value !== (strand.value.projectId ?? '')) update(await api.project(props.strandId, projectId.value || null))
    editing.value = false
  } catch (cause) { error.value = t(strandErrorKey(cause)) }
  finally { saving.value = false }
}
async function loadModels() {
  modelLoading.value = true
  modelError.value = null
  try { models.value = await modelApi.listModels() }
  catch (cause) { modelError.value = t(strandErrorKey(cause)) }
  finally { modelLoading.value = false }
}
async function openModels() { modelOpen.value = true; await loadModels() }
async function chooseModel(selection: ModelSelection | null) {
  if (saving.value) return
  saving.value = true
  modelError.value = null
  try {
    update(await modelApi.setStrandModel(props.strandId, selection ? { providerId: selection.providerId, modelId: selection.modelId } : null))
    modelOpen.value = false
  } catch (cause) { modelError.value = t(strandErrorKey(cause)); error.value = modelError.value }
  finally { saving.value = false }
}
onMounted(() => { void load(); void loadProjects() })
</script>

<template>
  <header class="max-h-[50dvh] shrink-0 overflow-y-auto border-b border-border bg-background px-3 py-3 md:px-6" :aria-busy="loading || saving">
    <div class="flex items-center gap-3">
      <Button class="min-h-11 min-w-11" variant="ghost" :aria-label="t('strandDetail.back')" @click="emit('back')"><AppIcon name="arrowLeft" class="h-5 w-5" /></Button>
      <h1 class="min-w-0 flex-1 break-words text-lg font-semibold">{{ strand?.title || t('strandDetail.untitled') }}</h1>
      <Button v-if="strand" class="min-h-11" variant="outline" :disabled="saving" :aria-expanded="editing" @click="editing ? editing = false : edit()">{{ t('strandDetail.edit') }}</Button>
    </div>
    <p v-if="loading" role="status" class="text-sm text-muted-foreground">{{ t('strandDetail.loading') }}</p>
    <Alert v-if="error" variant="destructive" role="alert" class="my-2"><AlertDescription>{{ error }}</AlertDescription><Button class="min-h-11" variant="ghost" :disabled="saving" @click="load">{{ t('strandDetail.retry') }}</Button><Button v-if="strand" class="min-h-11" variant="ghost" @click="error = ''">{{ t('strandDetail.dismiss') }}</Button></Alert>
    <template v-if="strand">
      <div class="mt-2 flex flex-wrap items-center gap-2 text-sm [overflow-wrap:anywhere]">
        <span class="rounded-md bg-muted px-2 py-1">{{ projectName || t('strandDetail.noProject') }}</span>
        <span v-for="tag in strand.tags" :key="tag" class="rounded-md border border-border px-2 py-1">#{{ tag }}</span>
        <Button class="min-h-11 max-w-full whitespace-normal break-all" variant="ghost" :disabled="saving" @click="openModels">{{ t('strandDetail.model') }}: {{ strand.effectiveModel?.modelId || t('strandDetail.defaultModel') }}</Button>
        <Button v-if="strand.pinnedModel" class="min-h-11" variant="ghost" :disabled="saving" @click="chooseModel(null)">{{ t('strandDetail.resetModel') }}</Button>
        <Button class="min-h-11" variant="ghost" :disabled="saving" :aria-pressed="strand.pinned" @click="mutate(() => api.patch(strandId, { pinned: !strand!.pinned }))">{{ t(strand.pinned ? 'strandDetail.unpin' : 'strandDetail.pin') }}</Button>
      </div>
      <section v-if="strand.projectSuggestion && !strand.projectId" class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border p-2" :aria-label="t('strandDetail.suggestion')">
        <p class="text-sm">{{ t('strandDetail.suggestProject', { project: strand.projectSuggestion.projectName || strand.projectSuggestion.projectId }) }} <span class="text-muted-foreground">{{ strand.projectSuggestion.reason }}</span></p>
        <Button class="min-h-11" variant="outline" :disabled="saving" @click="mutate(() => api.suggestion(strandId, 'accept'))">{{ t('strandDetail.accept') }}</Button>
        <Button class="min-h-11" variant="ghost" :disabled="saving" @click="mutate(() => api.suggestion(strandId, 'dismiss'))">{{ t('strandDetail.dismiss') }}</Button>
      </section>
      <form v-if="editing" class="my-3 grid gap-3 rounded-lg border border-border p-3" @submit.prevent="save">
        <label class="grid gap-1 text-sm">{{ t('strandDetail.title') }}<input v-model="title" maxlength="200" :disabled="saving" class="min-h-11 min-w-0 w-full rounded-md border border-input bg-background px-3 focus-visible:outline-ring"></label>
        <label class="grid gap-1 text-sm">{{ t('strandDetail.project') }}<select v-model="projectId" :aria-label="t('strandDetail.project')" :disabled="saving || projectsError" class="min-h-11 min-w-0 w-full rounded-md border border-input bg-background px-3"><option value="">{{ t('strandDetail.noProject') }}</option><option v-if="strand.projectId && !projects.some(p => p.id === strand!.projectId)" :value="strand.projectId">{{ projectName }}</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
        <div v-if="projectsError" role="alert" class="text-sm">{{ t('strandDetail.projectsError') }} <Button class="min-h-11" variant="outline" type="button" @click="loadProjects">{{ t('strandDetail.retry') }}</Button></div>
        <label class="grid gap-1 text-sm">{{ t('strandDetail.tags') }}<input v-model="tags" :disabled="saving" class="min-h-11 min-w-0 w-full rounded-md border border-input bg-background px-3 focus-visible:outline-ring"></label>
        <div class="flex gap-2"><Button class="min-h-11" type="submit" :disabled="saving">{{ t('common.save') }}</Button><Button class="min-h-11" variant="outline" type="button" :disabled="saving" @click="editing = false">{{ t('common.cancel') }}</Button></div>
      </form>
      <details class="mt-2"><summary class="flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-ring">{{ t('strandDetail.actions') }}</summary><StrandActions :key="strandId" :strand-id="strandId" :archived="strand.archived" :disabled="saving || loading" @changed="load" @update:archived="update({ archived: $event })" @deleted="emit('deleted', $event)" /></details>
    </template>
    <ModelPickerDialog :open="modelOpen" :models="models" :pinned="strand?.pinnedModel ?? null" :loading="modelLoading" :error="modelError" :saving="saving" @close="!saving && (modelOpen = false)" @retry="loadModels" @select="chooseModel" />
  </header>
</template>
