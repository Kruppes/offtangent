import { describe, it, expect } from 'vitest'
import { parseHaJson } from './ha-json.js'
describe('HA strict JSON', () => {
  it.each(['{"x":1,"x":2}', '{"na\\u006de":1,"name":2}', '{"nested":[{"a":1,"a":2}]}', '{"n":1e999}', '{"n":-1e999}', '{"n":NaN}', '{"n":Infinity}', '{"a":1,}', '{', '['.repeat(65)+'0'+']'.repeat(65)])('rejects ambiguity or invalid JSON %s', source => {
    expect(() => parseHaJson(source)).toThrow(SyntaxError)
  })
  it('allows repeated keys in different objects and ignores apparent syntax inside strings', () => {
    const source = '{"a":{"x":1},"b":{"x":2},"text":"{\\"x\\":0,\\"x\\":1} [] NaN 1e999"}'
    expect(parseHaJson(source)).toEqual(JSON.parse(source))
  })
  it('handles escaped quotes, slash, backslash and primitive arrays', () => {
    const value = [{ 'quoted"\\/': 'escaped"\\/' }, true, false, null, 1.2e-40]
    expect(parseHaJson(JSON.stringify(value))).toEqual(value)
  })
})
