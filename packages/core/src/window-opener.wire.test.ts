/**
 * http_400 strand window (incident 2026-11-12, review of eb00df29, B1/B2):
 * every repaired window must reach the Anthropic wire with a user message
 * first, and the opener must never lift the window above its budget.
 *
 * The wire half runs the windows through the installed pi-ai Anthropic
 * conversion (`streamSimple`, payload captured in `onPayload`, request
 * aborted before any network I/O) with a model that keeps mid-conversation
 * system messages native — the shape that produced the 400.
 */
import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { streamSimple } from './pi-models.js'
import { buildModel } from './provider-config.js'
import { estimateMessageTokens, trimMessagesToBudget } from './strand-context.js'
// Only names that already existed on eb00df29, so this file runs (and fails) there too.
import { isWindowOpener, openWindowOnUser, WINDOW_OPENER_TEXT } from './message-history.js'
// Present on 9048526b as well, so the G1 tests below run (and fail) there.
import { makeWindowOpener } from './message-history.js'

/** Test-local copy of the wire predicate: pi-ai drops blank/empty user messages. */
function wireUser(m: AgentMessage | undefined): boolean {
  if (!m || (m as { role?: string }).role !== 'user') return false
  const c = (m as { content: unknown }).content
  if (typeof c === 'string') return c.trim().length > 0
  return Array.isArray(c) && c.some((b: { type?: string; text?: string }) => b.type !== 'text' || (b.text ?? '').trim().length > 0)
}

const MODEL_ID = 'claude-opus-5-5'
const readNote = { name: 'read_note', description: 'Read a note.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }
const askUser = { name: 'ask_user', description: 'Ask the user.', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } }

function wireModel(): Model<Api> {
  const provider = { id: 'wire', name: 'wire', type: 'anthropic-oauth', providerType: 'anthropic-oauth', authMethod: 'oauth', baseUrl: '' }
  const m = buildModel(provider as never, MODEL_ID) as Model<Api> & { compat?: Record<string, unknown> }
  // Keep later system messages native and tool changes inline, as for the
  // production Claude models, and never touch the network.
  return { ...m, baseUrl: 'http://127.0.0.1:9', compat: { ...(m.compat ?? {}), supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } } as never
}

async function wireMessages(messages: AgentMessage[]): Promise<Array<{ role: string; content: unknown }>> {
  let captured: { messages?: Array<{ role: string; content: unknown }> } | undefined
  const ac = new AbortController()
  const ctx = { systemPrompt: '', messages, tools: [readNote] } as unknown as Context
  const s = streamSimple(wireModel() as never, ctx, {
    apiKey: 'sk-ant-oat01-wire-test', maxRetries: 0, signal: ac.signal,
    onPayload: (p: unknown) => { captured = JSON.parse(JSON.stringify(p)); ac.abort(); return p },
  } as never)
  try { for await (const _ of s) { /* drain */ } } catch { /* aborted */ }
  if (!captured?.messages) throw new Error('no payload captured')
  return captured.messages
}

let ts = 1
const sys = (): AgentMessage => ({ role: 'system', content: 'You are the persona.', toolsAdded: [readNote], timestamp: 0 }) as unknown as AgentMessage
const deferred = (): AgentMessage => ({ role: 'system', content: '', toolsAdded: [askUser], timestamp: 0 }) as unknown as AgentMessage
const user = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: ts++ }) as unknown as AgentMessage
function assistantCall(id: string, name = 'read_note'): AgentMessage {
  return {
    role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: MODEL_ID, stopReason: 'toolUse', timestamp: ts++,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: 'text', text: 'step' }, { type: 'toolCall', id, name, arguments: { key: id } }],
  } as unknown as AgentMessage
}
function assistantText(text: string): AgentMessage {
  return {
    role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: MODEL_ID, stopReason: 'stop', timestamp: ts++,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage
}
const toolResult = (id: string, text: string, toolName = 'read_note'): AgentMessage =>
  ({ role: 'toolResult', toolCallId: id, toolName, content: [{ type: 'text', text }], isError: false, timestamp: ts++ }) as unknown as AgentMessage

function toolChain(prefix: string, n: number, resultChars = 800): AgentMessage[] {
  const out: AgentMessage[] = []
  for (let i = 0; i < n; i++) out.push(assistantCall(`toolu_${prefix}${i}`), toolResult(`toolu_${prefix}${i}`, 'r'.repeat(resultChars)))
  out.push(assistantCall(`toolu_${prefix}ask`, 'ask_user'), toolResult(`toolu_${prefix}ask`, 'Option X', 'ask_user'))
  return out
}
const windowTokens = (msgs: readonly AgentMessage[]) =>
  msgs.filter((m, i) => !(i === 0 && (m as { role?: string }).role === 'system')).reduce((n, m) => n + estimateMessageTokens(m, 'visible'), 0)

/** The four shapes of the review: incident, wedged, blank user, large user. */
function shapes(): Record<string, { raw: AgentMessage[]; budget: number }> {
  const big = 'Bitte prüfe alles gründlich. '.repeat(10_000) // ~290k chars, ~72k tokens
  const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  return {
    incident: { raw: [sys(), deferred(), user('Untersuche die Notizen.'), ...toolChain('i', 6)], budget: 500 },
    wedged: { raw: [sys(), deferred(), ...toolChain('w', 2, 20), assistantText('fertig')], budget: 100_000 },
    blankUser: { raw: [sys(), deferred(), user('   '), ...toolChain('b', 2, 20), assistantText('fertig')], budget: 100_000 },
    largeUser: {
      raw: [sys(), deferred(), { role: 'user', content: [{ type: 'text', text: big }, image], timestamp: ts++ } as unknown as AgentMessage, ...toolChain('l', 6)],
      budget: 2000,
    },
  }
}

describe('window opener bounds (review B1/B2)', () => {
  it('treats a blank first user message as missing and opens the window before it (B2)', () => {
    const blank = user('   ')
    const window = [sys(), deferred(), blank, assistantCall('toolu_x'), toolResult('toolu_x', 'r')]
    const r = openWindowOnUser(window)
    expect(r.repaired).toBe(true)
    expect(isWindowOpener(r.messages[2])).toBe(true)
    expect(r.messages[3]).toBe(blank)
  })

  it('repairs a blank first user message in the strand trim as well (B2)', () => {
    const r = trimMessagesToBudget(shapes().blankUser.raw, 100_000, { reopenWithTurnUser: true })
    expect(r.repaired).toBe(true)
    expect(wireUser(r.messages.find(m => (m as { role?: string }).role !== 'system'))).toBe(true)
  })

  it('never lifts a cut window above its budget with a large or image-bearing turn user message (B1)', () => {
    const { raw, budget } = shapes().largeUser
    const r = trimMessagesToBudget(raw, budget, { reopenWithTurnUser: true })
    expect(r.repaired).toBe(true)
    expect(r.keptTokens).toBeLessThanOrEqual(budget)
    expect(windowTokens(r.messages)).toBeLessThanOrEqual(budget)
    const opener = r.messages.find(m => (m as { role?: string }).role !== 'system')!
    expect(JSON.stringify(opener)).not.toContain('"image"')
    // excerpt cap (2000 chars) plus marker text and JSON framing
    expect(JSON.stringify(opener).length).toBeLessThan(2600)
    expect(JSON.stringify(opener)).toContain(WINDOW_OPENER_TEXT)
  })
})

describe('repaired windows on the pi-ai Anthropic wire (review B2, wire proof)', () => {
  it('reproduces the 400 shape without repair (control)', async () => {
    const s = shapes()
    // Incident cut as the old trim left it: system, deferred, assistant first.
    const cut = [s.incident.raw[0], s.incident.raw[1], ...s.incident.raw.slice(-4), user('weiter')]
    expect((await wireMessages(cut))[0].role).toBe('system')
    expect((await wireMessages([...s.wedged.raw, user('weiter')]))[0].role).toBe('system')
    // B2: the blank user message passes the old role check but vanishes on the wire.
    expect((await wireMessages([...s.blankUser.raw, user('weiter')]))[0].role).toBe('system')
  })

  for (const name of ['incident', 'wedged', 'blankUser', 'largeUser'] as const) {
    it(`sends ${name} with a user message first after the strand trim and after the send-time repair`, async () => {
      const { raw, budget } = shapes()[name]
      const trimmed = trimMessagesToBudget(raw, budget, { reopenWithTurnUser: true })
      expect(trimmed.repaired).toBe(true)
      const viaTrim = await wireMessages([...trimmed.messages, user('weiter')])
      expect(viaTrim[0].role).toBe('user')
      // Paths that skip the trim (task injection, retry, steer) rely on the send-time repair.
      const viaSend = await wireMessages(openWindowOnUser([...raw, user('weiter')]).messages)
      expect(viaSend[0].role).toBe('user')
      // The private opener flag never reaches the wire.
      expect(JSON.stringify(viaTrim)).not.toContain('windowOpener')
      if (name === 'largeUser') expect(JSON.stringify(viaTrim)).not.toContain('"image"')
    })
  }
})

describe('repeated trims over 100 turns (review B1)', () => {
  it('one long tool turn: window stays in budget and the opener bytes never change', () => {
    const budget = 3000
    let window: AgentMessage[] = [sys(), deferred(), user('Lange Recherche, bitte. '.repeat(400))]
    let openerBytes: string | undefined
    for (let turn = 0; turn < 100; turn++) {
      window = [...window, assistantCall(`toolu_t${turn}`), toolResult(`toolu_t${turn}`, 'r'.repeat(600 + (turn % 7) * 100))]
      const r = trimMessagesToBudget(window, budget, { reopenWithTurnUser: true })
      expect(r.keptTokens).toBeLessThanOrEqual(budget)
      expect(wireUser(r.messages.find(m => (m as { role?: string }).role !== 'system'))).toBe(true)
      const opener = r.messages.find(m => isWindowOpener(m))
      if (opener) {
        const bytes = JSON.stringify(opener)
        if (openerBytes !== undefined) expect(bytes).toBe(openerBytes)
        openerBytes = bytes
      }
      // Idempotent: trimming the written-back window again changes nothing.
      const again = trimMessagesToBudget(r.messages, budget, { reopenWithTurnUser: true })
      expect(again.droppedCount).toBe(0)
      expect(JSON.stringify(again.messages)).toBe(JSON.stringify(r.messages))
      window = r.messages
    }
    expect(openerBytes).toBeDefined()
  })

  it('mixed turns: window stays in budget, opens on a wire user message, and an uncut window only grows at its end', () => {
    const budget = 4000
    let window: AgentMessage[] = [sys(), deferred()]
    let prev: string[] = []
    for (let turn = 0; turn < 100; turn++) {
      const text = turn % 5 === 0 ? 'Großer Auftrag. '.repeat(3000) : turn % 7 === 0 ? '   ' : `Frage ${turn}`
      window = [...window, user(text), ...toolChain(`m${turn}_`, turn % 3, 300 + (turn % 4) * 400), assistantText(`Antwort ${turn}`)]
      const r = trimMessagesToBudget(window, budget, { reopenWithTurnUser: true })
      expectBudgetRule(r, budget, window)
      expect(wireUser(r.messages.find(m => (m as { role?: string }).role !== 'system'))).toBe(true)
      const bytes = r.messages.map(m => JSON.stringify(m))
      if (r.droppedCount === 0 && !r.repaired) expect(bytes.slice(0, prev.length)).toEqual(prev)
      prev = bytes
      window = r.messages
    }
  })
})

/** Size of the opener without excerpt (the fixed sentence only). */
const bareOpenerTokens = () => estimateMessageTokens(makeWindowOpener(), 'visible')

/**
 * Budget rule of the cut (review G1): keptTokens <= max(budget, newest +
 * opener without excerpt); within budget whenever newest + that opener fit;
 * a window above the budget is flagged `overBudget`.
 */
function expectBudgetRule(r: ReturnType<typeof trimMessagesToBudget>, budget: number, input: readonly AgentMessage[]): void {
  const newestMsg = input[input.length - 1]
  const newest = estimateMessageTokens(newestMsg, 'visible')
  // Budget rule (review J1): no content is shortened, so the bound is the
  // first cut plus the opener without excerpt.
  expect(r.keptTokens).toBeLessThanOrEqual(Math.max(budget, newest) + bareOpenerTokens())
  // Whenever the cut production makes keeps the newest message, so does the result.
  if (trimMessagesToBudget(input, budget).messages.includes(newestMsg)) expect(r.messages[r.messages.length - 1]).toBe(newestMsg)
  expect((r as { overBudget?: boolean }).overBudget === true).toBe(r.keptTokens > budget)
  expect(windowTokens(r.messages)).toBe(r.keptTokens)
}

const firstNonSystem = (msgs: readonly AgentMessage[]) => msgs.find(m => (m as { role?: string }).role !== 'system')
const openerText = (m: AgentMessage | undefined) => ((m as { content: Array<{ text: string }> }).content)[0].text

describe('oversized newest message next to a required opener (review G1)', () => {
  it("reviewer's case: user ~100 tokens, assistant ~990 tokens, budget 1000 -> opener without excerpt, flagged over budget", () => {
    const input = [user('u'.repeat(400)), assistantText('a'.repeat(3960))]
    const r = trimMessagesToBudget(input, 1000, { reopenWithTurnUser: true })
    expect(r.repaired).toBe(true)
    expect(isWindowOpener(r.messages[0])).toBe(true)
    expect(openerText(r.messages[0])).toBe(WINDOW_OPENER_TEXT)
    expect(r.keptTokens).toBe(990 + bareOpenerTokens())
    expect((r as { overBudget?: boolean }).overBudget).toBe(true)
    expectBudgetRule(r, 1000, input)
  })

  it('newest message plus opener without excerpt fits: the excerpt is dropped and the window stays within budget', () => {
    const input = [user('u'.repeat(400)), assistantText('a'.repeat(3800))] // 950 tokens
    const r = trimMessagesToBudget(input, 1000, { reopenWithTurnUser: true })
    expect(r.repaired).toBe(true)
    expect(openerText(firstNonSystem(r.messages))).toBe(WINDOW_OPENER_TEXT)
    expect(r.keptTokens).toBeLessThanOrEqual(1000)
    expect((r as { overBudget?: boolean }).overBudget).toBeUndefined()
    expectBudgetRule(r, 1000, input)
  })

  it('newest message alone larger than the budget, window needs an opener', () => {
    const input = [sys(), user('Bitte fasse zusammen. '.repeat(20)), assistantCall('toolu_g1'), toolResult('toolu_g1', 'r'.repeat(400)), assistantText('a'.repeat(6000))]
    const r = trimMessagesToBudget(input, 1000, { reopenWithTurnUser: true })
    expect(r.repaired).toBe(true)
    expect(r.messages[0]).toBe(input[0])
    expect(openerText(firstNonSystem(r.messages))).toBe(WINDOW_OPENER_TEXT)
    expect(r.keptTokens).toBe(1500 + bareOpenerTokens())
    expect((r as { overBudget?: boolean }).overBudget).toBe(true)
    expectBudgetRule(r, 1000, input)
  })

  for (const budget of [10, 0]) {
    it(`budget ${budget}, smaller than the opener without excerpt`, () => {
      expect(bareOpenerTokens()).toBeGreaterThan(10)
      const input = [user('Frage zur Abrechnung, bitte genau prüfen.'), assistantText('a'.repeat(40))]
      const r = trimMessagesToBudget(input, budget, { reopenWithTurnUser: true })
      expect(r.repaired).toBe(true)
      expect(openerText(r.messages[0])).toBe(WINDOW_OPENER_TEXT)
      expect(r.messages[1]).toBe(input[1])
      expect(r.keptTokens).toBe(10 + bareOpenerTokens())
      expect((r as { overBudget?: boolean }).overBudget).toBe(true)
      expectBudgetRule(r, budget, input)
    })
  }

  it('fallback window on the pi-ai Anthropic wire: user message first, private flag not sent', async () => {
    const input = [sys(), deferred(), user('Untersuche die Notizen. '.repeat(16)), assistantCall('toolu_gw', 'ask_user'), toolResult('toolu_gw', 'Option X', 'ask_user'), assistantText('a'.repeat(3960))]
    const r = trimMessagesToBudget(input, 1000, { reopenWithTurnUser: true })
    expect(r.repaired).toBe(true)
    expect(openerText(firstNonSystem(r.messages))).toBe(WINDOW_OPENER_TEXT)
    expect((r as { overBudget?: boolean }).overBudget).toBe(true)
    expectBudgetRule(r, 1000, input)
    const wire = await wireMessages([...r.messages, user('weiter')])
    expect(wire[0].role).toBe('user')
    expect(JSON.stringify(wire[0])).toContain(WINDOW_OPENER_TEXT)
    expect(JSON.stringify(wire)).not.toContain('windowOpener')
  })

  it('documents base behaviour: an oversized newest tool result is dropped as an orphan and the window becomes empty', () => {
    const input = [user('Lies die Datei.'), assistantCall('toolu_orph'), toolResult('toolu_orph', 'r'.repeat(8000))]
    const r = trimMessagesToBudget(input, 1000, { reopenWithTurnUser: true })
    expect(r.messages).toEqual([])
    expect(r.keptTokens).toBe(0)
    expect(r.repaired).toBeUndefined()
    expect((r as { overBudget?: boolean }).overBudget).toBeUndefined()
  })
})

function assistantCalls(text: string, ids: string[]): AgentMessage {
  return {
    role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: MODEL_ID, stopReason: 'toolUse', timestamp: ts++,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: 'text', text }, ...ids.map(id => ({ type: 'toolCall', id, name: 'read_note', arguments: { key: id } }))],
  } as unknown as AgentMessage
}
/** Assistant text length so that the assistant message plus `rest` estimate exactly `target` tokens. */
function sizedCall(target: number, ids: string[], rest: readonly AgentMessage[]): AgentMessage {
  const restTokens = rest.reduce((n, m) => n + estimateMessageTokens(m, 'visible'), 0)
  let chars = Math.max(0, (target - restTokens) * 4)
  for (let i = 0; i < 50; i++) {
    const got = estimateMessageTokens(assistantCalls('a'.repeat(chars), ids), 'visible') + restTokens
    if (got === target) break
    chars = Math.max(0, chars + (target - got) * 4 + (got > target ? -1 : 1))
  }
  const m = assistantCalls('a'.repeat(chars), ids)
  expect(estimateMessageTokens(m, 'visible') + restTokens).toBe(target)
  return m
}
const tokensOf = (msgs: readonly AgentMessage[]) => msgs.reduce((n, m) => n + estimateMessageTokens(m, 'visible'), 0)

describe('a reserved cut never drops the newest tool result (review J1)', () => {
  const budget = 24_000
  function j1Input(): AgentMessage[] {
    // Reviewer's input: user of 100,000 characters, assistant with text plus
    // one tool call, matching result of 800 characters, the pair estimated at
    // 23,990 tokens. The wire-shaped assistant carries api/model/usage fields,
    // so its text is a few characters shorter than the reviewer's 95,096; the
    // literal reviewer objects are in strand-context.budget-rule.test.ts.
    const result = toolResult('toolu_j1', 'r'.repeat(800))
    return [user('u'.repeat(100_000)), sizedCall(23_990, ['toolu_j1'], [result]), result]
  }

  it("reviewer's input at budget 24,000: opener without excerpt, call and result, flagged, result last", () => {
    const input = j1Input()
    expect(tokensOf(input.slice(1))).toBe(23_990)
    const r = trimMessagesToBudget(input, budget, { reopenWithTurnUser: true })
    expect(r.messages).toHaveLength(3)
    expect(isWindowOpener(r.messages[0])).toBe(true)
    expect(openerText(r.messages[0])).toBe(WINDOW_OPENER_TEXT)
    expect(r.messages[1]).toBe(input[1])
    expect(r.messages[2]).toBe(input[2])
    expect(r.keptTokens).toBe(23_990 + bareOpenerTokens())
    expect(r.overBudget).toBe(true)
    expect(r.repaired).toBe(true)
    expectBudgetRule(r, budget, input)
  })

  it('a pair that fits together with the opener without excerpt is kept within budget and not flagged', () => {
    const result = toolResult('toolu_j1b', 'r'.repeat(800))
    const target = budget - bareOpenerTokens() - 3
    const input = [user('u'.repeat(100_000)), sizedCall(target, ['toolu_j1b'], [result]), result]
    const r = trimMessagesToBudget(input, budget, { reopenWithTurnUser: true })
    expect(r.messages).toHaveLength(3)
    expect(openerText(r.messages[0])).toBe(WINDOW_OPENER_TEXT)
    expect(r.messages[1]).toBe(input[1])
    expect(r.messages[2]).toBe(result)
    expect(r.keptTokens).toBe(target + bareOpenerTokens())
    expect(r.keptTokens).toBeLessThanOrEqual(budget)
    expect(r.overBudget).toBeUndefined()
    expectBudgetRule(r, budget, input)
  })

  it('one assistant message with three tool calls and three results close to the budget: all kept', () => {
    const results = ['toolu_m1', 'toolu_m2', 'toolu_m3'].map(id => toolResult(id, 'r'.repeat(2000)))
    const input = [sys(), user('u'.repeat(100_000)), sizedCall(budget - 10, ['toolu_m1', 'toolu_m2', 'toolu_m3'], results), ...results]
    const r = trimMessagesToBudget(input, budget, { reopenWithTurnUser: true })
    expect(r.messages[0]).toBe(input[0])
    expect(openerText(r.messages[1])).toBe(WINDOW_OPENER_TEXT)
    expect(r.messages.slice(2)).toEqual(input.slice(2))
    expect(r.messages[r.messages.length - 1]).toBe(results[2])
    expect(r.keptTokens).toBe(budget - 10 + bareOpenerTokens())
    expect(r.overBudget).toBe(true)
    expectBudgetRule(r, budget, input)
  })

  it('long tool chain: the reserved cut drops the oldest pair, keeps the newest message and is accepted', () => {
    const input = [sys(), deferred(), user('Recherche. '.repeat(2000)), ...toolChain('lc', 8, 4000)]
    // The first cut holds exactly the newest four pairs and the ask_user pair.
    const chainBudget = tokensOf(input.slice(-10)) + 5
    const production = trimMessagesToBudget(input, chainBudget)
    const r = trimMessagesToBudget(input, chainBudget, { reopenWithTurnUser: true })
    expect(r.repaired).toBe(true)
    // the excerpt opener is in use: the reserved cut was accepted, not the fallback
    expect(openerText(firstNonSystem(r.messages))).not.toBe(WINDOW_OPENER_TEXT)
    expect(r.messages[r.messages.length - 1]).toBe(input[input.length - 1])
    expect(r.droppedCount).toBeGreaterThan(production.droppedCount)
    expect(r.keptTokens).toBeLessThanOrEqual(chainBudget)
    expect(r.overBudget).toBeUndefined()
    expectBudgetRule(r, chainBudget, input)
  })

  it("reviewer's window on the pi-ai Anthropic wire: user first, tool call followed by its result", async () => {
    const input = [sys(), deferred(), ...j1Input()]
    const r = trimMessagesToBudget(input, budget, { reopenWithTurnUser: true })
    expect(r.messages[r.messages.length - 1]).toBe(input[input.length - 1])
    const wire = await wireMessages([...r.messages, user('weiter')])
    expect(wire[0].role).toBe('user')
    const callAt = wire.findIndex(m => m.role === 'assistant' && JSON.stringify(m.content).includes('"tool_use"'))
    expect(callAt).toBeGreaterThan(0)
    const next = wire[callAt + 1]
    expect(next.role).toBe('user')
    const blocks = next.content as Array<{ type: string; tool_use_id?: string }>
    expect(blocks[0].type).toBe('tool_result')
    expect(blocks[0].tool_use_id).toBe('toolu_j1')
    expect(JSON.stringify(wire)).not.toContain('windowOpener')
  })
})
