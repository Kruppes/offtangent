/**
 * S0-B/QW4+QW7: the shared contract fixture. The Kotlin app runs the same
 * file (`app/src/test/resources/interaction-contract.json`, byte-identical)
 * against its own parser, so the two parsers cannot drift silently.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  extractDraftText,
  extractInteractionBlocks,
  interactionSkipReason,
  parseInteractionMessage,
  resolveInteractionBlockState,
  renderInteractionMessageAsText,
  type InteractionCardPosition,
} from './interaction-blocks.js'

interface ParseCase {
  name: string
  /** Optional exclusion: only with `platformsReason`, see the fixture `_comment`. */
  platforms?: string[]
  platformsReason?: string
  streaming?: boolean
  content: string
  expect: {
    blocks: Array<{ kind: string; id: string; question: string; optionIds: string[] }>
    text?: string
    draft?: string | null
    pending?: boolean
  }
}
interface SkipCase { name: string; position: InteractionCardPosition; expect: string | null }
interface ExpiryCase { name: string; content: string; now: string; expect: 'open' | 'expired' }

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'interaction-contract.json'), 'utf8')) as {
  parse: ParseCase[]
  skip: SkipCase[]
  expiry: ExpiryCase[]
}

/**
 * No case is skipped silently: a case without `platforms` binds both parsers;
 * an exclusion needs a written reason and is listed in the test output.
 */
const excluded = fixture.parse.filter(entry => entry.platforms !== undefined && !entry.platforms.includes('ts'))
const tsCases = fixture.parse.filter(entry => !excluded.includes(entry))
if (excluded.length > 0) {
  console.info(`interaction contract: ${excluded.length} case(s) excluded for ts: ${excluded.map(entry => `${entry.name} (${entry.platformsReason ?? 'NO REASON'})`).join('; ')}`)
}

describe('interaction contract fixture (TS)', () => {
  it('excludes a case from a platform only with an explicit reason', () => {
    for (const entry of fixture.parse) {
      if (entry.platforms === undefined) continue
      expect(entry.platforms.length, entry.name).toBeGreaterThan(0)
      expect(entry.platformsReason?.trim(), `${entry.name}: platforms without platformsReason`).toBeTruthy()
    }
  })

  it('has expiry cases', () => {
    expect(fixture.expiry.length).toBeGreaterThan(0)
  })

  for (const testCase of tsCases) {
    it(testCase.name, () => {
      const segments = parseInteractionMessage(testCase.content, { streaming: testCase.streaming === true })
      const blocks = segments.flatMap(segment => segment.type === 'block' ? [segment.block] : [])
      expect(blocks.map(block => ({
        kind: block.kind, id: block.id, question: block.question, optionIds: block.options.map(option => option.id),
      }))).toEqual(testCase.expect.blocks)
      if (!testCase.streaming) {
        expect(extractInteractionBlocks(testCase.content).filter(block => block.supported).map(block => block.id).slice(0, 1))
          .toEqual(testCase.expect.blocks.map(block => block.id).slice(0, 1))
      }
      if (testCase.expect.text !== undefined) expect(renderInteractionMessageAsText(testCase.content)).toBe(testCase.expect.text)
      if (testCase.expect.draft !== undefined) expect(extractDraftText(testCase.content)).toBe(testCase.expect.draft)
      if (testCase.expect.pending !== undefined) {
        expect(segments.some(segment => segment.type === 'pending')).toBe(testCase.expect.pending)
      }
    })
  }

  for (const testCase of fixture.expiry) {
    it(`expiry: ${testCase.name}`, () => {
      const block = extractInteractionBlocks(testCase.content)[0]
      expect(block).toBeDefined()
      const state = resolveInteractionBlockState(block!, null, { now: Date.parse(testCase.now) })
      expect(state.closedReason === 'expired' ? 'expired' : 'open').toBe(testCase.expect)
    })
  }

  for (const testCase of fixture.skip) {
    it(`skip rule: ${testCase.name}`, () => {
      expect(interactionSkipReason(testCase.position)).toBe(testCase.expect)
    })
  }
})
