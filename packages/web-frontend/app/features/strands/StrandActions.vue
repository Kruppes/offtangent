<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import type { StrandDeletePreview } from '@axiom/core'
import { strandErrorKey, useStrandDetailApi } from './detailApi'
const props = defineProps<{ strandId: string; archived: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:archived': [value: boolean]; changed: []; deleted: [id: string] }>()
const { t } = useI18n()
const api = useStrandDetailApi()
const pending = ref(false)
const error = ref('')
const undo = ref<boolean | null>(null)
const preview = ref<StrandDeletePreview | null>(null)
const deleteFacts = ref(false)
const confirming = ref(false)
let undoTimer: ReturnType<typeof setTimeout> | null = null
onUnmounted(() => { if (undoTimer) clearTimeout(undoTimer) })
const counts = computed(() => preview.value ? t('strandDetail.deleteCounts', { messages: preview.value.messages, captures: preview.value.captures, attachments: preview.value.attachments, artifacts: preview.value.artifacts, facts: preview.value.facts.length }) + ' ' + t(preview.value.nowSlot ? 'strandDetail.nowSlotRemoved' : 'strandDetail.noNowSlot') : '')
async function archive(value: boolean, isUndo = false) {
  if (pending.value || props.disabled) return
  const previous = props.archived
  pending.value = true
  error.value = ''
  emit('update:archived', value)
  try {
    await api.patch(props.strandId, { archived: value })
    undo.value = isUndo ? null : previous
    if (undoTimer) clearTimeout(undoTimer)
    if (!isUndo) undoTimer = setTimeout(() => { undo.value = null }, 8000)
    emit('changed')
  } catch (cause) {
    emit('update:archived', previous)
    error.value = t(strandErrorKey(cause))
  } finally { pending.value = false }
}
async function loadPreview() {
  pending.value = true
  error.value = ''
  deleteFacts.value = false
  try { preview.value = await api.preview(props.strandId) }
  catch (cause) { error.value = t(strandErrorKey(cause)) }
  finally { pending.value = false }
}
async function remove() {
  if (!preview.value || pending.value) return
  pending.value = true
  error.value = ''
  try {
    await api.remove(props.strandId, deleteFacts.value)
    confirming.value = false
    preview.value = null
    emit('deleted', props.strandId)
  } catch (cause) {
    confirming.value = false
    error.value = t(strandErrorKey(cause))
  } finally { pending.value = false }
}
</script>

<template>
  <div class="space-y-2" @click.stop>
    <div class="flex flex-wrap gap-2">
      <Button class="min-h-11" variant="outline" :disabled="pending || disabled" @click="archive(!archived)">{{ t(archived ? 'strandDetail.restore' : 'strandDetail.archive') }}</Button>
      <Button class="min-h-11" variant="ghost" :disabled="pending || disabled" @click="loadPreview">{{ t('strandDetail.delete') }}</Button>
    </div>
    <div v-if="undo !== null" role="status" class="flex flex-wrap items-center gap-2 text-sm">
      {{ t(archived ? 'strandDetail.archived' : 'strandDetail.restored') }}
      <Button class="min-h-11" variant="outline" :disabled="pending || disabled" @click="archive(undo!, true)">{{ t('strandDetail.undo') }}</Button>
    </div>
    <p v-if="pending" role="status" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
    <Alert v-if="error" variant="destructive" role="alert"><AlertDescription>{{ error }}</AlertDescription><Button class="min-h-11" variant="ghost" @click="error = ''">{{ t('strandDetail.dismiss') }}</Button></Alert>
    <section v-if="preview" class="space-y-3 rounded-lg border border-border bg-card p-4" :aria-label="t('strandDetail.deletePreview')">
      <h3 class="font-semibold">{{ t('strandDetail.deletePreview') }}</h3>
      <p class="text-sm">{{ counts }}</p>
      <p class="text-sm text-muted-foreground">{{ t('strandDetail.keepFacts') }}</p>
      <label class="flex min-h-11 cursor-pointer items-center gap-3 text-sm"><input v-model="deleteFacts" type="checkbox" :disabled="pending" class="h-5 w-5 accent-destructive">{{ t('strandDetail.deleteFacts') }}</label>
      <div class="flex flex-wrap gap-2">
        <Button class="min-h-11" variant="outline" :disabled="pending" @click="preview = null">{{ t('common.cancel') }}</Button>
        <Button class="min-h-11" variant="destructive" :disabled="pending || disabled" @click="confirming = true">{{ t('strandDetail.delete') }}</Button>
      </div>
    </section>
    <ConfirmDialog :open="confirming" :title="t('strandDetail.deleteTitle')" :description="counts + ' ' + t(deleteFacts ? 'strandDetail.confirmWithFacts' : 'strandDetail.confirmKeepFacts')" :confirm-label="t('strandDetail.delete')" :loading="pending" destructive class="[&_button]:min-h-11" @confirm="remove" @cancel="!pending && (confirming = false)" />
  </div>
</template>
