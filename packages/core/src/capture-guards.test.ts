/**
 * The three capture gates (capture-guards.ts). Each block starts from the row
 * in the live database that forced the guard, so a regression is recognisable
 * as the incident coming back and not merely as a red test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { ensureOfftangentTables } from './offtangent-schema.js'
import { insertCapture, insertDecision, updateCapture, updateDecision } from './strand-store.js'
import {
  EXPLICIT_TARGET_FORBIDDEN,
  clientCreatedStrand,
  explicitTargetVerdict,
  findDeviceAffinity,
  isFillerCapture,
  isUserSurfaceSource,
} from './capture-guards.js'

let db: Database

beforeEach(() => {
  db = initDatabase(':memory:')
  ensureOfftangentTables(db)
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
})

afterEach(() => {
  db.close()
})

function strand(id: string, options: { archived?: number } = {}): string {
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, agent_id, started_at, last_activity, archived)
     VALUES (?, 1, '1', 'web', 'interactive', 'main', datetime('now'), datetime('now'), ?)`,
  ).run(id, options.archived ?? 0)
  return id
}

/** A capture that was filed into `strandId`, optionally aged by minutes. */
function filedCapture(input: { source: string; strandId: string; ageMinutes?: number; text?: string }): string {
  const capture = insertCapture(db, {
    userId: '1', agentId: 'main', clientMessageId: null, text: input.text ?? 'note',
    kind: 'text', source: input.source, attachments: [],
  })
  updateCapture(db, capture.id, { status: 'filed', strandId: input.strandId })
  if (input.ageMinutes) {
    db.prepare("UPDATE captures SET created_at = datetime('now', ?) WHERE id = ?")
      .run(`-${input.ageMinutes} minutes`, capture.id)
  }
  return capture.id
}

/** A decision that records `strandId` as created BY this capture. */
function creatingDecision(captureId: string, strandId: string): void {
  const decision = insertDecision(db, {
    captureId, action: 'new_strand', strandId: null, secondaryStrandId: null, intent: 'note',
    confidence: 0.9, tags: [], rationale: 'new', title: 'T', personaId: 'main', projectId: null,
    projectSuggestion: null, alternatives: [], model: 'stub', latencyMs: 1, state: 'proposed',
  })
  updateDecision(db, decision.id, { state: 'applied', createdStrandId: strandId, strandId, appliedAt: 'now' })
}

describe('explicit strand targeting', () => {
  it('knows which sources are a user interface', () => {
    expect(isUserSurfaceSource('web')).toBe(true)
    expect(isUserSurfaceSource('android')).toBe(true)
    expect(isUserSurfaceSource('ios')).toBe(true)
    expect(isUserSurfaceSource('bench')).toBe(false)
    expect(isUserSurfaceSource('test')).toBe(false)
    expect(isUserSurfaceSource('puck')).toBe(false)
    expect(isUserSurfaceSource('task')).toBe(false)
  })

  it('lets a user surface name any of the user\'s strands', () => {
    const id = strand('s-user')
    expect(explicitTargetVerdict(db, { userId: '1', source: 'web', strandId: id }))
      .toEqual({ kind: 'user' })
    expect(explicitTargetVerdict(db, { userId: '1', source: 'android', strandId: id }))
      .toEqual({ kind: 'user' })
  })

  /**
   * The incident: capture b008c981, source `bench`, filed into the strand
   * "Idee fuer Abendessen" that the product owner was writing in at that
   * moment, with `model: 'explicit'` and "Strand chosen by the user".
   */
  it('refuses a programmatic caller that targets a foreign strand', () => {
    const id = strand('s-foreign')
    const verdict = explicitTargetVerdict(db, { userId: '1', source: 'bench', strandId: id })
    expect(verdict.kind).toBe('forbidden')
    if (verdict.kind !== 'forbidden') throw new Error('unreachable')
    expect(verdict.code).toBe(EXPLICIT_TARGET_FORBIDDEN)
    expect(verdict.message).toContain('bench')
  })

  it('lets a programmatic caller write into a strand it created itself', () => {
    const id = strand('s-own')
    creatingDecision(filedCapture({ source: 'bench', strandId: id }), id)
    expect(clientCreatedStrand(db, '1', 'bench', id)).toBe(true)
    expect(explicitTargetVerdict(db, { userId: '1', source: 'bench', strandId: id }))
      .toEqual({ kind: 'client' })
  })

  it('does not let one client inherit the strand another client created', () => {
    const id = strand('s-other-client')
    creatingDecision(filedCapture({ source: 'puck', strandId: id }), id)
    expect(clientCreatedStrand(db, '1', 'bench', id)).toBe(false)
    expect(explicitTargetVerdict(db, { userId: '1', source: 'bench', strandId: id }).kind).toBe('forbidden')
  })

  it('does not let a client inherit a strand of another user', () => {
    const id = strand('s-user-2')
    creatingDecision(filedCapture({ source: 'bench', strandId: id }), id)
    expect(clientCreatedStrand(db, '2', 'bench', id)).toBe(false)
  })
})

describe('device affinity', () => {
  it('finds the strand of the previous capture from the same source', () => {
    const id = strand('s-device')
    filedCapture({ source: 'puck', strandId: id, ageMinutes: 2 })
    const hint = findDeviceAffinity(db, '1', { source: 'puck', windowMinutes: 10 })
    expect(hint).not.toBeNull()
    expect(hint!.strandId).toBe(id)
    expect(hint!.source).toBe('puck')
    expect(hint!.ageMinutes).toBeGreaterThanOrEqual(1)
    expect(hint!.ageMinutes).toBeLessThanOrEqual(3)
  })

  it('takes the most recent capture when several are in the window', () => {
    const older = strand('s-older')
    const newer = strand('s-newer')
    filedCapture({ source: 'puck', strandId: older, ageMinutes: 8 })
    filedCapture({ source: 'puck', strandId: newer, ageMinutes: 1 })
    expect(findDeviceAffinity(db, '1', { source: 'puck', windowMinutes: 10 })!.strandId).toBe(newer)
  })

  it('forgets a capture older than the window', () => {
    filedCapture({ source: 'puck', strandId: strand('s-old'), ageMinutes: 45 })
    expect(findDeviceAffinity(db, '1', { source: 'puck', windowMinutes: 10 })).toBeNull()
  })

  it('does not carry a hint across sources or users', () => {
    filedCapture({ source: 'puck', strandId: strand('s-cross'), ageMinutes: 1 })
    expect(findDeviceAffinity(db, '1', { source: 'web', windowMinutes: 10 })).toBeNull()
    expect(findDeviceAffinity(db, '2', { source: 'puck', windowMinutes: 10 })).toBeNull()
  })

  it('ignores an archived strand and a capture that was never filed', () => {
    filedCapture({ source: 'puck', strandId: strand('s-archived', { archived: 1 }), ageMinutes: 1 })
    expect(findDeviceAffinity(db, '1', { source: 'puck', windowMinutes: 10 })).toBeNull()

    const pending = insertCapture(db, {
      userId: '1', agentId: 'main', clientMessageId: null, text: 'x', kind: 'text', source: 'puck', attachments: [],
    })
    updateCapture(db, pending.id, { strandId: strand('s-pending') })
    expect(findDeviceAffinity(db, '1', { source: 'puck', windowMinutes: 10 })).toBeNull()
  })

  it('never points at the capture being routed right now', () => {
    const id = strand('s-self')
    const captureId = filedCapture({ source: 'puck', strandId: id })
    expect(findDeviceAffinity(db, '1', { source: 'puck', windowMinutes: 10, excludeCaptureId: captureId })).toBeNull()
  })

  it('is off at a window of zero', () => {
    filedCapture({ source: 'puck', strandId: strand('s-off'), ageMinutes: 1 })
    expect(findDeviceAffinity(db, '1', { source: 'puck', windowMinutes: 0 })).toBeNull()
  })
})

describe('filler gate', () => {
  /** Capture ffd77c2b: appended to a foreign strand with confidence 0.87. */
  it('recognises the thank you that was appended with 0.87', () => {
    expect(isFillerCapture('Vielen Dank.')).toBe(true)
  })

  it('recognises courtesy in both languages', () => {
    for (const text of [
      'Danke!', 'danke dir', 'Vielen Dank nochmal', 'Alles klar, danke.', 'Ok, danke schon mal',
      'Thanks', 'Thank you very much', 'thx', 'Perfekt, danke', 'Hallo', 'Tschüss', 'Mhm',
    ]) {
      expect(isFillerCapture(text), text).toBe(true)
    }
  })

  it('keeps every capture that carries a subject', () => {
    for (const text of [
      'Danke für die Bremsbeläge, die passen.',
      'Sag dem Gerät bitte in einem kurzen Satz, was es nach dem Aufwachen anzeigen soll.',
      'Idee für Abendessen: Ofengemüse',
      'Thanks, but the invoice is still open',
      'Hallo Welt, ich brauche einen Termin beim Zahnarzt',
    ]) {
      expect(isFillerCapture(text), text).toBe(false)
    }
  })

  /**
   * A bare "ja" is the answer to the question the persona just asked. It goes
   * to the router, where the device hint puts it back into its conversation;
   * swallowing an answer is worse than filing a meaningless one.
   */
  it('lets a bare answer through', () => {
    for (const text of ['Ja', 'ja.', 'Nein', 'ok', 'Yes', 'No', 'Doch!']) {
      expect(isFillerCapture(text), text).toBe(false)
    }
  })

  it('leaves the Whisper artefacts to the silence guard', () => {
    // `* Musik *` has no words at all, so this gate never claims it; the
    // silence guard upstream knows the bracket shapes.
    expect(isFillerCapture('* Musik *')).toBe(false)
    expect(isFillerCapture('')).toBe(false)
    expect(isFillerCapture('   ')).toBe(false)
  })

  it('never looks at a long text, and is off at zero characters', () => {
    const long = `${'danke '.repeat(30)}`
    expect(isFillerCapture(long, { maxChars: 80 })).toBe(false)
    expect(isFillerCapture('Vielen Dank.', { maxChars: 0 })).toBe(false)
  })
})
