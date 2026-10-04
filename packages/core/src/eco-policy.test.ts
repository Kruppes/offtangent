import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  buildEcoView,
  resolveEcoBudget,
  estimateEcoFixedTokens,
  estimateEcoMessageTokens,
  renderEcoToolView,
  ECO_FALLBACK_CONTEXT_WINDOW,
  ECO_VIEW_OPEN,
  ECO_OMITTED_MARKER,
} from './eco-policy.js'
import { sanitizeHistoryBoundaries } from './message-history.js'

// Synthetic fixtures only: no captures, no real names.
const sys = (text: string) => ({ role: 'system', content: text, timestamp: 1 }) as unknown as AgentMessage
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as AgentMessage
const call = (...calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>) => ({
  role: 'assistant',
  content: calls.map(c => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.args ?? {} })),
  stopReason: 'toolUse',
  timestamp: 1,
}) as unknown as AgentMessage
const result = (id: string, name: string, text: string, isError = false) => ({
  role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError, timestamp: 1,
}) as unknown as AgentMessage
const say = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 1 }) as unknown as AgentMessage

function bigOutput(tag: string, lines = 400): string {
  const out: string[] = [`${tag} START id=ABC-${tag}-001`]
  for (let i = 0; i < lines; i++) out.push(`${tag} line ${i} value=${i * 7} ok`)
  out.push(`${tag} END total=12345`)
  return out.join('\n')
}

function text(msg: AgentMessage): string {
  const c = (msg as { content?: unknown }).content
  if (typeof c === 'string') return c
  return (c as Array<{ text?: string }>).map(b => b.text ?? '').join('\n')
}

describe('resolveEcoBudget', () => {
  it('reserves maxTokens (output + thinking) and a margin from the operative window', () => {
    const b = resolveEcoBudget({ contextWindow: 40960, maxTokens: 8192 })
    expect(b.outputReserve).toBe(8192)
    expect(b.safetyMargin).toBe(4096)
    expect(b.inputBudget).toBe(40960 - 8192 - 4096)
    // The diagnosed failure: a 33k prompt + 8192 output exceeded 40960.
    expect(33309 + b.outputReserve + 0).toBeGreaterThan(40960)
    expect(b.inputBudget).toBeLessThan(40960 - 8192)
  })

  it('falls back conservatively when no window is declared, never inventing a runner limit', () => {
    const b = resolveEcoBudget({ contextWindow: null, maxTokens: null })
    expect(b.contextFallback).toBe(true)
    expect(b.contextWindow).toBe(ECO_FALLBACK_CONTEXT_WINDOW)
    expect(b.inputBudget).toBeGreaterThan(0)
  })

  it('caps an absurd maxTokens at half the window so a prompt still fits', () => {
    const b = resolveEcoBudget({ contextWindow: 16000, maxTokens: 64000 })
    expect(b.outputReserve).toBe(8000)
    expect(b.inputBudget).toBe(16000 - 8000 - 1600)
  })

  it('ignores invalid values', () => {
    expect(resolveEcoBudget({ contextWindow: -5, maxTokens: Number.NaN }).contextFallback).toBe(true)
  })
})

describe('estimate', () => {
  it('counts the system prompt and tool schemas', () => {
    const tools = [{ name: 'shell', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
    expect(estimateEcoFixedTokens('x'.repeat(300), tools)).toBeGreaterThan(100 + 10)
    expect(estimateEcoFixedTokens(undefined, [])).toBe(0)
  })

  it('is more conservative than chars/4', () => {
    expect(estimateEcoMessageTokens(user('a'.repeat(1200)))).toBeGreaterThanOrEqual(400)
  })
})

describe('renderEcoToolView', () => {
  it('keeps exact head/tail, header facts, error and URL lines from the middle', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `row ${i}`)
    lines[150] = 'Error: ENOENT no such file /srv/data/x.json'
    lines[151] = 'see https://example.invalid/docs/42'
    lines.push('process exited with code 2')
    const raw = lines.join('\n')
    // Without a recall reference there is no lossy view at all (safety contract).
    expect(renderEcoToolView({ role: 'toolResult', toolCallId: 'call_7', toolName: 'shell', isError: true, content: [{ type: 'text', text: raw }] }, 200, 100)).toBeNull()
    const view = renderEcoToolView({ role: 'toolResult', toolCallId: 'call_7', toolName: 'shell', isError: true, content: [{ type: 'text', text: raw }] }, 200, 100, 77)!
    expect(view.startsWith(ECO_VIEW_OPEN)).toBe(true)
    expect(view).toContain('tool=shell')
    expect(view).toContain('call=call_7')
    expect(view).toContain('status=error')
    expect(view).toContain('exit=2')
    expect(view).toContain(`stored=${raw.length} chars`)
    expect(view).toContain('LOSSY')
    expect(view).toContain('recall_message with message_id=77 and part="result"')
    expect(view).toContain(raw.slice(0, 200))
    expect(view).toContain(raw.slice(raw.length - 100))
    expect(view).toContain('Error: ENOENT no such file /srv/data/x.json')
    expect(view).toContain('https://example.invalid/docs/42')
    expect(view.length).toBeLessThan(raw.length)
  })

  it('returns null for small results (nothing to save)', () => {
    expect(renderEcoToolView({ role: 'toolResult', content: [{ type: 'text', text: 'short' }] }, 200, 100)).toBeNull()
  })

  it('is deterministic', () => {
    const m = { role: 'toolResult' as const, toolCallId: 'a', toolName: 't', content: [{ type: 'text', text: bigOutput('D') }] }
    expect(renderEcoToolView(m, 600, 400, 5)).toBe(renderEcoToolView(m, 600, 400, 5))
  })
})

describe('buildEcoView', () => {
  const budget = (contextWindow: number, maxTokens = 1024) => resolveEcoBudget({ contextWindow, maxTokens })
  // Every synthetic result counts as persisted with a stable row id.
  const recall = (id: string) => 1000 + [...id].reduce((a, c) => a + c.charCodeAt(0), 0)

  it('is a no-op under budget (same messages, unchanged)', () => {
    const msgs = [sys('s'), user('hi'), say('hello')]
    const r = buildEcoView({ messages: msgs, budget: budget(40960), fixedTokens: 0 })
    expect(r.changed).toBe(false)
    expect(r.messages).toEqual(msgs)
  })

  it('handles overflow across multiple tools: compacts old results, keeps the current batch exact', () => {
    const msgs = [
      sys('system'), user('do the work'),
      call({ id: 'c1', name: 'shell' }), result('c1', 'shell', bigOutput('A')),
      call({ id: 'c2', name: 'read_file' }), result('c2', 'read_file', bigOutput('B')),
      call({ id: 'c3', name: 'shell' }), result('c3', 'shell', bigOutput('C', 50)),
    ]
    const before = JSON.stringify(msgs)
    const r = buildEcoView({ messages: msgs, budget: budget(9000), fixedTokens: 500, resolveRecallId: recall })
    expect(JSON.stringify(msgs)).toBe(before) // input never mutated
    expect(r.changed).toBe(true)
    expect(r.compacted).toBe(2)
    expect(r.dropped).toBe(0)
    expect(r.degraded).toBe(false)
    expect(r.tokensAfter).toBeLessThanOrEqual(budget(9000).inputBudget)
    expect(text(r.messages[3])).toContain('call=c1')
    expect(text(r.messages[3])).toContain('ABC-A-001')
    expect(text(r.messages[3])).toContain('total=12345')
    expect(text(r.messages[7])).toBe(bigOutput('C', 50))
  })

  it('preserves errors of compacted results', () => {
    const err = `${'x'.repeat(6000)}\nFATAL: migration 0042 failed: duplicate key id=991\n${'y'.repeat(6000)}`
    const msgs = [user('go'), call({ id: 'e1', name: 'shell' }), result('e1', 'shell', err, true), call({ id: 'e2', name: 'shell' }), result('e2', 'shell', 'ok')]
    const r = buildEcoView({ messages: msgs, budget: budget(4096, 512), fixedTokens: 0, resolveRecallId: recall })
    const v = text(r.messages[2])
    expect(v).toContain('status=error')
    expect(v).toContain('FATAL: migration 0042 failed: duplicate key id=991')
  })

  it('keeps same-name parallel calls paired by id', () => {
    const msgs = [
      user('go'),
      call({ id: 'p1', name: 'shell' }, { id: 'p2', name: 'shell' }),
      result('p1', 'shell', bigOutput('P1')), result('p2', 'shell', bigOutput('P2')),
      call({ id: 'q1', name: 'shell' }), result('q1', 'shell', 'done'),
    ]
    const r = buildEcoView({ messages: msgs, budget: budget(8000), fixedTokens: 0, resolveRecallId: recall })
    expect(text(r.messages[2])).toContain('call=p1')
    expect(text(r.messages[2])).toContain(`message_id=${recall('p1')}`)
    expect(text(r.messages[3])).toContain(`message_id=${recall('p2')}`)
    expect(text(r.messages[2])).toContain('P1 START')
    expect(text(r.messages[3])).toContain('call=p2')
    expect(text(r.messages[3])).toContain('P2 START')
  })

  it('drops whole tool segments oldest-first, keeps head, pinned user and pairs intact', () => {
    const msgs: AgentMessage[] = [sys('system'), user('first task')]
    for (let i = 0; i < 30; i++) msgs.push(call({ id: `t${i}`, name: 'shell', args: { command: 'x'.repeat(400) } }), result(`t${i}`, 'shell', 'y'.repeat(1400)))
    msgs.push(call({ id: 'last', name: 'shell' }), result('last', 'shell', 'final exact output'))
    const r = buildEcoView({ messages: msgs, budget: budget(8000), fixedTokens: 300, resolveRecallId: recall })
    expect({ refusal: r.refusal, after: r.tokensAfter, compacted: r.compacted }).toEqual({ refusal: null, after: r.tokensAfter, compacted: r.compacted })
    expect(r.dropped).toBeGreaterThan(0)
    expect(r.dropped % 2).toBe(0) // call + result always together
    expect(r.messages[0]).toBe(msgs[0])
    expect(text(r.messages[1])).toContain('first task')
    expect(text(r.messages[1])).toContain(ECO_OMITTED_MARKER)
    expect(text(r.messages[r.messages.length - 1])).toBe('final exact output')
    expect(sanitizeHistoryBoundaries(r.messages).dropped).toBe(false)
    expect(r.tokensAfter).toBeLessThanOrEqual(budget(8000).inputBudget)
    // deterministic: same input, same view
    expect(JSON.stringify(buildEcoView({ messages: msgs, budget: budget(8000), fixedTokens: 300, resolveRecallId: recall }).messages)).toBe(JSON.stringify(r.messages))
  })

  it('never drops the pinned last user message of a multi-turn strand', () => {
    const msgs: AgentMessage[] = [user('first')]
    for (let i = 0; i < 10; i++) msgs.push(say('a'.repeat(3000)), user(`q${i} ` + 'b'.repeat(3000)))
    const r = buildEcoView({ messages: msgs, budget: budget(8000), fixedTokens: 0 })
    expect(text(r.messages[r.messages.length - 1])).toContain('q9 ')
    expect(text(r.messages[0])).toContain('first')
  })

  it('flags degraded instead of silently cutting the current batch below its facts', () => {
    const msgs = [user('go'), call({ id: 'h', name: 'shell' }), result('h', 'shell', bigOutput('HUGE', 5000))]
    const r = buildEcoView({ messages: msgs, budget: budget(4096, 512), fixedTokens: 3000 })
    expect(r.degraded).toBe(true)
    expect(r.refusal).not.toBeNull() // caller throws EcoBudgetError, nothing is sent
    expect(text(r.messages[2])).toContain('HUGE START id=ABC-HUGE-001')
    expect(text(r.messages[2])).toContain('HUGE END total=12345')
  })
})

describe('eco wave 1b: recall references and overflow evidence', () => {
  it('compact views point at the access-scoped recall_message row instead of re-running the tool', async () => {
    const { buildEcoView, resolveEcoBudget } = await import('./eco-policy.js')
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'synthetic' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'w1', name: 'shell', arguments: { command: 'write file' } }], stopReason: 'toolUse', timestamp: 1 },
      { role: 'toolResult', toolCallId: 'w1', toolName: 'shell', content: [{ type: 'text', text: 'WROTE ' + 'q'.repeat(9000) + ' exit code 0' }], isError: false, timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'w2', name: 'shell', arguments: { command: 'ls' } }], stopReason: 'toolUse', timestamp: 1 },
      { role: 'toolResult', toolCallId: 'w2', toolName: 'shell', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 1 },
    ] as never[]
    const view = buildEcoView({ messages: msgs, budget: resolveEcoBudget({ contextWindow: 4096, maxTokens: 512 }), fixedTokens: 0, resolveRecallId: id => (id === 'w1' ? 4242 : undefined) })
    const text = JSON.stringify(view.messages)
    expect(text).toContain('recall_message with message_id=4242')
    expect(text).toContain('exit=0')
    expect(text).not.toContain('repeat the call')
  })

  it('a throwing recall resolver means "not persisted": no lossy view, fail closed', async () => {
    const { buildEcoView, resolveEcoBudget } = await import('./eco-policy.js')
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'synthetic' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'shell', arguments: {} }], stopReason: 'toolUse', timestamp: 1 },
      { role: 'toolResult', toolCallId: 'x', toolName: 'shell', content: [{ type: 'text', text: 'p'.repeat(9000) }], isError: false, timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'y', name: 'shell', arguments: {} }], stopReason: 'toolUse', timestamp: 1 },
      { role: 'toolResult', toolCallId: 'y', toolName: 'shell', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 1 },
    ] as never[]
    const view = buildEcoView({ messages: msgs, budget: resolveEcoBudget({ contextWindow: 4096, maxTokens: 512 }), fixedTokens: 0, resolveRecallId: () => { throw new Error('db gone') } })
    expect(view.refusal).not.toBeNull()
    expect(view.compacted).toBe(0)
    expect(JSON.stringify(view.messages)).not.toContain('[eco view')
  })

  it('parses runner overflow errors and only ever lowers the window', async () => {
    const { parseContextOverflow, findLastContextOverflow, resolveEcoBudget } = await import('./eco-policy.js')
    expect(parseContextOverflow('request (41501 tokens) exceeds the available context size (40960 tokens), try increasing it')).toEqual({ requested: 41501, limit: 40960 })
    expect(parseContextOverflow("This model's maximum context length is 32768 tokens. However, your messages resulted in 40000 tokens.")).toEqual({ requested: 40000, limit: 32768 })
    expect(parseContextOverflow('context length exceeded: 41501 > 40960')).toEqual({ requested: 41501, limit: 40960 })
    expect(parseContextOverflow('rate limit reached')).toBeNull()
    expect(parseContextOverflow(undefined)).toBeNull()
    const transcript = [
      { role: 'user', content: 'x', timestamp: 1 },
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'request (41501 tokens) exceeds the available context size (40960 tokens)', timestamp: 1 },
    ] as never[]
    expect(findLastContextOverflow(transcript)).toEqual({ requested: 41501, limit: 40960 })
    expect(resolveEcoBudget({ contextWindow: 65536, maxTokens: 8192, observedContextLimit: 40960 }).contextWindow).toBe(40960)
    expect(resolveEcoBudget({ contextWindow: 16384, maxTokens: 2048, observedContextLimit: 40960 }).contextWindow).toBe(16384)
    // The diagnosed case: declared 40960 / maxTokens 8192 → input budget leaves the output reserve + margin.
    const b = resolveEcoBudget({ contextWindow: 40960, maxTokens: 8192 })
    expect(b.inputBudget + b.outputReserve + b.safetyMargin).toBe(40960)
    expect(b.inputBudget).toBeLessThan(33000)
  })
})
