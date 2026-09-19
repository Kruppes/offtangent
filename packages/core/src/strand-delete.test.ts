/**
 * Hard delete of a strand (SPEC 7.5b): the cascade, the attachment rules and
 * the "knowledge is not deleted silently" default.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { deleteStrand, hasLiveTaskForStrand, previewStrandDelete, removeUploadFiles } from './strand-delete.js'
import { insertSessionSummary } from './session-summary-store.js'
import { insertArtifact } from './artifact-store.js'
import type { UploadDescriptor } from './uploads.js'

let db: Database
let uploadsRoot: string
let previousDataDir: string | undefined

function descriptor(relativePath: string): UploadDescriptor {
  return {
    kind: 'file',
    originalName: path.basename(relativePath),
    storedName: path.basename(relativePath),
    relativePath,
    urlPath: `/api/uploads/${relativePath}`,
    mimeType: 'text/plain',
    size: 3,
  }
}

function writeUpload(relativePath: string): string {
  const absolute = path.join(uploadsRoot, 'uploads', relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, 'abc')
  return absolute
}

function createStrand(id: string, userId = '1', agentId = 'main'): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, agent_id, title)
     VALUES (?, ?, ?, 'web', 'interactive', ?, ?)`,
  ).run(id, 1, userId, agentId, `Strand ${id}`)
}

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR
  uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-strand-delete-'))
  process.env.DATA_DIR = uploadsRoot
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
})

afterEach(() => {
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(uploadsRoot, { recursive: true, force: true })
})

describe('previewStrandDelete / deleteStrand', () => {
  it('counts and then removes every row written under the strand, one table at a time', () => {
    createStrand('s1')
    createStrand('s2')

    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s1', 1, 'user', 'hello')").run()
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s1', 1, 'assistant', 'hi')").run()
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s2', 1, 'user', 'other strand')").run()

    db.prepare("INSERT INTO captures (id, user_id, text, strand_id, status) VALUES ('c1', '1', 'note', 's1', 'filed')").run()
    db.prepare("INSERT INTO captures (id, user_id, text, strand_id, status) VALUES ('c2', '1', 'kept', 's2', 'filed')").run()
    db.prepare(
      "INSERT INTO router_decisions (id, capture_id, action, confidence, state) VALUES ('d1', 'c1', 'append', 0.9, 'applied')",
    ).run()
    db.prepare(
      "INSERT INTO router_decisions (id, capture_id, action, confidence, state) VALUES ('d2', 'c2', 'append', 0.9, 'applied')",
    ).run()

    db.prepare("INSERT INTO tags (id, user_id, name) VALUES ('t1', '1', 'roof')").run()
    db.prepare("INSERT INTO strand_tags (strand_id, tag_id) VALUES ('s1', 't1')").run()
    db.prepare("INSERT INTO strand_tags (strand_id, tag_id) VALUES ('s2', 't1')").run()

    db.prepare("INSERT INTO strand_links (id, from_strand, to_strand) VALUES ('l1', 's1', 's2')").run()
    db.prepare("INSERT INTO strand_links (id, from_strand, to_strand) VALUES ('l2', 's2', 's1')").run()

    db.prepare("INSERT INTO now_set (user_id, strand_id, rank) VALUES ('1', 's1', 1)").run()
    db.prepare("INSERT INTO resurface_snoozes (user_id, strand_id, snoozed_until) VALUES ('1', 's1', '2099-01-01')").run()
    insertSessionSummary(db, 's1', { goal: 'Roof', decisions: [], open: [], artifacts: [], next: [] }, null, 'test')
    db.prepare("INSERT INTO tool_calls (session_id, tool_name, input) VALUES ('s1', 'shell', 'ls')").run()
    db.prepare("INSERT INTO token_usage (provider, model, session_id, estimated_cost) VALUES ('p', 'm', 's1', 1.5)").run()

    const preview = previewStrandDelete(db, '1', 's1')
    expect(preview.title).toBe('Strand s1')
    expect(preview.messages).toBe(2)
    expect(preview.captures).toBe(1)
    expect(preview.decisions).toBe(1)
    expect(preview.tags).toBe(1)
    expect(preview.links).toBe(2)
    expect(preview.nowSlot).toBe(true)
    expect(preview.snoozes).toBe(1)
    expect(preview.summaries).toBe(1)
    expect(preview.toolCalls).toBe(1)
    expect(preview.attachments).toBe(0)
    expect(preview.facts).toEqual([])

    const result = deleteStrand(db, '1', 's1')
    expect(result.messages).toBe(2)
    expect(result.captures).toBe(1)
    expect(result.decisions).toBe(1)

    const one = (sql: string, ...params: unknown[]): number =>
      (db.prepare(sql).get(...params) as { c: number }).c

    expect(one("SELECT COUNT(*) AS c FROM sessions WHERE id = 's1'")).toBe(0)
    expect(one("SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = 's1'")).toBe(0)
    expect(one("SELECT COUNT(*) AS c FROM captures WHERE strand_id = 's1'")).toBe(0)
    expect(one("SELECT COUNT(*) AS c FROM router_decisions WHERE id = 'd1'")).toBe(0)
    expect(one("SELECT COUNT(*) AS c FROM strand_tags WHERE strand_id = 's1'")).toBe(0)
    expect(one("SELECT COUNT(*) AS c FROM strand_links WHERE from_strand = 's1' OR to_strand = 's1'")).toBe(0)
    expect(one("SELECT COUNT(*) AS c FROM now_set WHERE strand_id = 's1'")).toBe(0)
    expect(one("SELECT COUNT(*) AS c FROM resurface_snoozes WHERE strand_id = 's1'")).toBe(0)
    expect(one("SELECT COUNT(*) AS c FROM session_summaries WHERE session_id = 's1'")).toBe(0)
    expect(one("SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = 's1'")).toBe(0)

    // Nothing of the neighbour strand is touched, and the tag row itself survives.
    expect(one("SELECT COUNT(*) AS c FROM sessions WHERE id = 's2'")).toBe(1)
    expect(one("SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = 's2'")).toBe(1)
    expect(one("SELECT COUNT(*) AS c FROM captures WHERE strand_id = 's2'")).toBe(1)
    expect(one("SELECT COUNT(*) AS c FROM router_decisions WHERE id = 'd2'")).toBe(1)
    expect(one("SELECT COUNT(*) AS c FROM strand_tags WHERE strand_id = 's2'")).toBe(1)
    expect(one("SELECT COUNT(*) AS c FROM tags WHERE id = 't1'")).toBe(1)
    // Cost accounting keeps its rows on purpose.
    expect(one("SELECT COUNT(*) AS c FROM token_usage WHERE session_id = 's1'")).toBe(1)
  })

  it('keeps facts by default and only deletes them when asked', () => {
    createStrand('s1')
    db.prepare("INSERT INTO memories (user_id, session_id, content, source) VALUES (1, 's1', 'roof costs 25k', 'fact')").run()
    db.prepare("INSERT INTO memories (user_id, session_id, content, source) VALUES (1, 's1', 'roofer is Emig', 'fact')").run()
    db.prepare("INSERT INTO memories (user_id, session_id, content, source) VALUES (1, 'other', 'unrelated', 'fact')").run()

    const preview = previewStrandDelete(db, '1', 's1')
    expect(preview.facts.map(f => f.text)).toEqual(['roof costs 25k', 'roofer is Emig'])

    const kept = deleteStrand(db, '1', 's1')
    expect(kept.facts).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS c FROM memories WHERE session_id = 's1'").get() as { c: number }).c).toBe(2)

    createStrand('s3')
    db.prepare("INSERT INTO memories (user_id, session_id, content, source) VALUES (1, 's3', 'gone', 'fact')").run()
    const removed = deleteStrand(db, '1', 's3', { deleteFacts: true })
    expect(removed.facts).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS c FROM memories WHERE session_id = 's3'").get() as { c: number }).c).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS c FROM memories WHERE session_id = 'other'").get() as { c: number }).c).toBe(1)
  })

  it('unlinks attachments only this strand references and keeps shared ones', () => {
    createStrand('s1')
    createStrand('s2')
    const onlyHere = writeUpload('2026/09/14/only-here.txt')
    const shared = writeUpload('2026/09/14/shared.txt')
    const captureFile = writeUpload('2026/09/14/capture.txt')

    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES ('s1', 1, 'user', 'a', ?)")
      .run(JSON.stringify({ files: [descriptor('2026/09/14/only-here.txt'), descriptor('2026/09/14/shared.txt')] }))
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES ('s2', 1, 'user', 'b', ?)")
      .run(JSON.stringify({ files: [descriptor('2026/09/14/shared.txt')] }))
    db.prepare("INSERT INTO captures (id, user_id, text, strand_id, status, attachments) VALUES ('c1', '1', 'note', 's1', 'filed', ?)")
      .run(JSON.stringify([descriptor('2026/09/14/capture.txt')]))

    expect(previewStrandDelete(db, '1', 's1').attachments).toBe(2)
    const result = deleteStrand(db, '1', 's1')
    expect(result.attachments).toBe(2)
    expect(fs.existsSync(onlyHere)).toBe(false)
    expect(fs.existsSync(captureFile)).toBe(false)
    expect(fs.existsSync(shared)).toBe(true)
  })

  it('refuses to unlink a file that resolves outside the uploads directory', () => {
    const outside = path.join(uploadsRoot, 'secret.txt')
    fs.writeFileSync(outside, 'keep me')
    const removed = removeUploadFiles([descriptor('../secret.txt'), descriptor('/etc/hostname')])
    expect(removed).toBe(0)
    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.existsSync('/etc/hostname')).toBe(true)
  })

  it('rolls the whole cascade back when one statement fails', () => {
    createStrand('s1')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s1', 1, 'user', 'hello')").run()
    db.prepare("INSERT INTO now_set (user_id, strand_id, rank) VALUES ('1', 's1', 1)").run()
    db.exec('DROP TABLE session_summaries')

    expect(() => deleteStrand(db, '1', 's1')).toThrow()
    const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c
    expect(one("SELECT COUNT(*) AS c FROM sessions WHERE id = 's1'")).toBe(1)
    expect(one("SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = 's1'")).toBe(1)
    expect(one("SELECT COUNT(*) AS c FROM now_set WHERE strand_id = 's1'")).toBe(1)
  })
})

describe('hasLiveTaskForStrand', () => {
  it('is true for running and paused tasks of that strand only', () => {
    createStrand('s1')
    createStrand('s2')
    const insert = db.prepare(
      "INSERT INTO tasks (id, name, prompt, status, trigger_type, session_id) VALUES (?, 'n', 'p', ?, 'user', ?)",
    )
    insert.run('t-done', 'completed', 's1')
    expect(hasLiveTaskForStrand(db, 's1')).toBe(false)
    insert.run('t-run', 'running', 's1')
    expect(hasLiveTaskForStrand(db, 's1')).toBe(true)
    expect(hasLiveTaskForStrand(db, 's2')).toBe(false)
    insert.run('t-paused', 'paused', 's2')
    expect(hasLiveTaskForStrand(db, 's2')).toBe(true)
  })
})

describe('canvas artifacts in the cascade (SPEC 7.4b + 7.5b)', () => {
  it('takes the artifacts of the strand with it, rows and files, and leaves other strands alone', () => {
    createStrand('s1')
    createStrand('s2')
    const mine = db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s1', 1, 'assistant', 'here')",
    ).run().lastInsertRowid as number
    const other = db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s2', 1, 'assistant', 'keep')",
    ).run().lastInsertRowid as number

    const a = insertArtifact(db, {
      userId: 1, strandId: 's1', messageId: mine, kind: 'html', title: 'Roof compare',
      source: 'inline_fence', mimeType: 'text/html', content: Buffer.from('<p>a</p>'),
    })
    const b = insertArtifact(db, {
      userId: 1, strandId: 's2', messageId: other, kind: 'html', title: 'Survivor',
      source: 'inline_fence', mimeType: 'text/html', content: Buffer.from('<p>b</p>'),
    })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()

    const contentPath = (id: string): string =>
      (db.prepare('SELECT content_path AS p FROM artifacts WHERE id = ?').get(id) as { p: string }).p
    const mineFile = path.join(uploadsRoot, 'artifacts', contentPath(a!.id))
    const otherFile = path.join(uploadsRoot, 'artifacts', contentPath(b!.id))
    expect(fs.existsSync(mineFile)).toBe(true)

    expect(previewStrandDelete(db, '1', 's1').artifacts).toBe(1)

    const result = deleteStrand(db, '1', 's1')

    expect(result.artifacts).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE strand_id = 's1'").get()).toEqual({ c: 0 })
    expect(fs.existsSync(mineFile)).toBe(false)
    // The neighbour strand keeps its row AND its bytes.
    expect(db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE strand_id = 's2'").get()).toEqual({ c: 1 })
    expect(fs.existsSync(otherFile)).toBe(true)
  })
})
