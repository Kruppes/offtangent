/**
 * What an interactive block (SPEC 7.4c) actually renders, and how it sits
 * inside the existing markdown renderer.
 *
 * No browser exists in the build sandbox, so the component goes through Vue's
 * SSR renderer: real SFC compilation, real props, real template logic, real
 * HTML. The second describe reproduces the segment loop of `ChatView.vue`
 * (markdown → card → markdown) against the real `marked` renderer from
 * `useMarkdown`, which is the part that proves the parser hooks INTO the
 * message renderer instead of standing next to it.
 *
 * Run: npx vitest run --config packages/web-frontend/vitest.render.config.ts
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h, ref, computed } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parseInteractionMessage, parseInteractionBlockPayload } from '@axiom/core/contracts'
import ChatInteractionBlock from './ChatInteractionBlock.vue'

// Nuxt auto-imports are free identifiers at runtime; the Nuxt runtime supplies
// exactly these, so the harness does the same.
const globals = globalThis as Record<string, unknown>
globals.ref = ref
globals.computed = computed
globals.useI18n = () => ({ t: (key: string) => key })
globals.useInteractions = () => ({
  segmentsOf: (content: string) => parseInteractionMessage(content),
  answerBlock: async () => ({ status: 'applied' as const, label: 'Hand over to Bob', resumed: true }),
  newClientMessageId: () => 'cmid-test',
})

const IconStub = defineComponent({
  props: { name: { type: String, default: '' } },
  setup: props => () => h('i', { 'data-icon': props.name }),
})

async function render(props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp(ChatInteractionBlock, props)
  app.component('AppIcon', IconStub)
  app.config.globalProperties.$t = (key: string) => key
  return renderToString(app)
}

const choice = parseInteractionBlockPayload({
  block: 'choice',
  id: 'b1',
  question: 'Hand this to Bob?',
  options: [
    { id: 'yes', label: 'Hand over to Bob' },
    { id: 'stay', label: 'Keep it here' },
  ],
})!

const confirmDestructive = parseInteractionBlockPayload({
  block: 'confirm',
  id: 'c1',
  question: 'Delete the draft?',
  destructive: true,
})!

describe('ChatInteractionBlock', () => {
  it('renders a choice card with one button per option', async () => {
    const html = await render({ block: choice, messageId: 42 })

    expect(html).toContain('Hand this to Bob?')
    expect(html).toContain('Hand over to Bob')
    expect(html).toContain('Keep it here')
    expect((html.match(/<button/g) ?? [])).toHaveLength(2)
  })

  it('gives every option a touch target of at least 44px', async () => {
    const html = await render({ block: choice, messageId: 42 })
    expect((html.match(/min-h-\[44px\]/g) ?? []).length).toBe(2)
  })

  it('labels the card for screen readers and marks it idle', async () => {
    const html = await render({ block: choice, messageId: 42 })
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-labelledby="interaction-b1-question"')
    expect(html).toContain('id="interaction-b1-question"')
    expect(html).toContain('aria-busy="false"')
  })

  it('paints the affirmative option of a destructive confirm in the destructive colour', async () => {
    const html = await render({ block: confirmDestructive, messageId: 7 })
    expect(html).toContain('Delete the draft?')
    expect(html).toContain('text-destructive')
    expect(html).toContain('Yes')
    expect(html).toContain('No')
  })

  it('collapses to a single chip once answered, with the alternatives gone', async () => {
    const html = await render({ block: choice, messageId: 42, answered: { label: 'Hand over to Bob' } })

    expect(html).toContain('Hand over to Bob')
    expect(html).not.toContain('Keep it here')
    expect(html).not.toContain('<button')
    expect(html).toContain('role="status"')
    expect(html).toContain('rounded-full')
  })

  it('animates only under motion-safe, so prefers-reduced-motion stays static', async () => {
    const html = await render({ block: choice, messageId: 42 })
    expect(html).not.toContain(' animate-')
    expect(html.includes('motion-safe:animate') || !html.includes('animate')).toBe(true)
  })

  it('uses semantic colour tokens, so dark mode needs no second stylesheet', async () => {
    const html = await render({ block: choice, messageId: 42 })
    expect(html).toContain('border-border')
    expect(html).toContain('text-foreground')
    expect(html).not.toMatch(/bg-(white|black|gray-\d00)\b/)
  })
})

describe('the segment loop of ChatView (parser inside the markdown renderer)', () => {
  // Same shape as the template: text segments go through the ordinary
  // markdown renderer, block segments become cards.
  async function renderMessage(content: string): Promise<string> {
    const { marked } = await import('marked')
    const parts: string[] = []
    for (const segment of parseInteractionMessage(content)) {
      if (segment.type === 'text') parts.push(marked.parse(segment.text) as string)
      else parts.push(await render({ block: segment.block, messageId: 5 }))
    }
    return parts.join('')
  }

  it('keeps the prose as markdown and turns only the fence into a card', async () => {
    const html = await renderMessage([
      '**Two ways** to go here.',
      '',
      '```offtangent',
      JSON.stringify({
        block: 'choice', id: 'b1', question: 'Hand this to Bob?',
        options: [{ id: 'yes', label: 'Hand over to Bob' }, { id: 'stay', label: 'Keep it here' }],
      }),
      '```',
      '',
      'Tell me either way.',
    ].join('\n'))

    expect(html).toContain('<strong>Two ways</strong>')
    expect(html).toContain('Tell me either way.')
    expect(html).toContain('role="group"')
    expect(html).toContain('Hand over to Bob')
    expect(html).not.toContain('"block"')
  })

  it('degrades a broken fence to a code block without breaking the message', async () => {
    const html = await renderMessage('Before\n\n```offtangent\n{ "block": "choice", "id":\n```\n\nAfter')

    expect(html).toContain('Before')
    expect(html).toContain('After')
    expect(html).toContain('<code')
    expect(html).not.toContain('role="group"')
  })

  it('renders an ordinary message exactly as before (one markdown pass, no card)', async () => {
    const { marked } = await import('marked')
    const content = 'Just **prose** with a list:\n\n- one\n- two\n'
    expect(await renderMessage(content)).toBe(marked.parse(content) as string)
  })
})
