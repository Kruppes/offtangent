<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Project, CreateProjectInput } from '~/api/projects'
const props = defineProps<{ open: boolean; project?: Project | null; loading: boolean; error: string | null }>()
const emit = defineEmits<{ close: []; submit: [payload: CreateProjectInput] }>()
const name = ref('')
const color = ref('')
watch(() => [props.open, props.project] as const, ([open, project]) => {
  if (open) { name.value = project?.name ?? ''; color.value = project?.color ?? '' }
}, { immediate: true })
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => { if (!value && !loading) emit('close') }">
    <DialogContent class="[&_button]:min-h-[44px] [&_button]:min-w-[44px]">
      <DialogHeader>
        <DialogTitle>{{ $t(project ? 'projectsW3.edit' : 'projectsW3.create') }}</DialogTitle>
        <DialogDescription>{{ $t('projectsW3.formHint') }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" :aria-busy="loading" @submit.prevent="emit('submit', { name, color: color || null })">
        <div class="space-y-2">
          <Label for="project-name">{{ $t('projectsW3.name') }}</Label>
          <Input id="project-name" v-model="name" class="min-h-[44px]" required maxlength="80" :disabled="loading" :aria-invalid="error === 'nameError'" :aria-describedby="error ? 'project-form-error' : undefined" />
        </div>
        <div class="space-y-2">
          <Label for="project-color">{{ $t('projectsW3.color') }}</Label>
          <Input id="project-color" v-model="color" class="min-h-[44px]" :disabled="loading" :aria-invalid="error === 'colorError'" aria-describedby="project-color-hint" />
          <p id="project-color-hint" class="text-sm text-muted-foreground">{{ $t('projectsW3.colorHint') }}</p>
        </div>
        <Alert v-if="error" id="project-form-error" variant="destructive" role="alert"><AlertDescription>{{ $t(`projectsW3.${error}`) }}</AlertDescription></Alert>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="loading" @click="emit('close')">{{ $t('common.cancel') }}</Button>
          <Button type="submit" :disabled="loading">{{ $t(loading ? 'common.loading' : 'common.save') }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
