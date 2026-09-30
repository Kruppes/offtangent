/**
 * F2 (review triage 19:25): answering a background task is a user entry path
 * without a boundary. `replyToTask` handed the raw text to `tasks.resume()`
 * (straight into the running task's model context) and copied it into the
 * prompt of a follow-up task (stored in `tasks.prompt`).
 *
 * Canaries are assembled at runtime.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  invalidateKnownValues,
  invalidateSecretHandleCache,
  resolveSecret,
  SECRET_HANDLE_RE,
} from '@axiom/core'
import type { ProviderConfig } from '@axiom/core'
import { createTaskReply } from './task-reply.js'

const STRONG_CANARY = ['ghp', '_', 'R3ply', 'Fake', 'Token', '0000', 'abcdefghij', 'klmnopqr'].join('')
const CONTEXT_CANARY = 'R3ply-Kanari3!'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

function handles(text: string): string[] {
  return [...text.matchAll(new RegExp(SECRET_HANDLE_RE.source, 'g'))].map(match => match[1]!)
}

const provider = { id: 'p1', name: 'test-provider', enabledModels: ['m1'] } as unknown as ProviderConfig

function makeDeps(task: Record<string, unknown>) {
  const calls = { resume: [] as string[], created: [] as Array<Record<string, unknown>> }
  const deps = {
    tasks: {
      getById: () => task,
      resume: async (_id: string, text: string) => { calls.resume.push(text); return true },
      create: (input: Record<string, unknown>) => { calls.created.push(input); return { ...input, id: 'follow-1' } },
      start: async () => {},
    },
    resolveProvider: () => provider,
    getDefaultProvider: () => provider,
    getMaxDurationMinutes: () => 30,
    getParentSessionId: () => null,
  }
  return { deps: deps as never, calls }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-reply-seal-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-task-reply-sealing'
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

describe('F2: a task reply is sealed before it is injected or stored', () => {
  it('seals the resume text of a paused task (user tier)', async () => {
    const { deps, calls } = makeDeps({ id: 't1', name: 'Paused', status: 'paused', prompt: 'x', agentId: 'main' })
    const replyToTask = createTaskReply(deps)
    await replyToTask({
      taskId: 't1',
      text: `use ${STRONG_CANARY} and mein Passwort ist ${CONTEXT_CANARY}`,
      userId: '1',
      source: 'app',
    })
    expect(calls.resume).toHaveLength(1)
    const injected = calls.resume[0]!
    expect(injected).not.toContain(STRONG_CANARY)
    expect(injected).not.toContain(CONTEXT_CANARY)
    expect(handles(injected)).toHaveLength(2)
    expect(handles(injected).map(slug => resolveSecret(slug)).sort())
      .toEqual([CONTEXT_CANARY, STRONG_CANARY].sort())
  })

  it('seals the text before it becomes the prompt of a follow-up task', async () => {
    const { deps, calls } = makeDeps({
      id: 't2', name: 'Done', status: 'completed', prompt: 'old prompt',
      resultSummary: 'old result', agentId: 'main', provider: 'test-provider', model: 'm1',
    })
    const replyToTask = createTaskReply(deps)
    await replyToTask({ taskId: 't2', text: `retry with ${STRONG_CANARY}`, userId: '1', source: 'telegram' })
    expect(calls.created).toHaveLength(1)
    const created = calls.created[0]!
    expect(String(created.prompt)).not.toContain(STRONG_CANARY)
    expect(String(created.name)).not.toContain(STRONG_CANARY)
    expect(handles(String(created.prompt))).toHaveLength(1)
  })

  it('leaves a reply without a secret unchanged', async () => {
    const { deps, calls } = makeDeps({ id: 't3', name: 'Paused', status: 'paused', prompt: 'x', agentId: 'main' })
    await createTaskReply(deps)({ taskId: 't3', text: 'yes, go ahead', userId: '1', source: 'app' })
    expect(calls.resume).toEqual(['yes, go ahead'])
  })
})
