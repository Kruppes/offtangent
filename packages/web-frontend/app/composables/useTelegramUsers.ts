export interface TelegramUser {
  id: number
  telegramId: string
  telegramUsername: string | null
  telegramDisplayName: string | null
  status: 'pending' | 'approved' | 'rejected'
  userId: number | null
  linkedUsername: string | null
  hasAvatar: boolean
  createdAt: string
  updatedAt: string
}

export function useTelegramUsers() {
  const { apiFetch } = useApi()

  const telegramUsers = ref<TelegramUser[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchTelegramUsers(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const data = await apiFetch<{ telegramUsers: TelegramUser[] }>('/api/telegram-users')
      telegramUsers.value = data.telegramUsers
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function updateTelegramUser(id: number, updates: { status?: string; userId?: number | null }): Promise<boolean> {
    error.value = null
    try {
      await apiFetch(`/api/telegram-users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      })
      await fetchTelegramUsers()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function deleteTelegramUser(id: number): Promise<boolean> {
    error.value = null
    try {
      await apiFetch(`/api/telegram-users/${id}`, {
        method: 'DELETE',
      })
      await fetchTelegramUsers()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  return {
    telegramUsers,
    loading,
    error,
    fetchTelegramUsers,
    updateTelegramUser,
    deleteTelegramUser,
  }
}
