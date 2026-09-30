import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ProjectsView from './ProjectsView.vue'
import { useProjects } from './useProjects'
import type { Project } from '~/api/projects'

vi.mock('./useProjects', async (original) => {
  const actual = await original<typeof import('./useProjects')>()
  return { ...actual, useProjects: vi.fn(actual.useProjects) }
})
vi.mock('./ProjectFormDialog.vue', () => ({ default: defineComponent({ render: () => null }) }))

const project: Project = { id: 'project-1', name: 'House', color: '#345d5a', archived: false, threadCount: 128, createdAt: '', updatedAt: '' }
async function render(options: { projectId?: string; items?: Project[]; loading?: boolean; error?: boolean; archived?: boolean } = {}) {
  const { useProjects: actual } = await vi.importActual<typeof import('./useProjects')>('./useProjects')
  const state = actual({ list: vi.fn(), create: vi.fn(), update: vi.fn() })
  state.items.value = options.items ?? [project]
  state.loading.value = options.loading ?? false
  state.loadError.value = options.error ?? false
  state.archived.value = options.archived ?? false
  vi.mocked(useProjects).mockReturnValue(state)
  const app = createSSRApp(ProjectsView, { projectId: options.projectId })
  app.config.globalProperties.$t = ((key: string, params?: { count: number }) => `${key}${params?.count !== undefined ? `:${params.count}` : ''}`) as typeof app.config.globalProperties.$t
  for (const [name, tag] of Object.entries({ PageHeader: 'header', Alert: 'section', AlertDescription: 'p', Button: 'button', NuxtLink: 'a' })) {
    app.component(name, defineComponent({ setup: (_, { slots }) => () => h(tag, slots.default?.()) }))
  }
  app.component('ConfirmDialog', defineComponent({ render: () => null }))
  return renderToString(app)
}

describe('project views', () => {
  it('renders navigable projects, server counts and mutation actions', async () => {
    const html = await render()
    expect(html).toContain('/projects/project-1')
    expect(html).toContain('House')
    expect(html).toContain('projectsW3.strandCount:128')
    expect(html).toContain('projectsW3.edit')
    expect(html).toContain('projectsW3.archive')
    expect(html).toContain('min-h-[44px]')
  })
  it('renders archived projects distinctly and offers restore', async () => {
    const html = await render({ archived: true, items: [{ ...project, archived: true }] })
    expect(html).toContain('House')
    expect(html).toContain('projectsW3.restore')
    expect(html).toContain('aria-pressed="true"')
  })
  it('handles unknown detail IDs without showing unrelated projects', async () => {
    const html = await render({ projectId: 'missing' })
    expect(html).toContain('projectsW3.notFound')
    expect(html).not.toContain('House')
  })
  it('uses the all-project response for archived detail pages', async () => {
    const html = await render({ projectId: project.id, items: [{ ...project, archived: true }] })
    expect(html).toContain('House')
    expect(html).toContain('projectsW3.restore')
    expect(html).not.toContain('projectsW3.notFound')
  })
  it('exposes loading, errors and both empty states', async () => {
    expect(await render({ loading: true })).toContain('aria-busy="true"')
    const failed = await render({ error: true })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('common.retry')
    expect(await render({ items: [] })).toContain('projects.empty')
    expect(await render({ items: [], archived: true })).toContain('projectsW3.emptyArchived')
  })
})
