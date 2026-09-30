/**
 * Hermetic test environment.
 *
 * The backend reads almost all of its state from `DATA_DIR` (settings.json,
 * the database, memory, agents, skills, secrets) and falls back to `/data`
 * when the variable is unset. Without this file a test run inherits whatever
 * `DATA_DIR` the shell has — inside the production container that is the
 * live `/data`, so tests read the operator's real settings (for example an
 * enforced model gate) and pass or fail depending on where they run.
 *
 * Vitest runs setup files before every test file is imported, so each test
 * file gets its own empty data and workspace directory here. Tests that need
 * a specific directory still set `process.env.DATA_DIR` themselves; this only
 * replaces the inherited default.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-test-data-'))

process.env.DATA_DIR = sandbox
process.env.WORKSPACE_DIR = path.join(sandbox, 'workspace')
fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true })
})
