import { describe, it, expect } from 'vitest'
import { buildInteractiveQuestionsPrompt, INTERACTIVE_QUESTION_EXAMPLE } from './interactive-questions-prompt.js'
import { parseInteractionMessage, parseInteractionBlockPayload } from './contracts/interaction-blocks.js'

describe('buildInteractiveQuestionsPrompt', () => {
  it('teaches an example the real parser renders as a card', () => {
    const prompt = buildInteractiveQuestionsPrompt()
    const fenceStart = prompt.indexOf('```offtangent')
    const fenceEnd = prompt.indexOf('```', fenceStart + 3)
    expect(fenceStart).toBeGreaterThan(-1)
    expect(fenceEnd).toBeGreaterThan(fenceStart)

    const message = `Two branches are ready.\n\n${prompt.slice(fenceStart, fenceEnd + 3)}`
    const segments = parseInteractionMessage(message)
    const blocks = segments.filter(s => s.type === 'block')

    expect(blocks).toHaveLength(1)
    const block = blocks[0]!.type === 'block' ? blocks[0]!.block : null
    expect(block?.kind).toBe('choice')
    expect(block?.id).toBe(INTERACTIVE_QUESTION_EXAMPLE.id)
    expect(block?.supported).toBe(true)
    expect(block?.options.map(o => o.id)).toEqual(INTERACTIVE_QUESTION_EXAMPLE.options.map(o => o.id))
  })

  it('names only kinds the contract accepts', () => {
    const prompt = buildInteractiveQuestionsPrompt()
    for (const kind of ['choice', 'confirm', 'multi']) {
      expect(prompt).toContain(`\`${kind}\``)
      expect(parseInteractionBlockPayload({
        block: kind,
        id: 'k',
        question: 'q?',
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      })).not.toBeNull()
    }
  })

  it('tells the persona to stop after asking and warns against overuse', () => {
    const prompt = buildInteractiveQuestionsPrompt()
    expect(prompt).toContain('<interactive_questions>')
    expect(prompt).toMatch(/then stop/i)
    expect(prompt).toMatch(/when you have enough to decide, decide/i)
    expect(prompt).toContain('at most 1 block per message')
  })
})
