import type { MemoryFact, MemoryFactsQuery } from '~/api/memory'
import { useMemoryApi } from '~/api/memory'

export type LoadMemoryFactsOptions = MemoryFactsQuery

export function useMemoryFacts() {
  const memoryApi = useMemoryApi()

  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  async function loadFacts(options: LoadMemoryFactsOptions = {}): Promise<{ facts: MemoryFact[]; total: number }> {
    loading.value = true
    error.value = null

    try {
      return await memoryApi.listFacts(options)
    } catch (err) {
      error.value = (err as Error).message
      return { facts: [], total: 0 }
    } finally {
      loading.value = false
    }
  }

  async function updateFact(id: number, content: string): Promise<boolean> {
    saving.value = true
    error.value = null

    try {
      await memoryApi.updateFact(id, content)
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function deleteFact(id: number): Promise<boolean> {
    saving.value = true
    error.value = null

    try {
      await memoryApi.deleteFact(id)
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  return {
    loading,
    saving,
    error,
    loadFacts,
    updateFact,
    deleteFact,
  }
}

export type { MemoryFact }
