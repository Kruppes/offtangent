/**
 * Regression (2026-10-29, session 6c7f8bcb): two photos sent without text in
 * the Android app, a voice note four seconds later. The photo row never got a
 * turn and the voice turn did not see the photos ("Ich sehe hier nur die
 * Sprachaufnahme, kein Foto").
 *
 * Contract covered here:
 *  - an attachment-only message waits for a follow-up in the same strand; the
 *    follow-up's turn carries BOTH (one turn, the photos as image uploads);
 *  - without a follow-up the photos start a turn of their own;
 *  - any turn that starts takes the images of earlier unanswered user rows
 *    of its strand (a photo row whose turn never started);
 *  - answered rows, other strands, old rows and non-image files stay out.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike } from './turn-runner.js'
import type { UploadDescriptor } from './uploads.js'
import { serializeUploadsMetadata } from './uploads.js'
import { collectUnansweredImageUploads, collectUnansweredImages, mergeUploads } from './unanswered-attachments.js'

function upload(name: string, kind: 'image' | 'file' = 'image', mimeType = 'image/jpeg'): UploadDescriptor {
  const relativePath = `2026/10/29/${name}`
  return { kind, originalName: name, storedName: name, relativePath, urlPath: `/api/uploads/${relativePath}`, mimeType, size: 10 }
}

class RecordingAgent implements TurnAgentLike {
  calls: Array<{ text: string; attachments: string[] }> = []
  async *sendMessage(_userId: string, text: string, _source?: string, attachments?: UploadDescriptor[]): AsyncIterable<ResponseChunk> {
    this.calls.push({ text, attachments: (attachments ?? []).map(a => a.originalName) })
    yield { type: 'text', text: 'ok' }
    yield { type: 'done' }
  }
  abort(): void {}
}

function setup(holdMs = 8_000) {
  const db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'h', 'admin')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('s-1', 1, 'main')").run()
  db.prepare("INSERT INTO sessions (id, user_id, agent_id) VALUES ('s-2', 1, 'main')").run()
  const agent = new RecordingAgent()
  const runner = new TurnRunner({ db, getAgent: () => agent, retryPolicy: { enabled: false }, attachmentOnlyHoldMs: holdMs })
  const row = (role: 'user' | 'assistant', content: string, files: UploadDescriptor[] = [], sessionId = 's-1') =>
    Number(db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, 1, ?, ?, ?, ?)',
    ).run(sessionId, role, content, files.length ? serializeUploadsMetadata(files) : null, 'main').lastInsertRowid)
  return { db, agent, runner, row }
}

const base = { userId: 1, sessionId: 's-1', agentId: 'main', source: 'web' as const }

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('photos without text + voice note (one turn, all images)', () => {
  it('photos first, voice note 4 s later: one turn that carries the photos and the recording', async () => {
    vi.useFakeTimers()
    const { agent, runner, row } = setup()
    const photos = [upload('46195.jpg'), upload('46196.jpg')]
    const photoId = row('user', '', photos)
    const held = runner.submitUserMessage({ ...base, text: '', attachments: photos, messageId: photoId })
    expect(held).toEqual({ mode: 'held', holdMs: 8_000 })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(agent.calls).toHaveLength(0)

    const recording = upload('recording-2026-10-29-091734.m4a', 'file', 'audio/mp4')
    const voiceId = row('user', 'Schau dir die Fotos an', [recording])
    const voice = runner.submitUserMessage({ ...base, text: 'Schau dir die Fotos an', attachments: [recording], messageId: voiceId, inputMode: 'voice' })
    expect(voice.mode).toBe('started')
    await vi.advanceTimersByTimeAsync(10)
    await flush()
    // The hold window passing must not start a second turn for the photos.
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()

    expect(agent.calls).toEqual([
      { text: 'Schau dir die Fotos an', attachments: ['46195.jpg', '46196.jpg', 'recording-2026-10-29-091734.m4a'] },
    ])
  })

  it('a photo without text and without follow-up starts its own turn after the hold', async () => {
    vi.useFakeTimers()
    const { agent, runner, row } = setup()
    const photo = upload('solo.jpg')
    const id = row('user', '', [photo])
    expect(runner.submitUserMessage({ ...base, text: '', attachments: [photo], messageId: id }).mode).toBe('held')
    await vi.advanceTimersByTimeAsync(7_999)
    expect(agent.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    await flush()
    expect(agent.calls).toEqual([{ text: '', attachments: ['solo.jpg'] }])
  })

  it('hold 0 starts the photo turn immediately', async () => {
    const { agent, runner, row } = setup(0)
    const photo = upload('now.jpg')
    const id = row('user', '', [photo])
    expect(runner.submitUserMessage({ ...base, text: '', attachments: [photo], messageId: id }).mode).toBe('started')
    await new Promise(r => setTimeout(r, 20))
    expect(agent.calls).toEqual([{ text: '', attachments: ['now.jpg'] }])
  })

  it('a follow-up in ANOTHER strand does not take the held photos; they start their own turn', async () => {
    vi.useFakeTimers()
    const { agent, runner, row } = setup()
    const photo = upload('a.jpg')
    const id = row('user', '', [photo])
    runner.submitUserMessage({ ...base, text: '', attachments: [photo], messageId: id })
    const otherId = row('user', 'anderes Thema', [], 's-2')
    runner.submitUserMessage({ ...base, sessionId: 's-2', text: 'anderes Thema', messageId: otherId })
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(agent.calls).toContainEqual({ text: 'anderes Thema', attachments: [] })
    expect(agent.calls).toContainEqual({ text: '', attachments: ['a.jpg'] })
  })

  it('a strand /stop cancels a held photo message', async () => {
    vi.useFakeTimers()
    const { agent, runner, row } = setup()
    const photo = upload('b.jpg')
    runner.submitUserMessage({ ...base, text: '', attachments: [photo], messageId: row('user', '', [photo]) })
    expect(runner.abortTurnInSession(1, 's-1')).toBe(true)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(agent.calls).toHaveLength(0)
  })

  it('a turn takes the images of an earlier unanswered row whose turn never started (the 2026-10-29 row)', async () => {
    const { agent, runner, row } = setup()
    row('user', 'alt', [upload('answered.jpg')])
    row('assistant', 'Antwort')
    row('user', '', [upload('46195.jpg'), upload('46196.jpg'), upload('notiz.pdf', 'file', 'application/pdf')])
    const voiceId = row('user', 'Was siehst du?')
    runner.submitUserMessage({ ...base, text: 'Was siehst du?', messageId: voiceId })
    await new Promise(r => setTimeout(r, 20))
    expect(agent.calls).toEqual([{ text: 'Was siehst du?', attachments: ['46195.jpg', '46196.jpg'] }])
  })
})

describe('collectUnansweredImageUploads', () => {
  function seed(): { db: Database; row: ReturnType<typeof setup>['row'] } {
    const { db, row } = setup()
    return { db, row }
  }

  it('only user rows after the last answer, before the message, inside the window, images only', () => {
    const { db, row } = seed()
    row('user', '', [upload('old-answered.jpg')])
    row('assistant', 'ok')
    row('user', '', [upload('x.jpg')], 's-2')
    row('user', '', [upload('p1.jpg'), upload('rec.m4a', 'file', 'audio/mp4')])
    const current = row('user', 'jetzt', [upload('p2.jpg')])
    row('user', 'später', [upload('later.jpg')])
    const found = collectUnansweredImageUploads(db, { sessionId: 's-1', userId: 1, beforeMessageId: current })
    expect(found.map(u => u.originalName)).toEqual(['p1.jpg'])
  })

  it('ignores rows older than the window', () => {
    const { db, row } = seed()
    const old = row('user', '', [upload('stale.jpg')])
    db.prepare("UPDATE chat_messages SET timestamp = datetime('now', '-2 hours') WHERE id = ?").run(old)
    const current = row('user', 'neu')
    expect(collectUnansweredImageUploads(db, { sessionId: 's-1', userId: 1, beforeMessageId: current })).toEqual([])
  })

  it('mergeUploads keeps order and drops the same stored file twice', () => {
    const a = upload('a.jpg')
    expect(mergeUploads([a, upload('b.jpg')], [a, upload('c.jpg')]).map(u => u.originalName)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
  })
})

/**
 * Review of 725e1d25 (F1, F5, F6): images get at most one turn. A stop
 * during the hold discards them, a turn that started with them settles them
 * whatever its outcome; nothing comes back in a later turn of the strand.
 */
class GatedAgent implements TurnAgentLike {
  calls: Array<{ text: string; attachments: string[] }> = []
  private gates: Array<() => void> = []
  async *sendMessage(_userId: string, text: string, _source?: string, attachments?: UploadDescriptor[]): AsyncIterable<ResponseChunk> {
    this.calls.push({ text, attachments: (attachments ?? []).map(a => a.originalName) })
    if (text.includes('[block]')) await new Promise<void>(resolve => this.gates.push(resolve))
    yield { type: 'text', text: 'ok' }
    yield { type: 'done' }
  }
  release(): void {
    for (const gate of this.gates.splice(0)) gate()
  }
  abort(): void {
    this.release()
  }
}

function gatedSetup(holdMs = 8_000) {
  const ctx = setup(holdMs)
  const agent = new GatedAgent()
  const runner = new TurnRunner({ db: ctx.db, getAgent: () => agent, retryPolicy: { enabled: false }, attachmentOnlyHoldMs: holdMs })
  return { ...ctx, agent, runner }
}

function meta(db: Database, id: number): Record<string, unknown> {
  const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(id) as { metadata: string | null }
  return row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {}
}

describe('review F1/F5: stopped or taken images never come back', () => {
  it('/stop during the hold, then a new turn in the same strand: no image of the stopped message', async () => {
    vi.useFakeTimers()
    const { db, agent, runner, row } = setup()
    const photo = upload('stopped.jpg')
    const photoId = row('user', '', [photo])
    expect(runner.submitUserMessage({ ...base, text: '', attachments: [photo], messageId: photoId }).mode).toBe('held')
    expect(runner.abortTurnInSession(1, 's-1')).toBe(true)
    expect(meta(db, photoId).imagesDiscarded).toBe(true)

    const nextId = row('user', 'Neues Thema')
    expect(runner.submitUserMessage({ ...base, text: 'Neues Thema', messageId: nextId }).mode).toBe('started')
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(agent.calls).toEqual([{ text: 'Neues Thema', attachments: [] }])
  })

  it('abortTurn(user) (/kill) drops a held message in every strand and discards its images', async () => {
    vi.useFakeTimers()
    const { db, agent, runner, row } = setup()
    const p1 = upload('kill-1.jpg')
    const p2 = upload('kill-2.jpg')
    const id1 = row('user', '', [p1])
    const id2 = row('user', '', [p2], 's-2')
    runner.submitUserMessage({ ...base, text: '', attachments: [p1], messageId: id1 })
    runner.submitUserMessage({ ...base, sessionId: 's-2', text: '', attachments: [p2], messageId: id2 })
    expect(runner.abortTurn(1)).toBe(true)
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(agent.calls).toHaveLength(0)
    expect(meta(db, id1).imagesDiscarded).toBe(true)
    expect(meta(db, id2).imagesDiscarded).toBe(true)

    const nextId = row('user', 'weiter')
    runner.submitUserMessage({ ...base, text: 'weiter', messageId: nextId })
    await vi.advanceTimersByTimeAsync(10)
    await flush()
    expect(agent.calls).toEqual([{ text: 'weiter', attachments: [] }])
  })

  it('a turn stopped while running (no assistant row) does not hand its images to the next turn', async () => {
    const { db, agent, runner, row } = gatedSetup(0)
    const photo = upload('running.jpg')
    const id = row('user', '[block] schau', [photo])
    const first = runner.submitUserMessage({ ...base, text: '[block] schau', attachments: [photo], messageId: id })
    expect(first.mode).toBe('started')
    await new Promise(r => setTimeout(r, 20))
    expect(agent.calls).toHaveLength(1)
    expect(typeof meta(db, id).imagesTakenBy).toBe('string')
    expect(runner.abortTurnInSession(1, 's-1')).toBe(true)
    await new Promise(r => setTimeout(r, 20))
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'assistant' AND session_id = 's-1' AND content = 'ok'").get()).toEqual({ n: 0 })

    const nextId = row('user', 'nochmal ohne Bild')
    runner.submitUserMessage({ ...base, text: 'nochmal ohne Bild', messageId: nextId })
    await new Promise(r => setTimeout(r, 20))
    expect(agent.calls[1]).toEqual({ text: 'nochmal ohne Bild', attachments: [] })
  })

  it('two photo messages, then text: ONE turn with all images, none twice', async () => {
    vi.useFakeTimers()
    const { db, agent, runner, row } = setup()
    const a = [upload('a1.jpg'), upload('a2.jpg')]
    const b = [upload('b1.jpg')]
    const idA = row('user', '', a)
    expect(runner.submitUserMessage({ ...base, text: '', attachments: a, messageId: idA }).mode).toBe('held')
    await vi.advanceTimersByTimeAsync(3_000)
    const idB = row('user', '', b)
    expect(runner.submitUserMessage({ ...base, text: '', attachments: b, messageId: idB }).mode).toBe('held')
    await vi.advanceTimersByTimeAsync(3_000)
    const textId = row('user', 'Vergleiche die Bilder')
    expect(runner.submitUserMessage({ ...base, text: 'Vergleiche die Bilder', messageId: textId }).mode).toBe('started')
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()
    expect(agent.calls).toEqual([{ text: 'Vergleiche die Bilder', attachments: ['a1.jpg', 'a2.jpg', 'b1.jpg'] }])
    // Both photo rows are settled by that turn.
    expect(typeof meta(db, idA).imagesTakenBy).toBe('string')
    expect(meta(db, idB).imagesTakenBy).toBe(meta(db, idA).imagesTakenBy)
  })

  it('the hold timer fires while another strand of the persona runs: the photos are queued, not lost', async () => {
    const { agent, runner, row } = gatedSetup(40)
    const photo = upload('queued.jpg')
    const photoId = row('user', '', [photo])
    expect(runner.submitUserMessage({ ...base, text: '', attachments: [photo], messageId: photoId }).mode).toBe('held')
    const blockId = row('user', '[block] zweite', [], 's-2')
    expect(runner.submitUserMessage({ ...base, sessionId: 's-2', text: '[block] zweite', messageId: blockId }).mode).toBe('started')
    await new Promise(r => setTimeout(r, 100))
    // Timer fired during the s-2 turn: no call yet for the photos (queued).
    expect(agent.calls.map(c => c.text)).toEqual(['[block] zweite'])
    agent.release()
    await new Promise(r => setTimeout(r, 50))
    expect(agent.calls[1]).toEqual({ text: '', attachments: ['queued.jpg'] })
  })

  it('a document or a recording without text is not held (images only, F6)', async () => {
    const { agent, runner, row } = setup()
    const doc = upload('notiz.pdf', 'file', 'application/pdf')
    const docId = row('user', '', [doc])
    expect(runner.submitUserMessage({ ...base, text: '', attachments: [doc], messageId: docId }).mode).toBe('started')
    await new Promise(r => setTimeout(r, 20))
    const mixed = [upload('m.jpg'), upload('rec.m4a', 'file', 'audio/mp4')]
    const mixedId = row('user', '', mixed)
    expect(runner.submitUserMessage({ ...base, text: '', attachments: mixed, messageId: mixedId }).mode).toBe('started')
    await new Promise(r => setTimeout(r, 20))
    expect(agent.calls.map(c => c.attachments)).toEqual([['notiz.pdf'], ['m.jpg', 'rec.m4a']])
  })
})

describe('collectUnansweredImages: isolation, settled rows, cap (F1/F3)', () => {
  it('only rows of the same session and user (legacy NULL user tolerated)', () => {
    const { db, row } = setup()
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'u2', 'h', 'user')").run()
    row('user', '', [upload('own.jpg')])
    row('user', '', [upload('other-session.jpg')], 's-2')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES ('s-1', 2, 'user', '', ?, 'main')")
      .run(JSON.stringify({ files: [upload('other-user.jpg')] }))
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES ('s-1', NULL, 'user', '', ?, 'main')")
      .run(JSON.stringify({ files: [upload('legacy.jpg')] }))
    const current = row('user', 'jetzt')
    expect(collectUnansweredImageUploads(db, { sessionId: 's-1', userId: 1, beforeMessageId: current }).map(u => u.originalName))
      .toEqual(['own.jpg', 'legacy.jpg'])
    expect(collectUnansweredImageUploads(db, { sessionId: 's-1', userId: 2, beforeMessageId: current }).map(u => u.originalName))
      .toEqual(['other-user.jpg', 'legacy.jpg'])
    expect(collectUnansweredImageUploads(db, { sessionId: 's-1', userId: null, beforeMessageId: current })).toEqual([])
  })

  it('skips discarded and taken rows', () => {
    const { db, row } = setup()
    const discarded = row('user', '', [upload('d.jpg')])
    const taken = row('user', '', [upload('t.jpg')])
    row('user', '', [upload('open.jpg')])
    db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(JSON.stringify({ files: [upload('d.jpg')], imagesDiscarded: true }), discarded)
    db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(JSON.stringify({ files: [upload('t.jpg')], imagesTakenBy: 'turn-x' }), taken)
    const current = row('user', 'jetzt')
    const found = collectUnansweredImages(db, { sessionId: 's-1', userId: 1, beforeMessageId: current })
    expect(found.uploads.map(u => u.originalName)).toEqual(['open.jpg'])
    expect(found.messageIds).toHaveLength(1)
  })

  it('at most 8 images, the newest win, sent order kept', () => {
    const { db, row } = setup()
    for (let r = 0; r < 4; r++) row('user', '', [upload(`r${r}-a.jpg`), upload(`r${r}-b.jpg`), upload(`r${r}-c.jpg`)])
    const current = row('user', 'jetzt')
    const found = collectUnansweredImageUploads(db, { sessionId: 's-1', userId: 1, beforeMessageId: current })
    expect(found.map(u => u.originalName)).toEqual([
      'r1-b.jpg', 'r1-c.jpg', 'r2-a.jpg', 'r2-b.jpg', 'r2-c.jpg', 'r3-a.jpg', 'r3-b.jpg', 'r3-c.jpg',
    ])
  })
})
