import { describe, it, expect } from 'vitest'
import { detectFactConflicts, normalizeForConflicts } from './memory-conflicts.js'
import type { ConflictCandidate } from './memory-conflicts.js'

function fact(
  id: number,
  content: string,
  extra: Partial<Omit<ConflictCandidate, 'id' | 'content'>> = {},
): ConflictCandidate {
  return { id, content, status: 'active', supersessionKey: null, ...extra }
}

describe('normalizeForConflicts', () => {
  it('lowercases, folds diacritics and collapses whitespace', () => {
    expect(normalizeForConflicts('  Grüße   AUS   Köln!  ')).toBe('gruesse aus koeln')
  })

  it('keeps numbers and separators that carry the value', () => {
    expect(normalizeForConflicts('Port 3800/tcp, version 2.1')).toBe('port 3800/tcp, version 2.1')
  })
})

describe('detectFactConflicts', () => {
  it('flags two active facts that share a supersession key', () => {
    const links = detectFactConflicts([
      fact(1, 'The backup lives in one place', { supersessionKey: 'system.backup' }),
      fact(2, 'The backup lives somewhere else entirely', { supersessionKey: 'system.backup' }),
    ])

    expect(links.get(1)).toEqual([{ id: 2, reason: 'same_subject_key' }])
    expect(links.get(2)).toEqual([{ id: 1, reason: 'same_subject_key' }])
  })

  it('ignores a shared supersession key when one side is already superseded', () => {
    const links = detectFactConflicts([
      fact(1, 'Alpha uses sqlite', { supersessionKey: 'alpha.db', status: 'superseded' }),
      fact(2, 'Alpha uses postgres', { supersessionKey: 'alpha.db' }),
    ])

    expect(links.size).toBe(0)
  })

  it('flags a negated restatement of the same content', () => {
    const links = detectFactConflicts([
      fact(1, 'The owner rides the nomad seven on alpine trails'),
      fact(2, 'The owner does not ride the nomad seven on alpine trails'),
    ])

    expect(links.get(1)).toEqual([{ id: 2, reason: 'negation' }])
  })

  it('flags a German negated restatement', () => {
    const links = detectFactConflicts([
      fact(1, 'Der Heizungstausch ist geplant fuer Oktober'),
      fact(2, 'Der Heizungstausch ist nicht geplant fuer Oktober'),
    ])

    expect(links.get(1)?.[0]?.reason).toBe('negation')
  })

  it('flags a numeric mismatch on otherwise identical content', () => {
    const links = detectFactConflicts([
      fact(1, 'The offtangent instance listens on port 3800'),
      fact(2, 'The offtangent instance listens on port 3900'),
    ])

    expect(links.get(1)).toEqual([{ id: 2, reason: 'value_mismatch' }])
  })

  it('does not flag unrelated facts', () => {
    const links = detectFactConflicts([
      fact(1, 'The garden gate needs new hinges'),
      fact(2, 'The offtangent instance listens on port 3800'),
      fact(3, 'Coffee beans are stored in the pantry'),
    ])

    expect(links.size).toBe(0)
  })

  it('does not flag two facts that agree including their numbers', () => {
    const links = detectFactConflicts([
      fact(1, 'The offtangent instance listens on port 3800'),
      fact(2, 'Port 3800 is where the offtangent instance listens'),
    ])

    expect(links.size).toBe(0)
  })

  it('prefers the supersession key reason over the text heuristics', () => {
    const links = detectFactConflicts([
      fact(1, 'The roof work starts in week 12', { supersessionKey: 'roof.start' }),
      fact(2, 'The roof work starts in week 14', { supersessionKey: 'roof.start' }),
    ])

    expect(links.get(1)).toEqual([{ id: 2, reason: 'same_subject_key' }])
  })

  it('is deterministic and order independent for the produced pairs', () => {
    const facts = [
      fact(3, 'The offtangent instance listens on port 3800'),
      fact(1, 'The offtangent instance listens on port 3900'),
      fact(2, 'Coffee beans are stored in the pantry'),
    ]
    const first = detectFactConflicts(facts)
    const second = detectFactConflicts([...facts].reverse())

    expect([...first.entries()].sort()).toEqual([...second.entries()].sort())
    expect(first.get(1)).toEqual([{ id: 3, reason: 'value_mismatch' }])
    expect(first.get(3)).toEqual([{ id: 1, reason: 'value_mismatch' }])
  })

  it('never compares more facts than the scan window allows', () => {
    const facts = Array.from({ length: 10 }, (_, i) => fact(i + 1, 'The port is 3800', { supersessionKey: 'port' }))
    const links = detectFactConflicts(facts, { maxScan: 3 })

    expect([...links.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('sorts conflict partners by id', () => {
    const links = detectFactConflicts([
      fact(9, 'Value is 1', { supersessionKey: 'k' }),
      fact(4, 'Value is 2', { supersessionKey: 'k' }),
      fact(7, 'Value is 3', { supersessionKey: 'k' }),
    ])

    expect(links.get(7)).toEqual([{ id: 4, reason: 'same_subject_key' }, { id: 9, reason: 'same_subject_key' }])
  })
})
