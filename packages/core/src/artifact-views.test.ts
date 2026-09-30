/**
 * Living views: one artifact per (strand, view key) that keeps its history.
 *
 * The rules pinned here are the ones every client depends on:
 *   - the same key delivered again is revision n + 1, never a second view
 *   - a revision never overwrites the bytes of an older one
 *   - `latestRevision` on every artifact tells an old card it is old
 *   - two strands with the same key are two independent views
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  getArtifactForUser,
  insertArtifact,
  listArtifacts,
  listStrandViews,
  readArtifactContent,
  recordMessageArtifacts,
} from './artifact-store.js'
import { normalizeViewKey } from './artifact-extract.js'
import { saveUpload } from './uploads.js'

const USER_ID = 5
const STRAND = 'strand-wheel-session'

let tempDir: string
let previousDataDir: string | undefined
let db: Database

function view(messageId: number, revisionText: string, viewKey: string | null = 'front-wheel') {
  return insertArtifact(db, {
    userId: USER_ID,
    strandId: STRAND,
    messageId,
    agentId: 'analyst',
    kind: 'html',
    title: `Front wheel ${revisionText}`,
    source: 'upload',
    mimeType: 'text/html',
    content: Buffer.from(`<p>${revisionText}</p>`, 'utf8'),
    viewKey,
  })
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-views-'))
  previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = tempDir
  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice', 'x', 'admin')").run(USER_ID)
})

afterEach(() => {
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('normalizeViewKey', () => {
  it('accepts a key of 2 to 40 characters and folds case and whitespace', () => {
    expect(normalizeViewKey('front-wheel')).toBe('front-wheel')
    expect(normalizeViewKey('  Front-Wheel  ')).toBe('front-wheel')
    expect(normalizeViewKey('w1')).toBe('w1')
    expect(normalizeViewKey('a'.repeat(40))).toBe('a'.repeat(40))
  })

  it('refuses everything it would have to rewrite', () => {
    for (const bad of ['', 'a', 'a'.repeat(41), '-wheel', 'wheel-', 'front_wheel', 'front wheel', 'rad/vorn', 'rädle', null, 7]) {
      expect(normalizeViewKey(bad as unknown)).toBeNull()
    }
  })
})

describe('view revisions', () => {
  it('numbers revisions from 1 and reports the latest on every revision', () => {
    const first = view(10, 'round 1')!
    const second = view(11, 'round 2')!
    const third = view(12, 'round 3')!

    expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3])
    expect(first.viewKey).toBe('front-wheel')

    // Re-read: the projection has to report the newest revision on an OLD row,
    // which is what makes "a newer version exists" a pure comparison.
    expect(getArtifactForUser(db, USER_ID, first.id)!.latestRevision).toBe(3)
    expect(getArtifactForUser(db, USER_ID, third.id)!.latestRevision).toBe(3)
  })

  it('keeps the bytes of every revision', () => {
    const first = view(10, 'round 1')!
    const second = view(11, 'round 2')!
    expect(readArtifactContent(db, first.id)!.toString('utf8')).toBe('<p>round 1</p>')
    expect(readArtifactContent(db, second.id)!.toString('utf8')).toBe('<p>round 2</p>')
  })

  it('leaves a plain artifact without a view key, revision or latest revision', () => {
    const plain = view(10, 'one off', null)!
    expect(plain.viewKey).toBeNull()
    expect(plain.revision).toBeNull()
    expect(plain.latestRevision).toBeNull()
  })

  it('refuses an invalid view key instead of storing a broken one', () => {
    expect(() => view(10, 'bad', 'Front Wheel')).toThrow(/Invalid view key/)
  })

  it('counts per strand, so the same key in another strand starts at 1', () => {
    view(10, 'round 1')
    const other = insertArtifact(db, {
      userId: USER_ID,
      strandId: 'another-strand',
      messageId: 20,
      kind: 'html',
      title: 'Front wheel elsewhere',
      source: 'upload',
      mimeType: 'text/html',
      content: Buffer.from('<p>elsewhere</p>', 'utf8'),
      viewKey: 'front-wheel',
    })!
    expect(other.revision).toBe(1)
  })

  it('lists the views of a strand newest first with their revisions ascending', () => {
    view(10, 'round 1')
    view(11, 'round 2')
    insertArtifact(db, {
      userId: USER_ID,
      strandId: STRAND,
      messageId: 12,
      kind: 'svg',
      title: 'Tension chart',
      source: 'upload',
      mimeType: 'image/svg+xml',
      content: Buffer.from('<svg/>', 'utf8'),
      viewKey: 'tension-chart',
    })
    // A plain artifact of the same strand must not show up as a view.
    view(13, 'one off', null)

    const views = listStrandViews(db, USER_ID, STRAND)
    expect(views.map(v => v.viewKey).sort()).toEqual(['front-wheel', 'tension-chart'])
    const wheel = views.find(v => v.viewKey === 'front-wheel')!
    expect(wheel.latestRevision).toBe(2)
    expect(wheel.title).toBe('Front wheel round 2')
    expect(wheel.kind).toBe('html')
    expect(wheel.revisions.map(r => r.revision)).toEqual([1, 2])
    expect(wheel.updatedAt).toBe(wheel.revisions[1]!.createdAt)
  })

  it('returns no views for a strand that has none', () => {
    view(10, 'one off', null)
    expect(listStrandViews(db, USER_ID, STRAND)).toEqual([])
  })

  it('hides the views of another user', () => {
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (9, 'bob', 'x', 'user')").run()
    view(10, 'round 1')
    expect(listStrandViews(db, 9, STRAND)).toEqual([])
  })
})

describe('recordMessageArtifacts with a view key on the upload', () => {
  function upload(name: string, viewKey?: string) {
    const descriptor = saveUpload({
      buffer: Buffer.from(`<!doctype html><title>${name}</title>`, 'utf8'),
      originalName: name,
      mimeType: 'text/html; charset=utf-8',
      source: 'web',
      userId: USER_ID,
      sessionId: STRAND,
    })
    if (viewKey) descriptor.viewKey = viewKey
    return descriptor
  }

  it('turns two deliveries of the same key into revision 1 and 2', () => {
    const first = recordMessageArtifacts(db, {
      messageId: 30,
      strandId: STRAND,
      userId: USER_ID,
      content: '',
      uploads: [upload('round-1.html', 'front-wheel')],
    })
    const second = recordMessageArtifacts(db, {
      messageId: 31,
      strandId: STRAND,
      userId: USER_ID,
      content: '',
      uploads: [upload('round-2.html', 'front-wheel')],
    })

    expect(first.artifacts[0]!.revision).toBe(1)
    expect(second.artifacts[0]!.revision).toBe(2)
    expect(second.artifacts[0]!.viewKey).toBe('front-wheel')
    expect(listStrandViews(db, USER_ID, STRAND)).toHaveLength(1)
  })

  it('ignores an invalid key on the descriptor rather than dropping the artifact', () => {
    const descriptor = upload('round-1.html')
    ;(descriptor as { viewKey?: string }).viewKey = 'Not A Key'
    const result = recordMessageArtifacts(db, {
      messageId: 32,
      strandId: STRAND,
      userId: USER_ID,
      content: '',
      uploads: [descriptor],
    })
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]!.viewKey).toBeNull()
  })

  it('never makes an inline fence a view revision', () => {
    const result = recordMessageArtifacts(db, {
      messageId: 33,
      strandId: STRAND,
      userId: USER_ID,
      content: '```html Inline\n<p>hi</p>\n```',
      uploads: [],
    })
    expect(result.artifacts[0]!.viewKey).toBeNull()
    expect(listArtifacts(db, USER_ID, { strandId: STRAND })).toHaveLength(1)
  })
})
