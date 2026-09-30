import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '~/composables/useApi'
import { strandErrorKey, useStrandDetailApi } from './detailApi'
afterEach(() => vi.unstubAllGlobals())
describe('strand detail contracts', () => {
  it('uses encoded strand PATCH and explicit confirmed delete retaining facts by default', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ strand: { id: 'a/b' } })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const api = useStrandDetailApi()
    await api.patch('a/b', { archived: true })
    await api.preview('a/b')
    await api.remove('a/b')
    await api.remove('a/b', true)
    expect(apiFetch.mock.calls).toEqual([
      ['/api/strands/a%2Fb', { method: 'PATCH', body: '{"archived":true}' }],
      ['/api/strands/a%2Fb/delete-preview'],
      ['/api/strands/a%2Fb?confirm=1&delete_facts=0', { method: 'DELETE' }],
      ['/api/strands/a%2Fb?confirm=1&delete_facts=1', { method: 'DELETE' }],
    ])
  })
  it('uses thread endpoint for project edits and explicit suggestion actions', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ strand: {}, thread: {} })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const api = useStrandDetailApi()
    await api.project('s', null)
    await api.tags('s', ['tag'])
    await api.suggestion('s', 'accept')
    await api.suggestion('s', 'dismiss')
    expect(apiFetch.mock.calls).toEqual([
      ['/api/threads/s', { method: 'PATCH', body: '{"projectId":null}' }],
      ['/api/strands/s/tags', { method: 'PUT', body: '{"tags":["tag"]}' }],
      ['/api/strands/s/project-suggestion/accept', { method: 'POST' }],
      ['/api/strands/s/project-suggestion/dismiss', { method: 'POST' }],
    ])
  })
  it('maps conflicts without exposing raw service errors', () => {
    expect(strandErrorKey(new ApiError('raw', 409, { code: 'strand_busy' }))).toBe('strandDetail.busy')
    expect(strandErrorKey(new ApiError('raw', 409))).toBe('strandDetail.conflict')
    expect(strandErrorKey(new ApiError('raw', 404))).toBe('strandDetail.notFound')
    expect(strandErrorKey(new Error('secret'))).toBe('strandDetail.error')
  })
})
