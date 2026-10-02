/**
 * Where the interaction card sits inside the chat view.
 *
 * This spec checks the position of `<ChatInteractionBlock>` in the real
 * template of the real file: since the W2a split the speaking row lives in
 * `chat/ChatBubble.vue`, and the send path spans `ChatView.vue` (the card's
 * free text answer), `chat/ChatComposer.vue` (the composer submit) and
 * `useMessageSegments` (answered elsewhere). The card must be a SIBLING of
 * the chat bubble, not a descendant of it, and a message that is nothing but
 * a card must not render an empty bubble. The full surface is mounted in
 * `chatView.render.spec.ts`.
 *
 * Run: npx vitest run packages/web-frontend/app/components/chatViewInteractionCard.render.spec.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'

type Node = {
  type: number
  tag?: string
  props?: { type: number; name?: string; value?: { content?: string }; exp?: { content?: string }; arg?: { content?: string } }[]
  children?: Node[]
}

const descriptor = parse(readFileSync(new URL('./chat/ChatBubble.vue', import.meta.url), 'utf8')).descriptor
const template = descriptor.template!.ast as unknown as Node
/** The script side of the send path, in the order the checks below expect it. */
const sendPathScript = [
  parse(readFileSync(new URL('./ChatView.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content,
  parse(readFileSync(new URL('./chat/ChatComposer.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content,
  readFileSync(new URL('../composables/chat/useMessageSegments.ts', import.meta.url), 'utf8'),
].join('\n')

function staticClassOf(node: Node): string {
  const attr = node.props?.find(p => p.type === 6 && p.name === 'class')
  return attr?.value?.content ?? ''
}

function bindingOf(node: Node, name: string): string | undefined {
  return node.props?.find(p => p.type === 7 && p.name === name)?.exp?.content
}

/** Path from the template root down to the first node matching `predicate`. */
function pathTo(node: Node, predicate: (n: Node) => boolean, trail: Node[] = []): Node[] | null {
  if (predicate(node)) return [...trail, node]
  for (const child of node.children ?? []) {
    const hit = pathTo(child, predicate, [...trail, node])
    if (hit) return hit
  }
  return null
}

function findAll(node: Node, predicate: (n: Node) => boolean): Node[] {
  const hits = predicate(node) ? [node] : []
  for (const child of node.children ?? []) hits.push(...findAll(child, predicate))
  return hits
}

const isBubble = (n: Node) => n.type === 1 && staticClassOf(n).includes('rounded-2xl px-4 py-2.5')
const isCard = (n: Node) => n.type === 1 && n.tag === 'ChatInteractionBlock'

describe('ChatView: the interaction card next to the bubble', () => {
  it('renders exactly one card element, outside the chat bubble', () => {
    const cards = findAll(template, isCard)
    expect(cards).toHaveLength(1)

    const path = pathTo(template, isCard)!
    expect(path).not.toBeNull()
    const ancestors = path.slice(0, -1)
    expect(ancestors.some(isBubble)).toBe(false)
  })

  it('gives the card the sibling spacing and the full column width', () => {
    const card = findAll(template, isCard)[0]!
    expect(staticClassOf(card)).toContain('mt-2')
    expect(staticClassOf(card)).toContain('w-full')
    // Review round 2: a row with five words on 817px falls apart into an
    // indicator on the left and emptiness on the right, so the card is capped.
    expect(staticClassOf(card)).toContain('max-w-xl')
  })

  it('shares the message column with the bubble (same parent, bubble first)', () => {
    const cardPath = pathTo(template, isCard)!
    const parent = cardPath[cardPath.length - 2]!
    const siblings = parent.children ?? []
    const bubbleIndex = siblings.findIndex(isBubble)
    const cardIndex = siblings.findIndex(isCard)
    expect(bubbleIndex).toBeGreaterThan(-1)
    expect(cardIndex).toBeGreaterThan(bubbleIndex)
  })

  it('skips the bubble entirely when the message is nothing but a card', () => {
    const bubble = findAll(template, isBubble)[0]!
    // The bubble only renders when there is a body to put in it.
    expect(bindingOf(bubble, 'if')).toContain('hasBubbleBody')
    // …and the speaker line then moves out of the bubble so the card is not
    // an orphan.
    const speakerLines = findAll(template, n => (n.props ?? []).some(p => p.type === 6 && p.name === 'data-speaker-label'))
    expect(speakerLines.length).toBeGreaterThanOrEqual(2)
    expect(speakerLines.some(n => (bindingOf(n, 'if') ?? '').includes('!hasBubbleBody'))).toBe(true)
  })

  it('drops the bubble outline when a card follows it', () => {
    const bubble = findAll(template, isBubble)[0]!
    const classBinding = bindingOf(bubble, 'bind') ?? ''
    expect(classBinding).toContain('interactionCard(msg)')
    // The bordered assistant bubble is the no-card case only.
    expect(classBinding).toContain("!interactionCard(msg)")
    expect(classBinding).toContain("'bg-muted text-foreground'")
  })

  it('keeps only text segments inside the bubble', () => {
    const bubble = findAll(template, isBubble)[0]!
    const loops = findAll(bubble, n => (bindingOf(n, 'for') ?? '').includes('messageTextSegments'))
    expect(loops).toHaveLength(1)
    expect(findAll(bubble, isCard)).toHaveLength(0)
  })

  it('keeps the timestamp line in the bubble, below the last text line; read-aloud sits in the action row', () => {
    const bubble = findAll(template, isBubble)[0]!
    const meta = findAll(bubble, n => (bindingOf(n, 'if') ?? '').includes('msg.timestamp'))
    expect(meta).toHaveLength(1)
    expect(staticClassOf(meta[0]!)).toContain('justify-end')
    // Read-aloud moved out of the bubble into the message action row (W4a).
    expect(findAll(bubble, n => (bindingOf(n, 'if') ?? '').includes('ttsEnabled'))).toHaveLength(0)
    const actions = findAll(template, n => n.tag === 'ChatMessageActions')
    expect(actions).toHaveLength(1)
    // W4b: read aloud + audio summary live in MessageSpeechActions (gated on ttsEnabled there).
    expect(findAll(actions[0]!, n => n.tag === 'MessageSpeechActions')).toHaveLength(1)
    // …and it is the last child of the bubble, i.e. below the text segments.
    const children = (bubble.children ?? []).filter(c => c.type === 1)
    expect(children[children.length - 1]).toBe(meta[0])
    const textLoopIndex = children.findIndex(n => (bindingOf(n, 'for') ?? '').includes('messageTextSegments') || findAll(n, m => (bindingOf(m, 'for') ?? '').includes('messageTextSegments')).length > 0)
    expect(textLoopIndex).toBeGreaterThan(-1)
    expect(children.indexOf(meta[0]!)).toBeGreaterThan(textLoopIndex)
    // The card sits below that whole bubble, not between text and timestamp.
    expect(findAll(bubble, isCard)).toHaveLength(0)
  })

  it('hands free text to the ordinary send path and tells the card about later user messages', () => {
    const card = findAll(template, isCard)[0]!
    const handler = card.props?.find(p => p.type === 7 && p.arg?.content === 'own-answer')?.exp?.content
    expect(handler).toBe('handleOwnAnswer')
    expect(bindingOf(card, 'bind')).toBeDefined()
    const answeredElsewhere = card.props?.find(p => p.type === 7 && p.arg?.content === 'answered-elsewhere')?.exp?.content
    expect(answeredElsewhere).toContain('answeredElsewhere')
  })
})

describe('ChatView: the free text send path', () => {
  const script = sendPathScript

  it('sends free text as an ordinary user message through useChat().sendMessage', () => {
    expect(script).toMatch(/async function handleOwnAnswer\(text: string\)[\s\S]*?await sendMessage\(value\)/)
  })

  it('does not touch the composer draft while doing so', () => {
    const body = script.slice(script.indexOf('async function handleOwnAnswer'))
    const fn = body.slice(0, body.indexOf('\n}\n') + 2)
    expect(fn).not.toContain('inputText')
    expect(fn).not.toContain('pendingFiles')
  })

  it('uses the very same send function as the composer submit handler', () => {
    // Both the composer (`handleSend`) and the card (`handleOwnAnswer`) call the
    // single `sendMessage` pulled out of `useChat()`; no second send path, and
    // therefore no backend change.
    // The composer also passes the kept dictation recordings (stored uploads).
    expect(script).toMatch(/async function handleSend\(\)[\s\S]*?await sendMessage\(text, files, stored\)/)
    expect(script).toMatch(/^\s{2}sendMessage,$/m)
    expect(script.match(/await sendMessage\(/g)?.length).toBe(2)
  })

  it('treats any later user message as an answer given in the chat', () => {
    expect(script).toMatch(/function answeredElsewhere\(index: number\): boolean[\s\S]*?role === 'user'/)
  })
})
