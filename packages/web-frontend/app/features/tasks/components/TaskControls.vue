<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useTasksApi, TASK_REPLY_MAX_LENGTH, type TaskEventItem, type TaskInfo } from '~/api/tasks'
import { checkReply, pendingQuestion, statusKey, taskActions } from '../taskControls'

/**
 * Status, result and the two actions of a task detail (the app's task detail
 * screen): stop with a confirmation step, and answer a paused task. Texts are
 * rendered as text; nothing here uses v-html.
 */
const props = defineProps<{ task: TaskInfo; events: TaskEventItem[] }>()
/** `changed` carries the notice key; the parent shows it, because it reloads the task (and this component) afterwards. */
const emit = defineEmits<{ changed: [notice: string]; followUp: [taskId: string] }>()
const api = useTasksApi()
const actions = computed(() => taskActions(props.task.status))
const key = computed(() => statusKey(props.task.status))
const question = computed(() => actions.value.canAnswer ? pendingQuestion(props.events) : null)
const confirming = ref(false)
const stopping = ref(false)
const reply = ref('')
const sending = ref(false)
const error = ref('')
const replyError = ref('')
const confirmButton = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const stopButton = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
function focusEl(target: { $el?: HTMLElement } | HTMLElement | null) {
  const el = target && '$el' in target ? target.$el : target
  ;(el as HTMLElement | undefined)?.focus?.()
}
function askStop() {
  confirming.value = true; error.value = ''
  void nextTick(() => focusEl(confirmButton.value))
}
function cancelStop() {
  confirming.value = false
  void nextTick(() => focusEl(stopButton.value))
}
async function stop() {
  stopping.value = true; error.value = ''
  try {
    await api.killTask(props.task.id)
    confirming.value = false
    emit('changed', 'tasks.detail.stopped')
  } catch { error.value = 'tasks.detail.stopError' }
  finally { stopping.value = false }
}
async function send() {
  replyError.value = ''; error.value = ''
  const checked = checkReply(reply.value)
  if (!checked.ok) { replyError.value = `tasks.detail.reply.${checked.reason}`; return }
  sending.value = true
  try {
    const result = await api.replyToTask(props.task.id, checked.text)
    reply.value = ''
    if (result.outcome === 'follow_up' && result.followUpTaskId) emit('followUp', result.followUpTaskId)
    else emit('changed', 'tasks.detail.reply.sent')
  } catch (err) {
    error.value = (err as { status?: number }).status === 409 ? 'tasks.detail.reply.running' : 'tasks.detail.reply.error'
  } finally { sending.value = false }
}
</script>

<template>
  <section class="space-y-3 border-b border-border px-3 py-3 md:px-5" data-testid="task-controls" :aria-label="$t('tasks.detail.label')">
    <p class="text-sm" role="status" data-testid="task-status-line">
      <span class="font-medium">{{ $t(`tasks.detail.status.${key}`) }}</span>
    </p>
    <div v-if="task.resultSummary || task.errorMessage" class="space-y-1 rounded-lg border border-border bg-card p-3 [overflow-wrap:anywhere]" data-testid="task-result">
      <h3 class="text-sm font-semibold">{{ $t(task.errorMessage && !task.resultSummary ? 'tasks.detail.errorHeading' : 'tasks.detail.resultHeading') }}</h3>
      <p v-if="task.resultSummary" class="measure whitespace-pre-wrap text-sm">{{ task.resultSummary }}</p>
      <p v-if="task.errorMessage" class="measure whitespace-pre-wrap text-sm text-destructive">{{ task.errorMessage }}</p>
    </div>
    <p v-if="error" role="alert" class="rounded-md border border-destructive p-2 text-sm">{{ $t(error) }}</p>

    <form v-if="actions.canAnswer" class="space-y-2 rounded-lg border border-primary p-3" data-testid="task-reply" @submit.prevent="send">
      <p v-if="question" class="measure whitespace-pre-wrap text-sm [overflow-wrap:anywhere]"><span class="font-medium">{{ $t('tasks.detail.reply.question') }}</span> {{ question }}</p>
      <label for="task-reply-text" class="block text-sm font-medium">{{ $t('tasks.detail.reply.label') }}</label>
      <textarea id="task-reply-text" v-model="reply" rows="3" :maxlength="TASK_REPLY_MAX_LENGTH" :disabled="sending" :aria-invalid="replyError ? 'true' : undefined" :aria-describedby="replyError ? 'task-reply-error' : undefined"
        class="block w-full resize-y rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @keydown="(e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); send() } }" />
      <p v-if="replyError" id="task-reply-error" class="text-sm text-destructive">{{ $t(replyError) }}</p>
      <Button type="submit" class="min-h-11" :disabled="sending">{{ $t(sending ? 'tasks.detail.reply.sending' : 'tasks.detail.reply.send') }}</Button>
    </form>

    <div v-if="actions.canStop" class="flex flex-wrap items-center gap-2">
      <Button v-if="!confirming" ref="stopButton" variant="outline" class="min-h-11" data-testid="task-stop" @click="askStop">{{ $t('tasks.detail.stop') }}</Button>
      <div v-else role="group" aria-labelledby="task-stop-confirm" class="flex flex-wrap items-center gap-2 rounded-lg border border-destructive p-2" data-testid="task-stop-confirm" @keydown.esc="cancelStop">
        <p id="task-stop-confirm" class="text-sm">{{ $t('tasks.detail.stopConfirm') }}</p>
        <Button ref="confirmButton" variant="destructive" class="min-h-11" :disabled="stopping" data-testid="task-stop-yes" @click="stop">{{ $t('tasks.detail.stopYes') }}</Button>
        <Button variant="ghost" class="min-h-11" :disabled="stopping" @click="cancelStop">{{ $t('common.cancel') }}</Button>
      </div>
    </div>
  </section>
</template>
