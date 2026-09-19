import { useMemoryApi } from '~/api/memory'

export function useMemory() {
  const memoryApi = useMemoryApi()

  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  async function load(fetcher: () => Promise<{ content: string }>): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await fetcher()
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function save(saver: () => Promise<unknown>): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await saver()
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  function clearMessages() {
    error.value = null
    successMessage.value = null
  }

  return {
    loading,
    saving,
    error,
    successMessage,
    clearMessages,
    loadAgentRules: () => load(memoryApi.getAgentRules),
    saveAgentRules: (content: string) => save(() => memoryApi.updateAgentRules(content)),
    loadDefaultAgentRules: () => load(memoryApi.getDefaultAgentRules),
    loadHeartbeat: () => load(memoryApi.getHeartbeat),
    saveHeartbeat: (content: string) => save(() => memoryApi.updateHeartbeat(content)),
    loadDefaultHeartbeat: () => load(memoryApi.getDefaultHeartbeat),
    loadConsolidationRules: () => load(memoryApi.getConsolidationRules),
    saveConsolidationRules: (content: string) => save(() => memoryApi.updateConsolidationRules(content)),
    loadDefaultConsolidationRules: () => load(memoryApi.getDefaultConsolidationRules),
    loadTasksGuidelines: () => load(memoryApi.getTasksGuidelines),
    saveTasksGuidelines: (content: string) => save(() => memoryApi.updateTasksGuidelines(content)),
    loadDefaultTasksGuidelines: () => load(memoryApi.getDefaultTasksGuidelines),
  }
}
