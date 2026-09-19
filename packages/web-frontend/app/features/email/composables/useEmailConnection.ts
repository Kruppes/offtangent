import type { EmailConnectionPayload, EmailConnectionTestResult, EmailFolder, EmailProtocol } from '~/api/email'
import { useEmailApi } from '~/api/email'

export function useEmailConnection() {
  const emailApi = useEmailApi()

  const testing = ref<EmailProtocol | null>(null)
  const testResult = ref<EmailConnectionTestResult | null>(null)
  const testError = ref<string | null>(null)

  const folders = ref<EmailFolder[]>([])
  const foldersLoading = ref(false)
  const foldersError = ref<string | null>(null)

  async function testConnection(payload: EmailConnectionPayload, protocol: EmailProtocol): Promise<boolean> {
    testing.value = protocol
    testError.value = null
    try {
      const result = await emailApi.testConnection({ ...payload, protocol })
      testResult.value = { ...testResult.value, ...result }
      return result.ok
    } catch (err) {
      testError.value = (err as Error).message
      return false
    } finally {
      testing.value = null
    }
  }

  async function loadFolders(payload: EmailConnectionPayload): Promise<boolean> {
    foldersLoading.value = true
    foldersError.value = null
    try {
      const data = await emailApi.listFolders(payload)
      folders.value = data.folders
      return true
    } catch (err) {
      foldersError.value = (err as Error).message
      folders.value = []
      return false
    } finally {
      foldersLoading.value = false
    }
  }

  function reset(): void {
    testResult.value = null
    testError.value = null
    folders.value = []
    foldersError.value = null
  }

  return {
    testing,
    testResult,
    testError,
    testConnection,
    folders,
    foldersLoading,
    foldersError,
    loadFolders,
    reset,
  }
}
