import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { collectMetrics } from './service.js'
let dir: string
let db: Database
const old = process.env.DATA_DIR
beforeEach(() => { dir = fs.mkdtempSync(path.join(process.cwd(), '.mqtt-test-')); process.env.DATA_DIR = dir; db = initDatabase(path.join(dir, 'db.sqlite')) })
afterEach(() => { db.close(); if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old; fs.rmSync(dir, { recursive: true, force: true }) })
describe('numeric metrics from local DB', () => {
  it('counts SQLite-native timestamps and known provider families without publishing account names', () => {
    db.prepare("INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES ('anthropic', 'test-model', 100, 25, 0.12)").run()
    db.prepare("INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES ('private-account-name', 'test-model', 10, 5, 0.03)").run()
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES ('session', 'user', 'Private chat content')").run()
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type) VALUES ('test-running', 'Private task name', 'Private prompt', 'running', 'user')").run()
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, completed_at) VALUES ('test-failed', 'Private task name', 'Private prompt', 'failed', 'user', datetime('now'))").run()
    const collected = collectMetrics(db)
    expect(collected.usage.today_total).toMatchObject({ tokens: 140, cost: 0.15 })
    expect(collected.usage.today_anthropic).toMatchObject({ tokens: 125, cost: 0.12 })
    expect(collected.activity).toMatchObject({ messagesToday: 1, runningTasks: 1, failedTasksToday: 1, lastCronRun: null })
    expect(JSON.stringify(collected)).not.toMatch(/Private|private-account-name/)
  })
})
