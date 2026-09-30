import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref, readonly } from 'vue'
import { useConnectionStatus } from './useConnectionStatus'

afterEach(() => vi.unstubAllGlobals())
function setup(role: string) {
  const apiFetch = vi.fn().mockResolvedValue({ enabled: true, provider: { name: 'Provider', status: 'healthy' } })
  vi.stubGlobal('useApi', () => ({ apiFetch }))
  vi.stubGlobal('useAuth', () => ({ isAuthenticated: ref(true), user: ref({ role }) }))
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()))
  vi.stubGlobal('readonly', readonly)
  return { apiFetch, status: useConnectionStatus() }
}
describe('role-safe header health polling', () => {
  it('does not call the admin endpoint as a member', async () => {
    const { apiFetch, status } = setup('user')
    await status.poll()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(status.healthMonitorEnabled.value).toBe(false)
    expect(status.quota.value).toBeNull()
  })
  it('continues to show provider health for an administrator', async () => {
    const { apiFetch, status } = setup('admin')
    await status.poll()
    expect(apiFetch).toHaveBeenCalledWith('/api/health')
    expect(status.status.value).toBe('healthy')
    expect(status.providerName.value).toBe('Provider')
  })
})
