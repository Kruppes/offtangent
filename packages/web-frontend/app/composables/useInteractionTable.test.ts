import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import {
  applyInteractionRow, cardClosedByTable, interactionIdOfToolResult, replaceStrandRows, rowOfBlock, rowOfToolCall, useInteractionTable,
} from './useInteractionTable'

const row = (over: Record<string, unknown> = {}) => ({ id: 'ia_1', strandId: 's1', messageId: 7, blockId: 'b1', status: 'open', ...over })
const askRow = (over: Record<string, unknown> = {}) => ({
  id: 'ia_ask', strandId: 's1', messageId: 7, toolCallId: 'call_1', blockId: null, status: 'open', blocking: true,
  payload: { kind: 'ask_user', id: 'call_1', question: 'Which?', blocking: true, questions: [{ id: 'q1', type: 'choice', question: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowComment: false }] },
  ...over,
})

describe('useInteractionTable (S1-A web heuristic reads the table)', () => {
  it('upserts a frame row by interaction id and keeps known fields on payload-less updates', () => {
    let state = applyInteractionRow({}, row({ draft: null }))
    state = applyInteractionRow(state, { id: 'ia_1', strandId: 's1', messageId: 7, blockId: 'b1', status: 'superseded', closeSource: 'user_continued' })
    expect(state.ia_1).toMatchObject({ status: 'superseded', closeSource: 'user_continued', draft: null })
    expect(rowOfBlock(state, 7, 'b1')?.id).toBe('ia_1')
  })

  it('ignores malformed frames', () => {
    expect(applyInteractionRow({}, { id: 'x' })).toEqual({})
    expect(applyInteractionRow({}, null)).toEqual({})
  })

  it('replaces the rows of one strand and leaves other strands alone', () => {
    let state = applyInteractionRow({}, row())
    state = applyInteractionRow(state, row({ id: 'ia_2', strandId: 's2', messageId: 9 }))
    state = replaceStrandRows(state, 's1', [row({ id: 'ia_3', messageId: 8, status: 'expired' })])
    expect(Object.keys(state).sort()).toEqual(['ia_2', 'ia_3'])
  })

  it('closes a card only for superseded, expired and dismissed; open, answered and unknown stay open', () => {
    expect(cardClosedByTable('superseded')).toBe(true)
    expect(cardClosedByTable('expired')).toBe(true)
    expect(cardClosedByTable('dismissed')).toBe(true)
    expect(cardClosedByTable('answered')).toBe(false)
    expect(cardClosedByTable('open')).toBe(false)
    expect(cardClosedByTable(null)).toBe(false)
  })

  it('finds the ask_user row by tool call id and reads the interaction id of a tool result', () => {
    const state = applyInteractionRow({}, askRow())
    expect(rowOfToolCall(state, 'call_1')?.id).toBe('ia_ask')
    expect(interactionIdOfToolResult({ details: { interactionId: 'ia_x' } })).toBe('ia_x')
    expect(interactionIdOfToolResult('Warte auf Antwort. (interaction ia_y) Beende den Turn')).toBe('ia_y')
    expect(interactionIdOfToolResult(null)).toBeNull()
  })
})

describe('ask_user card state from WS frames (S1-C)', () => {
  const store = new Map<string, Ref<unknown>>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('useState', <T>(key: string, init: () => T): Ref<T> => {
      if (!store.has(key)) store.set(key, ref(init()) as Ref<unknown>)
      return store.get(key) as Ref<T>
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('interaction.pending shows a skeleton with the question count until interaction.open arrives', () => {
    const table = useInteractionTable()
    table.receivePending('call_1', 3)
    expect(table.pendingCount('call_1')).toBe(3)
    expect(table.toolCallRow('call_1')).toBeNull()
    table.receive(askRow())
    expect(table.pendingCount('call_1')).toBeNull()
    expect(table.toolCallRow('call_1')?.status).toBe('open')
  })

  it('a late pending frame after interaction.open does not bring the skeleton back', () => {
    const table = useInteractionTable()
    table.receive(askRow())
    table.receivePending('call_1', 1)
    expect(table.pendingCount('call_1')).toBeNull()
  })

  it('walks open -> draft -> answered, and open -> dismissed / superseded / expired', () => {
    const table = useInteractionTable()
    table.receive(askRow())
    table.receive({ id: 'ia_ask', strandId: 's1', messageId: 7, toolCallId: 'call_1', status: 'open', draft: { q1: { selected: ['b'] } } })
    expect(table.toolCallRow('call_1')).toMatchObject({ status: 'open', draft: { q1: { selected: ['b'] } } })
    expect(table.toolCallRow('call_1')?.payload).toBeTruthy()
    table.receive({ id: 'ia_ask', strandId: 's1', messageId: 7, toolCallId: 'call_1', status: 'answered', answer: { label: 'B', items: [] } })
    expect(table.toolCallRow('call_1')).toMatchObject({ status: 'answered', answer: { label: 'B' } })

    for (const status of ['dismissed', 'superseded', 'expired'] as const) {
      const id = `ia_${status}`
      table.receive(askRow({ id, toolCallId: `call_${status}` }))
      table.receive({ id, strandId: 's1', messageId: 7, toolCallId: `call_${status}`, status })
      expect(table.toolCallRow(`call_${status}`)?.status).toBe(status)
    }
  })

  it('loads every card of the strand (open and history) from the GET list', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ interactions: [askRow(), askRow({ id: 'ia_old', toolCallId: 'call_0', status: 'answered' })] })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const table = useInteractionTable()
    await table.loadStrand('s1')
    expect(apiFetch.mock.calls[0]![0]).toBe('/api/strands/s1/interactions')
    expect(table.toolCallRow('call_0')?.status).toBe('answered')
    expect(table.toolCallRow('call_1')?.status).toBe('open')
  })

  it('B2: a delayed GET snapshot neither sets a card back nor drops a card that came by frame meanwhile', async () => {
    let resolveGet!: (value: unknown) => void
    const apiFetch = vi.fn(() => new Promise(resolve => { resolveGet = resolve }))
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const table = useInteractionTable()
    table.receive(askRow())
    const loading = table.loadStrand('s1')
    // While the GET is on its way: answered elsewhere, and a new card opens.
    table.receive({ ...askRow(), status: 'answered', answer: { label: 'B', resumed: true, items: [] } })
    table.receive(askRow({ id: 'ia_new', toolCallId: 'call_new' }))
    // The snapshot was taken before both frames.
    resolveGet({ interactions: [askRow()] })
    await loading
    expect(table.toolCallRow('call_1')).toMatchObject({ status: 'answered', answer: { label: 'B', resumed: true } })
    expect(table.toolCallRow('call_new')?.status).toBe('open')
  })

  it('B2: an open frame field (draft) that arrived during the GET wins over the snapshot', async () => {
    let resolveGet!: (value: unknown) => void
    vi.stubGlobal('useApi', () => ({ apiFetch: vi.fn(() => new Promise(resolve => { resolveGet = resolve })) }))
    const table = useInteractionTable()
    const loading = table.loadStrand('s1')
    table.receive(askRow({ draft: { q1: { selected: ['b'] } } }))
    resolveGet({ interactions: [askRow({ draft: { q1: { selected: ['a'] } } })] })
    await loading
    expect(table.toolCallRow('call_1')?.draft).toEqual({ q1: { selected: ['b'] } })
  })

  it('B2: rows are monotonic — an older open copy or resumed=false never undoes a later state', () => {
    let state = applyInteractionRow({}, askRow({ status: 'answered', answer: { label: 'A', resumed: true } }))
    state = applyInteractionRow(state, askRow())
    expect(state.ia_ask!.status).toBe('answered')
    state = applyInteractionRow(state, askRow({ status: 'answered', answer: { label: 'A', resumed: false } }))
    expect(state.ia_ask!.answer?.resumed).toBe(true)
    state = replaceStrandRows(state, 's1', [askRow()])
    expect(state.ia_ask!.status).toBe('answered')
  })

  it('B2 review 2: closed by frame BEFORE the GET starts, the snapshot says open => stays closed', async () => {
    let resolveGet!: (value: unknown) => void
    vi.stubGlobal('useApi', () => ({ apiFetch: vi.fn(() => new Promise(resolve => { resolveGet = resolve })) }))
    const table = useInteractionTable()
    table.receive(askRow())
    table.receive({ ...askRow(), status: 'superseded', closeSource: 'user_continued' })
    const loading = table.loadStrand('s1')
    resolveGet({ interactions: [askRow()] })
    await loading
    expect(table.toolCallRow('call_1')?.status).toBe('superseded')
  })

  describe('B2 review 2: a card known before the GET that the snapshot lacks', () => {
    afterEach(() => { useInteractionTable().clearPendingVerify(); vi.useRealTimers() })

    async function loadWithout(table: ReturnType<typeof useInteractionTable>): Promise<void> {
      vi.stubGlobal('useApi', () => ({ apiFetch: vi.fn().mockResolvedValue({ interactions: [] }) }))
      await table.loadStrand('s1')
    }

    it('open and its frame younger than 60 s => kept (server lag)', async () => {
      vi.useFakeTimers({ now: 1_000_000 })
      const table = useInteractionTable()
      table.receive(askRow())
      vi.setSystemTime(1_000_000 + 59_000)
      await loadWithout(table)
      expect(table.toolCallRow('call_1')?.status).toBe('open')
    })

    it('open but its frame older than 60 s => removed', async () => {
      vi.useFakeTimers({ now: 1_000_000 })
      const table = useInteractionTable()
      table.receive(askRow())
      vi.setSystemTime(1_000_000 + 61_000)
      await loadWithout(table)
      expect(table.toolCallRow('call_1')).toBeNull()
    })

    it('closed (young frame) => removed; open but never seen by frame (only from an older GET) => removed', async () => {
      vi.useFakeTimers({ now: 1_000_000 })
      const table = useInteractionTable()
      table.receive({ ...askRow(), status: 'answered', answer: { label: 'A', resumed: true } })
      table.replaceStrand('s1', [askRow({ id: 'ia_list', toolCallId: 'call_list' }), { ...askRow(), status: 'answered', answer: { label: 'A', resumed: true } }])
      await loadWithout(table)
      expect(table.toolCallRow('call_1')).toBeNull()
      expect(table.toolCallRow('call_list')).toBeNull()
    })

    it('review 3: kept young card unconfirmed => removed 60 s later by the timer; confirmed => stays, mark cleared', async () => {
      vi.useFakeTimers({ now: 1_000_000 })
      const table = useInteractionTable()
      table.receive(askRow())
      await loadWithout(table)
      expect(table.toolCallRow('call_1')?.status).toBe('open')
      expect(table.keptPendingVerify.value).toHaveProperty('ia_ask')
      vi.advanceTimersByTime(60_000)
      expect(table.toolCallRow('call_1')).toBeNull()
      expect(table.keptPendingVerify.value).toEqual({})

      table.receive(askRow())
      await loadWithout(table)
      expect(table.keptPendingVerify.value).toHaveProperty('ia_ask')
      table.replaceStrand('s1', [askRow()])
      expect(table.keptPendingVerify.value).toEqual({})
      vi.advanceTimersByTime(120_000)
      expect(table.toolCallRow('call_1')?.status).toBe('open')
    })

    it('review 3: kept young card still missing in the next snapshot => removed', async () => {
      vi.useFakeTimers({ now: 1_000_000 })
      const table = useInteractionTable()
      table.receive(askRow())
      await loadWithout(table)
      expect(table.toolCallRow('call_1')?.status).toBe('open')
      vi.setSystemTime(1_000_000 + 5_000)
      await loadWithout(table)
      expect(table.toolCallRow('call_1')).toBeNull()
      expect(table.keptPendingVerify.value).toEqual({})
    })
  })
})
