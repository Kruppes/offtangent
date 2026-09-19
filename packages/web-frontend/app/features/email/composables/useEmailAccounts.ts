import type { EmailAccount, EmailAccountPayload } from '~/api/email'
import { useEmailApi } from '~/api/email'

export function useEmailAccounts() {
  const emailApi = useEmailApi()

  const accounts = ref<EmailAccount[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchAccounts(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const data = await emailApi.listAccounts()
      accounts.value = data.accounts
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function createAccount(payload: EmailAccountPayload): Promise<boolean> {
    error.value = null
    try {
      await emailApi.createAccount(payload)
      await fetchAccounts()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function updateAccount(id: string, payload: Partial<EmailAccountPayload>): Promise<boolean> {
    error.value = null
    try {
      await emailApi.updateAccount(id, payload)
      await fetchAccounts()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function deleteAccount(id: string): Promise<boolean> {
    error.value = null
    try {
      await emailApi.deleteAccount(id)
      await fetchAccounts()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  return { accounts, loading, error, fetchAccounts, createAccount, updateAccount, deleteAccount }
}
