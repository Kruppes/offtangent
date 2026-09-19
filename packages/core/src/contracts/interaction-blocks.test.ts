import { describe, it, expect } from 'vitest'
import {
  ANSWERABLE_INTERACTION_BLOCK_KINDS,
  extractAnswerableInteractionBlocks,
  findAnswerableInteractionBlock,
  INTERACTION_BLOCK_KINDS,
  INTERACTION_BLOCK_MAX_OPTIONS,
  RENDERED_INTERACTION_BLOCK_KINDS,
  extractInteractionBlocks,
  findInteractionBlock,
  formatInteractionBlockAsText,
  formatInteractionBlockFence,
  hasInteractionBlock,
  parseInteractionBlockPayload,
  parseInteractionMessage,
  readInteractionAnswers,
  renderInteractionMessageAsText,
  validateInteractionAnswer,
  withInteractionAnswer,
  type InteractionAnswerRecord,
} from './interaction-blocks.js'

function fence(body: string): string {
  return ['```offtangent', body, '```'].join('\n')
}

const choiceBody = JSON.stringify({
  block: 'choice',
  id: 'b1',
  question: 'Hand this to Bob?',
  options: [
    { id: 'yes', label: 'Hand over to Bob', icon: 'handover' },
    { id: 'stay', label: 'Keep it here' },
  ],
})

describe('parseInteractionMessage', () => {
  it('splits text around a choice block', () => {
    const content = `Here is what I found.\n\n${fence(choiceBody)}\n\nTell me either way.`
    const segments = parseInteractionMessage(content)

    expect(segments.map(s => s.type)).toEqual(['text', 'block', 'text'])
    const block = segments[1] as Extract<(typeof segments)[number], { type: 'block' }>
    expect(block.block.kind).toBe('choice')
    expect(block.block.id).toBe('b1')
    expect(block.block.options).toHaveLength(2)
    expect(block.block.options[0]!.label).toBe('Hand over to Bob')
    expect((segments[0] as { text: string }).text).toContain('Here is what I found.')
    expect((segments[2] as { text: string }).text).toContain('Tell me either way.')
  })

  it('parses a confirm block and defaults its two options', () => {
    const body = JSON.stringify({ block: 'confirm', id: 'c1', question: 'Delete the strand?', destructive: true })
    const blocks = extractInteractionBlocks(fence(body))

    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('confirm')
    expect(blocks[0]!.destructive).toBe(true)
    expect(blocks[0]!.options.map(o => o.id)).toEqual(['yes', 'no'])
    expect(blocks[0]!.options[0]!.style).toBe('danger')
  })

  it('honours custom confirm labels', () => {
    const body = JSON.stringify({
      block: 'confirm', id: 'c2', question: 'Send it?', confirmLabel: 'Send now', cancelLabel: 'Not yet',
    })
    const blocks = extractInteractionBlocks(fence(body))
    expect(blocks[0]!.options.map(o => o.label)).toEqual(['Send now', 'Not yet'])
  })

  it('never throws and keeps broken JSON as plain text', () => {
    const content = `Before\n\n${fence('{ "block": "choice", "id": ')}\n\nAfter`
    const segments = parseInteractionMessage(content)

    expect(segments.every(s => s.type === 'text')).toBe(true)
    expect(segments.map(s => (s as { text: string }).text).join('')).toContain('"block": "choice"')
    expect(hasInteractionBlock(content)).toBe(false)
  })

  it('keeps an unterminated fence as text (a streaming message is not a card yet)', () => {
    const content = `Thinking…\n\n\`\`\`offtangent\n{ "block": "choice", "id": "b1", "question": "Now?"`
    const segments = parseInteractionMessage(content)
    expect(segments.every(s => s.type === 'text')).toBe(true)
  })

  it.each([
    ['unknown kind', { block: 'vote', id: 'b', question: 'q', options: [{ id: 'a', label: 'A' }] }],
    ['missing id', { block: 'choice', question: 'q', options: [{ id: 'a', label: 'A' }] }],
    ['missing question', { block: 'choice', id: 'b', options: [{ id: 'a', label: 'A' }] }],
    ['empty options', { block: 'choice', id: 'b', question: 'q', options: [] }],
    ['option without label', { block: 'choice', id: 'b', question: 'q', options: [{ id: 'a' }] }],
    ['duplicate option ids', { block: 'choice', id: 'b', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }],
    ['options not an array', { block: 'choice', id: 'b', question: 'q', options: 'yes' }],
    ['a bare array', ['choice']],
    ['a bare string', 'choice'],
  ])('rejects %s', (_name, payload) => {
    expect(parseInteractionBlockPayload(payload)).toBeNull()
    expect(hasInteractionBlock(fence(JSON.stringify(payload)))).toBe(false)
  })

  it(`rejects more than ${INTERACTION_BLOCK_MAX_OPTIONS} options (restraint rule)`, () => {
    const options = Array.from({ length: INTERACTION_BLOCK_MAX_OPTIONS + 1 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }))
    const body = JSON.stringify({ block: 'choice', id: 'b', question: 'q', options })
    expect(hasInteractionBlock(fence(body))).toBe(false)
    expect(renderInteractionMessageAsText(fence(body))).toContain('"block"')
  })

  it('renders at most one card per message and degrades the rest to text', () => {
    const second = JSON.stringify({
      block: 'choice', id: 'b2', question: 'And the second one?',
      options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
    })
    const content = `${fence(choiceBody)}\n\n${fence(second)}`
    const segments = parseInteractionMessage(content)

    expect(segments.filter(s => s.type === 'block')).toHaveLength(1)
    const text = segments.filter(s => s.type === 'text').map(s => (s as { text: string }).text).join('')
    expect(text).toContain('And the second one?')
    expect(text).toContain('1. Alpha')
    expect(text).not.toContain('"block"')
  })

  it('degrades kinds that are reserved but not shipped (multi, handover, schedule)', () => {
    const body = JSON.stringify({
      block: 'schedule', id: 's1', question: 'When should I resurface this?',
      options: [{ id: 'tonight', label: 'Tonight' }, { id: 'tomorrow', label: 'Tomorrow' }],
    })
    const segments = parseInteractionMessage(fence(body))

    expect(segments.every(s => s.type === 'text')).toBe(true)
    const text = (segments[0] as { text: string }).text
    expect(text).toContain('When should I resurface this?')
    expect(text).toContain('1. Tonight')
    expect(text).not.toContain('{')
  })

  it('leaves ordinary code fences alone', () => {
    const content = 'Look:\n\n```json\n{ "block": "choice" }\n```\n'
    const segments = parseInteractionMessage(content)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.type).toBe('text')
    expect((segments[0] as { text: string }).text).toBe(content)
  })

  it('handles an empty message', () => {
    expect(parseInteractionMessage('')).toEqual([])
    expect(renderInteractionMessageAsText('')).toBe('')
  })

  it('finds a block by id', () => {
    expect(findInteractionBlock(fence(choiceBody), 'b1')?.question).toBe('Hand this to Bob?')
    expect(findInteractionBlock(fence(choiceBody), 'nope')).toBeNull()
  })
})

describe('all five SPEC kinds are prepared; two of them render', () => {
  const payloads = {
    choice: { block: 'choice', id: 'k1', question: 'Which one?', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] },
    confirm: { block: 'confirm', id: 'k2', question: 'Send it?' },
    multi: { block: 'multi', id: 'k3', question: 'Which ones?', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] },
    handover: { block: 'handover', id: 'k4', question: 'Who takes it?', options: [{ id: 'bob', label: 'Bob', icon: 'handover' }, { id: 'me', label: 'Keep it here' }] },
    schedule: { block: 'schedule', id: 'k5', question: 'When?', options: [{ id: 'now', label: 'Now' }, { id: 'tonight', label: 'Tonight' }] },
  } as const

  it.each(INTERACTION_BLOCK_KINDS)('parses and validates a %s block', (kind) => {
    const block = parseInteractionBlockPayload(payloads[kind])
    expect(block).not.toBeNull()
    expect(block!.kind).toBe(kind)
    expect(block!.options.length).toBeGreaterThan(0)
    // Answer validation works for every kind, so enabling a renderer later
    // needs no backend change.
    const value = kind === 'multi' ? [block!.options[0]!.id] : block!.options[0]!.id
    expect(validateInteractionAnswer(block!, value).ok).toBe(true)
  })

  it('renders exactly confirm and choice as cards; the other three stay text', () => {
    expect([...RENDERED_INTERACTION_BLOCK_KINDS]).toEqual(['confirm', 'choice'])
    for (const kind of INTERACTION_BLOCK_KINDS) {
      const block = parseInteractionBlockPayload(payloads[kind])!
      const rendered = RENDERED_INTERACTION_BLOCK_KINDS.includes(kind)
      expect(block.supported).toBe(rendered)
      expect(hasInteractionBlock(fence(JSON.stringify(payloads[kind])))).toBe(rendered)
      // Whatever does not render is a readable list, never raw JSON.
      if (!rendered) {
        const text = renderInteractionMessageAsText(fence(JSON.stringify(payloads[kind])))
        expect(text).toContain(payloads[kind].question)
        expect(text).toContain('1. ')
        expect(text).not.toContain('{')
      }
    }
  })

  it('allows up to eight options for multi and five for the rest', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }))
    expect(parseInteractionBlockPayload({ block: 'multi', id: 'm', question: 'q', options: eight })).not.toBeNull()
    expect(parseInteractionBlockPayload({ block: 'handover', id: 'h', question: 'q', options: eight })).toBeNull()
  })
})

describe('text degradation (Telegram parity, SPEC 7.11)', () => {
  it('turns a block into a numbered list and never leaks JSON', () => {
    const content = `Two ways to go here.\n\n${fence(choiceBody)}`
    const text = renderInteractionMessageAsText(content)

    expect(text).toContain('Two ways to go here.')
    expect(text).toContain('Hand this to Bob?')
    expect(text).toContain('1. Hand over to Bob')
    expect(text).toContain('2. Keep it here')
    expect(text).toContain('Reply with the number or the label.')
    expect(text).not.toContain('```')
    expect(text).not.toContain('"block"')
    expect(text).not.toContain('{')
  })

  it('numbers a confirm block as well', () => {
    const body = JSON.stringify({ block: 'confirm', id: 'c1', question: 'Really delete it?', destructive: true })
    const text = renderInteractionMessageAsText(fence(body))
    expect(text).toBe('Really delete it?\n1. Yes\n2. No\n(Reply with the number or the label.)')
  })

  it('uses the plural hint for multi', () => {
    const block = parseInteractionBlockPayload({
      block: 'multi', id: 'm1', question: 'Which ones?',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    })!
    expect(formatInteractionBlockAsText(block)).toContain('Reply with the numbers or the labels.')
  })
})

describe('answer state in chat_messages.metadata', () => {
  const record: InteractionAnswerRecord = {
    blockId: 'b1',
    value: 'yes',
    label: 'Hand over to Bob',
    answeredAt: '2026-09-15T10:00:00.000Z',
    clientMessageId: 'cmid-1',
    resumed: false,
  }

  it('merges an answer without losing other metadata', () => {
    const merged = withInteractionAnswer(JSON.stringify({ files: ['a.png'], type: 'x' }), record)
    expect(merged.files).toEqual(['a.png'])
    expect(merged.type).toBe('x')
    expect(readInteractionAnswers(merged).b1!.label).toBe('Hand over to Bob')
  })

  it('reads answers from a JSON string and from an object', () => {
    const merged = withInteractionAnswer(null, record)
    expect(readInteractionAnswers(JSON.stringify(merged)).b1!.value).toBe('yes')
    expect(readInteractionAnswers(merged).b1!.value).toBe('yes')
  })

  it('returns an empty state for junk metadata', () => {
    expect(readInteractionAnswers('not json')).toEqual({})
    expect(readInteractionAnswers(null)).toEqual({})
    expect(readInteractionAnswers('{"interactionAnswers": 5}')).toEqual({})
  })
})

describe('validateInteractionAnswer', () => {
  const block = parseInteractionBlockPayload(JSON.parse(choiceBody))!

  it('accepts a known option id and returns its label', () => {
    expect(validateInteractionAnswer(block, 'stay')).toEqual({ ok: true, label: 'Keep it here', value: 'stay' })
  })

  it('rejects an unknown option id', () => {
    expect(validateInteractionAnswer(block, 'maybe')).toEqual({ ok: false, code: 'invalid_value' })
  })

  it('rejects an array for a single-choice block', () => {
    expect(validateInteractionAnswer(block, ['yes'])).toEqual({ ok: false, code: 'invalid_value' })
  })

  it('accepts several ids for multi', () => {
    const multi = parseInteractionBlockPayload({
      block: 'multi', id: 'm1', question: 'Which ones?',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    })!
    expect(validateInteractionAnswer(multi, ['a', 'b'])).toEqual({ ok: true, label: 'A, B', value: ['a', 'b'] })
    expect(validateInteractionAnswer(multi, [])).toEqual({ ok: false, code: 'invalid_value' })
  })
})

describe('formatInteractionBlockFence', () => {
  it('produces a fence the parser reads back as the same block', () => {
    const fenced = formatInteractionBlockFence({
      kind: 'choice',
      id: 'note-confirm',
      question: 'Oder soll ich darauf antworten?',
      options: [
        { id: 'keep', label: 'Nur als Notiz behalten' },
        { id: 'answer', label: 'Antworte darauf' },
      ],
    })
    expect(fenced.startsWith('```offtangent\n')).toBe(true)
    expect(fenced.endsWith('\n```')).toBe(true)

    const blocks = extractInteractionBlocks(fenced)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({
      kind: 'choice',
      id: 'note-confirm',
      question: 'Oder soll ich darauf antworten?',
      options: [
        { id: 'keep', label: 'Nur als Notiz behalten' },
        { id: 'answer', label: 'Antworte darauf' },
      ],
      destructive: false,
      supported: true,
    })
  })

  it('carries the optional fields only when they mean something', () => {
    const plain = formatInteractionBlockFence({
      kind: 'confirm', id: 'c1', question: 'Delete it?',
      options: [{ id: 'yes', label: 'Delete' }, { id: 'no', label: 'Keep' }],
    })
    expect(plain).not.toContain('destructive')
    expect(plain).not.toContain('expiresAt')

    const loud = formatInteractionBlockFence({
      kind: 'confirm', id: 'c1', question: 'Delete it?',
      options: [{ id: 'yes', label: 'Delete', style: 'danger' }, { id: 'no', label: 'Keep' }],
      destructive: true,
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
    const block = extractInteractionBlocks(loud)[0]
    expect(block.destructive).toBe(true)
    expect(block.expiresAt).toBe('2030-01-01T00:00:00.000Z')
    expect(block.options[0].style).toBe('danger')
  })

  it('degrades to a numbered list instead of raw JSON, prose intact', () => {
    const message = 'Als Notiz abgelegt.\n\n' + formatInteractionBlockFence({
      kind: 'choice', id: 'note-confirm', question: 'Oder soll ich darauf antworten?',
      options: [{ id: 'keep', label: 'Nur als Notiz behalten' }, { id: 'answer', label: 'Antworte darauf' }],
    })
    const text = renderInteractionMessageAsText(message)
    expect(text).toContain('Als Notiz abgelegt.')
    expect(text).toContain('1. Nur als Notiz behalten')
    expect(text).toContain('2. Antworte darauf')
    expect(text).not.toContain('{')
    expect(text).not.toContain('```')
  })
})

describe('extractAnswerableInteractionBlocks', () => {
  function fence(payload: Record<string, unknown>): string {
    return ['```offtangent', JSON.stringify(payload), '```'].join('\n')
  }

  const twoOptions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]

  it('returns every declared kind, including the ones that only degrade to text', () => {
    for (const kind of INTERACTION_BLOCK_KINDS) {
      const content = `Text\n\n${fence({ block: kind, id: 'x', question: 'Which?', options: twoOptions })}`
      const answerable = findAnswerableInteractionBlock(content, 'x')
      expect(answerable?.kind).toBe(kind)
      // …while the rendering view still shows restraint for the kinds that
      // have no card yet. That difference is the point of the two functions.
      const rendered = findInteractionBlock(content, 'x')
      if (RENDERED_INTERACTION_BLOCK_KINDS.includes(kind)) expect(rendered?.kind).toBe(kind)
      else expect(rendered).toBeNull()
    }
  })

  it('declares every kind answerable', () => {
    expect([...ANSWERABLE_INTERACTION_BLOCK_KINDS]).toEqual([...INTERACTION_BLOCK_KINDS])
  })

  it('finds a second block that the renderer degrades to text', () => {
    const content = [
      fence({ block: 'choice', id: 'one', question: 'Which?', options: twoOptions }),
      fence({ block: 'choice', id: 'two', question: 'Which?', options: twoOptions }),
    ].join('\n\n')
    expect(extractAnswerableInteractionBlocks(content).map(b => b.id)).toEqual(['one', 'two'])
    expect(extractInteractionBlocks(content).map(b => b.id)).toEqual(['one'])
  })

  it('keeps ignoring broken, unterminated and unknown payloads', () => {
    expect(extractAnswerableInteractionBlocks('```offtangent\n{ "block": "choice"\n```')).toEqual([])
    expect(extractAnswerableInteractionBlocks('```offtangent\n{ "block": "choice", "id": "a" }')).toEqual([])
    expect(extractAnswerableInteractionBlocks(fence({ block: 'poll', id: 'p', question: 'Q?', options: twoOptions }))).toEqual([])
    expect(extractAnswerableInteractionBlocks('no fence here')).toEqual([])
  })

  it('lets the first block of a duplicated id win, so an answer is never ambiguous', () => {
    const content = [
      fence({ block: 'choice', id: 'dup', question: 'First?', options: twoOptions }),
      fence({ block: 'choice', id: 'dup', question: 'Second?', options: twoOptions }),
    ].join('\n\n')
    const blocks = extractAnswerableInteractionBlocks(content)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].question).toBe('First?')
  })
})
