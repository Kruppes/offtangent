import { afterEach, describe, expect, it, vi } from 'vitest'
import { useProjectsApi, type Project } from '~/api/projects'
import { projectColor, useProjects, validateProject } from './useProjects'

const project = (patch: Partial<Project> = {}): Project => ({ id: 'p1', name: 'Home', color: null, archived: false, threadCount: 123, createdAt: '', updatedAt: '', ...patch })
function mockApi() {
  return { list: vi.fn().mockResolvedValue([project()]), create: vi.fn().mockResolvedValue(project()), update: vi.fn().mockResolvedValue(project()) }
}
afterEach(() => vi.unstubAllGlobals())

describe('project transport uses supported routes', () => {
  it('lists active or all projects and unwraps the server envelope', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ projects: [project()] })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const api = useProjectsApi()
    expect(await api.list()).toEqual([project()])
    await api.list(true)
    expect(apiFetch.mock.calls).toEqual([['/api/projects'], ['/api/projects?include_archived=1']])
  })
  it('creates and patches with encoded IDs, including null color and archive state', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ project: project() })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const api = useProjectsApi()
    expect(await api.create({ name: 'Home', color: '#345d5a' })).toEqual(project())
    expect(apiFetch).toHaveBeenLastCalledWith('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Home', color: '#345d5a' }) })
    await api.update('id/space here', { name: 'New', color: null, archived: true })
    expect(apiFetch).toHaveBeenLastCalledWith('/api/projects/id%2Fspace%20here', { method: 'PATCH', body: JSON.stringify({ name: 'New', color: null, archived: true }) })
  })
})

describe('projects state', () => {
  it('filters active and archived projects without estimating server strand counts', async () => {
    const api = mockApi()
    api.list.mockResolvedValue([project(), project({ id: 'p2', archived: true, threadCount: 41 })])
    const state = useProjects(api)
    await state.load()
    expect(api.list).toHaveBeenCalledWith(true)
    expect(state.visible.value.map(p => p.threadCount)).toEqual([123])
    state.archived.value = true
    expect(state.visible.value.map(p => p.threadCount)).toEqual([41])
  })
  it('supports load failures and retry', async () => {
    const api = mockApi()
    api.list.mockRejectedValueOnce(new Error('private server error'))
    const state = useProjects(api)
    await state.load()
    expect(state.loadError.value).toBe(true)
    expect(state.loading.value).toBe(false)
    await state.load()
    expect(state.loadError.value).toBe(false)
    expect(state.items.value).toHaveLength(1)
  })
  it('refreshes server counts without unmounting the list and its Undo panel', async () => {
    const api = mockApi()
    const state = useProjects(api)
    await state.load()
    api.list.mockResolvedValueOnce([project({ threadCount: 122 })])
    const pending = state.refreshCounts()
    expect(state.loading.value).toBe(false)
    await pending
    expect(state.items.value[0]?.threadCount).toBe(122)
  })
  it('ignores stale list responses', async () => {
    const api = mockApi()
    let resolve!: (value: Project[]) => void
    api.list.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const state = useProjects(api)
    const first = state.load()
    await state.load()
    resolve([])
    await first
    expect(state.items.value).toHaveLength(1)
  })
  it('normalizes create, rename and color removal while retaining server counts', async () => {
    const api = mockApi()
    const state = useProjects(api)
    expect(await state.save({ name: ' Home ', color: ' #ABCDEF ' })).toBe(true)
    expect(api.create).toHaveBeenCalledWith({ name: 'Home', color: '#abcdef' })
    expect(state.items.value[0]?.threadCount).toBe(123)
    expect(await state.save({ name: 'New', color: '' }, 'p1')).toBe(true)
    expect(api.update).toHaveBeenCalledWith('p1', { name: 'New', color: null })
  })
  it('rejects invalid forms without HTTP calls and preserves items on save errors', async () => {
    const api = mockApi()
    const state = useProjects(api)
    expect(await state.save({ name: ' ' })).toBe(false)
    expect(state.mutationError.value).toBe('nameError')
    expect(api.create).not.toHaveBeenCalled()
    await state.load()
    api.update.mockRejectedValueOnce(new Error('private'))
    expect(await state.save({ name: 'New' }, 'p1')).toBe(false)
    expect(state.items.value[0]?.name).toBe('Home')
    expect(state.mutationError.value).toBe('saveError')
    expect(state.saving.value).toBe(false)
  })
  it('archives and restores using returned project data', async () => {
    const api = mockApi()
    const state = useProjects(api)
    await state.load()
    api.update.mockResolvedValueOnce(project({ archived: true }))
    expect(await state.setArchived(project())).toBe(true)
    expect(api.update).toHaveBeenLastCalledWith('p1', { archived: true })
    expect(state.visible.value).toEqual([])
    expect(await state.setArchived(project({ archived: true }))).toBe(true)
    expect(api.update).toHaveBeenLastCalledWith('p1', { archived: false })
    expect(state.visible.value).toHaveLength(1)
  })
  it('keeps archive confirmation retryable after a failed request', async () => {
    const api = mockApi()
    const state = useProjects(api)
    await state.load()
    api.update.mockRejectedValueOnce(new Error('network'))
    expect(await state.setArchived(project())).toBe(false)
    expect(state.visible.value).toHaveLength(1)
    expect(state.mutationError.value).toBe('saveError')
  })
})

describe('backend-compatible project validation', () => {
  it('accepts 80 trimmed characters and rejects 81', () => {
    expect(validateProject({ name: ` ${'x'.repeat(80)} ` })).toBeNull()
    expect(validateProject({ name: 'x'.repeat(81) })).toBe('nameError')
  })
  it('only displays six-digit metadata colors', () => {
    expect(projectColor('#aAbBcC')).toBe('#aAbBcC')
    for (const color of ['#fff', 'red', 'url(https://example.com)', null]) expect(projectColor(color)).toBeUndefined()
    expect(validateProject({ name: 'Valid', color: '#fff' })).toBe('colorError')
    expect(validateProject({ name: 'Valid', color: null })).toBeNull()
  })
})
