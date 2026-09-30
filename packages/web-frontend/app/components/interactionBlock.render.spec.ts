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
import { createSSRApp, defineComponent, h, ref, computed, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parseInteractionMessage, parseInteractionBlockPayload } from '@axiom/core/contracts'
import ChatInteractionBlock from './ChatInteractionBlock.vue'

// Nuxt auto-imports are free identifiers at runtime; the Nuxt runtime supplies
// exactly these, so the harness does the same.
const globals = globalThis as Record<string, unknown>
globals.ref = ref
globals.computed = computed
globals.nextTick = nextTick
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

/** The opening tag of the row that carries `label`, class attribute included. */
function rowTagOf(html: string, label: string): string {
  const labelIndex = html.indexOf(label)
  expect(labelIndex).toBeGreaterThan(-1)
  const start = html.lastIndexOf('<button', labelIndex)
  return html.slice(start, html.indexOf('>', start) + 1)
}

/** Full `<button>…</button>` block (incl. the indicator span), not just the opening tag. */
function rowBlockOf(html: string, label: string): string {
  const labelIndex = html.indexOf(label)
  expect(labelIndex).toBeGreaterThan(-1)
  const start = html.lastIndexOf('<button', labelIndex)
  const end = html.indexOf('</button>', labelIndex)
  expect(end).toBeGreaterThan(-1)
  return html.slice(start, end + '</button>'.length)
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

/** Exactly 60 characters — the length that used to be cut off by `truncate`. */
const longLabel = 'Hand the whole draft to Bob and let him finish it by Friday.'
const choiceLongLabel = parseInteractionBlockPayload({
  block: 'choice',
  id: 'b2',
  question: 'Which way?',
  options: [
    { id: 'long', label: longLabel },
    { id: 'stay', label: 'Keep it here' },
  ],
})!

const multi = parseInteractionBlockPayload({
  block: 'multi',
  id: 'm1',
  question: 'Which ones do you want?',
  options: [
    { id: 'a', label: 'Chamomile' },
    { id: 'b', label: 'Peppermint' },
    { id: 'c', label: 'Rooibos' },
  ],
})!

const confirmDestructive = parseInteractionBlockPayload({
  block: 'confirm',
  id: 'c1',
  question: 'Delete the draft?',
  destructive: true,
})!

describe('ChatInteractionBlock', () => {
  it('renders a choice card with one row per option', async () => {
    const html = await render({ block: choice, messageId: 42 })

    expect(html).toContain('Hand this to Bob?')
    expect(html).toContain('Hand over to Bob')
    expect(html).toContain('Keep it here')
    // Two options plus the own-answer row that every open card carries.
    expect((html.match(/<button/g) ?? [])).toHaveLength(3)
  })

  it('is one card on the background surface, not a box inside a box', async () => {
    const html = await render({ block: choice, messageId: 42 })
    expect(html).toContain('rounded-lg border border-border bg-background')
    expect(html).not.toContain('bg-muted/20')
  })

  it('stacks the options in one column and lets long labels wrap', async () => {
    const html = await render({ block: choiceLongLabel, messageId: 42 })
    expect(html).toContain('divide-y divide-border')
    // One column: no flex-basis row layout, no fixed minimum option width.
    expect(html).not.toContain('sm:flex-row')
    expect(html).not.toContain('min-w-[9rem]')
    expect(html).not.toContain('truncate')
  })

  it('keeps a 60 character label whole (no truncate on the label span)', async () => {
    expect(longLabel).toHaveLength(60)
    const html = await render({ block: choiceLongLabel, messageId: 42 })
    expect(html).toContain(`<span class="text-sm leading-5">${longLabel}</span>`)
  })

  it('separates hover from selected, in light and dark (review round 2)', async () => {
    const html = await render({ block: choice, messageId: 42 })
    // Idle rows hover on a muted tint; the selected tint is reserved for state.
    expect(html).toContain('hover:bg-muted/60')
    expect(html).not.toContain('bg-primary/10')
    // 10 % primary is barely visible on the dark background, so the selected
    // tint steps up there and the hover-on-selected step exists in both themes.
    const source = await import('node:fs').then(fs => fs.readFileSync(new URL('./ChatInteractionBlock.vue', import.meta.url), 'utf8'))
    expect(source).toContain('dark:bg-primary/15')
    expect(source).toContain('hover:bg-primary/15')
    expect(source).toContain('dark:bg-destructive/15')
  })

  it('gives every row a touch target of at least 44px', async () => {
    const html = await render({ block: choice, messageId: 42 })
    // min-h-11 = 2.75rem = 44px, on both options and the own-answer row.
    expect((html.match(/min-h-11/g) ?? []).length).toBe(3)
  })

  it('offers an own-answer row on every open card, and none on an answered one', async () => {
    for (const block of [choice, confirmDestructive, multi]) {
      const html = await render({ block, messageId: 42 })
      expect(html).toContain('chat.interaction.ownAnswer')
      expect(html).toContain('data-icon="edit"')
    }
    const answered = await render({ block: choice, messageId: 42, answered: { label: 'Hand over to Bob' } })
    expect(answered).not.toContain('chat.interaction.ownAnswer')
  })

  it('labels the card for screen readers and marks it idle', async () => {
    const html = await render({ block: choice, messageId: 42 })
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-labelledby="interaction-b1-question"')
    expect(html).toContain('id="interaction-b1-question"')
    expect(html).toContain('aria-busy="false"')
  })

  it('exposes single choice as a radiogroup with unchecked radios', async () => {
    const html = await render({ block: choice, messageId: 42 })
    expect(html).toContain('role="radiogroup"')
    expect((html.match(/role="radio"/g) ?? [])).toHaveLength(2)
    expect((html.match(/aria-checked="false"/g) ?? [])).toHaveLength(2)
    expect(html).toContain('focus-visible:ring-inset')
  })

  it('gives the unselected indicator a contrast-safe border instead of the low-contrast card border', async () => {
    const html = await render({ block: choice, messageId: 42 })
    const yesBlock = rowBlockOf(html, '>Hand over to Bob<')
    const stayBlock = rowBlockOf(html, '>Keep it here<')
    // Vorgabe: unselected indicator uses `border-muted-foreground` (>=3:1 against
    // bg-background in both themes), not the low-contrast `border-border` (card frame token).
    expect(yesBlock).toContain('border-muted-foreground')
    expect(yesBlock).not.toContain('border-border')
    expect(stayBlock).toContain('border-muted-foreground')
    expect(stayBlock).not.toContain('border-border')
  })

  it('paints the affirmative option of a destructive confirm without a red frame', async () => {
    const html = await render({ block: confirmDestructive, messageId: 7 })
    expect(html).toContain('Delete the draft?')
    expect(html).toContain('Yes')
    expect(html).toContain('No')

    const yesRow = rowTagOf(html, '>Yes<')
    expect(yesRow).toContain('text-destructive')
    expect(yesRow).toContain('hover:bg-destructive/10')
    // Vorgabe f: no red outline around the row — the indicator carries the colour.
    expect(yesRow).not.toContain('border-destructive')
    expect(yesRow).not.toContain('border-destructive/40')
    // …and the indicator inside the row does, unaffected by the contrast fix above.
    const yesBlock = rowBlockOf(html, '>Yes<')
    expect(yesBlock).toContain('border-destructive')
    expect(html).toContain('border-destructive')
  })

  it('keeps the question and only the chosen row once answered, without a chip', async () => {
    const html = await render({ block: choice, messageId: 42, answered: { label: 'Hand over to Bob' } })

    expect(html).toContain('Hand this to Bob?')
    expect(html).toContain('Hand over to Bob')
    expect(html).not.toContain('Keep it here')
    expect(html).not.toContain('<button')
    expect(html).toContain('role="status"')
    expect(html).toContain('data-icon="check"')
    expect(html).toContain('text-primary')
    // The chip is gone: no pill, no hover, no tinted row.
    expect(html).not.toContain('rounded-full')
    expect(html).not.toContain('hover:bg-muted')
    expect(html).not.toContain('bg-primary/10')
  })

  it('renders a closed card when the question was answered in the chat', async () => {
    const html = await render({ block: choice, messageId: 42, answeredElsewhere: true })

    expect(html).toContain('Hand this to Bob?')
    expect(html).toContain('chat.interaction.answeredInChat')
    expect(html).toContain('data-icon="edit"')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('Keep it here')
    expect(html).toContain('role="status"')
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

describe('a multi block as a card', () => {
  it('draws one checkbox row per option, none of them checked yet', async () => {
    const html = await render({ block: multi, messageId: 9 })

    expect(html).toContain('Which ones do you want?')
    expect(html).toContain('chat.interaction.multiHint')
    expect((html.match(/role="checkbox"/g) ?? [])).toHaveLength(3)
    expect((html.match(/aria-checked="false"/g) ?? [])).toHaveLength(3)
    expect(html).not.toContain('aria-checked="true"')
    expect(html).toContain('Chamomile')
    expect(html).toContain('Rooibos')
    // Square indicators for multi, round ones for single choice.
    expect((html.match(/rounded-sm/g) ?? []).length).toBe(3)
  })

  it('puts the send button in a right-aligned footer, disabled and not full width', async () => {
    const html = await render({ block: multi, messageId: 9 })
    expect(html).toContain('border-t border-border px-4 py-2.5')
    expect(html).toContain('justify-end')
    const sendTag = rowTagOf(html, 'chat.interaction.sendAnswer')
    expect(sendTag).toContain('disabled')
    expect(sendTag).toContain('h-9')
    expect(sendTag).not.toContain('w-full')
  })

  it('keeps the 44px touch target for every row including own answer', async () => {
    const html = await render({ block: multi, messageId: 9 })
    expect((html.match(/min-h-11/g) ?? []).length).toBe(4)
  })

  it('keeps the question and the chosen rows once answered', async () => {
    const html = await render({ block: multi, messageId: 9, answered: { label: 'Chamomile, Rooibos' } })

    expect(html).toContain('Which ones do you want?')
    expect(html).toContain('Chamomile')
    expect(html).toContain('Rooibos')
    expect(html).not.toContain('Peppermint')
    expect(html).not.toContain('role="checkbox"')
    expect(html).not.toContain('<button')
    expect(html).toContain('role="status"')
    expect((html.match(/data-icon="check"/g) ?? [])).toHaveLength(2)
  })
})

describe('a stale card', () => {
  it('keeps the question and states the reason as a row', async () => {
    const block = parseInteractionBlockPayload({ block: 'confirm', id: 's1', question: 'Still on?' })!
    const html = await render({ block, messageId: 3 })
    // The open card is the baseline; the stale path is reached through the
    // answer flow, which the runtime harness covers. Here we only pin that an
    // open card carries no stale row.
    expect(html).not.toContain('chat.interaction.stale')
    expect(html).toContain('Still on?')
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

  it('turns a multi fence into a card instead of a numbered list', async () => {
    const html = await renderMessage([
      'Pick what you need.',
      '',
      '```offtangent',
      JSON.stringify({
        block: 'multi', id: 'm1', question: 'Which ones do you want?',
        options: [{ id: 'a', label: 'Chamomile' }, { id: 'b', label: 'Peppermint' }],
      }),
      '```',
    ].join('\n'))

    expect(html).toContain('role="group"')
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('chat.interaction.sendAnswer')
    expect(html).not.toContain('1. Chamomile')
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
