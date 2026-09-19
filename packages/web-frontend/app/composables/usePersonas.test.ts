/**
 * The persona composable: what the screen does when the API answers, and what
 * it does when the API refuses.
 *
 * The second half is the point. Archiving a persona that is mid-turn answers
 * 409 `persona_busy`, and the user has to SEE that — a composable that
 * swallows the rejection and leaves the card looking archived is worse than
 * one that throws.
 *
 * Like useChat.test.ts, the Nuxt auto-imports (`ref`, `useApi`) are stubbed as
 * globals rather than mocked per module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const globals = globalThis as unknown as Record<string, unknown>

/** Calls the fake API recorded for assertions. */
let calls: Array<{ method: string; path: string; body?: unknown }> = []
/** Queue of responses; a string means "reject with this message". */
let responses: unknown[] = []

function nextResponse(method: string, path: string, body?: unknown): Promise<unknown> {
  calls.push({ method, path, body })
  const next = responses.shift()
  if (typeof next === 'string') return Promise.reject(new Error(next))
  return Promise.resolve(next)
}

beforeEach(() => {
  calls = []
  responses = []
  globals.ref = ref
  globals.useApi = () => ({
    apiFetch: (path: string, options: RequestInit = {}) =>
      nextResponse(options.method ?? 'GET', path, options.body ? JSON.parse(options.body as string) : undefined),
  })
})

afterEach(() => {
  delete globals.useApi
  delete globals.ref
  vi.restoreAllMocks()
})

async function loadComposable() {
  const module = await import('./usePersonas')
  return module.usePersonas()
}

function persona(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scout',
    displayName: 'Scout',
    color: '#4f8ef7',
    badge: '🧭',
    role: 'Finds things out.',
    isDefault: false,
    archived: false,
    fileCount: 5,
    hasTelegramBinding: false,
    ...overrides,
  }
}

describe('usePersonas', () => {
  it('loads the list and clears the loading flag', async () => {
    responses = [[persona()]]
    const personas = await loadComposable()
    await personas.fetchPersonas()

    expect(personas.personas.value).toHaveLength(1)
    expect(personas.loading.value).toBe(false)
    expect(personas.error.value).toBeNull()
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/personas' })
  })

  it('surfaces a failed list as a readable error and stops loading', async () => {
    responses = ['Admin access required']
    const personas = await loadComposable()
    await personas.fetchPersonas()

    expect(personas.error.value).toBe('Admin access required')
    expect(personas.loading.value).toBe(false)
    expect(personas.personas.value).toEqual([])
  })

  it('sends structured fields on create and refreshes the list afterwards', async () => {
    responses = [{ id: 'scout' }, [persona()]]
    const personas = await loadComposable()
    const result = await personas.createPersona({ id: 'scout', fields: { name: 'Scout' } })

    expect(result).toEqual({ id: 'scout' })
    expect(calls[0]).toMatchObject({
      method: 'POST', path: '/api/personas', body: { id: 'scout', fields: { name: 'Scout' } },
    })
    // The refresh is what keeps the card list honest after a write.
    expect(calls[1]).toMatchObject({ method: 'GET', path: '/api/personas' })
  })

  it('archives through the update endpoint rather than deleting', async () => {
    responses = [{ id: 'scout', archived: true }, [persona({ archived: true })]]
    const personas = await loadComposable()
    await personas.archivePersona('scout', true)

    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/personas/scout', body: { archived: true } })
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  })

  it('keeps a rejected archive visible instead of pretending it worked', async () => {
    responses = ['A turn of this persona is running']
    const personas = await loadComposable()
    const result = await personas.archivePersona('scout', true)

    expect(result).toBeNull()
    expect(personas.error.value).toBe('A turn of this persona is running')
    // No refresh: nothing changed, so the list must not flicker.
    expect(calls).toHaveLength(1)
  })

  it('confirms the hard delete on the wire', async () => {
    responses = [{ message: 'ok' }, []]
    const personas = await loadComposable()
    const ok = await personas.deletePersona('scout')

    expect(ok).toBe(true)
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/personas/scout?confirm=1' })
  })

  it('reports a refused delete as false with the reason', async () => {
    responses = ['The default persona cannot be deleted — promote another persona first']
    const personas = await loadComposable()
    const ok = await personas.deletePersona('main')

    expect(ok).toBe(false)
    expect(personas.error.value).toContain('default persona cannot be deleted')
  })

  it('reads the cascade preview before a delete', async () => {
    responses = [{ personaId: 'scout', strands: 3, messages: 40, tasks: 0, cronjobs: 1, facts: 7, captures: 2 }]
    const personas = await loadComposable()
    const preview = await personas.getDeletePreview('scout')

    expect(preview).toMatchObject({ strands: 3, facts: 7 })
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/personas/scout/delete-preview' })
  })

  it('promotes a persona to default through the same write endpoint', async () => {
    responses = [{ id: 'scout', isDefault: true }, [persona({ isDefault: true })]]
    const personas = await loadComposable()
    await personas.makeDefault('scout')

    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/personas/scout', body: { isDefault: true } })
  })
})
