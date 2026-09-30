/**
 * SPEC 7.4b (canvas R2): the artifact extraction hangs off the single place
 * every channel writes its assistant row, so web, app and Telegram get the
 * same artifacts from the same turn.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike, TurnEvent } from './turn-runner.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { listArtifacts, readArtifactContent } from './artifact-store.js'

const fence = '```'
const SESSION_ID = 'session-canvas'
const USER_ID = 7

let db: Database
let dataDir: string
let previousDataDir: string | undefined

function scriptedAgent(chunks: ResponseChunk[]): TurnAgentLike {
  return {
    sendMessage: async function* () {
      for (const chunk of chunks) yield chunk
    },
    abort: vi.fn(),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

async function runTurn(text: string): Promise<void> {
  const runner = new TurnRunner({ db, getAgent: () => scriptedAgent([{ type: 'text', text }, { type: 'done' }]) })
  const events: TurnEvent[] = []
  runner.subscribe(USER_ID, e => events.push(e))
  runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'go' })
  await waitFor(() => events.some(e => e.type === 'turn_end'))
}

function assistantRows(): Array<{ id: number; content: string }> {
  return db.prepare(
    "SELECT id, content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id",
  ).all(SESSION_ID) as Array<{ id: number; content: string }>
}

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-turn-artifacts-'))
  process.env.DATA_DIR = dataDir
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
})

afterEach(() => {
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
})

describe('TurnRunner canvas artifacts', () => {
  it('extracts the html fence of a finished answer and keeps the fallback text', async () => {
    const answer = `Der Vergleich als Canvas, Kurzfassung: Variante B ist billiger.\n\n${fence}html Dachvergleich\n<h1>Dach</h1>\n${fence}`
    await runTurn(answer)

    const rows = assistantRows()
    expect(rows).toHaveLength(1)
    // Telegram and the plain web view keep the complete text including the fence.
    expect(rows[0]!.content).toBe(answer)

    const artifacts = listArtifacts(db, USER_ID, { strandId: SESSION_ID })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      messageId: rows[0]!.id,
      strandId: SESSION_ID,
      kind: 'html',
      title: 'Dachvergleich',
      source: 'inline_fence',
    })
    expect(readArtifactContent(db, artifacts[0]!.id)?.toString()).toBe('<h1>Dach</h1>')
  })

  it('creates nothing for an answer without an html block', async () => {
    await runTurn(`Nein.\n\n${fence}bash\nls -la\n${fence}`)
    expect(listArtifacts(db, USER_ID, { strandId: SESSION_ID })).toEqual([])
  })

  it('creates nothing for a truncated fence', async () => {
    await runTurn(`Hier:\n\n${fence}html\n<h1>abgeschnitten`)
    expect(listArtifacts(db, USER_ID, { strandId: SESSION_ID })).toEqual([])
  })
})
