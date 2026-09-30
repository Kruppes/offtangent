import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const descriptor = parse(readFileSync(new URL('./ChatInteractionBlock.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'interaction-test', inlineTemplate: true })
const compiled = ts.transpile(script.content, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 })
const exported: { default?: Vue.Component } = {}
new Function('require', 'exports', compiled)(() => Vue, exported)
const ChatInteractionBlock = exported.default!
import { parseInteractionBlockPayload } from '@axiom/core/contracts'

type Node = { type: string; props: Record<string, unknown>; children: Node[]; parent?: Node }
const node = (type: string): Node => ({ type, props: {}, children: [] })
const renderer = createRenderer<Node, Node>({
  createElement: node, createText: node, createComment: node,
  setText: (n, text) => { n.type = text }, setElementText: (n, text) => { n.children = [node(text)] },
  parentNode: n => n?.parent ?? null,
  // Vue's removeFragment walks `while (cur !== end)` via nextSibling, so a stub
  // that always answers null never reaches the end anchor. Ordered insert plus
  // real sibling lookup make that walk terminate; a stubbed-out nextSibling
  // turns every fragment unmount into an infinite loop that no test timeout can
  // interrupt, which is what hung the image build.
  nextSibling: n => {
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
  remove: n => { if (n?.parent) n.parent.children = n.parent.children.filter(c => c !== n) },
})
function find(n: Node, predicate: (n: Node) => boolean): Node | undefined {
  if (predicate(n)) return n
  for (const child of n.children) { const result = find(child, predicate); if (result) return result }
}
function findAll(n: Node, predicate: (n: Node) => boolean): Node[] {
  const hits = predicate(n) ? [n] : []
  for (const child of n.children) hits.push(...findAll(child, predicate))
  return hits
}
afterEach(() => vi.unstubAllGlobals())

/**
 * Nuxt auto-imports as globals, plus one deliberate deviation: `nextTick` is
 * stubbed so it resolves WITHOUT running the callback. The only callback the
 * component schedules is `input.focus()`, and the element of this renderer is
 * a plain object with no DOM methods. Focus is a browser behaviour and is
 * covered by the Playwright screenshot run, not here.
 */
/** The own-answer row: a button with the i18n key somewhere inside it. */
function ownAnswerRow(root: Node): Node | undefined {
  return find(root, n => n.type === 'button' && !!find(n, c => c.type === 'chat.interaction.ownAnswer'))
}

/** `@keydown.enter` + `@keydown.esc` compile into an array of handlers. */
function fireKeydown(input: Node, key: string) {
  const handler = input.props.onKeydown as ((e: unknown) => void) | ((e: unknown) => void)[]
  for (const fn of Array.isArray(handler) ? handler : [handler]) fn({ key, preventDefault: () => {} })
}

function stubRuntime(answerBlock: unknown) {
  vi.stubGlobal('ref', ref); vi.stubGlobal('computed', computed)
  vi.stubGlobal('nextTick', () => Promise.resolve())
  vi.stubGlobal('useI18n', () => ({ t: (s: string) => s }))
  vi.stubGlobal('useInteractions', () => ({ answerBlock, newClientMessageId: vi.fn(() => 'stable') }))
}

describe('interaction taps', () => {
  it('reuses a client ID after a dropped response; retry submits instead of merely hiding error', async () => {
    const answerBlock = vi.fn().mockResolvedValueOnce({ status: 'error', message: 'Offline' }).mockResolvedValueOnce({ status: 'already_answered', label: 'Yes' })
    stubRuntime(answerBlock)
    const block = parseInteractionBlockPayload({ block: 'confirm', id: 'b', question: 'Proceed?' })!
    const root = node('root')
    const app = renderer.createApp(ChatInteractionBlock, { block, messageId: 42 })
    app.component('AppIcon', defineComponent(() => () => h('i')))
    app.config.globalProperties.$t = (s: string) => s
    app.mount(root)
    await (find(root, n => n.type === 'button')!.props.onClick as () => Promise<void>)()
    await nextTick()
    const retry = find(root, n => n.type === 'button' && n.children.some(c => c.type === 'common.retry'))!
    expect(retry).toBeDefined()
    ;(retry.props.onClick as () => void)()
    await Promise.resolve(); await nextTick()
    expect(answerBlock).toHaveBeenCalledTimes(2)
    expect(answerBlock.mock.calls[0]![0].clientMessageId).toBe('stable')
    expect(answerBlock.mock.calls[1]![0].clientMessageId).toBe('stable')
    expect(find(root, n => n.type === 'button')).toBeUndefined()
    app.unmount()
  })

  it('sends the toggled option ids of a multi card, and nothing before one is picked', async () => {
    const answerBlock = vi.fn().mockResolvedValue({ status: 'applied', label: 'Chamomile, Rooibos', resumed: true })
    stubRuntime(answerBlock)
    const block = parseInteractionBlockPayload({
      block: 'multi', id: 'm1', question: 'Which ones?',
      options: [{ id: 'a', label: 'Chamomile' }, { id: 'b', label: 'Peppermint' }, { id: 'c', label: 'Rooibos' }],
    })!
    const root = node('root')
    const app = renderer.createApp(ChatInteractionBlock, { block, messageId: 42 })
    app.component('AppIcon', defineComponent(() => () => h('i')))
    app.config.globalProperties.$t = (s: string) => s
    app.mount(root)

    const boxes = findAll(root, n => n.props.role === 'checkbox')
    const send = () => findAll(root, n => n.type === 'button').find(b => !boxes.includes(b) && b.props.disabled !== undefined)!
    expect(boxes).toHaveLength(3)
    expect(send().props.disabled).toBe(true)

    ;(boxes[0]!.props.onClick as () => void)()
    ;(boxes[2]!.props.onClick as () => void)()
    ;(boxes[1]!.props.onClick as () => void)()
    ;(boxes[1]!.props.onClick as () => void)()
    await nextTick()
    expect(boxes.map(b => b.props['aria-checked'])).toEqual(['true', 'false', 'true'])
    expect(send().props.disabled).toBe(false)
    expect(answerBlock).not.toHaveBeenCalled()

    await (send().props.onClick as () => Promise<void>)()
    await nextTick()
    expect(answerBlock).toHaveBeenCalledTimes(1)
    expect(answerBlock.mock.calls[0]![0].value).toEqual(['a', 'c'])
    expect(find(root, n => n.type === 'button')).toBeUndefined()
    // Answered: the question stays and the chosen rows remain, one per option.
    expect(find(root, n => n.type === 'Chamomile')).toBeDefined()
    expect(find(root, n => n.type === 'Rooibos')).toBeDefined()
    expect(find(root, n => n.type === 'Peppermint')).toBeUndefined()
    expect(find(root, n => n.props.role === 'status')).toBeDefined()
    app.unmount()
  })

  it('swaps the own-answer row for an inline input and emits the typed text on Enter', async () => {
    const answerBlock = vi.fn()
    stubRuntime(answerBlock)
    const block = parseInteractionBlockPayload({ block: 'confirm', id: 'b', question: 'Proceed?' })!
    const ownAnswer = vi.fn()
    const root = node('root')
    const app = renderer.createApp(ChatInteractionBlock, { block, messageId: 42, onOwnAnswer: ownAnswer })
    app.component('AppIcon', defineComponent(() => () => h('i')))
    app.config.globalProperties.$t = (s: string) => s
    app.mount(root)

    const row = ownAnswerRow(root)!
    expect(row).toBeDefined()
    expect(find(root, n => n.type === 'input')).toBeUndefined()
    ;(row.props.onClick as () => void)()
    await nextTick()

    const input = find(root, n => n.type === 'input')!
    expect(input).toBeDefined()
    expect(input.props['aria-label']).toBe('chat.interaction.ownAnswer')
    ;(input.props.onInput as (e: unknown) => void)({ target: { value: 'Ask Bob first' } })
    await nextTick()
    fireKeydown(input, 'Enter')
    await nextTick()

    expect(ownAnswer).toHaveBeenCalledTimes(1)
    expect(ownAnswer.mock.calls[0]![0]).toBe('Ask Bob first')
    expect(answerBlock).not.toHaveBeenCalled()
    // The card settles into its answered state showing the written answer.
    expect(find(root, n => n.type === 'Ask Bob first')).toBeDefined()
    expect(find(root, n => n.type === 'button')).toBeUndefined()
    app.unmount()
  })

  it('closes the inline input again on Escape, without sending anything', async () => {
    const answerBlock = vi.fn()
    stubRuntime(answerBlock)
    const block = parseInteractionBlockPayload({ block: 'confirm', id: 'b', question: 'Proceed?' })!
    const ownAnswer = vi.fn()
    const root = node('root')
    const app = renderer.createApp(ChatInteractionBlock, { block, messageId: 42, onOwnAnswer: ownAnswer })
    app.component('AppIcon', defineComponent(() => () => h('i')))
    app.config.globalProperties.$t = (s: string) => s
    app.mount(root)

    const row = ownAnswerRow(root)!
    ;(row.props.onClick as () => void)()
    await nextTick()
    const input = find(root, n => n.type === 'input')!
    ;(input.props.onInput as (e: unknown) => void)({ target: { value: 'never mind' } })
    fireKeydown(input, 'Escape')
    await nextTick()

    expect(find(root, n => n.type === 'input')).toBeUndefined()
    expect(ownAnswerRow(root)).toBeDefined()
    expect(ownAnswer).not.toHaveBeenCalled()
    app.unmount()
  })

  it('sends free text of a multi card as a message only, when no option is picked', async () => {
    const answerBlock = vi.fn()
    stubRuntime(answerBlock)
    const block = parseInteractionBlockPayload({
      block: 'multi', id: 'm1', question: 'Which ones?',
      options: [{ id: 'a', label: 'Chamomile' }, { id: 'b', label: 'Peppermint' }],
    })!
    const ownAnswer = vi.fn()
    const root = node('root')
    const app = renderer.createApp(ChatInteractionBlock, { block, messageId: 42, onOwnAnswer: ownAnswer })
    app.component('AppIcon', defineComponent(() => () => h('i')))
    app.config.globalProperties.$t = (s: string) => s
    app.mount(root)

    const boxes = findAll(root, n => n.props.role === 'checkbox')
    const sendButton = () => findAll(root, n => n.type === 'button').find(b => !boxes.includes(b) && b.props.disabled !== undefined)!
    expect(sendButton().props.disabled).toBe(true)

    const row = ownAnswerRow(root)!
    ;(row.props.onClick as () => void)()
    await nextTick()
    const input = find(root, n => n.type === 'input')!
    ;(input.props.onInput as (e: unknown) => void)({ target: { value: 'Something else entirely' } })
    fireKeydown(input, 'Enter')
    await nextTick()

    // Free text alone is not an option answer: it waits for the send button
    // and then leaves as an ordinary message.
    expect(ownAnswer).not.toHaveBeenCalled()
    expect(find(root, n => n.type === 'Something else entirely')).toBeDefined()
    expect(sendButton().props.disabled).toBe(false)

    await (sendButton().props.onClick as () => void | Promise<void>)()
    await nextTick()
    expect(answerBlock).not.toHaveBeenCalled()
    expect(ownAnswer).toHaveBeenCalledTimes(1)
    expect(ownAnswer.mock.calls[0]![0]).toBe('Something else entirely')
    app.unmount()
  })

  it('sends option ids and the free text when a multi card carries both', async () => {
    const answerBlock = vi.fn().mockResolvedValue({ status: 'applied', label: 'Chamomile', resumed: true })
    stubRuntime(answerBlock)
    const block = parseInteractionBlockPayload({
      block: 'multi', id: 'm1', question: 'Which ones?',
      options: [{ id: 'a', label: 'Chamomile' }, { id: 'b', label: 'Peppermint' }],
    })!
    const ownAnswer = vi.fn()
    const root = node('root')
    const app = renderer.createApp(ChatInteractionBlock, { block, messageId: 42, onOwnAnswer: ownAnswer })
    app.component('AppIcon', defineComponent(() => () => h('i')))
    app.config.globalProperties.$t = (s: string) => s
    app.mount(root)

    const boxes = findAll(root, n => n.props.role === 'checkbox')
    ;(boxes[0]!.props.onClick as () => void)()
    const row = ownAnswerRow(root)!
    ;(row.props.onClick as () => void)()
    await nextTick()
    const input = find(root, n => n.type === 'input')!
    ;(input.props.onInput as (e: unknown) => void)({ target: { value: 'and camomile tea please' } })
    fireKeydown(input, 'Enter')
    await nextTick()

    const send = findAll(root, n => n.type === 'button').find(b => !boxes.includes(b) && b.props.disabled !== undefined)!
    await (send.props.onClick as () => Promise<void>)()
    await nextTick()

    expect(answerBlock).toHaveBeenCalledTimes(1)
    expect(answerBlock.mock.calls[0]![0].value).toEqual(['a'])
    expect(ownAnswer).toHaveBeenCalledTimes(1)
    expect(ownAnswer.mock.calls[0]![0]).toBe('and camomile tea please')
    app.unmount()
  })
})
