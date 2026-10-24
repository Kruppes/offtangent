import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createRenderer, defineComponent, h, nextTick, ref, type Ref } from 'vue'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as askUserCardModule from '~/composables/chat/useAskUserCard'
import * as interactionTableModule from '~/composables/useInteractionTable'
import type { InteractionTableRow } from '~/composables/useInteractionTable'

/**
 * Render test of the ask_user card (S1-C). The SFC is compiled in place; its
 * imports resolve to the real card logic and table, `useInteractions` is a
 * stub (no network).
 */
const answerById = vi.fn()
const saveDraft = vi.fn(async () => true)
const dismissById = vi.fn()
const modules: Record<string, unknown> = {
  'vue': Vue,
  '~/composables/chat/useAskUserCard': askUserCardModule,
  '~/composables/useInteractionTable': interactionTableModule,
  '~/composables/useInteractions': { newClientMessageId: () => 'req-1', useInteractions: () => ({ answerById, saveDraft, dismissById }) },
}
const descriptor = parse(readFileSync(new URL('./chat/AskUserCard.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'ask-user-test', inlineTemplate: true })
const compiled = ts.transpile(script.content, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 })
const exported: { default?: Vue.Component } = {}
new Function('require', 'exports', compiled)((id: string) => {
  if (!(id in modules)) throw new Error(`unexpected import ${id}`)
  return modules[id]
}, exported)
const AskUserCard = exported.default!

type Node = { type: string; props: Record<string, unknown>; children: Node[]; parent?: Node }
const node = (type: string): Node => ({ type, props: {}, children: [] })
const renderer = createRenderer<Node, Node>({
  createElement: node, createText: node, createComment: node,
  setText: (n, text) => { n.type = text }, setElementText: (n, text) => { n.children = [node(text)] },
  parentNode: n => n?.parent ?? null,
  nextSibling: (n) => {
    const siblings = n?.parent?.children
    if (!siblings) return null
    const index = siblings.indexOf(n)
    return index === -1 ? null : siblings[index + 1] ?? null
  },
  patchProp: (n, key, _old, value) => { n.props[key] = value },
  insert: (n, parent, anchor) => {
    n.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index === -1) parent.children.push(n)
    else parent.children.splice(index, 0, n)
  },
  remove: (n) => { if (n?.parent) n.parent.children = n.parent.children.filter(c => c !== n) },
})
function find(n: Node, predicate: (n: Node) => boolean): Node | undefined {
  if (predicate(n)) return n
  for (const child of n.children) { const hit = find(child, predicate); if (hit) return hit }
}
function findAll(n: Node, predicate: (n: Node) => boolean): Node[] {
  const hits = predicate(n) ? [n] : []
  for (const child of n.children) hits.push(...findAll(child, predicate))
  return hits
}
const has = (attr: string) => (n: Node) => attr in n.props
const text = (n: Node): string => n.children.length ? n.children.map(text).join('') : n.type

const store = new Map<string, Ref<unknown>>()
beforeEach(() => {
  store.clear()
  answerById.mockReset(); dismissById.mockReset(); saveDraft.mockClear()
  vi.stubGlobal('useState', <T>(key: string, init: () => T): Ref<T> => {
    if (!store.has(key)) store.set(key, ref(init()) as Ref<unknown>)
    return store.get(key) as Ref<T>
  })
  vi.stubGlobal('useI18n', () => ({ t: (s: string) => s }))
  vi.stubGlobal('window', { confirm: () => true })
})
afterEach(() => vi.unstubAllGlobals())

const questions = [
  { id: 'q1', type: 'choice', question: 'Which DB?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sq', label: 'SQLite' }], recommended: 'pg', allowComment: true },
  { id: 'q2', type: 'confirm', question: 'Migrate now?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], allowComment: false },
]
const makeRow = (over: Partial<InteractionTableRow> = {}): InteractionTableRow => ({
  id: 'ia_1', strandId: 's1', messageId: 3, toolCallId: 'call_1', status: 'open', blocking: false, draft: null,
  payload: { kind: 'ask_user', id: 'call_1', question: 'Which DB?', blocking: false, questions },
  ...over,
})

function mount(props: Record<string, unknown>) {
  const root = node('root')
  const app = renderer.createApp(AskUserCard, props)
  app.component('AppIcon', defineComponent(() => () => h('i')))
  app.config.globalProperties.$t = (s: string) => s
  app.mount(root)
  return { root, app }
}

describe('AskUserCard render', () => {
  it('pending: a skeleton with the announced question count', () => {
    const { root, app } = mount({ row: null, pendingCount: 2 })
    expect(find(root, has('data-ask-user-skeleton'))).toBeDefined()
    expect(find(root, has('data-ask-user-open'))).toBeUndefined()
    app.unmount()
  })

  it('open wizard: radio choice with recommended mark, next, confirm buttons, one submit at the end', async () => {
    answerById.mockResolvedValue({ status: 'applied', label: 'Postgres', interaction: null })
    const { root, app } = mount({ row: makeRow() })
    expect(find(root, has('data-ask-user-progress'))).toBeDefined()
    const radios = findAll(root, n => n.type === 'input' && n.props.type === 'radio')
    expect(radios).toHaveLength(2)
    expect(findAll(root, has('data-recommended'))).toHaveLength(1)
    expect(find(root, has('data-ask-user-comment'))).toBeDefined()
    expect(find(root, has('data-ask-user-submit'))).toBeUndefined()
    ;(radios[0]!.props.onChange as () => void)()
    await nextTick()
    ;(find(root, has('data-ask-user-next'))!.props.onClick as () => void)()
    await nextTick()
    const confirmButtons = findAll(root, n => n.type === 'button' && n.props.role === 'radio')
    expect(confirmButtons).toHaveLength(2)
    ;(confirmButtons[0]!.props.onClick as () => void)()
    await nextTick()
    await (find(root, has('data-ask-user-submit'))!.props.onClick as () => Promise<void>)()
    await nextTick()
    expect(answerById).toHaveBeenCalledTimes(1)
    expect(answerById.mock.calls[0]![0].answers).toEqual({ q1: { selected: ['pg'] }, q2: { selected: ['yes'] } })
    expect(find(root, has('data-ask-user-open'))).toBeUndefined()
    expect(find(root, has('data-ask-user-closed'))).toBeDefined()
    app.unmount()
  })

  it('a closed row renders read-only with its status and answer', () => {
    for (const status of ['answered', 'dismissed', 'superseded', 'expired'] as const) {
      const answer = status === 'answered'
        ? { items: [{ questionId: 'q1', question: 'Which DB?', selected: [{ id: 'pg', label: 'Postgres' }] }] }
        : null
      const { root, app } = mount({ row: makeRow({ status, answer }) })
      expect(find(root, has('data-ask-user-open'))).toBeUndefined()
      expect(text(find(root, has('data-ask-user-status'))!)).toBe(`chat.askUser.status.${status}`)
      expect(!!find(root, has('data-ask-user-answer'))).toBe(status === 'answered')
      expect(findAll(root, n => n.type === 'input')).toHaveLength(0)
      app.unmount()
    }
  })

  it('409 on submit: shows the current status and locks the card', async () => {
    answerById.mockResolvedValue({ status: 'conflict', current: 'expired', label: null, interaction: null })
    const single = makeRow({ payload: { kind: 'ask_user', id: 'call_1', question: 'Migrate now?', blocking: false, questions: [questions[1]] } })
    const { root, app } = mount({ row: single })
    ;(findAll(root, n => n.type === 'button' && n.props.role === 'radio')[1]!.props.onClick as () => void)()
    await nextTick()
    await (find(root, has('data-ask-user-submit'))!.props.onClick as () => Promise<void>)()
    await nextTick()
    expect(find(root, has('data-ask-user-open'))).toBeUndefined()
    expect(text(find(root, has('data-ask-user-status'))!)).toBe('chat.askUser.status.expired')
    app.unmount()
  })

  it('dismiss button posts dismiss and closes the card', async () => {
    dismissById.mockResolvedValue({ status: 'dismissed', interaction: null })
    const { root, app } = mount({ row: makeRow() })
    await (find(root, has('data-ask-user-dismiss'))!.props.onClick as () => Promise<void>)()
    await nextTick()
    expect(dismissById).toHaveBeenCalledWith('ia_1')
    expect(text(find(root, has('data-ask-user-status'))!)).toBe('chat.askUser.status.dismissed')
    app.unmount()
  })

  it('B1: 502 keeps the card sendable with the same key, even when the row says answered; 200 locks it', async () => {
    const stored = { label: 'Postgres', clientRequestId: 'req-1', resumed: false, items: [{ questionId: 'q1', question: 'Which DB?', selected: [{ id: 'pg', label: 'Postgres' }] }] }
    answerById
      .mockResolvedValueOnce({ status: 'retryable', message: 'agent not started', interaction: { ...makeRow(), status: 'answered', answer: stored } })
      .mockResolvedValueOnce({ status: 'applied', label: 'Postgres', interaction: { ...makeRow(), status: 'answered', answer: { ...stored, resumed: true } } })
    const single = makeRow({ blocking: true, payload: { kind: 'ask_user', id: 'call_1', question: 'Which DB?', blocking: true, questions: [questions[0]] } })
    const table = interactionTableModule.useInteractionTable()
    table.receive(single)
    const live = computed(() => table.toolCallRow('call_1'))
    const Host = defineComponent(() => () => h(AskUserCard, { row: live.value }))
    const root = node('root')
    const app = renderer.createApp(Host)
    app.component('AppIcon', defineComponent(() => () => h('i')))
    app.config.globalProperties.$t = (s: string) => s
    app.mount(root)
    ;(findAll(root, n => n.type === 'input' && n.props.type === 'radio')[0]!.props.onChange as () => void)()
    await nextTick()
    await (find(root, has('data-ask-user-submit'))!.props.onClick as () => Promise<void>)()
    await nextTick()
    // 502: no end state. Hint + resend, the row of the 502 is not taken over.
    expect(find(root, has('data-ask-user-closed'))).toBeUndefined()
    expect(find(root, has('data-ask-user-resume'))).toBeDefined()
    expect(text(find(root, has('data-ask-user-submit'))!)).toBe('chat.askUser.resend')
    // Even when the frame of the stored answer (resumed false) arrives, retry stays possible.
    table.receive({ ...single, status: 'answered', answer: stored })
    await nextTick()
    expect(find(root, has('data-ask-user-submit'))).toBeDefined()
    await (find(root, has('data-ask-user-submit'))!.props.onClick as () => Promise<void>)()
    await nextTick()
    expect(answerById).toHaveBeenCalledTimes(2)
    expect(answerById.mock.calls[1]![0].clientRequestId).toBe(answerById.mock.calls[0]![0].clientRequestId)
    expect(answerById.mock.calls[1]![0].answers).toEqual({ q1: { selected: ['pg'] } })
    // 200: locked.
    expect(find(root, has('data-ask-user-submit'))).toBeUndefined()
    expect(find(root, has('data-ask-user-closed'))).toBeDefined()
    app.unmount()
  })

  it('B1: after a reload a row answered with resumed=false offers resend; resumed=true via frame locks it', async () => {
    const stored = { label: 'Postgres', clientRequestId: 'req-old', resumed: false, items: [{ questionId: 'q1', question: 'Which DB?', selected: [{ id: 'pg', label: 'Postgres' }] }] }
    const single = makeRow({ blocking: true, status: 'answered', answer: stored, payload: { kind: 'ask_user', id: 'call_1', question: 'Which DB?', blocking: true, questions: [questions[0]] } })
    const row = ref<InteractionTableRow>(single)
    const Host = defineComponent(() => () => h(AskUserCard, { row: row.value }))
    const root = node('root')
    const app = renderer.createApp(Host)
    app.component('AppIcon', defineComponent(() => () => h('i')))
    app.config.globalProperties.$t = (s: string) => s
    app.mount(root)
    expect(find(root, has('data-ask-user-resume'))).toBeDefined()
    answerById.mockResolvedValueOnce({ status: 'retryable', message: 'still down', interaction: null })
    await (find(root, has('data-ask-user-submit'))!.props.onClick as () => Promise<void>)()
    expect(answerById.mock.calls[0]![0].clientRequestId).toBe('req-old')
    row.value = { ...single, answer: { ...stored, resumed: true } }
    await nextTick()
    expect(find(root, has('data-ask-user-submit'))).toBeUndefined()
    expect(find(root, has('data-ask-user-closed'))).toBeDefined()
    app.unmount()
  })

  it('B1 review 2: mounted with row=null, the GET later delivers answered/resumed=false => resend visible, submit uses the stored key and items', async () => {
    const stored = { label: 'Postgres', clientRequestId: 'req-stored', resumed: false, items: [{ questionId: 'q1', question: 'Which DB?', selected: [{ id: 'pg', label: 'Postgres' }] }] }
    const answered = makeRow({ blocking: true, status: 'answered', answer: stored, payload: { kind: 'ask_user', id: 'call_1', question: 'Which DB?', blocking: true, questions: [questions[0]] } })
    let resolveGet!: (value: unknown) => void
    vi.stubGlobal('useApi', () => ({ apiFetch: vi.fn(() => new Promise(resolve => { resolveGet = resolve })) }))
    const table = interactionTableModule.useInteractionTable()
    const live = computed(() => table.toolCallRow('call_1'))
    const Host = defineComponent(() => () => h(AskUserCard, { row: live.value }))
    const root = node('root')
    const app = renderer.createApp(Host)
    app.component('AppIcon', defineComponent(() => () => h('i')))
    app.config.globalProperties.$t = (s: string) => s
    app.mount(root)
    expect(live.value).toBeNull()
    expect(find(root, has('data-ask-user-resume'))).toBeUndefined()
    const loading = table.loadStrand('s1')
    resolveGet({ interactions: [answered] })
    await loading
    await nextTick()
    expect(find(root, has('data-ask-user-resume'))).toBeDefined()
    expect(text(find(root, has('data-ask-user-submit'))!)).toBe('chat.askUser.resend')
    answerById.mockResolvedValueOnce({ status: 'applied', label: 'Postgres', interaction: { ...answered, answer: { ...stored, resumed: true } } })
    await (find(root, has('data-ask-user-submit'))!.props.onClick as () => Promise<void>)()
    await nextTick()
    expect(answerById).toHaveBeenCalledTimes(1)
    expect(answerById.mock.calls[0]![0]).toMatchObject({ interactionId: answered.id, clientRequestId: 'req-stored', answers: { q1: { selected: ['pg'] } } })
    expect(find(root, has('data-ask-user-submit'))).toBeUndefined()
    expect(find(root, has('data-ask-user-closed'))).toBeDefined()
    app.unmount()
  })

  it('M2: label and question with HTML render as text, never as img/a elements', () => {
    const evil = ['<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>']
    const payload = { kind: 'ask_user', id: 'call_1', question: evil[0]!, blocking: false, questions: [
      { id: 'q1', type: 'choice', question: evil[0]!, options: [{ id: 'a', label: evil[1]!, description: evil[0]! }, { id: 'b', label: evil[0]! }], allowComment: false },
    ] }
    const confirm = { kind: 'ask_user', id: 'call_1', question: evil[1]!, blocking: false, questions: [
      { id: 'q1', type: 'confirm', question: evil[1]!, options: [{ id: 'yes', label: evil[0]! }, { id: 'no', label: evil[1]! }], allowComment: false },
    ] }
    for (const p of [payload, confirm]) {
      const { root, app } = mount({ row: makeRow({ payload: p as InteractionTableRow['payload'] }) })
      const all = findAll(root, () => true)
      expect(all.some(n => n.type === 'img' || n.type === 'a')).toBe(false)
      expect(all.some(n => 'innerHTML' in n.props)).toBe(false)
      expect(all.some(n => n.type.trim() === evil[0])).toBe(true)
      expect(all.some(n => n.type.trim() === evil[1])).toBe(true)
      app.unmount()
    }
  })

  it('M3: unmount before 800 ms cancels the draft timer, no PUT', async () => {
    vi.useFakeTimers()
    try {
      const { root, app } = mount({ row: makeRow() })
      ;(findAll(root, n => n.type === 'input' && n.props.type === 'radio')[0]!.props.onChange as () => void)()
      await nextTick()
      vi.advanceTimersByTime(300)
      app.unmount()
      vi.advanceTimersByTime(2000)
      expect(saveDraft).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
