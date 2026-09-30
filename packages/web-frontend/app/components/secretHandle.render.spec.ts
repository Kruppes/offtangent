/**
 * Render tests for sealed secret handles in the chat (plan 2026-09-26, T4).
 *
 * Covered here:
 *  - the markdown path (assistant text) turns `{{secret:<slug>}}` into a chip
 *  - the plain-text path (user/system bubbles) does the same without v-html
 *  - an XSS attempt right next to a handle stays inert
 *
 * No real secret appears in this file; the handles are slugs only.
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SecretHandleText from './SecretHandleText.vue'
import { useMarkdown } from '../composables/useMarkdown'
import { countSecretHandles, splitSecretHandles } from '../utils/secretHandles'

const { renderMarkdown } = useMarkdown()

async function renderPlain(text: string): Promise<string> {
  const app = createSSRApp({ render: () => h(SecretHandleText, { text }) })
  return renderToString(app)
}

describe('markdown handle chip', () => {
  it('renders a chip instead of the raw handle', () => {
    const html = renderMarkdown('use {{secret:router-password}} to log in')
    expect(html).toContain('class="secret-chip"')
    expect(html).toContain('data-secret-chip="router-password"')
    expect(html).toContain('router-password')
    expect(html).not.toContain('{{secret:router-password}}</p>')
    // Focusable and explained on hover/focus.
    expect(html).toContain('tabindex="0"')
    expect(html).toMatch(/title="[^"]*\(\{\{secret:router-password\}\}\)"/)
    expect(html).toMatch(/aria-label="[^"]*router-password/)
  })

  it('renders several handles and keeps surrounding markdown intact', () => {
    const html = renderMarkdown('**a** {{secret:token-1}} and {{secret:token-2}}')
    expect(html).toContain('<strong>a</strong>')
    expect(html.match(/data-secret-chip="token-/g)).toHaveLength(2)
  })

  it('leaves an invalid handle alone', () => {
    const html = renderMarkdown('{{secret:UPPER}} and {{secret:}} and {{ secret:x }}')
    expect(html).not.toContain('secret-chip')
    expect(html).toContain('{{secret:UPPER}}')
  })

  it('keeps a handle inside a code span literal', () => {
    const html = renderMarkdown('`{{secret:router-password}}`')
    expect(html).toContain('<code>{{secret:router-password}}</code>')
    expect(html).not.toContain('secret-chip')
  })

  it('does not execute script markup that sits next to a handle', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> {{secret:router-password}} <script>alert(2)</script>')
    expect(html).toContain('data-secret-chip="router-password"')
    // The chip itself introduces no attacker-controlled attribute value.
    expect(html).not.toContain('onerror="alert(1)" data-secret-chip')
    // A handle-looking string inside an attribute must not become markup.
    const inAttribute = renderMarkdown('[link](https://example.test/{{secret:router-password}})')
    expect(inAttribute).not.toMatch(/href="[^"]*<span/)
  })
})

describe('plain-text handle chip', () => {
  it('renders the chip in a user bubble without v-html', async () => {
    const html = await renderPlain('my pin is {{secret:pin-1}} ok')
    expect(html).toContain('data-secret-chip="pin-1"')
    expect(html).toContain('my pin is')
    expect(html).not.toContain('{{secret:pin-1}}<')
  })

  it('escapes text that looks like markup', async () => {
    const html = await renderPlain('<script>alert(1)</script> {{secret:pin-1}}')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('data-secret-chip="pin-1"')
  })
})

describe('handle helpers', () => {
  it('splits text into parts', () => {
    expect(splitSecretHandles('a {{secret:x-1}} b')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'handle', slug: 'x-1' },
      { type: 'text', text: ' b' },
    ])
  })

  it('counts handles', () => {
    expect(countSecretHandles('{{secret:a-1}} {{secret:a-1}} {{secret:b-2}}')).toBe(3)
    expect(countSecretHandles('nothing here')).toBe(0)
    expect(countSecretHandles('')).toBe(0)
  })
})
