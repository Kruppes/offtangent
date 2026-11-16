/**
 * Seeded randomized check of the budget rule of the interactive strand trim
 * (`reopenWithTurnUser`, reviews G1 and J1). Adapted from the independent
 * reviewer's scratch test; fixed seed, so every run sees the same cases.
 */
import { it, expect } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { trimMessagesToBudget, estimateMessageTokens } from './strand-context.js'
import { isWireUser, isWindowOpener, makeWindowOpener, WINDOW_OPENER_TEXT } from './message-history.js'

const SEED = 0x5e14c56f
const CASES = 500

it(`budget rule holds over ${CASES} seeded transcripts (seed ${SEED})`, () => {
  let state = SEED >>> 0
  const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
  const pick = (n: number) => rand() % n
  const lengths = [0, 1, 4, 60, 400, 1600, 2100, 5000, 20000, 95000, 100000]
  const text = () => 'x'.repeat(lengths[pick(lengths.length)])
  const msg = (role: string, content: unknown, rest = {}) => ({ role, content, timestamp: 0, ...rest }) as unknown as AgentMessage
  const user = () => msg('user', pick(9) === 0 ? ' ' : text())
  const assistant = () => msg('assistant', [{ type: 'text', text: text() }], { stopReason: 'stop' })
  const tools = (id: string) => {
    const ids = Array.from({ length: 1 + pick(3) }, (_, i) => `${id}-${i}`)
    return [
      msg('assistant', [{ type: 'text', text: text() }, ...ids.map(c => ({ type: 'toolCall', id: c, name: 'probe', arguments: {} }))], { stopReason: 'toolUse' }),
      ...ids.map(c => msg('toolResult', [{ type: 'text', text: text() }], { toolCallId: c, toolName: 'probe', isError: false })),
    ]
  }
  const size = (m: AgentMessage) => estimateMessageTokens(m, 'visible')
  const bareSize = size(makeWindowOpener())

  for (let k = 0; k < CASES; k++) {
    const body: AgentMessage[] = []
    if (pick(3) === 0) body.push(makeWindowOpener(msg('user', text())))
    const groups = 1 + pick(6)
    for (let g = 0; g < groups; g++) {
      if (pick(4) !== 0) body.push(user())
      const n = 1 + pick(4)
      for (let t = 0; t < n; t++) {
        if (pick(2) === 0) body.push(...tools(`${k}-${g}-${t}`))
        else body.push(assistant())
      }
    }
    if (pick(8) === 0) body.push(msg('toolResult', [{ type: 'text', text: text() }], { toolCallId: 'orphan', toolName: 'probe', isError: false }))
    const input: AgentMessage[] = pick(2) ? [msg('system', 'prompt'), ...body] : body
    const newest = input[input.length - 1]
    const newestSize = size(newest)
    // size of the newest tool turn (assistant with its results), to hit J1 shapes
    let turnStart = input.length - 1
    while (turnStart > 0 && (input[turnStart] as { role: string }).role === 'toolResult') turnStart--
    const turnSize = input.slice(turnStart).reduce((n, m) => n + size(m), 0)
    const budgets = [0, 1, bareSize, Math.max(0, newestSize - 1), newestSize, newestSize + bareSize - 1, newestSize + bareSize,
      turnSize, turnSize + bareSize - 1, turnSize + bareSize, turnSize + 3, 24000, pick(8000)]
    const budget = budgets[pick(budgets.length)]

    const r = trimMessagesToBudget(input, budget, { reopenWithTurnUser: true })
    const production = trimMessagesToBudget(input, budget)
    const details = () => `seed=${SEED}, case=${k}, budget=${budget}, input=${JSON.stringify(input).slice(0, 4000)}, output=${JSON.stringify(r).slice(0, 4000)}`

    // Bound: first cut plus the opener without excerpt.
    expect(r.keptTokens <= Math.max(budget, newestSize) + bareSize, details()).toBe(true)
    // Whenever the cut production makes keeps the newest message, the result keeps it last.
    if (production.messages.includes(newest)) expect(r.messages[r.messages.length - 1] === newest, details()).toBe(true)
    // Flag exactly when above budget.
    expect(r.overBudget === true, details()).toBe(r.keptTokens > budget)
    // keptTokens is the size of the window without a leading system message.
    const window = r.messages[0]?.role === 'system' ? r.messages.slice(1) : r.messages
    expect(window.reduce((n, m) => n + size(m), 0), details()).toBe(r.keptTokens)
    // A non-empty window opens, after an optional system message, on a wire user or an opener.
    if (window.length > 0) expect(isWireUser(window[0]) || isWindowOpener(window[0]), details()).toBe(true)
    // Idempotent.
    const again = trimMessagesToBudget(r.messages, budget, { reopenWithTurnUser: true })
    expect(JSON.stringify(again.messages), details()).toBe(JSON.stringify(r.messages))
    expect(again.keptTokens, details()).toBe(r.keptTokens)
    expect(again.overBudget === true, details()).toBe(r.overBudget === true)
  }
}, 60_000)

it("reviewer's literal J1 objects at budget 24,000 keep the tool pair behind the opener without excerpt", () => {
  const msg = (role: string, content: unknown, rest = {}) => ({ role, content, timestamp: 0, ...rest }) as unknown as AgentMessage
  const input = [
    msg('user', 'u'.repeat(100_000)),
    msg('assistant', [{ type: 'text', text: 'a'.repeat(95_096) }, { type: 'toolCall', id: 'pair', name: 'probe', arguments: {} }], { stopReason: 'toolUse' }),
    msg('toolResult', [{ type: 'text', text: 'r'.repeat(800) }], { toolCallId: 'pair', toolName: 'probe', isError: false }),
  ]
  expect(estimateMessageTokens(input[1]) + estimateMessageTokens(input[2])).toBe(23_990)
  const r = trimMessagesToBudget(input, 24_000, { reopenWithTurnUser: true })
  expect(r.messages).toHaveLength(3)
  expect(isWindowOpener(r.messages[0])).toBe(true)
  expect((r.messages[0] as { content: Array<{ text: string }> }).content[0].text).toBe(WINDOW_OPENER_TEXT)
  expect(r.messages[1]).toBe(input[1])
  expect(r.messages[2]).toBe(input[2])
  expect(r.keptTokens).toBe(23_990 + estimateMessageTokens(makeWindowOpener()))
  expect(r.overBudget).toBe(true)
})
