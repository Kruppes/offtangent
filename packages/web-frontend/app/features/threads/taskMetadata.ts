import type { Task } from '../../api/tasks'

export type TaskMetadata = Pick<Task, 'model' | 'provider'>

/** Panel-scoped cache: deduplicate requests, including errors, across live ticks
 * and collapse/expand. Discarded on unmount; never caches prompts or usage. */
export function createTaskMetadataCache(getTask: (id: string) => Promise<{ task: Task }>) {
  const entries = new Map<string, Promise<TaskMetadata | null>>()
  return (id: string): Promise<TaskMetadata | null> => {
    let entry = entries.get(id)
    if (!entry) {
      entry = getTask(id).then(({ task }) => ({ model: task.model, provider: task.provider })).catch(() => null)
      entries.set(id, entry)
    }
    return entry
  }
}
