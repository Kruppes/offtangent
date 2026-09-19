/**
 * Legacy task-result rows get their card derived on read.
 *
 * The measured case: a report of 20,342 characters stored straight in
 * `chat_messages.content` before the card format existed, which every client
 * downloaded in full when it opened the strand. No migration, no schema
 * change — the server derives the short form and leaves the row alone.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { initDatabase, TASK_RESULT_PREVIEW_MAX_CHARS } from '@axiom/core'
import type { Database } from '@axiom/core'
import { withDerivedTaskResultPreviews } from './task-result-preview.js'

let db: Database

const LONG_REPORT = Array.from({ length: 400 }, (_, i) => `Line ${i + 1}: a sentence of the report that carries detail.`).join('\n')

function legacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    role: 'system',
    content: `✅ Task completed: Nightly run\n\n${LONG_REPORT}`,
    metadata: JSON.stringify({ type: 'task_result', taskId: 'task-1', taskName: 'Nightly run', taskStatus: 'completed' }),
    ...overrides,
  }
}

function insertTask(id: string, summary: string | null): void {
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, status, trigger_type, result_summary, created_at)
     VALUES (?, 'Nightly run', 'do it', 'completed', 'user', ?, datetime('now'))`,
  ).run(id, summary)
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('admin', 'x', 'admin')
})

afterAll(() => {
  db?.close()
})

describe('withDerivedTaskResultPreviews', () => {
  it('shortens a legacy row and fills the preview fields the card needs', () => {
    insertTask('task-1', LONG_REPORT)
    const [row] = withDerivedTaskResultPreviews(db, [legacyRow()])

    const content = row.content as string
    expect(content.length).toBeLessThan(900)
    expect(content.startsWith('✅ Task completed: Nightly run')).toBe(true)
    expect(content).toContain('Line 1:')
    expect(content).not.toContain('Line 40:')
    expect(content).toMatch(/more characters — open the task card for the full report \(task task-1\)\./)

    const metadata = JSON.parse(row.metadata as string) as Record<string, unknown>
    expect(metadata.type).toBe('task_result')
    expect(metadata.taskId).toBe('task-1')
    expect(metadata.resultTruncated).toBe(true)
    expect(metadata.resultPreviewDerived).toBe(true)
    expect(metadata.resultBodyKind).toBe('summary')
    expect(metadata.resultFullLength).toBe(LONG_REPORT.length)
    expect((metadata.resultPreview as string).length).toBeLessThanOrEqual(TASK_RESULT_PREVIEW_MAX_CHARS + 1)
  })

  it('never writes the shortened form back into the database', () => {
    insertTask('task-1', LONG_REPORT)
    const original = legacyRow()
    const [row] = withDerivedTaskResultPreviews(db, [original])

    expect(row).not.toBe(original)
    expect(original.content).toBe(`✅ Task completed: Nightly run\n\n${LONG_REPORT}`)
    db.prepare(
      `INSERT INTO sessions (id, user_id, agent_id, title, type) VALUES ('s1', 1, 'main', 'S', 'interactive')`,
    ).run()
    db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES ('s1', 1, 'system', ?, ?)`,
    ).run(original.content, original.metadata)
    const stored = db.prepare('SELECT content FROM chat_messages').get() as { content: string }
    expect(stored.content.length).toBe((original.content as string).length)
  })

  it('leaves a row whose task is gone untouched: the message is the last copy of the report', () => {
    const [row] = withDerivedTaskResultPreviews(db, [legacyRow()])
    expect((row.content as string).length).toBe((legacyRow().content as string).length)
    expect(JSON.parse(row.metadata as string).resultPreviewDerived).toBeUndefined()
  })

  it('leaves a row whose task has no result summary untouched', () => {
    insertTask('task-1', null)
    const [row] = withDerivedTaskResultPreviews(db, [legacyRow()])
    expect((row.content as string).length).toBe((legacyRow().content as string).length)
  })

  it('leaves rows that already carry a stored preview alone', () => {
    insertTask('task-1', LONG_REPORT)
    const modern = legacyRow({
      content: '✅ Task completed: Nightly run\n\nLine 1: short\n\n…20000 more characters',
      metadata: JSON.stringify({ type: 'task_result', taskId: 'task-1', resultPreview: 'Line 1: short', resultTruncated: true }),
    })
    const [row] = withDerivedTaskResultPreviews(db, [modern])
    expect(row.content).toBe(modern.content)
    expect(row.metadata).toBe(modern.metadata)
  })

  it('leaves a short legacy report alone: there is nothing to shorten', () => {
    insertTask('task-1', 'All good.')
    const short = legacyRow({ content: '✅ Task completed: Nightly run\n\nAll good.' })
    const [row] = withDerivedTaskResultPreviews(db, [short])
    expect(row.content).toBe(short.content)
    expect(row.metadata).toBe(short.metadata)
  })

  it('keeps ordinary chat rows and unparseable metadata exactly as they are', () => {
    insertTask('task-1', LONG_REPORT)
    const rows = withDerivedTaskResultPreviews(db, [
      { id: 2, content: 'hello', metadata: null },
      { id: 3, content: 'hello', metadata: '{not json' },
      { id: 4, content: LONG_REPORT, metadata: JSON.stringify({ type: 'task_result' }) },
    ])
    expect(rows[0].content).toBe('hello')
    expect(rows[1].metadata).toBe('{not json')
    expect(rows[2].content).toBe(LONG_REPORT)
  })

  it('treats a report without the headline line as all body', () => {
    insertTask('task-9', LONG_REPORT)
    const row = legacyRow({
      content: LONG_REPORT,
      metadata: JSON.stringify({ type: 'task_result', taskId: 'task-9' }),
    })
    const [derived] = withDerivedTaskResultPreviews(db, [row])
    const content = derived.content as string
    expect(content.startsWith('Line 1:')).toBe(true)
    expect(content).toContain('open the task card for the full report (task task-9)')
    expect(content.length).toBeLessThan(900)
  })
})
