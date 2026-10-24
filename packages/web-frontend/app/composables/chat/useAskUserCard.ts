/**
 * useAskUserCard — the state machine behind one ask_user card (S1-C).
 *
 * Kept free of DOM and Nuxt globals so the transitions (wizard, draft
 * debounce, 409 lock, retry, dismiss) are unit-testable; `AskUserCard.vue`
 * only draws it.
 *
 *  - The status comes from the table row (`interactions`, kept current by the
 *    socket frames). A 409 or a successful answer/dismiss pins the status
 *    locally until the frame confirms it. Only `open` is operable.
 *  - Every change schedules ONE draft save 800 ms after the last change
 *    (`PUT /api/interactions/:id/draft`), so another device can continue.
 *  - A draft that arrives from another device (`interaction.draft`) replaces
 *    the local answers only while the user is not typing here.
 *  - 2 to 4 questions form a wizard: back/next, progress, ONE submit at the
 *    end. The `clientRequestId` is minted per submit and reused for its
 *    retries; any edit after a failed submit starts a new one.
 */
import { computed, ref, watch, type Ref } from 'vue'
import type { AskUserPayload, AskUserQuestion } from '@axiom/core/contracts'
import type { InteractionTableRow, InteractionTableStatus } from '../useInteractionTable'
import type { InteractionByIdOutcome, InteractionDismissOutcome } from '../useInteractions'

export const ASK_USER_DRAFT_DEBOUNCE_MS = 800
export const ASK_USER_COMMENT_MAX = 2000
/** A remote draft is not applied within this window after a local edit. */
export const ASK_USER_TYPING_WINDOW_MS = 2000
const OTHER_ID = 'other'

export interface AskUserLocalAnswer { selected: string[]; comment: string }
export type AskUserAnswers = Record<string, AskUserLocalAnswer>

export interface AskUserCardDeps {
  answerById: (input: { interactionId: string; clientRequestId: string; answers: Record<string, { selected: string[]; comment?: string }> }) => Promise<InteractionByIdOutcome>
  saveDraft: (interactionId: string, answers: unknown) => Promise<boolean>
  dismissById: (interactionId: string) => Promise<InteractionDismissOutcome>
  newRequestId: () => string
  /** Asked before dismissing a blocking card; true = go ahead. */
  confirmDismiss?: () => boolean | Promise<boolean>
  now?: () => number
  debounceMs?: number
}

function emptyAnswers(payload: AskUserPayload | null): AskUserAnswers {
  const out: AskUserAnswers = {}
  for (const q of payload?.questions ?? []) out[q.id] = { selected: [], comment: '' }
  return out
}

/** Reads a stored draft (`{ [questionId]: { selected, comment? } }`) defensively. */
export function draftToAnswers(payload: AskUserPayload | null, draft: unknown): AskUserAnswers | null {
  if (!payload || !draft || typeof draft !== 'object' || Array.isArray(draft)) return null
  const out = emptyAnswers(payload)
  let any = false
  for (const q of payload.questions) {
    const entry = (draft as Record<string, unknown>)[q.id] as { selected?: unknown; comment?: unknown } | undefined
    if (!entry || typeof entry !== 'object') continue
    const known = new Set(q.options.map(o => o.id))
    const selected = Array.isArray(entry.selected) ? entry.selected.filter((id): id is string => typeof id === 'string' && known.has(id)) : []
    out[q.id] = {
      selected: q.type === 'multi' ? selected : selected.slice(0, 1),
      comment: typeof entry.comment === 'string' ? entry.comment.slice(0, ASK_USER_COMMENT_MAX) : '',
    }
    any = true
  }
  return any ? out : null
}

/** The wire form of the answers: comments trimmed, empty ones dropped. */
export function answersToWire(answers: AskUserAnswers): Record<string, { selected: string[]; comment?: string }> {
  const out: Record<string, { selected: string[]; comment?: string }> = {}
  for (const [id, a] of Object.entries(answers)) {
    const comment = a.comment.trim()
    out[id] = comment ? { selected: [...a.selected], comment } : { selected: [...a.selected] }
  }
  return out
}

/** The stored answer items of a row back as local answers (retry after reload). */
export function itemsToAnswers(payload: AskUserPayload | null, items: unknown): AskUserAnswers | null {
  if (!payload || !Array.isArray(items)) return null
  const draft: Record<string, { selected: string[]; comment?: string }> = {}
  for (const item of items as Array<{ questionId?: unknown; selected?: unknown; comment?: unknown }>) {
    if (!item || typeof item.questionId !== 'string') continue
    const selected = Array.isArray(item.selected)
      ? item.selected.map(o => (o as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string')
      : []
    draft[item.questionId] = typeof item.comment === 'string' ? { selected, comment: item.comment } : { selected }
  }
  return draftToAnswers(payload, draft)
}

/** Is one question complete enough to move on / submit? */
export function questionComplete(question: AskUserQuestion, answer: AskUserLocalAnswer | undefined): boolean {
  if (!answer || answer.selected.length === 0) return false
  if (answer.selected.includes(OTHER_ID) && !answer.comment.trim()) return false
  return true
}

export function useAskUserCard(row: Ref<InteractionTableRow | null>, deps: AskUserCardDeps) {
  const now = deps.now ?? (() => Date.now())
  const debounceMs = deps.debounceMs ?? ASK_USER_DRAFT_DEBOUNCE_MS

  const payload = computed<AskUserPayload | null>(() => {
    const p = row.value?.payload as Partial<AskUserPayload> | undefined
    return p && p.kind === 'ask_user' && Array.isArray(p.questions) ? p as AskUserPayload : null
  })
  const questions = computed(() => payload.value?.questions ?? [])
  const isWizard = computed(() => questions.value.length > 1)

  const answers = ref<AskUserAnswers>(draftToAnswers(payload.value, row.value?.draft) ?? emptyAnswers(payload.value))
  const step = ref(0)
  /** Status pinned by our own answer/dismiss or a 409, until the row agrees. */
  const lockedStatus = ref<InteractionTableStatus | null>(null)
  const conflictLabel = ref<string | null>(null)
  const submitting = ref(false)
  const retryable = ref(false)
  const errorMessage = ref<string | null>(null)
  let requestId: string | null = null
  /**
   * B1 (review 1, review 2): a blocking card whose answer is stored but whose
   * turn did not start (`answer.resumed === false`) — a 502 before a reload.
   * Derived from the CURRENT row, not once at mount: the card is often
   * mounted with `row = null` (skeleton) and the GET delivers the answered
   * row later. It may be sent again with the stored key; the server treats
   * that as a resume retry and ignores the value of the body.
   */
  const owed = computed(() => {
    const r = row.value
    return r?.status === 'answered' && r.blocking === true
      && r.answer?.resumed === false && typeof r.answer.clientRequestId === 'string'
  })
  watch(owed, (isOwed) => {
    if (!isOwed || lockedStatus.value !== null) return
    requestId = row.value!.answer!.clientRequestId!
    const restored = itemsToAnswers(payload.value, row.value!.answer!.items)
    if (restored) answers.value = restored
  }, { immediate: true })
  let draftTimer: ReturnType<typeof setTimeout> | null = null
  let lastLocalEdit = -Infinity

  const status = computed<InteractionTableStatus | null>(() => lockedStatus.value ?? row.value?.status ?? null)
  /**
   * B1: the answer is stored, the agent did not start (502 `retryable`, or a
   * row found that way on mount). The card stays sendable with the SAME key
   * and the SAME answers, even if the row already says `answered`, until a
   * 200 or a frame with `answer.resumed === true` closes it.
   */
  const resumePending = computed(() => {
    if (lockedStatus.value !== null) return false
    const r = row.value
    if (!r || (r.status !== 'open' && r.status !== 'answered')) return false
    if (r.answer?.resumed === true) return false
    return retryable.value || owed.value
  })
  const isOpen = computed(() => status.value === 'open' && !submitting.value && !resumePending.value)
  const current = computed(() => questions.value[step.value] ?? null)
  const progress = computed(() => ({ current: step.value + 1, total: questions.value.length }))
  const isLast = computed(() => step.value >= questions.value.length - 1)
  const currentComplete = computed(() => !!current.value && questionComplete(current.value, answers.value[current.value.id]))
  const allComplete = computed(() => questions.value.length > 0 && questions.value.every(q => questionComplete(q, answers.value[q.id])))

  // A row that arrives later (frame after the list) fills empty answers.
  watch(() => payload.value?.id, () => {
    if (Object.keys(answers.value).length === 0) {
      answers.value = draftToAnswers(payload.value, row.value?.draft) ?? emptyAnswers(payload.value)
    }
  })

  // The row closed on the server (answered elsewhere, superseded, expired):
  // drop a local pin that no longer matters and stop the pending draft.
  watch(() => row.value?.status, (next) => {
    if (next && next !== 'open') {
      cancelDraft()
      if (lockedStatus.value === next) lockedStatus.value = null
    }
  })

  // A draft from another device: taken over unless the user types here.
  watch(() => row.value?.draft, (draft) => { applyRemoteDraft(draft) }, { deep: true })

  function isTyping(): boolean {
    return draftTimer !== null || now() - lastLocalEdit < ASK_USER_TYPING_WINDOW_MS
  }

  function applyRemoteDraft(draft: unknown): boolean {
    if (status.value !== 'open' || isTyping()) return false
    const next = draftToAnswers(payload.value, draft)
    if (!next) return false
    answers.value = next
    return true
  }

  function cancelDraft(): void {
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = null
  }

  function scheduleDraft(): void {
    const id = row.value?.id
    if (!id) return
    cancelDraft()
    draftTimer = setTimeout(() => {
      draftTimer = null
      if (status.value !== 'open') return
      void deps.saveDraft(id, answersToWire(answers.value))
    }, debounceMs)
  }

  function edited(): void {
    lastLocalEdit = now()
    // New content = a new submit: the old key belongs to the old answers.
    requestId = null
    retryable.value = false
    errorMessage.value = null
    scheduleDraft()
  }

  function questionById(questionId: string): AskUserQuestion | undefined {
    return questions.value.find(q => q.id === questionId)
  }

  function select(questionId: string, optionId: string): void {
    const q = questionById(questionId)
    const a = answers.value[questionId]
    if (!q || !a || !isOpen.value) return
    if (q.type === 'multi') {
      a.selected = a.selected.includes(optionId) ? a.selected.filter(id => id !== optionId) : [...a.selected, optionId]
    } else {
      a.selected = [optionId]
    }
    edited()
  }

  function setComment(questionId: string, text: string): void {
    const q = questionById(questionId)
    const a = answers.value[questionId]
    if (!q || !a || !isOpen.value || !q.allowComment) return
    a.comment = text.slice(0, ASK_USER_COMMENT_MAX)
    // Only a comment, no option: it is the "Other" answer.
    if (a.comment.trim() && a.selected.length === 0 && q.options.some(o => o.id === OTHER_ID)) {
      a.selected = [OTHER_ID]
    }
    edited()
  }

  function next(): boolean {
    if (!currentComplete.value || isLast.value) return false
    step.value += 1
    return true
  }

  function back(): boolean {
    if (step.value === 0) return false
    step.value -= 1
    return true
  }

  function pin(outcomeStatus: InteractionTableStatus | null, interaction: InteractionTableRow | null): void {
    lockedStatus.value = outcomeStatus ?? interaction?.status ?? 'superseded'
  }

  async function submit(): Promise<InteractionByIdOutcome | null> {
    const id = row.value?.id
    if (!id || submitting.value) return null
    if (status.value !== 'open' && !resumePending.value) return null
    // Resume from a stored row: the key is the row's, the body value is
    // ignored by the server (resume retry), the items are sent along.
    const fromRow = resumePending.value && owed.value && !retryable.value
    if (!fromRow && !allComplete.value) return null
    cancelDraft()
    if (fromRow) requestId = row.value!.answer!.clientRequestId!
    requestId ??= deps.newRequestId()
    submitting.value = true
    errorMessage.value = null
    const body = fromRow ? (itemsToAnswers(payload.value, row.value!.answer!.items) ?? answers.value) : answers.value
    const outcome = await deps.answerById({ interactionId: id, clientRequestId: requestId, answers: answersToWire(body) })
    submitting.value = false
    if (outcome.status === 'applied') {
      retryable.value = false
      lockedStatus.value = 'answered'
      conflictLabel.value = outcome.label || null
    } else if (outcome.status === 'conflict') {
      // 409: the card is no longer open. Show what it is, lock it.
      retryable.value = false
      pin(outcome.current, outcome.interaction)
      conflictLabel.value = outcome.label
    } else if (outcome.status === 'retryable') {
      // 502: the answer is stored, the turn did not start. Same key again.
      // The row of the 502 is NOT taken as the end state (AskUserCard.vue).
      retryable.value = true
      errorMessage.value = outcome.message
    } else if (outcome.status === 'stale') {
      pin('superseded', null)
    } else {
      errorMessage.value = outcome.message
    }
    return outcome
  }

  async function dismiss(): Promise<InteractionDismissOutcome | null> {
    const id = row.value?.id
    if (!id || status.value !== 'open' || submitting.value || resumePending.value) return null
    if (row.value?.blocking ?? payload.value?.blocking) {
      const ok = deps.confirmDismiss ? await deps.confirmDismiss() : true
      if (!ok) return null
    }
    cancelDraft()
    submitting.value = true
    const outcome = await deps.dismissById(id)
    submitting.value = false
    if (outcome.status === 'dismissed') lockedStatus.value = 'dismissed'
    else if (outcome.status === 'conflict') pin(outcome.current, outcome.interaction)
    else errorMessage.value = outcome.message
    return outcome
  }

  return {
    payload, questions, isWizard, answers, step, status, isOpen, current, progress, isLast,
    currentComplete, allComplete, submitting, retryable, resumePending, errorMessage, conflictLabel,
    select, setComment, next, back, submit, dismiss, applyRemoteDraft, cancelDraft,
  }
}
