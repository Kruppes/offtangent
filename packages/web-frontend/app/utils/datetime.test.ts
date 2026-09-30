import { describe, expect, it } from 'vitest'
import { parseBackendTimestamp } from './datetime'

describe('parseBackendTimestamp', () => {
  it('treats SQLite naked datetime strings as UTC', () => {
    const date = parseBackendTimestamp('2024-11-04 13:07:42')
    expect(date).not.toBeNull()
    expect(date!.toISOString()).toBe('2024-11-04T13:07:42.000Z')
  })

  it('treats naked ISO strings without offset as UTC', () => {
    const date = parseBackendTimestamp('2024-11-04T13:07:42')
    expect(date).not.toBeNull()
    expect(date!.toISOString()).toBe('2024-11-04T13:07:42.000Z')
  })

  it('preserves ISO strings with explicit Z', () => {
    const date = parseBackendTimestamp('2024-11-04T13:07:42Z')
    expect(date!.toISOString()).toBe('2024-11-04T13:07:42.000Z')
  })

  it('preserves ISO strings with millisecond precision and Z', () => {
    const date = parseBackendTimestamp('2024-11-04T13:07:42.123Z')
    expect(date!.toISOString()).toBe('2024-11-04T13:07:42.123Z')
  })

  it('preserves ISO strings with explicit positive offset', () => {
    const date = parseBackendTimestamp('2024-11-04T15:07:42+02:00')
    expect(date!.toISOString()).toBe('2024-11-04T13:07:42.000Z')
  })

  it('preserves ISO strings with explicit negative offset', () => {
    const date = parseBackendTimestamp('2024-11-04T08:07:42-05:00')
    expect(date!.toISOString()).toBe('2024-11-04T13:07:42.000Z')
  })

  it('returns null for empty or nullish input', () => {
    expect(parseBackendTimestamp(null)).toBeNull()
    expect(parseBackendTimestamp(undefined)).toBeNull()
    expect(parseBackendTimestamp('')).toBeNull()
    expect(parseBackendTimestamp('   ')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(parseBackendTimestamp('not a date')).toBeNull()
  })
})
