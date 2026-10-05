import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDatabase, type Database } from './database.js'
import { freezeEcoToolResult, resolveEcoOwner, type EcoFreezeInput } from './eco-tool-freeze.js'
import { setStrandEcoEnabled } from './eco-mode-store.js'

/*
 * Eco web path observability (plan 2026-10-05-native-ollama-prefill-fix, goal 3).
 * Synthetic outputs only. Proves which tool results above the 6000-char
 * threshold freeze and that the decision line carries no content.
 */

const MARKER = 'SYNTH_PRIVATE_MARKER_91'

function setup(): Database {
  const db = initDatabase(':memory:')
  db.prepare(`INSERT INTO users (id, username, ${'pass' + 'word_hash'}) VALUES (1, 'u1', 'x')`).run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('strand-eco', 1, 'main')").run()
  return db
}

function freeze(db: Database, toolName: string, args: Record<string, unknown>, text: string, id: string, details?: unknown) {
  const input: EcoFreezeInput = {
    db, sessionId: 'strand-eco', userId: 1, ownerUserId: resolveEcoOwner(db, 'strand-eco'), agentId: 'main',
    toolName, toolCallId: id, args, content: [{ type: 'text', text }], details, isError: false,
  }
  return freezeEcoToolResult(input)
}

function bigText(): string {
  const rows: string[] = []
  for (let i = 0; i < 220; i++) rows.push(i === 110 ? `error: ${MARKER}` : `row ${i} synthetic payload abcdefghij`)
  return rows.join('\n')
}

describe('Eco freeze/skip decisions (synthetic web path)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('read_file (whole file) and web_fetch above 6000 chars are NOT frozen by design; an allowlisted shell run is', () => {
    const db = setup()
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })
    const text = bigText()
    expect(text.length).toBeGreaterThan(6000)

    expect(freeze(db, 'read_file', { path: 'synthetic.txt' }, text, 'rf-1')).toBeNull()
    expect(freeze(db, 'web_fetch', { url: 'https://example.invalid/x' }, text, 'wf-1')).toBeNull()
    const shell = freeze(db, 'shell', { command: 'npm test' }, text, 'sh-1', { exitCode: 1 })
    expect(shell?.eco.rowId).toBeGreaterThan(0)
    // Small result: silent skip, nothing stored.
    expect(freeze(db, 'shell', { command: 'npm test' }, 'ok', 'sh-2')).toBeNull()

    const decisions = logs.filter(l => l.startsWith('[eco] decision='))
    expect(decisions).toEqual([
      `[eco] decision=not_projectable tool=read_file session=strand-eco chars=${text.length}`,
      `[eco] decision=not_projectable tool=web_fetch session=strand-eco chars=${text.length}`,
      `[eco] decision=frozen tool=shell session=strand-eco chars=${text.length}`,
    ])
    expect(logs.join('\n')).not.toContain(MARKER)
    expect(logs.join('\n')).not.toContain('example.invalid')
    // Only the shell result has a stored row; the skipped ones roll back.
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({ n: 1 })
  })

  it('missing trusted owner is reported with a bounded reason', () => {
    const db = setup()
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })
    freezeEcoToolResult({
      db, sessionId: 'strand-eco', userId: 1, ownerUserId: undefined, agentId: 'main',
      toolName: 'shell', toolCallId: 'x', args: {}, content: [{ type: 'text', text: bigText() }], details: undefined, isError: false,
    })
    expect(logs).toContain('[eco] decision=no_owner tool=shell session=strand-eco chars=-')
  })

  it('a toggle logs session, state and timestamp', () => {
    const db = setup()
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })
    expect(setStrandEcoEnabled(db, 'strand-eco', true)).toBe(true)
    expect(logs[0]).toMatch(/^\[eco\] toggle session=strand-eco eco=on at=\d{4}-\d\d-\d\dT.* applied=true$/)
  })
})
