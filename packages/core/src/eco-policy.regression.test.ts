/**
 * Eco wave-1 regression suite (review 5c5f47a6). Synthetic data only.
 * Proves fail-closed refusal, persistence-gated compaction with recall, the
 * side-effect ledger, telemetry/read-error isolation and per-session state.
 * These tests prove behaviour of the chars/3 ESTIMATE; they do not prove a
 * match with any real tokenizer or anything about native speed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { initDatabase } from './database.js'
import { buildEcoView, resolveEcoBudget, EcoBudgetError, isEcoRefusalText, parseContextOverflow } from './eco-policy.js'
import { applyEcoRequestView, ecoTelemetry, setStrandEcoEnabled, lastEcoViewForStrand, resetObservedEcoLimits, findToolResultRowId } from './eco-mode-store.js'
import { sanitizeHistoryBoundaries } from './message-history.js'

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as unknown as AgentMessage
const calls = (...cs: Array<{ id: string; name: string; args?: Record<string, unknown> }>) => ({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'synthetic reasoning', thinkingSignature: 'sig-SYNTH-1' },
    ...cs.map(c => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.args ?? {} })),
  ],
  stopReason: 'toolUse', timestamp: 1,
}) as unknown as AgentMessage
const result = (id: string, name: string, text: string, isError = false) =>
  ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError, timestamp: 1 }) as unknown as AgentMessage
const all = (ms: readonly AgentMessage[]) => JSON.stringify(ms)
const budget = resolveEcoBudget({ contextWindow: 40960, maxTokens: 8192 })

/** 20k-char result whose middle holds non-error ids, key=value numbers and a path. */
function middleFacts(tag: string): string {
  const lines = Array.from({ length: 400 }, (_, i) => `${tag} filler ${i} ${'f'.repeat(40)}`)
  lines[200] = `${tag} order_id=ORD-${tag}-7781 amount=4711.25 path=/srv/synthetic/${tag}/data.json`
  return lines.join('\n')
}

afterEach(() => { vi.restoreAllMocks(); resetObservedEcoLimits() })

describe('fail closed (typed refusal, never the raw messages)', () => {
  it('150k-char user paste: refusal current_user_message_too_large', () => {
    const r = buildEcoView({ messages: [user('p'.repeat(150_000))], budget, fixedTokens: 3000, resolveRecallId: () => 1 })
    expect(r.refusal).toBe('current_user_message_too_large')
    const err = new EcoBudgetError(r.refusal!, r.tokensAfter, budget.inputBudget)
    expect(isEcoRefusalText(err.message)).toBe(true)
    expect(parseContextOverflow(err.message)).toBeNull() // never mistaken for a runner overflow
    expect(err.message).toMatch(/Abhilfe/)
  })

  it('120k-char tool arguments in the current batch: refusal, not a cut', () => {
    const msgs = [user('write it'), calls({ id: 'w', name: 'write_file', args: { content: 'a'.repeat(120_000) } }), result('w', 'write_file', 'ok')]
    const r = buildEcoView({ messages: msgs, budget, fixedTokens: 3000, resolveRecallId: () => 1 })
    expect(r.refusal).toBe('current_tool_arguments_too_large')
  })

  it('runtime path throws EcoBudgetError and records a numeric refusal metric', () => {
    const db = initDatabase(':memory:')
    db.prepare("INSERT INTO sessions (id, agent_id) VALUES ('s1', 'main')").run()
    setStrandEcoEnabled(db, 's1', true)
    expect(() => applyEcoRequestView({ db, sessionId: 's1', messages: [user('p'.repeat(150_000))], model: { contextWindow: 40960, maxTokens: 8192 }, systemPrompt: 'sys', tools: [] }))
      .toThrow(EcoBudgetError)
    const m = lastEcoViewForStrand(db, 's1')!
    expect(m.refused).toBe(true)
    expect(m.refusalReason).toBe('current_user_message_too_large')
  })
})

describe('persistence-gated compaction + recall', () => {
  it('12 parallel same-name 20k results: once persisted, older batch facts are recallable and pairs/signatures intact', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `par${i}`)
    const msgs: AgentMessage[] = [user('collect')]
    msgs.push(calls(...ids.map(id => ({ id, name: 'shell' }))), ...ids.map(id => result(id, 'shell', middleFacts(id))))
    msgs.push(calls({ id: 'next', name: 'shell' }), result('next', 'shell', 'small'))
    const rows = new Map(ids.map((id, i) => [id, 500 + i]))
    const r = buildEcoView({ messages: msgs, budget, fixedTokens: 3000, resolveRecallId: id => rows.get(id) })
    expect(r.refusal).toBeNull()
    expect(r.tokensAfter).toBeLessThanOrEqual(budget.inputBudget)
    const out = all(r.messages)
    for (const id of ids) {
      // Either a lossy view or a ledger entry — both carry the stable row ref.
      expect(out.includes(`message_id=${rows.get(id)}`) || out.includes(`recall=${rows.get(id)}`)).toBe(true)
    }
    expect(out).toContain('LOSSY') // middle values are NOT claimed to be present
    expect(out).toContain('sig-SYNTH-1') // thinking signature of kept assistant messages untouched
    expect(sanitizeHistoryBoundaries(r.messages).dropped).toBe(false)
    expect(r.messages[r.messages.length - 1]).toBe(msgs[msgs.length - 1]) // current batch exact
  })

  it('missing raw persistence: no lossy cut — refusal instead', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `np${i}`)
    const msgs: AgentMessage[] = [user('collect'), calls(...ids.map(id => ({ id, name: 'shell' }))), ...ids.map(id => result(id, 'shell', middleFacts(id))),
      calls({ id: 'n2', name: 'shell' }), result('n2', 'shell', 'small')]
    const r = buildEcoView({ messages: msgs, budget, fixedTokens: 3000, resolveRecallId: () => undefined })
    expect(r.refusal).not.toBeNull()
    expect(r.compacted).toBe(0)
    expect(r.messages).toEqual(msgs) // returned for diagnostics only; the caller throws
  })

  it('side-effect ledger: every dropped call of the CURRENT turn is listed with its ref, no double execution hint', () => {
    const msgs: AgentMessage[] = [user('deploy nothing, synthetic')]
    for (let i = 0; i < 40; i++) msgs.push(calls({ id: `se${i}`, name: 'write_file', args: { path: `/tmp/synthetic-${i}`, content: 'x'.repeat(1200) } }), result(`se${i}`, 'write_file', `wrote ${i} ` + 'w'.repeat(1600)))
    msgs.push(calls({ id: 'cur', name: 'shell' }), result('cur', 'shell', 'current'))
    const small = resolveEcoBudget({ contextWindow: 16384, maxTokens: 2048 })
    const r = buildEcoView({ messages: msgs, budget: small, fixedTokens: 1000, resolveRecallId: id => 9000 + Number(id.replace(/\D/g, '') || 0) })
    expect(r.refusal).toBeNull()
    expect(r.dropped).toBeGreaterThan(0)
    const out = all(r.messages)
    expect(out).toContain('do NOT repeat them')
    let listed = 0
    for (let i = 0; i < 40; i++) {
      const inView = out.includes(`"id":"se${i}"`)
      const inLedger = out.includes(`call=se${i} status=ok recall=${9000 + i} (current turn)`)
      expect(inView || inLedger).toBe(true)
      if (inLedger) listed++
    }
    expect(listed * 2).toBe(r.dropped)
    expect(out).not.toContain('repeat the call')
  })
})

describe('isolation: telemetry, read errors, interleaved sessions', () => {
  function db2() {
    const db = initDatabase(':memory:')
    db.prepare("INSERT INTO sessions (id, agent_id) VALUES ('a', 'main'), ('b', 'main')").run()
    return db
  }
  const loop = (sid: string, n: number) => {
    const ms: AgentMessage[] = [user(`task ${sid}`)]
    for (let i = 0; i < n; i++) ms.push(calls({ id: `${sid}${i}`, name: 'shell' }), result(`${sid}${i}`, 'shell', `R-${sid}-${i} ` + 'z'.repeat(9000)))
    return ms
  }
  const persist = (db: ReturnType<typeof initDatabase>, sid: string, ms: AgentMessage[]) => {
    for (const m of ms as Array<{ role: string; toolCallId?: string; content?: Array<{ text?: string }> }>) {
      if (m.role !== 'toolResult') continue
      db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, NULL, 'tool', 'Tool: shell', ?, 'main')")
        .run(sid, JSON.stringify({ toolName: 'shell', toolCallId: m.toolCallId, toolResult: m.content![0].text, toolIsError: false }))
    }
  }
  const model = { contextWindow: 16384, maxTokens: 2048 }

  it('a throwing metrics write does not change the outcome', () => {
    const db = db2()
    setStrandEcoEnabled(db, 'a', true)
    const ms = loop('a', 2); persist(db, 'a', ms)
    const ok = applyEcoRequestView({ db, sessionId: 'a', messages: ms, model, systemPrompt: 's', tools: [] })
    vi.spyOn(ecoTelemetry, 'record').mockImplementation(() => { throw new Error('disk full (synthetic)') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(all(applyEcoRequestView({ db, sessionId: 'a', messages: ms, model, systemPrompt: 's', tools: [] }))).toBe(all(ok))
    expect(ok).toBe(ms) // admission only: the very same array
    // A refusal stays a refusal when its metric cannot be written.
    expect(() => applyEcoRequestView({ db, sessionId: 'a', messages: loop('a', 6), model, systemPrompt: 's', tools: [] })).toThrow(EcoBudgetError)
  })

  it('an unreadable eco switch refuses instead of silently disabling Eco', () => {
    const db = db2()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { prepare: (sql: string) => { if (/eco_mode/.test(sql)) throw new Error('SQLITE_BUSY (synthetic)'); return db.prepare(sql) } } as unknown as typeof db
    expect(() => applyEcoRequestView({ db: broken, sessionId: 'a', messages: loop('a', 1), model, systemPrompt: 's', tools: [] }))
      .toThrow(expect.objectContaining({ reason: 'eco_state_unreadable' }))
  })

  it('interleaved sessions: state and observed limits never cross; no session is ever rewritten', () => {
    const db = db2()
    setStrandEcoEnabled(db, 'a', true)
    const a = loop('a', 1); const b = loop('b', 1)
    persist(db, 'a', a)
    expect(findToolResultRowId(db, 'b', 'a0')).toBeUndefined()
    const m = { ...model, provider: 'synthetic', id: 'm-1', baseUrl: 'http://127.0.0.1:9/v1' }
    const overflowA = [...a, { role: 'assistant', content: [], stopReason: 'error', provider: 'synthetic', model: 'm-1', errorMessage: 'request (41501 tokens) exceeds the available context size (12000 tokens)', timestamp: 1 } as unknown as AgentMessage]
    // a: evidence lowers a's budget, the messages pass through untouched.
    expect(applyEcoRequestView({ db, sessionId: 'a', messages: overflowA, model: m, systemPrompt: 's', tools: [] })).toBe(overflowA)
    expect(() => applyEcoRequestView({ db, sessionId: 'a', messages: [...loop('a', 4), overflowA[overflowA.length - 1]!], model: m, systemPrompt: 's', tools: [] }))
      .toThrow(expect.objectContaining({ inputBudget: resolveEcoBudget({ contextWindow: 12000, maxTokens: 2048 }).inputBudget }))
    // b is off: byte-identical (normal mode unchanged), even interleaved with a.
    expect(applyEcoRequestView({ db, sessionId: 'b', messages: b, model: m, systemPrompt: 's', tools: [] })).toBe(b)
    setStrandEcoEnabled(db, 'b', true)
    expect(applyEcoRequestView({ db, sessionId: 'b', messages: b, model: m, systemPrompt: 's', tools: [] })).toBe(b)
    // a's observed limit never reached b: b is budgeted against the declared 16384.
    expect(() => applyEcoRequestView({ db, sessionId: 'b', messages: loop('b', 6), model: m, systemPrompt: 's', tools: [] }))
      .toThrow(expect.objectContaining({ inputBudget: resolveEcoBudget({ contextWindow: 16384, maxTokens: 2048 }).inputBudget }))
    expect(lastEcoViewForStrand(db, 'a')!.refused).toBe(true)
    expect(lastEcoViewForStrand(db, 'b')!.refused).toBe(true)
  })
})
