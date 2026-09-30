import type { FactsQuery } from './types.js'

interface ParseSuccess<T> {
  ok: true
  value: T
}

interface ParseFailure {
  ok: false
  error: string
}

type ParseResult<T> = ParseSuccess<T> | ParseFailure

function toSingleString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0]
  }

  return undefined
}

export function parseContentBody(body: unknown): ParseResult<string> {
  const content = (body as { content?: unknown } | null | undefined)?.content
  if (content === undefined || content === null) {
    return { ok: false, error: 'Content is required' }
  }

  return { ok: true, value: content as string }
}

export function parseDateParam(rawDate: unknown): ParseResult<string> {
  const date = toSingleString(rawDate)
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: 'Invalid date format. Use YYYY-MM-DD' }
  }

  return { ok: true, value: date }
}

export function parseWikiFilenameParam(rawFilename: unknown): ParseResult<{ name: string; safeFilename: string }> {
  const filename = toSingleString(rawFilename)
  if (!filename || !/^[\w.-]+$/.test(filename)) {
    return {
      ok: false,
      error: 'Invalid filename. Use only alphanumeric characters, hyphens, underscores, and dots.',
    }
  }

  const name = filename.endsWith('.md') ? filename.slice(0, -3) : filename
  return {
    ok: true,
    value: {
      name,
      safeFilename: `${name}.md`,
    },
  }
}

export function parseMemoryPathParam(rawPath: unknown): ParseResult<string> {
  const raw = toSingleString(rawPath)
  const segments = (raw ?? '').split('/').filter((segment) => segment.length > 0)

  // Segments must not start with a dot — this blocks '.', '..' (path traversal) and hidden files.
  const isValidSegment = (segment: string) => /^[\w][\w.-]*$/.test(segment)

  if (segments.length === 0 || !segments.every(isValidSegment) || !segments[segments.length - 1].endsWith('.md')) {
    return {
      ok: false,
      error: 'Invalid path. Use relative paths with alphanumeric segments ending in .md',
    }
  }

  return { ok: true, value: segments.join('/') }
}

export function parseProjectNameParam(rawName: unknown): ParseResult<string> {
  const name = toSingleString(rawName)
  if (!name || !/^[\w-]+$/.test(name)) {
    return {
      ok: false,
      error: 'Invalid project name. Use only alphanumeric characters, hyphens, and underscores.',
    }
  }

  return { ok: true, value: name }
}

export function parseFactIdParam(rawId: unknown): ParseResult<number> {
  const id = Number.parseInt(toSingleString(rawId) ?? '', 10)
  if (Number.isNaN(id)) {
    return { ok: false, error: 'Invalid fact ID' }
  }

  return { ok: true, value: id }
}

export function parseFactsQuery(query: Record<string, unknown>): ParseResult<FactsQuery> {
  const rawUserId = toSingleString(query.userId)
  const rawLimit = toSingleString(query.limit)
  const rawOffset = toSingleString(query.offset)

  const userId = rawUserId && rawUserId.trim().length > 0
    ? Number.parseInt(rawUserId, 10)
    : undefined

  const limit = rawLimit && rawLimit.trim().length > 0
    ? Number.parseInt(rawLimit, 10)
    : undefined

  const offset = rawOffset && rawOffset.trim().length > 0
    ? Number.parseInt(rawOffset, 10)
    : undefined

  if (userId !== undefined && Number.isNaN(userId)) {
    return { ok: false, error: 'Invalid userId' }
  }

  if (limit !== undefined && Number.isNaN(limit)) {
    return { ok: false, error: 'Invalid limit' }
  }

  if (offset !== undefined && Number.isNaN(offset)) {
    return { ok: false, error: 'Invalid offset' }
  }

  return {
    ok: true,
    value: {
      query: toSingleString(query.query),
      userId,
      dateFrom: toSingleString(query.dateFrom),
      dateTo: toSingleString(query.dateTo),
      limit,
      offset,
    },
  }
}
