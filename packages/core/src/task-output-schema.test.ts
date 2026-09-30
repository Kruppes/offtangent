import { describe, expect, it } from 'vitest'
import { parseOutputSchema, extractJsonObject, checkOutputAgainstSchema, buildSchemaCorrectionPrompt } from './task-output-schema.js'

const schema = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' } }, additionalProperties: false }

describe('task-output-schema', () => {
  it('parses a schema string and rejects broken or non object schemas', () => {
    expect(parseOutputSchema(JSON.stringify(schema)).ok).toBe(true)
    expect(parseOutputSchema('{oops').ok).toBe(false)
    expect(parseOutputSchema('[1]').ok).toBe(false)
    expect(parseOutputSchema('{"type":"string"}').ok).toBe(false)
    expect(parseOutputSchema(undefined).ok).toBe(false)
  })

  it('extracts JSON from bare, fenced and prose wrapped summaries', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({ ok: true, value: { a: 1 } })
    expect(extractJsonObject('no json').ok).toBe(false)
  })

  it('validates and reports readable errors', () => {
    expect(checkOutputAgainstSchema(schema, '{"findings":["x"],"count":2}').ok).toBe(true)
    const bad = checkOutputAgainstSchema(schema, '{"findings":[1],"count":"x","extra":true}')
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.some(e => e.includes('/findings/0'))).toBe(true)
      expect(bad.errors.some(e => e.includes('/count'))).toBe(true)
      expect(bad.errors.some(e => e.includes('additional properties'))).toBe(true)
    }
  })

  it('builds the correction prompt with errors verbatim and the schema', () => {
    const p = buildSchemaCorrectionPrompt(JSON.stringify(schema), ['/count: must be integer'])
    expect(p).toContain('only correction round')
    expect(p).toContain('- /count: must be integer')
    expect(p).toContain('"required":["findings"]')
  })
})
