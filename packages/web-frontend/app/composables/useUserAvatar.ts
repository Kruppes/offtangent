/**
 * Shared composable for the current user's avatar.
 * Provides a reactive URL with cache-busting and a refresh method
 * that can be called after linking/unlinking a Telegram user.
 *
 * The URL is only built when the server reported a picture
 * (`user.hasAvatar` from `GET /api/auth/me`). Without one the views show the
 * initial right away instead of requesting an image that answers 404.
 */
const avatarVersion = ref(0)
const avatarFailed = ref(false)
/** User id whose `hasAvatar` is being fetched, so callers ask only once. */
let avatarLookupFor: number | null = null

export function useUserAvatar() {
  const { user, getAccessToken, reloadUser } = useAuth()
  const config = useRuntimeConfig()

  const userInitial = computed(() => user.value?.username?.charAt(0).toUpperCase() ?? '?')

  const userAvatarUrl = computed(() => {
    if (!user.value?.id || user.value.hasAvatar !== true) return null
    const token = getAccessToken()
    if (!token) return null

    // Include avatarVersion so the URL changes on refresh
    const version = avatarVersion.value
    return `${config.public.apiBase}/api/telegram-users/avatar-by-user-id/${user.value.id}?token=${token}&v=${version}`
  })

  // A user cached before `hasAvatar` existed (or fresh from login/refresh,
  // which do not report it) asks `/me` once.
  if (!import.meta.server && user.value?.id && user.value.hasAvatar === undefined && avatarLookupFor !== user.value.id) {
    avatarLookupFor = user.value.id
    void reloadUser()
  }

  async function refreshAvatar() {
    await reloadUser()
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
