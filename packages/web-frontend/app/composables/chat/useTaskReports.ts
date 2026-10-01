import { ref } from 'vue'
import type { ChatMessage } from '~/composables/useChat'

/** The task card body without its first (title) line. */
export function taskResultBody(content: string): string {
  const lines = (content ?? '').split('\n')
  const bodyLines = lines.slice(1)
  while (bodyLines.length > 0 && bodyLines[0]!.trim() === '') bodyLines.shift()
  return bodyLines.join('\n') || content
}

/**
 * Expanded full reports of task cards, keyed by message index. The stream
 * only carries a preview; the rest is fetched from `GET /api/tasks/:id` on
 * first expand.
 */
export function useTaskReports(emptyText: () => string) {
  const { apiFetch } = useApi()
  const taskReports = ref<Map<number, string>>(new Map())
  const taskReportLoading = ref<Set<number>>(new Set())
  const taskReportError = ref<Map<number, boolean>>(new Map())

  function taskResultVisibleBody(msg: ChatMessage, index: number): string {
    const full = taskReports.value.get(index)
    if (full) return full
    const body = taskResultBody(msg.content)
    // The persisted content ends with a pointer line ("…N more characters —
    // open the task card…") for clients without this card. Here the button
    // right below says the same thing, so drop it.
    return msg.taskResultTruncated
      ? body.replace(/\n*…\d+ more characters[^\n]*$/, '').trimEnd()
      : body
  }

  async function toggleTaskReport(msg: ChatMessage, index: number) {
    if (taskReports.value.has(index)) {
      const next = new Map(taskReports.value)
      next.delete(index)
      taskReports.value = next
      return
    }
    const taskId = msg.taskResultTaskId
    if (!taskId || taskReportLoading.value.has(index)) return

    taskReportLoading.value = new Set(taskReportLoading.value).add(index)
    const errors = new Map(taskReportError.value)
    errors.delete(index)
    taskReportError.value = errors
    try {
      const res = await apiFetch<{ task: { resultSummary?: string | null; errorMessage?: string | null } }>(`/api/tasks/${taskId}`)
      const body = res.task?.resultSummary || res.task?.errorMessage || emptyText()
      taskReports.value = new Map(taskReports.value).set(index, body)
    } catch {
      taskReportError.value = new Map(taskReportError.value).set(index, true)
    } finally {
      const loading = new Set(taskReportLoading.value)
      loading.delete(index)
      taskReportLoading.value = loading
    }
  }

  return { taskReports, taskReportLoading, taskReportError, taskResultVisibleBody, toggleTaskReport }
}
