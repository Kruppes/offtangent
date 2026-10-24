/**
 * S1-B, B4: the `askUser` section of the shared contract fixture
 * (`fixtures/interaction-contract.json`, byte-identical copy in the app repo
 * under `app/src/test/resources/`). The TS validator `parseAskUserArgs` must
 * produce exactly the expected normalization or rule code for every case.
 * The Kotlin app reads only the sections it knows (`parse`, `expiry`, `skip`),
 * so this section is additive; the app-side test of `askUser` is S1-C.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ASK_USER_OTHER_OPTION_ID, parseAskUserArgs } from './ask-user.js'

interface ExpectedQuestion { id: string; type: string; optionIds: string[]; allowComment: boolean; recommended?: string }
type AskUserCase = {
  name: string
  args: unknown
  expect: { ok: true; blocking: boolean; questions: ExpectedQuestion[] } | { ok: false; code: string }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'interaction-contract.json'), 'utf8')) as { askUser?: AskUserCase[] }
const cases = fixture.askUser ?? []

describe('ask_user contract fixture (shared with the app)', () => {
  it('has the askUser section with valid and invalid cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8)
    expect(cases.some(c => c.expect.ok)).toBe(true)
    expect(cases.some(c => !c.expect.ok)).toBe(true)
    expect(new Set(cases.map(c => c.name)).size).toBe(cases.length)
  })

  for (const c of cases) {
    it(c.name, () => {
      const result = parseAskUserArgs(c.args, { id: 'fixture', now: Date.parse('2026-01-01T00:00:00Z') })
      if (!c.expect.ok) {
        expect(result).toMatchObject({ ok: false, code: c.expect.code })
        return
      }
      if (!result.ok) throw new Error(`${c.name}: rejected with ${result.code}`)
      expect(result.value.blocking).toBe(c.expect.blocking)
      const actual = result.value.questions.map(q => {
        const row: ExpectedQuestion = { id: q.id, type: q.type, optionIds: q.options.map(o => o.id), allowComment: q.allowComment }
        if (q.recommended !== undefined) row.recommended = q.recommended
        return row
      })
      expect(actual).toEqual(c.expect.questions)
      // The automatic Other row exists exactly when allowComment is set, is last and is flagged.
      for (const q of result.value.questions) {
        const others = q.options.filter(o => o.id === ASK_USER_OTHER_OPTION_ID)
        expect(others.length).toBe(q.allowComment ? 1 : 0)
        if (q.allowComment) expect(q.options.at(-1)).toMatchObject({ id: ASK_USER_OTHER_OPTION_ID, other: true })
      }
    })
  }
})
