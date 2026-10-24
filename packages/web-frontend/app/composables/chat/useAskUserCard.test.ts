import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { InteractionTableRow } from '../useInteractionTable'
import { ASK_USER_DRAFT_DEBOUNCE_MS, ASK_USER_TYPING_WINDOW_MS, useAskUserCard, type AskUserCardDeps } from './useAskUserCard'

const q = (id: string, type: 'choice' | 'multi' | 'confirm', extra: Record<string, unknown> = {}) => ({
  id, type, question: `Question ${id}?`,
  options: type === 'confirm'
    ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
    : [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'other', label: 'Other', other: true }],
  allowComment: true, ...extra,
})

function makeRow(questions: unknown[], over: Partial<InteractionTableRow> = {}): InteractionTableRow {
  return {
    id: 'ia_1', strandId: 's1', messageId: 3, toolCallId: 'call_1', status: 'open', blocking: false, draft: null,
    payload: { kind: 'ask_user', id: 'call_1', question: 'Question q1?', blocking: false, questions },
    ...over,
  }
}

function setup(questions: unknown[], over: Partial<InteractionTableRow> = {}, depsOver: Partial<AskUserCardDeps> = {}) {
  let clock = 1_000_000
  const row = ref<InteractionTableRow | null>(makeRow(questions, over))
  let n = 0
  const deps = {
    answerById: vi.fn(async () => ({ status: 'applied', label: 'A', interaction: null }) as const),
    saveDraft: vi.fn(async () => true),
    dismissById: vi.fn(async () => ({ status: 'dismissed', interaction: null }) as const),
    newRequestId: vi.fn(() => `req-${++n}`),
    confirmDismiss: vi.fn(() => true),
    now: () => clock,
    ...depsOver,
  } as unknown as AskUserCardDeps & Record<string, ReturnType<typeof vi.fn>>
  const card = useAskUserCard(row, deps)
  const advance = (ms: number) => { clock += ms; vi.advanceTimersByTime(ms) }
  return { row, card, deps, advance }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ask_user card: question types', () => {
  it('choice keeps one option, multi toggles several, confirm takes one of two', () => {
    const { card } = setup([q('q1', 'choice'), q('q2', 'multi'), q('q3', 'confirm')])
    card.select('q1', 'a'); card.select('q1', 'b')
    expect(card.answers.value.q1!.selected).toEqual(['b'])
    card.select('q2', 'a'); card.select('q2', 'b'); card.select('q2', 'a')
    expect(card.answers.value.q2!.selected).toEqual(['b'])
    card.select('q3', 'no')
    expect(card.answers.value.q3!.selected).toEqual(['no'])
  })

  it('a comment without an option selects "Other" automatically; the comment is capped at 2000 chars', () => {
    const { card } = setup([q('q1', 'choice')])
    card.setComment('q1', 'x'.repeat(2500))
    expect(card.answers.value.q1).toEqual({ selected: ['other'], comment: 'x'.repeat(2000) })
  })

  it('"Other" without a comment is not complete', () => {
    const { card } = setup([q('q1', 'choice')])
    card.select('q1', 'other')
    expect(card.allComplete.value).toBe(false)
    card.setComment('q1', 'mine')
    expect(card.allComplete.value).toBe(true)
  })
})

describe('ask_user card: wizard navigation', () => {
  it('2 to 4 questions: next only when the step is answered, back keeps answers, ONE submit at the end', async () => {
    const { card, deps } = setup([q('q1', 'choice'), q('q2', 'multi'), q('q3', 'confirm')])
    expect(card.isWizard.value).toBe(true)
    expect(card.progress.value).toEqual({ current: 1, total: 3 })
    expect(card.next()).toBe(false)
    card.select('q1', 'a')
    expect(card.next()).toBe(true)
    expect(card.progress.value).toEqual({ current: 2, total: 3 })
    card.select('q2', 'b')
    expect(card.back()).toBe(true)
    expect(card.current.value?.id).toBe('q1')
    expect(card.answers.value.q1!.selected).toEqual(['a'])
    card.next(); card.next()
    expect(card.isLast.value).toBe(true)
    expect(await card.submit()).toBeNull()
    card.select('q3', 'yes')
    await card.submit()
    expect(deps.answerById).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.answerById).mock.calls[0]![0]).toEqual({
      interactionId: 'ia_1', clientRequestId: 'req-1',
      answers: { q1: { selected: ['a'] }, q2: { selected: ['b'] }, q3: { selected: ['yes'] } },
    })
    expect(card.status.value).toBe('answered')
  })

  it('a single question is no wizard', () => {
    const { card } = setup([q('q1', 'choice')])
    expect(card.isWizard.value).toBe(false)
    expect(card.isLast.value).toBe(true)
  })
})

describe('ask_user card: draft', () => {
  it('draft debounce: saves once, 800 ms after the last change', () => {
    const { card, deps, advance } = setup([q('q1', 'choice')])
    card.select('q1', 'a')
    advance(400)
    card.setComment('q1', 'because')
    advance(ASK_USER_DRAFT_DEBOUNCE_MS - 1)
    expect(deps.saveDraft).not.toHaveBeenCalled()
    advance(1)
    expect(deps.saveDraft).toHaveBeenCalledTimes(1)
    expect(deps.saveDraft).toHaveBeenCalledWith('ia_1', { q1: { selected: ['a'], comment: 'because' } })
  })

  it('prefills the answers from the stored draft', () => {
    const { card } = setup([q('q1', 'multi')], { draft: { q1: { selected: ['a', 'b', 'zzz'], comment: 'hi' } } })
    expect(card.answers.value.q1).toEqual({ selected: ['a', 'b'], comment: 'hi' })
  })

  it('takes over a draft from another device, but not while the user is typing here', async () => {
    const { row, card, advance } = setup([q('q1', 'choice')])
    row.value = { ...row.value!, draft: { q1: { selected: ['b'] } } }
    await nextTick()
    expect(card.answers.value.q1!.selected).toEqual(['b'])

    card.select('q1', 'a')
    row.value = { ...row.value!, draft: { q1: { selected: ['other'], comment: 'remote' } } }
    await nextTick()
    expect(card.answers.value.q1!.selected).toEqual(['a'])

    advance(ASK_USER_DRAFT_DEBOUNCE_MS + ASK_USER_TYPING_WINDOW_MS)
    row.value = { ...row.value!, draft: { q1: { selected: ['b'], comment: 'later' } } }
    await nextTick()
    expect(card.answers.value.q1).toEqual({ selected: ['b'], comment: 'later' })
  })
})

describe('ask_user card: status, 409 lock, retry', () => {
  it('409 lock: shows the current status and locks the card', async () => {
    const { card, deps } = setup([q('q1', 'choice')], {}, {
      answerById: vi.fn(async () => ({ status: 'conflict', current: 'answered', label: 'B', interaction: null })) as never,
    })
    card.select('q1', 'a')
    await card.submit()
    expect(card.status.value).toBe('answered')
    expect(card.conflictLabel.value).toBe('B')
    expect(card.isOpen.value).toBe(false)
    card.select('q1', 'b')
    expect(card.answers.value.q1!.selected).toEqual(['a'])
    expect(await card.submit()).toBeNull()
    expect(await card.dismiss()).toBeNull()
    expect(deps.answerById).toHaveBeenCalledTimes(1)
  })

  // Review 1 B1: the 502 answer is stored server-side, so the card no longer
  // lets the user edit it into a second answer under a fresh key (that would
  // run into 409); "send again" re-sends the same answer with the same key.
  it('502 retryable: "send again" reuses the same clientRequestId and answer; an edit is refused; 200 locks', async () => {
    const answerById = vi.fn()
      .mockResolvedValueOnce({ status: 'retryable', message: 'resume failed' })
      .mockResolvedValueOnce({ status: 'retryable', message: 'resume failed' })
      .mockResolvedValueOnce({ status: 'applied', label: 'B', interaction: null })
    const { card } = setup([q('q1', 'choice')], {}, { answerById: answerById as never })
    card.select('q1', 'a')
    await card.submit()
    expect(card.retryable.value).toBe(true)
    expect(card.status.value).toBe('open')
    await card.submit()
    expect(answerById.mock.calls[1]![0].clientRequestId).toBe(answerById.mock.calls[0]![0].clientRequestId)
    card.select('q1', 'b')
    expect(card.retryable.value).toBe(true)
    expect(card.resumePending.value).toBe(true)
    await card.submit()
    expect(answerById.mock.calls[2]![0].clientRequestId).toBe(answerById.mock.calls[0]![0].clientRequestId)
    expect(answerById.mock.calls[2]![0].answers).toEqual(answerById.mock.calls[0]![0].answers)
    expect(card.status.value).toBe('answered')
    expect(card.resumePending.value).toBe(false)
    expect(await card.submit()).toBeNull()
  })

  it('only open is operable: a row closed by a frame cannot be answered', async () => {
    for (const status of ['answered', 'dismissed', 'superseded', 'expired'] as const) {
      const { row, card, deps } = setup([q('q1', 'choice')])
      row.value = { ...row.value!, status }
      await nextTick()
      expect(card.status.value).toBe(status)
      expect(card.isOpen.value).toBe(false)
      card.select('q1', 'a')
      expect(await card.submit()).toBeNull()
      expect(deps.answerById).not.toHaveBeenCalled()
    }
  })

  it('a frame closing the card cancels a pending draft save', async () => {
    const { row, card, deps, advance } = setup([q('q1', 'choice')])
    card.select('q1', 'a')
    row.value = { ...row.value!, status: 'superseded' }
    await nextTick()
    advance(ASK_USER_DRAFT_DEBOUNCE_MS * 2)
    expect(deps.saveDraft).not.toHaveBeenCalled()
  })
})

describe('ask_user card: dismiss', () => {
  it('non-blocking: dismisses without confirmation', async () => {
    const { card, deps } = setup([q('q1', 'choice')])
    await card.dismiss()
    expect(deps.confirmDismiss).not.toHaveBeenCalled()
    expect(deps.dismissById).toHaveBeenCalledWith('ia_1')
    expect(card.status.value).toBe('dismissed')
  })

  it('blocking: asks first; a cancelled confirmation keeps the card open', async () => {
    const confirmDismiss = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const { card, deps } = setup([q('q1', 'choice')], { blocking: true }, { confirmDismiss })
    await card.dismiss()
    expect(deps.dismissById).not.toHaveBeenCalled()
    expect(card.status.value).toBe('open')
    await card.dismiss()
    expect(confirmDismiss).toHaveBeenCalledTimes(2)
    expect(deps.dismissById).toHaveBeenCalledTimes(1)
    expect(card.status.value).toBe('dismissed')
  })

  it('dismiss on a card closed meanwhile (409) shows the current status', async () => {
    const { card } = setup([q('q1', 'choice')], {}, {
      dismissById: vi.fn(async () => ({ status: 'conflict', current: 'expired', interaction: null })) as never,
    })
    await card.dismiss()
    expect(card.status.value).toBe('expired')
  })
})
