import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, readonly, ref, type Ref } from 'vue'

interface TestUser { id: number; username: string; role: string; hasAvatar?: boolean }

let user: Ref<TestUser | null>
let reloadUser: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  user = ref<TestUser | null>(null)
  reloadUser = vi.fn(async () => {})
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('readonly', readonly)
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'http://localhost:3000' } }))
  vi.stubGlobal('useAuth', () => ({ user, getAccessToken: () => 'test-token', reloadUser }))
})

afterEach(() => vi.unstubAllGlobals())

async function load() {
  const { useUserAvatar } = await import('./useUserAvatar')
  return useUserAvatar()
}

describe('useUserAvatar', () => {
  it('requests no image when the server reports no avatar, so the initial shows without a 404', async () => {
    user.value = { id: 1, username: 'admin', role: 'admin', hasAvatar: false }
    const avatar = await load()
    expect(avatar.userAvatarUrl.value).toBeNull()
    expect(avatar.userInitial.value).toBe('A')
    expect(reloadUser).not.toHaveBeenCalled()
  })

  it('builds the avatar URL when the server has a picture', async () => {
    user.value = { id: 1, username: 'admin', role: 'admin', hasAvatar: true }
    const avatar = await load()
    expect(avatar.userAvatarUrl.value).toBe('http://localhost:3000/api/telegram-users/avatar-by-user-id/1?token=test-token&v=0')
  })

  it('asks the server once when the cached user does not say whether an avatar exists', async () => {
    user.value = { id: 1, username: 'admin', role: 'admin' }
    const avatar = await load()
    expect(avatar.userAvatarUrl.value).toBeNull()
    await load()
    expect(reloadUser).toHaveBeenCalledTimes(1)

    user.value = { ...user.value, hasAvatar: true }
    expect(avatar.userAvatarUrl.value).toContain('/avatar-by-user-id/1?')
  })

  it('re-reads the user before retrying the image after a Telegram link change', async () => {
    user.value = { id: 1, username: 'admin', role: 'admin', hasAvatar: false }
    reloadUser.mockImplementation(async () => { user.value = { ...user.value!, hasAvatar: true } })
    const avatar = await load()
    avatar.onAvatarError()
    await avatar.refreshAvatar()
    expect(reloadUser).toHaveBeenCalledTimes(1)
    expect(avatar.avatarFailed.value).toBe(false)
    expect(avatar.userAvatarUrl.value).toBe('http://localhost:3000/api/telegram-users/avatar-by-user-id/1?token=test-token&v=1')
  })
})
