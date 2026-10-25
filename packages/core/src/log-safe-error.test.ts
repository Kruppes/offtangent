import { describe, it, expect } from 'vitest'
import { inspect } from 'node:util'
import { errorClass, withRawError } from './log-safe-error.js'

const MARKER = 'PRIVATE_SPOKEN_PHRASE_SAMPLE'

describe('errorClass', () => {
  it('maps known shapes to fixed classes', () => {
    expect(errorClass(new Error('Request timed out'))).toBe('timeout')
    expect(errorClass(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('aborted')
    expect(errorClass(Object.assign(new Error('x'), { status: 429 }))).toBe('rate_limited')
    expect(errorClass(new Error('401 Unauthorized'))).toBe('auth')
    expect(errorClass(Object.assign(new Error('x'), { status: 503 }))).toBe('http_503')
    expect(errorClass(new Error('upstream said 500: boom'))).toBe('http_500')
    expect(errorClass(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe('network')
    expect(errorClass(new Error('model p:x is not available'))).toBe('model_unavailable')
    expect(errorClass(new TypeError('x'))).toBe('type_error')
    expect(errorClass('a string')).toBe('non_error')
  })

  it('never returns any part of the message', () => {
    for (const err of [
      new Error(`provider echo ${MARKER}`),
      new Error(`Incorrect API key provided: sk-${MARKER}`),
      Object.assign(new Error(MARKER), { name: MARKER, code: MARKER, status: MARKER }),
      { message: MARKER, name: MARKER },
    ]) {
      expect(errorClass(err)).not.toContain(MARKER)
      expect(errorClass(err)).toMatch(/^[a-z_0-9]+$/)
    }
  })
})

describe('withRawError (review K0-K2-5, hardening)', () => {
  const MARKER = 'PRIVATE_CLOCK_DICTATION_MARKER_007'

  it('keeps the raw text readable in process, but out of JSON, inspect, keys and spread', () => {
    const chunk = withRawError({ type: 'error', error: 'The model provider reported an error (auth).' }, `401 ${MARKER}`)
    expect(chunk.rawError).toBe(`401 ${MARKER}`)
    expect(Object.keys(chunk)).toEqual(['type', 'error'])
    expect(JSON.stringify(chunk)).not.toContain(MARKER)
    expect(inspect(chunk, { depth: 5 })).not.toContain(MARKER)
    expect(inspect({ wrapped: [chunk] }, { depth: 5 })).not.toContain(MARKER)
    expect(({ ...chunk } as { rawError?: string }).rawError).toBeUndefined()
  })

  it('a forwarder can re-attach it to a spread copy; undefined attaches nothing', () => {
    const chunk = withRawError({ type: 'error', error: 'x' }, `raw ${MARKER}`)
    const forwarded = withRawError({ ...chunk, sessionId: 's' }, chunk.rawError)
    expect(forwarded.rawError).toBe(`raw ${MARKER}`)
    expect(JSON.stringify(forwarded)).not.toContain(MARKER)
    const plain = withRawError({ type: 'error', error: 'x' }, undefined)
    expect('rawError' in plain).toBe(false)
  })
})
