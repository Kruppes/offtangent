export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return

  const { isAuthenticated, validateSession } = useAuth()

  // Allow access to login page without auth
  if (to.path === '/login') {
    if (isAuthenticated.value) {
      return navigateTo('/')
    }
    return
  }

  // If the token looks valid (exists + not expired), allow navigation.
  // On the very first navigation after page load, validateSession() will
  // also verify the token server-side (handled inside validateSession).
  if (isAuthenticated.value) {
    // Still run server-side validation on first load (non-blocking for
    // subsequent navigations since sessionValidated will be true).
    await validateSession()

    // Re-check after validation — validateSession may have cleared auth
    // if the server rejected the token.
    if (isAuthenticated.value) {
      return
    }
  }

  // Token is missing or expired — try to refresh / validate
  const valid = await validateSession()
  if (valid) {
    return
  }

  return navigateTo('/login')
})
