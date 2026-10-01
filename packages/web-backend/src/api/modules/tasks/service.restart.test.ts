/**
 * Restarting a task keeps the task policy's thinking level and routing record
 * when it runs on the original provider and model, and drops both when the
 * restart re-pins another model (NULL → background thinking setting).
 * Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database, ProviderConfig, Task, TaskRuntimeTaskBoundary } from '@axiom/core'
import { TaskStore, initDatabase, initTasksTable } from '@axiom/core'

vi.mock('@axiom/core', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    resolveProviderModelInput: vi.fn((input: { provider?: string; model?: string }) => {
      const models = ['claude-opus-5-5', 'claude-sonnet-5-5']
      const modelId = input.model ?? models[0]
      if (!models.includes(modelId)) return { ok: false, error: `Model "${modelId}" is not enabled.` }
      return { ok: true, providerId: 'prov-a', providerName: 'ProvA', modelId }
    }),
  }
})

import { TasksService } from './service.js'

const PROVIDER: ProviderConfig = {
  id: 'prov-a',
  name: 'ProvA',
  type: 'anthropic-messages',
  providerType: 'anthropic-oauth',
  provider: 'anthropic',
  baseUrl: 'https://example.invalid',
  apiKey: '',
  enabledModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
} as unknown as ProviderConfig

const ROUTING = {
  source: 'strand' as const,
  kind: 'coding' as const,
  difficulty: 'high' as const,
  tier: 'strong' as const,
  family: 'anthropic' as const,
  modelId: 'claude-opus-5-5',
  thinking: 'high' as const,
  thinkingSource: 'profile' as const,
  reason: 'strand provider "ProvA"; coding/high → strong',
}

let db: Database
let started: Array<{ task: Task; provider: ProviderConfig }>
let service: TasksService

function store(): TaskStore {
  return new TaskStore(db)
}

beforeEach(() => {
  db = initDatabase(':memory:')
  initTasksTable(db)
  started = []
  const runtime = {
    create: (input: Parameters<TaskRuntimeTaskBoundary['create']>[0]) => store().create(input),
    getById: (id: string) => store().getById(id),
    start: async (task: Task, provider: ProviderConfig) => {
      started.push({ task, provider })
      return task.id
    },
  } as unknown as TaskRuntimeTaskBoundary
  service = new TasksService({
    db,
    getTaskRuntime: () => runtime,
    resolveProvider: (id: string) => (id === PROVIDER.id ? PROVIDER : null),
    getDefaultProvider: () => PROVIDER,
  } as unknown as ConstructorParameters<typeof TasksService>[0])
})

afterEach(() => {
  db.close()
})

function failedPolicyTask(): Task {
  const task = store().create({
    name: 'Refactor module',
    prompt: 'Synthetic prompt',
    triggerType: 'agent',
    provider: 'ProvA',
    model: 'claude-opus-5-5',
    isDefaultModel: false,
    thinkingLevel: 'high',
    routing: ROUTING,
  })
  store().update(task.id, { status: 'failed' })
  return store().getById(task.id)!
}

const ADMIN = { userId: 1, role: 'admin' }

describe('TasksService.restartTask — task policy fields', () => {
  it('a restart on the same provider and model keeps thinking level and routing', async () => {
    const original = failedPolicyTask()

    const restarted = await service.restartTask(original.id, {}, ADMIN)

    expect(restarted.model).toBe('claude-opus-5-5')
    expect(restarted.thinkingLevel).toBe('high')
    expect(restarted.routing).toMatchObject({ source: 'strand', tier: 'strong', modelId: 'claude-opus-5-5' })
    expect(started).toHaveLength(1)
  })

  it('a restart re-pinned to another model drops both (background thinking)', async () => {
    const original = failedPolicyTask()

    const restarted = await service.restartTask(original.id, { model: 'claude-sonnet-5-5' }, ADMIN)

    expect(restarted.model).toBe('claude-sonnet-5-5')
    expect(restarted.thinkingLevel).toBeNull()
    expect(restarted.routing).toBeNull()
  })
})
