interface User {
  id: number
  username: string
  role: string
}

interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: User
}

const TOKEN_KEY = 'axiom_access_token'
const REFRESH_TOKEN_KEY = 'axiom_refresh_token'
const USER_KEY = 'axiom_user'

/**
 * Decode the JWT payload and check if the token is expired.
 * Returns true if expired or unparseable. Uses a 30-second safety margin
 * so we refresh *before* the backend rejects the token.
 */
function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) return true
    const payload = JSON.parse(atob(parts[1])) as { exp?: number }
    if (!payload.exp) return true
    // Expire 30 seconds early to avoid race conditions
    return payload.exp * 1000 <= Date.now() + 30_000
  } catch {
    return true
  }
}

/**
 * Shared across all useAuth() callers on the page: only one refresh request may
 * be in flight, otherwise parallel 401 retries would replay the same refresh
 * token (see refreshAccessToken).
 */
let refreshInFlight: Promise<boolean> | null = null

export function useAuth() {
  const user = useState<User | null>('auth_user', () => {
    if (import.meta.client) {
      const stored = localStorage.getItem(USER_KEY)
      if (stored) {
        try {
          return JSON.parse(stored)
        } catch {
          localStorage.removeItem(USER_KEY)
          localStorage.removeItem(TOKEN_KEY)
          localStorage.removeItem(REFRESH_TOKEN_KEY)
          return null
        }
      }
    }
    return null
  })

  const accessToken = useState<string | null>('auth_token', () => {
    if (import.meta.client) {
      return localStorage.getItem(TOKEN_KEY)
    }
    return null
  })

  // Track whether we have performed the initial server-side validation
  const sessionValidated = useState<boolean>('auth_session_validated', () => false)

  const isAuthenticated = computed(() => {
    const token = accessToken.value
    if (!token) return false
    return !isTokenExpired(token)
  })

  function setAuth(data: LoginResponse) {
    accessToken.value = data.accessToken
    user.value = data.user
    localStorage.setItem(TOKEN_KEY, data.accessToken)
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken)
    localStorage.setItem(USER_KEY, JSON.stringify(data.user))
  }

  function clearAuth() {
    accessToken.value = null
    user.value = null
    sessionValidated.value = false
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  }

  function getAccessToken(): string | null {
    return accessToken.value
  }

  function getRefreshToken(): string | null {
    if (import.meta.client) {
      return localStorage.getItem(REFRESH_TOKEN_KEY)
    }
    return null
  }

  async function performRefresh(): Promise<boolean> {
    const refresh = getRefreshToken()
    if (!refresh) return false

    try {
      const config = useRuntimeConfig()
      const res = await fetch(`${config.public.apiBase}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      })

      if (!res.ok) return false

      const data = (await res.json()) as LoginResponse
      setAuth(data)
      return true
    } catch {
      return false
    }
  }

  /**
   * Refresh the access token. Concurrent callers share one in-flight request:
   * the backend rotates refresh tokens, and sending the same (already rotated)
   * token twice trips server-side reuse detection and kills the session.
   */
  async function refreshAccessToken(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }

  /**
   * Validate the current session. Checks token expiry client-side and,
   * on first call after page load, also validates against the backend
   * to ensure the user still exists and the token is accepted.
   *
   * Returns true if the session is valid (possibly after a refresh).
   */
  async function validateSession(): Promise<boolean> {
    // Re-sync token from localStorage in case state drifted
    if (import.meta.client) {
      const stored = localStorage.getItem(TOKEN_KEY)
      if (stored && stored !== accessToken.value) {
        accessToken.value = stored
      }
    }

    const token = accessToken.value

    // No token at all — check if we can refresh
    if (!token) {
      const refreshed = await refreshAccessToken()
      if (!refreshed) {
        clearAuth()
        return false
      }
      sessionValidated.value = true
      return true
    }

    // Token is expired — try to refresh
    if (isTokenExpired(token)) {
      const refreshed = await refreshAccessToken()
      if (!refreshed) {
        clearAuth()
        return false
      }
      sessionValidated.value = true
      return true
    }

    // Token looks valid client-side. On first load, also verify server-side
    // to catch deleted users or revoked tokens.
    if (!sessionValidated.value) {
      try {
        const config = useRuntimeConfig()
        const res = await fetch(`${config.public.apiBase}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (res.ok) {
          const data = (await res.json()) as { user: User }
          // Update user data in case it changed (e.g. role change)
          user.value = data.user
          localStorage.setItem(USER_KEY, JSON.stringify(data.user))
          sessionValidated.value = true
          return true
        }

        // Token rejected by server — try refresh
        const refreshed = await refreshAccessToken()
        if (!refreshed) {
          clearAuth()
          return false
        }
        sessionValidated.value = true
        return true
      } catch {
        // Network error (backend unreachable) — clear auth so we don't
        // show stale cached data behind a login wall.
        clearAuth()
        return false
      }
    }

    return true
  }

  async function login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const config = useRuntimeConfig()
      const res = await fetch(`${config.public.apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return { success: false, error: (body as { error?: string }).error || 'Login failed' }
      }

      const data = (await res.json()) as LoginResponse
      setAuth(data)
      sessionValidated.value = true
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /**
   * Revoke the refresh token server-side, then drop the local session.
   * Best effort: if the backend is unreachable we still log out locally.
   */
  async function revokeRefreshToken(): Promise<void> {
    const token = accessToken.value
    const refresh = getRefreshToken()
    if (!token || !refresh) return
    try {
      const config = useRuntimeConfig()
      await fetch(`${config.public.apiBase}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ refreshToken: refresh }),
      })
    } catch {
      // ignore — local logout must not depend on the network
    }
  }

  async function logout() {
    await revokeRefreshToken()
    clearAuth()
    navigateTo('/login')
  }

  return {
    user,
    accessToken,
    isAuthenticated,
    login,
    logout,
    getAccessToken,
    refreshAccessToken,
    validateSession,
  }
}
