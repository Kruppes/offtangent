export interface User {
  id: number
  username: string
  role: string
  telegramId: string | null
  createdAt: string
  updatedAt: string
}

export function useUsers() {
  const { apiFetch } = useApi()

  const users = ref<User[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchUsers(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const data = await apiFetch<{ users: User[] }>('/api/users')
      users.value = data.users
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function createUser(username: string, password: string, role: string): Promise<boolean> {
    error.value = null
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, role }),
      })
      await fetchUsers()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function updateUser(id: number, updates: { role?: string; password?: string }): Promise<boolean> {
    error.value = null
    try {
      await apiFetch(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      })
      await fetchUsers()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function deleteUser(id: number): Promise<boolean> {
    error.value = null
    try {
      await apiFetch(`/api/users/${id}`, {
        method: 'DELETE',
      })
      await fetchUsers()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  return {
    users,
    loading,
    error,
    fetchUsers,
    createUser,
    updateUser,
    deleteUser,
  }
}
