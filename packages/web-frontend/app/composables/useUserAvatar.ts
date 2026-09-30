/**
 * Shared composable for the current user's avatar.
 * Provides a reactive URL with cache-busting and a refresh method
 * that can be called after linking/unlinking a Telegram user.
 */
const avatarVersion = ref(0)
const avatarFailed = ref(false)

export function useUserAvatar() {
  const { user, getAccessToken } = useAuth()
  const config = useRuntimeConfig()

  const userInitial = computed(() => user.value?.username?.charAt(0).toUpperCase() ?? '?')

  const userAvatarUrl = computed(() => {
    if (!user.value?.id) return null
    const token = getAccessToken()
    if (!token) return null

    // Include avatarVersion so the URL changes on refresh
    const version = avatarVersion.value
    return `${config.public.apiBase}/api/telegram-users/avatar-by-user-id/${user.value.id}?token=${token}&v=${version}`
  })

  function refreshAvatar() {
    avatarFailed.value = false
    avatarVersion.value++
  }

  function onAvatarError() {
    avatarFailed.value = true
  }

  return {
    userAvatarUrl,
    avatarFailed: readonly(avatarFailed),
    userInitial,
    refreshAvatar,
    onAvatarError,
  }
}
