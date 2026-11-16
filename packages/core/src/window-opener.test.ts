/**
 * Unit tests for the window-opener rule (review of eb00df29: B2 predicate,
 * F3 bounded/id-free structure, F4 wording, F5 flag instead of text prefix).
 */
import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { trimMessagesToBudget } from './strand-context.js'
import {
  describeHistoryStructure,
  isWindowOpener,
  isWireUser,
  makeWindowOpener,
  MAX_STRUCTURE_CHARS,
  openWindowOnUser,
  WINDOW_OPENER_EXCERPT_CHARS,
  WINDOW_OPENER_TEXT,
} from './message-history.js'

let ts = 1
const readNote = { name: 'read_note' }
const askUser = { name: 'ask_user' }
const sys = (): AgentMessage => ({ role: 'system', content: 'You are the persona.', toolsAdded: [readNote], timestamp: 0 }) as unknown as AgentMessage
const deferred = (): AgentMessage => ({ role: 'system', content: '', toolsAdded: [askUser], timestamp: 0 }) as unknown as AgentMessage
const user = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: ts++ }) as unknown as AgentMessage
const assistantCall = (id: string): AgentMessage =>
  ({ role: 'assistant', stopReason: 'toolUse', timestamp: ts++, content: [{ type: 'text', text: 'step' }, { type: 'toolCall', id, name: 'read_note', arguments: {} }] }) as unknown as AgentMessage
const toolResult = (id: string, text: string): AgentMessage =>
  ({ role: 'toolResult', toolCallId: id, toolName: 'read_note', content: [{ type: 'text', text }], isError: false, timestamp: ts++ }) as unknown as AgentMessage
function shapes() {
  const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  const chain: AgentMessage[] = []
  for (let i = 0; i < 6; i++) chain.push(assistantCall(`toolu_l${i}`), toolResult(`toolu_l${i}`, 'r'.repeat(800)))
  return {
    blankUser: { raw: [sys(), deferred(), user('   '), assistantCall('toolu_b'), toolResult('toolu_b', 'r')], budget: 100_000 },
    largeUser: { raw: [sys(), deferred(), { role: 'user', content: [{ type: 'text', text: 'Bitte prüfe alles gründlich. '.repeat(10_000) }, image], timestamp: ts++ } as unknown as AgentMessage, ...chain], budget: 2000 },
  }
}

describe('window opener predicate and bounds (review B1/B2)', () => {
  it('treats a blank first user message as missing and opens the window before it (B2)', () => {
    const blank = user('   ')
    const window = [sys(), deferred(), blank, assistantCall('toolu_x'), toolResult('toolu_x', 'r')]
    const r = openWindowOnUser(window)
    expect(r.repaired).toBe(true)
    expect(isWindowOpener(r.messages[2])).toBe(true)
    expect(r.messages[3]).toBe(blank)
    expect(isWireUser(blank)).toBe(false)
    expect(isWireUser({ role: 'user', content: '' } as never)).toBe(false)
    expect(isWireUser({ role: 'user', content: [] } as never)).toBe(false)
    expect(isWireUser({ role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] } as never)).toBe(true)
  })

  it('repairs a blank first user message in the strand trim as well (B2)', () => {
    const r = trimMessagesToBudget(shapes().blankUser.raw, 100_000, { reopenWithTurnUser: true })
    expect(r.repaired).toBe(true)
    const first = r.messages.find(m => (m as { role?: string }).role !== 'system')
    expect(isWireUser(first)).toBe(true)
  })

  it('never lifts a cut window above its budget with a large or image-bearing turn user message (B1)', () => {
    const { raw, budget } = shapes().largeUser
    const r = trimMessagesToBudget(raw, budget, { reopenWithTurnUser: true })
    expect(r.repaired).toBe(true)
    expect(r.keptTokens).toBeLessThanOrEqual(budget)
    const opener = r.messages.find(m => isWindowOpener(m))!
    expect(JSON.stringify(opener)).not.toContain('"image"')
    const text = (opener as { content: Array<{ text: string }> }).content[0].text
    expect(text.startsWith(WINDOW_OPENER_TEXT)).toBe(true)
    expect(text.length).toBeLessThanOrEqual(WINDOW_OPENER_TEXT.length + WINDOW_OPENER_EXCERPT_CHARS + 120)
  })

  it('builds the opener deterministically: same input, same bytes', () => {
    const u = user('Gleiche Eingabe')
    expect(JSON.stringify(makeWindowOpener(u, 5))).toBe(JSON.stringify(makeWindowOpener(u, 5)))
  })

  it('does not treat a real user message that starts with the marker as an opener (F5)', () => {
    const real = user(`${WINDOW_OPENER_TEXT} — von Hand getippt`)
    expect(isWindowOpener(real)).toBe(false)
    expect(isWireUser(real)).toBe(true)
  })

  it('states, never instructs, in the opener (F4)', () => {
    expect(WINDOW_OPENER_TEXT).not.toMatch(/\b(continue|please|answer|reply|do)\b/i)
  })
})

describe('describeHistoryStructure is bounded and id-free (review F3)', () => {
  it('replaces tool-call ids by ordinals and caps the length', () => {
    const msgs: AgentMessage[] = [user('x')]
    for (let i = 0; i < 400; i++) msgs.push(assistantCall(`toolu_SECRETISH_${i}_${'z'.repeat(50)}`), toolResult(`toolu_SECRETISH_${i}_${'z'.repeat(50)}`, 'r'))
    const s = describeHistoryStructure(msgs)
    expect(s.length).toBeLessThanOrEqual(MAX_STRUCTURE_CHARS)
    expect(s).not.toContain('SECRETISH')
    expect(s).toMatch(/^…\(\d+ older messages\) \| /)
    expect(s).toContain('toolResult#400')
  })
  it('counts only shapes the conversion drops as missing; an unknown content shape stays a user message', () => {
    expect(isWireUser(user('   '))).toBe(false)
    expect(isWireUser({ role: 'user', content: '' } as unknown as AgentMessage)).toBe(false)
    expect(isWireUser({ role: 'user', content: [] } as unknown as AgentMessage)).toBe(false)
    expect(isWireUser({ role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] } as unknown as AgentMessage)).toBe(true)
    expect(isWireUser({ role: 'user', text: 'legacy shape' } as unknown as AgentMessage)).toBe(true)
    const window = [sys(), { role: 'user', text: 'legacy shape' } as unknown as AgentMessage, assistantCall('toolu_u'), toolResult('toolu_u', 'r')]
    expect(openWindowOnUser(window).repaired).toBe(false)
  })
})
