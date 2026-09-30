import { afterEach, describe, expect, it, vi } from 'vitest'
import { useApi, ApiError } from './useApi'

afterEach(() => vi.unstubAllGlobals())
function setup() {
  vi.stubGlobal('useAuth', () => ({ getAccessToken: () => 'unit-token', refreshAccessToken: vi.fn(), logout: vi.fn() }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://example.test' } }))
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  return { fetch, ...useApi() }
}

describe('API transport for capture uploads and feed mutations', () => {
  it('accepts an empty 204 read acknowledgment without parsing JSON', async () => {
    const { fetch, apiFetch } = setup()
    fetch.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(apiFetch('/api/feed/1/read', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('lets the browser generate the multipart boundary for uploads', async () => {
    const { fetch, apiFetch } = setup()
    fetch.mockResolvedValue(Response.json({ files: [] }))
    const body = new FormData()
    body.append('files', new Blob(['example']), 'note.txt')
    await apiFetch('/api/uploads', { method: 'POST', body })
    const options = fetch.mock.calls[0]![1]!
    expect(options.body).toBe(body)
    expect(options.headers).toEqual({ Authorization: 'Bearer unit-token' })
  })

  it('preserves the server size-limit error and status', async () => {
    const { fetch, apiFetch } = setup()
    fetch.mockResolvedValue(Response.json({ error: 'File is too large', code: 'file_too_large' }, { status: 413 }))
    const error = await apiFetch('/api/uploads', { method: 'POST', body: new FormData() }).catch(error => error)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: 'File is too large', status: 413, body: { code: 'file_too_large' } })
  })
})
