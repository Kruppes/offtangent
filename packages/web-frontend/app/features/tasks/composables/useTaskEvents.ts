import { ref, onUnmounted } from 'vue'
import type { TaskEventItem, TaskInfo } from '~/api/tasks'
import { useTasksApi } from '~/api/tasks'

/** Persisted timeline polling uses the server's two-source cursor, never timestamps. */
export function useTaskEvents() {
  const tasksApi = useTasksApi()
  const events = ref<TaskEventItem[]>([])
  const taskInfo = ref<TaskInfo | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const isLive = ref(false)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let since: string | undefined

  async function loadTaskEvents(taskId: string) {
    disconnect()
    const requestGeneration = generation
    events.value = []
    taskInfo.value = null
    since = undefined
    loading.value = true
    error.value = null
    await poll(taskId, requestGeneration)
  }

  async function poll(taskId: string, requestGeneration: number): Promise<void> {
    try {
      const data = await tasksApi.getTaskEvents(taskId, since)
      if (requestGeneration !== generation) return
      // Advance only after successfully applying the response. A failed poll
      // retries the same cursor; an empty delta still refreshes live metrics.
      events.value.push(...normalizeRestEvents(data.events))
      since = data.nextSince
      taskInfo.value = data.task
      isLive.value = data.task.status === 'running' || data.task.status === 'paused'
      error.value = null
    } catch (err) {
      if (requestGeneration !== generation) return
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      if (requestGeneration === generation) {
        loading.value = false
        if (isLive.value || error.value) {
          timer = setTimeout(() => { void poll(taskId, requestGeneration) }, 2000)
        }
      }
    }
  }

  function normalizeRestEvents(rawEvents: TaskEventItem[]): TaskEventItem[] {
    return rawEvents.map((event) => {
      if (event.type === 'tool_call') {
        return {
          type: 'tool_call_end' as const,
          timestamp: event.timestamp,
          toolName: event.toolName,
          toolArgs: safeParseJson(event.input),
          toolResult: safeParseJson(event.output),
          toolIsError: event.status === 'error',
          durationMs: event.durationMs,
        }
      }

      if (event.type === 'message') {
        const metadata = event.metadata as Record<string, unknown> | null
        const thinking = metadata?.thinking as string | undefined

        return {
          type: 'text_delta' as const,
          timestamp: event.timestamp,
          text: event.content,
          role: event.role,
          thinking,
        }
      }

      return event
    })
  }

  function disconnect() {
    generation += 1
    clearTimeout(timer)
    timer = undefined
    isLive.value = false
  }

  onUnmounted(disconnect)
  return { events, taskInfo, loading, error, isLive, loadTaskEvents, disconnect }
}

function safeParseJson(rawValue: string | undefined | null): unknown {
  if (!rawValue) return null

  try {
    return JSON.parse(rawValue)
  } catch {
    return rawValue
  }
}
