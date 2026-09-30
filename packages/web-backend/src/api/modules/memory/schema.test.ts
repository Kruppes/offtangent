import { describe, expect, it } from 'vitest'
import {
  parseContentBody,
  parseDateParam,
  parseFactIdParam,
  parseFactsQuery,
  parseMemoryPathParam,
  parseProjectNameParam,
  parseWikiFilenameParam,
} from './schema.js'

describe('memory schema', () => {
  it('parses required content payloads', () => {
    expect(parseContentBody({})).toEqual({ ok: false, error: 'Content is required' })
    expect(parseContentBody({ content: null })).toEqual({ ok: false, error: 'Content is required' })
    expect(parseContentBody({ content: '# Hello' })).toEqual({ ok: true, value: '# Hello' })
  })

  it('validates date params as YYYY-MM-DD', () => {
    expect(parseDateParam('2026-03-27')).toEqual({ ok: true, value: '2026-03-27' })
    expect(parseDateParam('2026-3-27')).toEqual({ ok: false, error: 'Invalid date format. Use YYYY-MM-DD' })
    expect(parseDateParam(undefined)).toEqual({ ok: false, error: 'Invalid date format. Use YYYY-MM-DD' })
  })

  it('normalizes wiki filenames and project names', () => {
    expect(parseWikiFilenameParam('axiom')).toEqual({
      ok: true,
      value: { name: 'axiom', safeFilename: 'axiom.md' },
    })
    expect(parseWikiFilenameParam('axiom.md')).toEqual({
      ok: true,
      value: { name: 'axiom', safeFilename: 'axiom.md' },
    })
    expect(parseWikiFilenameParam('../escape')).toEqual({
      ok: false,
      error: 'Invalid filename. Use only alphanumeric characters, hyphens, underscores, and dots.',
    })

    expect(parseProjectNameParam('project_42')).toEqual({ ok: true, value: 'project_42' })
    expect(parseProjectNameParam('project.md')).toEqual({
      ok: false,
      error: 'Invalid project name. Use only alphanumeric characters, hyphens, and underscores.',
    })
  })

  it('validates memory file paths and rejects traversal', () => {
    expect(parseMemoryPathParam('wiki/axiom.md')).toEqual({ ok: true, value: 'wiki/axiom.md' })
    expect(parseMemoryPathParam('/SOUL.md')).toEqual({ ok: true, value: 'SOUL.md' })
    expect(parseMemoryPathParam('daily//2026-01-01.md')).toEqual({ ok: true, value: 'daily/2026-01-01.md' })

    expect(parseMemoryPathParam('../secrets.md').ok).toBe(false)
    expect(parseMemoryPathParam('wiki/../../etc/passwd.md').ok).toBe(false)
    expect(parseMemoryPathParam('wiki/.hidden.md').ok).toBe(false)
    expect(parseMemoryPathParam('wiki/page.txt').ok).toBe(false)
    expect(parseMemoryPathParam('').ok).toBe(false)
    expect(parseMemoryPathParam(undefined).ok).toBe(false)
  })

  it('validates fact IDs and query pagination parameters', () => {
    expect(parseFactIdParam('12')).toEqual({ ok: true, value: 12 })
    expect(parseFactIdParam('abc')).toEqual({ ok: false, error: 'Invalid fact ID' })

    expect(parseFactsQuery({ userId: 'nope' })).toEqual({ ok: false, error: 'Invalid userId' })
    expect(parseFactsQuery({ limit: 'NaN' })).toEqual({ ok: false, error: 'Invalid limit' })
    expect(parseFactsQuery({ offset: 'oops' })).toEqual({ ok: false, error: 'Invalid offset' })

    expect(parseFactsQuery({ query: 'docker', userId: '2', limit: '20', offset: '40' })).toEqual({
      ok: true,
      value: {
        query: 'docker',
        userId: 2,
        dateFrom: undefined,
        dateTo: undefined,
        limit: 20,
        offset: 40,
      },
    })
  })
})
