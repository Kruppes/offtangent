/**
 * `fork_strand`: the tool contract. What these pin down:
 *   - the parent strand and the owner come from the RUN, not from arguments;
 *   - `run_agent: true` starts exactly one turn in the new strand, and
 *     `run_agent: false` leaves the seed sitting there;
 *   - a run that was itself started by a fork gets a dormant fork (no cascade);
 *   - at most three forks per run, and every refusal is a tool error with a
 *     readable reason instead of a throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { SessionManager } from './session-manager.js'
import { createForkStrandTool } from './strand-fork-tool.js'
import { getStrandForkLineage, listChildStrandIds, type StrandFork } from './strand-fork.js'

type ToolResult = {
  content: { type: string; text: string }[]
  isError?: boolean
  details?: Record<string, unknown>
}

describe('fork_strand tool', () => {
  let db: Database
  let tmpDir: string
  let sessions: SessionManager
  let strandId: string
  let started: { userId: number; strandId: string; agentId: string; text: string }[]
  let announced: (StrandFork & { userId: number })[]

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-fork-tool-'))
    const memoryDir = path.join(tmpDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    db = initDatabase(path.join(tmpDir, 'db.sqlite'))
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'other', 'x')
    sessions = new SessionManager({ db, memoryDir, timeoutMinutes: 15 })
    strandId = sessions.createThread('1', 'main', 'Gmail integration').id
    started = []
    announced = []
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function tool(overrides: Partial<Parameters<typeof createForkStrandTool>[0]> = {}) {
    return createForkStrandTool({
      db,
      getCurrentToolUserId: () => 1,
      getCurrentStrandId: () => strandId,
      getSessions: () => sessions,
      getForkScope: () => 'turn-1',
      startTurn: (input) => { started.push(input) },
      announce: (fork) => { announced.push(fork) },
      ...overrides,
    })
  }

  async function run(
    instance: ReturnType<typeof createForkStrandTool>,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    return await instance.execute('call-1', params, {} as never) as ToolResult
  }

  it('creates a dormant fork by default and announces it', async () => {
    const result = await run(tool(), {
      title: 'Privacy: Gmail-Scopes',
      seed: 'Eigener Nebenpfad: welche Scopes und was gespeichert wird.',
    })

    expect(result.isError).toBeFalsy()
    const newStrandId = result.details!.strandId as string
    expect(result.content[0]!.text).toContain(newStrandId)
    expect(result.details).toMatchObject({ parentStrandId: strandId, depth: 1, runStarted: false })
    expect(started).toEqual([])
    expect(announced).toHaveLength(1)
    expect(announced[0]!.strandId).toBe(newStrandId)
    expect(getStrandForkLineage(db, newStrandId).parentStrandId).toBe(strandId)

    const seed = db.prepare("SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user'")
      .get(newStrandId) as { content: string }
    expect(seed.content).toContain('welche Scopes')
  })

  it('starts exactly one turn with the seed when run_agent is true', async () => {
    const result = await run(tool(), { title: 'Privacy', seed: 'Nebenpfad Datenschutz.', run_agent: true })
    const newStrandId = result.details!.strandId as string
    expect(result.details).toMatchObject({ runStarted: true, seedMessageId: null })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ userId: 1, strandId: newStrandId, agentId: 'main' })
    expect(started[0]!.text).toContain('Nebenpfad Datenschutz.')
  })

  it('downgrades run_agent to a dormant fork when no turn starter is wired (background task)', async () => {
    const result = await run(tool({ startTurn: undefined }), {
      title: 'Privacy', seed: 'Nebenpfad.', run_agent: true,
    })
    expect(result.isError).toBeFalsy()
    expect(result.details).toMatchObject({ runStarted: false })
    expect(result.content[0]!.text).toContain('created dormant')
  })

  it('does not cascade: a fork-started run forks dormant', async () => {
    const first = await run(tool(), { title: 'Privacy', seed: 'Nebenpfad.', run_agent: true })
    const childId = first.details!.strandId as string
    // The turn runner persists the seed as the first user message of the child.
    db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', ?, 'main')",
    ).run(childId, 'seed')

    const nested = await run(
      tool({ getCurrentStrandId: () => childId, getForkScope: () => 'turn-2' }),
      { title: 'Retention', seed: 'Noch ein Unterpfad.', run_agent: true },
    )
    expect(nested.isError).toBeFalsy()
    expect(nested.details).toMatchObject({ runStarted: false, depth: 2 })
    expect(nested.content[0]!.text).toContain('no cascade of automatic runs')
    expect(started).toHaveLength(1)
    expect(listChildStrandIds(db, childId)).toEqual([nested.details!.strandId])
  })

  it('stops after three forks in one run and keeps counting per scope', async () => {
    let scope = 'turn-1'
    const instance = tool({ getForkScope: () => scope })
    for (let index = 1; index <= 3; index += 1) {
      const ok = await run(instance, { title: `Zweig ${index}`, seed: `Nebenpfad ${index}.` })
      expect(ok.isError).toBeFalsy()
    }
    const denied = await run(instance, { title: 'Zweig 4', seed: 'Zu viel.' })
    expect(denied.isError).toBe(true)
    expect(denied.content[0]!.text).toContain('already created 3 strands in this run')
    expect(listChildStrandIds(db, strandId)).toHaveLength(3)

    scope = 'turn-2'
    const nextTurn = await run(instance, { title: 'Zweig 4', seed: 'Neuer Turn.' })
    expect(nextTurn.isError).toBeFalsy()
  })

  it('reports missing context and a foreign strand as a tool error, never a throw', async () => {
    const noUser = await run(tool({ getCurrentToolUserId: () => undefined }), { title: 'X', seed: 'Y' })
    expect(noUser.isError).toBe(true)
    expect(noUser.content[0]!.text).toContain('needs a user context')

    const noStrand = await run(tool({ getCurrentStrandId: () => null }), { title: 'X', seed: 'Y' })
    expect(noStrand.isError).toBe(true)
    expect(noStrand.content[0]!.text).toContain('needs the strand it runs in')

    const foreign = sessions.createThread('2', 'main', 'Not yours').id
    const wrongOwner = await run(tool({ getCurrentStrandId: () => foreign }), { title: 'X', seed: 'Y' })
    expect(wrongOwner.isError).toBe(true)
    expect(wrongOwner.content[0]!.text).toContain('parent_not_found')
    expect(listChildStrandIds(db, foreign)).toEqual([])

    const noSessions = await run(tool({ getSessions: () => null }), { title: 'X', seed: 'Y' })
    expect(noSessions.isError).toBe(true)
    expect(noSessions.content[0]!.text).toContain('session manager')
  })

  it('reports an invalid title or seed as a tool error', async () => {
    const instance = tool()
    const badTitle = await run(instance, { title: '   ', seed: 'ok' })
    expect(badTitle.isError).toBe(true)
    expect(badTitle.content[0]!.text).toContain('invalid_title')

    const badSeed = await run(instance, { title: 'ok', seed: '' })
    expect(badSeed.isError).toBe(true)
    expect(badSeed.content[0]!.text).toContain('invalid_seed')

    // A rejected call created nothing, so it must not cost the run a fork:
    // three real forks still fit after two argument mistakes.
    for (let index = 1; index <= 3; index += 1) {
      const ok = await run(instance, { title: `Zweig ${index}`, seed: `Nebenpfad ${index}.` })
      expect(ok.isError).toBeFalsy()
    }
    expect(listChildStrandIds(db, strandId)).toHaveLength(3)
  })

  it('keeps the fork when announcing or starting the turn fails', async () => {
    const instance = tool({
      announce: () => { throw new Error('bus down') },
      startTurn: () => { throw new Error('runner down') },
    })
    const result = await run(instance, { title: 'Privacy', seed: 'Nebenpfad.', run_agent: true })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toContain('bus down')
    expect(result.content[0]!.text).toContain('runner down')
    expect(listChildStrandIds(db, strandId)).toHaveLength(1)
  })
})
