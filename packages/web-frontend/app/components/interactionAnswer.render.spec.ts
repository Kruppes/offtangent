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
afterEach(() => vi.unstubAllGlobals())

describe('interaction taps', () => {
  it('reuses a client ID after a dropped response; retry submits instead of merely hiding error', async () => {
    const answerBlock = vi.fn().mockResolvedValueOnce({ status: 'error', message: 'Offline' }).mockResolvedValueOnce({ status: 'already_answered', label: 'Yes' })
    vi.stubGlobal('ref', ref); vi.stubGlobal('computed', computed)
    vi.stubGlobal('useI18n', () => ({ t: (s: string) => s }))
    vi.stubGlobal('useInteractions', () => ({ answerBlock, newClientMessageId: vi.fn(() => 'stable') }))
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
})
