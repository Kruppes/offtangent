import { describe, it, expect } from 'vitest'
import { inspect } from 'node:util'
import { errorClass, formatProviderErrorDiagnostic, providerErrorDiagnostic, withRawError } from './log-safe-error.js'

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

describe('providerErrorDiagnostic (http_400 incident 2026-11-12)', () => {
  const VERBATIM = '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0: a system message that holds tool blocks cannot be the first message; declare these tools in tools[] or place the message after the first user message"},"request_id":"req_011CgyMZ2iUKefZeQMYMsPGx"}'
  // Record and log line of the incident message as produced on 5e14c56f (before the H1 allowlists).
  const INCIDENT_RECORD = {
    status: 400, type: 'invalid_request_error', path: 'messages.0',
    phrases: ['system message', 'tool blocks', 'first message', 'first user message', 'tools[]', 'user'],
    fingerprint: 'f4f81932f674',
  }
  const INCIDENT_LINE = 'status=400 type=invalid_request_error path=messages.0 '
    + 'phrases=[system message|tool blocks|first message|first user message|tools[]|user] fp=f4f81932f674'

  it('keeps status, error type, path and fixed phrases of the verbatim Anthropic rejection', () => {
    const d = providerErrorDiagnostic(VERBATIM)
    expect(d).not.toBeNull()
    expect(d!.status).toBe(400)
    expect(d!.type).toBe('invalid_request_error')
    expect(d!.path).toBe('messages.0')
    expect(d!.phrases).toEqual(expect.arrayContaining(['system message', 'tool blocks', 'first message', 'first user message', 'tools[]']))
    expect(d!.fingerprint).toMatch(/^[0-9a-f]{12}$/)
    // Same message, other request id: same fingerprint.
    expect(providerErrorDiagnostic(VERBATIM.replace('req_011CgyMZ2iUKefZeQMYMsPGx', 'req_other'))!.fingerprint).toBe(d!.fingerprint)
  })

  it('never carries text the provider echoed from the request', () => {
    const MARKER = 'PRIVATE_DICTATION_MARKER_4242'
    const raw = `400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0: unexpected text ${MARKER} in tool_result"}}`
    const d = providerErrorDiagnostic(raw)!
    expect(d.path).toBe('messages.3.content.0')
    expect(JSON.stringify(d)).not.toContain(MARKER)
    expect(formatProviderErrorDiagnostic(d)).not.toContain(MARKER)
    const plain = providerErrorDiagnostic(`400 bad request, request was: ${MARKER}`)!
    expect(JSON.stringify(plain)).not.toContain(MARKER)
    // A non-allowlisted error type becomes the fixed word, never the provider value (review H1).
    expect(providerErrorDiagnostic(`400 {"error":{"type":"${MARKER} x","message":"m"}}`)!.type).toBe('other')
  })

  it('H1: an identifier-shaped echo in the path is cut, never stored or logged', () => {
    const cases: Array<[string, string, string]> = [
      ['MY_PRIVATE_ACCESS_TOKEN', 'messages.MY_PRIVATE_ACCESS_TOKEN: invalid argument', 'messages.<cut>'],
      ['SecretName', 'tools.3.custom.SecretName: field required', 'tools.3.custom.<cut>'],
      ['Hidden_Word', 'messages.2.content.0.Hidden_Word.text: bad', 'messages.2.content.0.<cut>'],
      ['secret_prop', 'tools.0.input_schema.properties.secret_prop: invalid', 'tools.0.input_schema.properties.<cut>'],
    ]
    for (const [word, message, expected] of cases) {
      const raw = `400 {"type":"error","error":{"type":"invalid_request_error","message":${JSON.stringify(message)}}}`
      const d = providerErrorDiagnostic(raw)!
      expect(d.path).toBe(expected)
      expect(JSON.stringify(d)).not.toContain(word)
      expect(formatProviderErrorDiagnostic(d)).not.toContain(word)
      expect(formatProviderErrorDiagnostic(d)).toContain(`path=${expected} `)
      // Same for a non-JSON body.
      const plain = providerErrorDiagnostic(`400 invalid argument ${message}`)!
      expect(plain.path).toBe(expected)
      expect(formatProviderErrorDiagnostic(plain)).not.toContain(word)
    }
    // Known fields and indexes pass unchanged.
    expect(providerErrorDiagnostic('400 messages.1.content.2.tool_use_id: bad')!.path).toBe('messages.1.content.2.tool_use_id')
  })

  it('H1: an unknown error.type is replaced by the fixed word "other"', () => {
    for (const word of ['my_private_access_token', 'secretname', 'invalid_request_error_x']) {
      const d = providerErrorDiagnostic(`400 {"type":"error","error":{"type":"${word}","message":"messages.0: bad"}}`)!
      expect(d.type).toBe('other')
      expect(JSON.stringify(d)).not.toContain(word)
      expect(formatProviderErrorDiagnostic(d)).not.toContain(word)
    }
    for (const known of ['invalid_request_error', 'overloaded_error', 'rate_limit_error', 'not_found_error', 'exceed_context_size_error']) {
      expect(providerErrorDiagnostic(`400 {"error":{"type":"${known}","message":"m"}}`)!.type).toBe(known)
    }
  })

  it('H1: the incident message gives exactly the same record as before the allowlists', () => {
    expect(providerErrorDiagnostic(VERBATIM)).toEqual(INCIDENT_RECORD)
    expect(formatProviderErrorDiagnostic(providerErrorDiagnostic(VERBATIM)!)).toBe(INCIDENT_LINE)
  })

  it('returns null for anything that is not a 4xx', () => {
    expect(providerErrorDiagnostic('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBeNull()
    expect(providerErrorDiagnostic('fetch failed (ECONNRESET)')).toBeNull()
    expect(providerErrorDiagnostic(undefined)).toBeNull()
  })
})
