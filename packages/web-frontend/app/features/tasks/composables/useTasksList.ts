import type { Task, TaskProviderFilterOption } from '~/api/tasks'
import { useTasksApi } from '~/api/tasks'
import { createDefaultTaskDateRange, formatTaskCreatedAtBoundary } from '../utils/dateFilters'

export const TASK_DEFAULT_PROVIDER_FILTER = '__default__'

export function encodeTaskProviderModelFilter(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}|${encodeURIComponent(model)}`
}

function decodeTaskProviderModelFilter(value: string): { provider: string; model: string } | null {
  const [provider, model] = value.split('|')
  if (!provider || !model) return null

  return {
    provider: decodeURIComponent(provider),
    model: decodeURIComponent(model),
  }
}

export function useTasksList() {
  const tasksApi = useTasksApi()

  const tasks = ref<Task[]>([])
  const providerOptions = ref<TaskProviderFilterOption[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const pagination = ref({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  })

  const defaultDateRange = createDefaultTaskDateRange()
  const filters = reactive({
    status: '' as string,
    triggerType: '' as string,
    providerFilter: '' as string,
    createdFrom: defaultDateRange.createdFrom,
    createdTo: defaultDateRange.createdTo,
  })

  const activeFilterCount = computed(() => {
    let count = 0
    if (filters.status) count++
    if (filters.triggerType) count++
    if (filters.providerFilter) count++
    if (
      filters.createdFrom !== defaultDateRange.createdFrom
      || filters.createdTo !== defaultDateRange.createdTo
    ) count++
    return count
  })

  const sortField = ref<string>('createdAt')
  const sortDirection = ref<'asc' | 'desc'>('desc')

  let pollTimer: ReturnType<typeof setInterval> | null = null

  const hasRunningTasks = computed(() =>
    tasks.value.some(task => task.status === 'running'),
  )

  function isProviderFilterAvailable(value: string): boolean {
    if (!value) return true
    if (value === TASK_DEFAULT_PROVIDER_FILTER) {
      return providerOptions.value.some(option => option.isDefaultModel === true)
    }

    const decoded = decodeTaskProviderModelFilter(value)
    if (!decoded) return false

    return providerOptions.value.some(option =>
      option.provider === decoded.provider && option.model === decoded.model,
    )
  }

  async function loadTasks(
    page: number = 1,
    { silent = false, allowProviderReset = true }: { silent?: boolean; allowProviderReset?: boolean } = {},
  ) {
    if (!silent) {
      loading.value = true
    }
    error.value = null

    try {
      const providerFilter = filters.providerFilter === TASK_DEFAULT_PROVIDER_FILTER
        ? { isDefaultModel: true }
        : decodeTaskProviderModelFilter(filters.providerFilter) ?? {}

      const data = await tasksApi.listTasks({
        page,
        limit: pagination.value.limit,
        status: filters.status || undefined,
        triggerType: filters.triggerType || undefined,
        ...providerFilter,
        createdFrom: formatTaskCreatedAtBoundary(filters.createdFrom, 'start'),
        createdTo: formatTaskCreatedAtBoundary(filters.createdTo, 'end'),
      })

      providerOptions.value = data.providerOptions ?? []

      if (!silent && allowProviderReset && filters.providerFilter && !isProviderFilterAvailable(filters.providerFilter)) {
        filters.providerFilter = ''
        await loadTasks(1, { silent, allowProviderReset: false })
        return
      }

      tasks.value = data.tasks
      pagination.value = data.pagination
    } catch (err) {
      if (!silent) {
        error.value = (err as Error).message
      }
    } finally {
      if (!silent) {
        loading.value = false
      }
    }
  }

  async function killTask(id: string): Promise<boolean> {
    try {
      await tasksApi.killTask(id)
      await loadTasks(pagination.value.page)
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  function sortBy(field: string) {
    if (sortField.value === field) {
      sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortField.value = field
      sortDirection.value = field === 'createdAt' ? 'desc' : 'asc'
    }
  }

  const sortedTasks = computed(() => {
    const field = sortField.value
    const directionMultiplier = sortDirection.value === 'asc' ? 1 : -1

    return [...tasks.value].sort((leftTask, rightTask) => {
      const leftValue: unknown = (leftTask as Record<string, unknown>)[field]
      const rightValue: unknown = (rightTask as Record<string, unknown>)[field]

      if (leftValue == null && rightValue == null) return 0
      if (leftValue == null) return 1
      if (rightValue == null) return -1

      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return (leftValue - rightValue) * directionMultiplier
      }

      return String(leftValue).localeCompare(String(rightValue)) * directionMultiplier
    })
  })

  function startPolling(intervalMs: number = 5000) {
    stopPolling()

    pollTimer = setInterval(() => {
      if (hasRunningTasks.value || tasks.value.length === 0) {
        loadTasks(pagination.value.page, { silent: true })
      }
    }, intervalMs)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    tasks,
    providerOptions,
    sortedTasks,
    loading,
    error,
    pagination,
    filters,
    activeFilterCount,
    sortField,
    sortDirection,
    hasRunningTasks,
    loadTasks,
    killTask,
    sortBy,
    startPolling,
    stopPolling,
  }
}
