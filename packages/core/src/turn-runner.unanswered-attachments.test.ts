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
import { collectUnansweredImageUploads, mergeUploads } from './unanswered-attachments.js'

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
    const found = collectUnansweredImageUploads(db, { sessionId: 's-1', beforeMessageId: current })
    expect(found.map(u => u.originalName)).toEqual(['p1.jpg'])
  })

  it('ignores rows older than the window', () => {
    const { db, row } = seed()
    const old = row('user', '', [upload('stale.jpg')])
    db.prepare("UPDATE chat_messages SET timestamp = datetime('now', '-2 hours') WHERE id = ?").run(old)
    const current = row('user', 'neu')
    expect(collectUnansweredImageUploads(db, { sessionId: 's-1', beforeMessageId: current })).toEqual([])
  })

  it('mergeUploads keeps order and drops the same stored file twice', () => {
    const a = upload('a.jpg')
    expect(mergeUploads([a, upload('b.jpg')], [a, upload('c.jpg')]).map(u => u.originalName)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
  })
})
