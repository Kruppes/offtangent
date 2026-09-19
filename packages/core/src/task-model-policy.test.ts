import { describe, it, expect } from 'vitest'
import {
  resolveTaskModelRole,
  resolveTaskModelRoleFrom,
  taskModelRoleKeys,
  isTaskModelRoleKind,
  TASK_MODEL_ROLE_KINDS,
} from './task-model-policy.js'

describe('task model policy roles', () => {
  const roles = {
    'task:default': 'local:qwen3-30b',
    'task:cronjob': 'anthropic:claude-haiku-5',
    'task:heartbeat': '   ',
    'task:agent': 42,
  }

  it('prefers the kind-specific role over the generic one', () => {
    expect(resolveTaskModelRole('cronjob', roles)).toEqual({ role: 'task:cronjob', spec: 'anthropic:claude-haiku-5' })
  })

  it('falls back to task:default for kinds without an entry', () => {
    expect(resolveTaskModelRole('user', roles)).toEqual({ role: 'task:default', spec: 'local:qwen3-30b' })
  })

  it('ignores blank and non-string specs', () => {
    expect(resolveTaskModelRole('heartbeat', roles)?.role).toBe('task:default')
    expect(resolveTaskModelRole('agent', roles)?.role).toBe('task:default')
    expect(resolveTaskModelRoleFrom(['task:heartbeat'], roles)).toBeNull()
    expect(resolveTaskModelRoleFrom(['task:agent'], roles)).toBeNull()
  })

  it('returns null when no role is configured', () => {
    expect(resolveTaskModelRole('cronjob', {})).toBeNull()
    expect(resolveTaskModelRoleFrom(['task:default'], {})).toBeNull()
  })

  it('uses only task:default without a kind', () => {
    expect(taskModelRoleKeys()).toEqual(['task:default'])
    expect(taskModelRoleKeys('agent')).toEqual(['task:agent', 'task:default'])
  })

  it('validates kinds against the task trigger types', () => {
    for (const kind of TASK_MODEL_ROLE_KINDS) expect(isTaskModelRoleKind(kind)).toBe(true)
    expect(isTaskModelRoleKind('router')).toBe(false)
    expect(isTaskModelRoleKind(null)).toBe(false)
  })
})
