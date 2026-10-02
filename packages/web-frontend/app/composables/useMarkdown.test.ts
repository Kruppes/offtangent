import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderSafeMarkdown, useMarkdown, writeClipboardText } from './useMarkdown'

describe('useMarkdown', () => {
  it('renders markdown links with target=_blank and safe rel attributes', () => {
    const { renderMarkdown } = useMarkdown()

    const html = renderMarkdown('[OpenAI](https://openai.com)')

    expect(html).toContain('href="https://openai.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

describe('code blocks and clipboard', () => {
  it('renders language and copy controls without interpreting code as HTML', () => {
    const html = useMarkdown().renderMarkdown('```ts\nconst a = "<script>&"\n```')
    expect(html).toContain('data-language="ts"')
    expect(html).toContain('data-code-copy-button="true"')
    expect(html).toContain('aria-label="Copy code"')
    expect(html).toContain('class="language-ts"')
    expect(html).toContain('const a = &quot;&lt;script&gt;&amp;&quot;\n')
    expect(html).not.toContain('<script>')
  })
  it('handles a streaming, unclosed fence and unknown language safely', () => {
    const html = useMarkdown().renderMarkdown('```\npartial <tag>')
    expect(html).toContain('data-language="code"')
    expect(html).toContain('partial &lt;tag&gt;\n')
  })
})


describe('clipboard writes', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('copies exact plain code, preserving indentation and newlines', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const code = '  <tag> & "quoted"\n\treturn false\n'
    expect(await writeClipboardText(code)).toBe(true)
    expect(writeText).toHaveBeenCalledWith(code)
  })
  it('handles clipboard denial and unavailable clipboard without rejecting', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    expect(await writeClipboardText('code')).toBe(false)
    vi.stubGlobal('navigator', {})
    expect(await writeClipboardText('code')).toBe(false)
  })
  it('delegates nested copy icon clicks to the containing code block only', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    // Minimal DOM doubles: exercise event delegation without a browser dependency.
    class ElementDouble { closest(_selector: string): unknown { return null } }
    class PreDouble extends ElementDouble { textContent = '<plain>\n' }
    const pre = new PreDouble()
    class ButtonDouble extends ElementDouble {
      override closest() { return { querySelector: () => pre } }
    }
    const button = new ButtonDouble()
    class IconDouble extends ElementDouble { override closest() { return button } }
    vi.stubGlobal('Element', ElementDouble)
    vi.stubGlobal('HTMLButtonElement', ButtonDouble)
    vi.stubGlobal('HTMLPreElement', PreDouble)
    const event = { target: new IconDouble(), preventDefault: vi.fn(), stopPropagation: vi.fn() }
    useMarkdown().handleMarkdownCodeCopy(event as unknown as MouseEvent)
    expect(writeText).toHaveBeenCalledWith('<plain>\n')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    writeText.mockClear()
    useMarkdown().handleMarkdownCodeCopy({ ...event, target: new ElementDouble() } as unknown as MouseEvent)
    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('safe renderer for agent-published text (feed bodies, boards)', () => {
  const { renderMarkdown } = useMarkdown()

  it('keeps the chat renderer behaviour untouched, including its raw HTML pass-through', () => {
    // Documents *why* board/feed text needs a stricter renderer: the chat
    // renderer deliberately passes raw HTML through (chat content is authored
    // by the user in this app), so it cannot be reused for LLM/scraped text.
    const html = renderMarkdown('<b>x</b>\n\n[y](javascript:alert(1))')
    expect(html).toContain('<b>x</b>')
    expect(html).toContain('href="javascript:alert(1)"')
  })

  it('is strictly stricter than the chat renderer on HTML, scripts and link schemes', () => {
    const attacks = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<iframe src="https://evil.example.com"></iframe>',
      '<div onclick="alert(1)">t</div>',
      '[a](javascript:alert(1))',
      '[b](data:text/html;base64,PHNjcmlwdD4=)',
      '[c](vbscript:msgbox)',
      '![d](javascript:alert(1))',
      '<a href="javascript:alert(1)">e</a>',
      '<!-- <script>alert(1)</script> -->',
      // Bypass vectors from the adversarial review: entity-encoded schemes,
      // attribute breakouts, autolinks, reference links, mixed case, and
      // schemes that are not http(s).
      '[a](javascript&#58;alert(1))',
      '[a](javascript&colon;alert(1))',
      '[a](https://ok.example.com "y" onmouseover="alert(1)")',
      '![img](https://ok.example.com/x.png "y" onerror="alert(1)")',
      '<https://x" onclick=alert(1)>',
      '[ref][r]\n\n[r]: javascript:alert(1)',
      '![ref][ri]\n\n[ri]: javascript:alert(1)',
      '```js">\ncode\n```',
      '<!--><script>alert(1)</script>-->',
      '<!-- --><img src=x onerror=alert(1)>',
      '<ScRiPt>alert(1)</ScRiPt>',
      '<IMG SRC="jAvAsCrIpT:alert(1)">',
      '[a](//evil.example.com)',
      '![d](data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+)',
      '[d](data:image/png;base64,iVBORw0KGgo=)',
      '<style>body{background:url(javascript:alert(1))}</style>',
      'www.example.com/?a=" onclick="alert(1)',
      '| <script>alert(1)</script> |\n| - |\n| <img src=x onerror=alert(1)> |',
      '# <script>alert(1)</script>',
      '- [ ] <script>alert(1)</script>',
    ]
    // Inspect the real tags of the output: raw HTML from the input must never
    // become a tag, and no tag may carry an event handler or a non-http href.
    const allowed = new Set(['p', '/p', 'strong', '/strong', 'em', '/em', 'ul', '/ul', 'li', '/li', 'ol', '/ol', 'a', '/a', 'br', 'code', '/code', 'pre', '/pre', 'div', '/div', 'span', '/span', 'button', '/button', 'svg', '/svg', 'rect', '/rect', 'path', '/path', 'table', '/table', 'thead', '/thead', 'tbody', '/tbody', 'tr', '/tr', 'th', '/th', 'td', '/td', 'input', 'hr', 'blockquote', '/blockquote', 'h1', '/h1', 'h2', '/h2', 'h3', '/h3', 'h4', '/h4', 'h5', '/h5', 'h6', '/h6'])
    for (const attack of attacks) {
      const safe = renderSafeMarkdown(attack)
      const tags = [...safe.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)]
      for (const [raw, name, attrs] of tags) {
        expect(allowed.has(`${raw.startsWith('</') ? '/' : ''}${name!.toLowerCase()}`), `${attack} -> ${raw}`).toBe(true)
        expect(attrs!.toLowerCase(), `${attack} -> ${raw}`).not.toMatch(/\son[a-z]+\s*=/)
        const href = /href="([^"]*)"/i.exec(attrs!)
        if (href) expect(href[1], `${attack} -> ${raw}`).toMatch(/^https?:\/\//i)
        const src = /src="([^"]*)"/i.exec(attrs!)
        if (src) expect(src[1], `${attack} -> ${raw}`).toMatch(/^https?:\/\//i)
        // No real tag may carry a dangerous scheme in ANY attribute, not just
        // in the href/src the checks above look at.
        expect(raw.toLowerCase(), `${attack} -> ${raw}`).not.toMatch(/javascript:|vbscript:|data:/)
      }
      expect(safe, attack).not.toMatch(/<script|<iframe|<img|<style|<object|<embed/i)
    }
  })

  it('escapes raw HTML inside emphasis, links and lists instead of dropping the text', () => {
    expect(renderSafeMarkdown('**<script>x</script>**')).toContain('<strong>&lt;script&gt;x&lt;/script&gt;</strong>')
    expect(renderSafeMarkdown('[<script>x</script>](https://ok.example.com)')).toContain('>&lt;script&gt;x&lt;/script&gt;</a>')
    expect(renderSafeMarkdown('- <b>item</b>')).toContain('<li>&lt;b&gt;item&lt;/b&gt;</li>')
  })

  it('inherits the chat options and the chat code-block renderer', () => {
    const html = renderSafeMarkdown('```ts\nconst a = "<script>&"\n```')
    expect(html).toContain('data-language="ts"')
    expect(html).toContain('data-code-copy-button="true"')
    expect(html).toContain('const a = &quot;&lt;script&gt;&amp;&quot;\n')
    // `breaks: true` and `gfm: true` are module-level marked options, shared.
    expect(renderSafeMarkdown('a\nb')).toContain('<br>')
    expect(renderSafeMarkdown('| a |\n| - |\n| 1 |')).toContain('<table>')
  })

  it('renders http(s) links exactly like chat does, with the same rel/target', () => {
    const safe = renderSafeMarkdown('[OpenAI](https://openai.com)')
    expect(safe).toContain('href="https://openai.com"')
    expect(safe).toContain('target="_blank"')
    expect(safe).toContain('rel="noopener noreferrer"')
  })

  it('returns an empty string for empty input', () => {
    expect(renderSafeMarkdown('')).toBe('')
    expect(renderSafeMarkdown(null)).toBe('')
    expect(renderSafeMarkdown(undefined)).toBe('')
  })
})

describe('tables in their own scroll container', () => {
  const table = '| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n| beta | 22 |'

  it('wraps every chat table in one focusable .table-scroll element', () => {
    const { renderMarkdown } = useMarkdown()
    const html = renderMarkdown(`Intro\n\n${table}\n\nOutro`)
    expect(html.match(/<div class="table-scroll" tabindex="0"><table>/g)).toHaveLength(1)
    expect(html).toContain('</table>\n</div>')
    // The table itself is still the ordinary marked output.
    expect(html).toContain('<th>Name</th>')
    expect(html).toContain('<th align="right">Value</th>')
    expect(html).toContain('<td align="right">22</td>')
    expect(html).toContain('<p>Outro</p>')
  })

  it('wraps tables of the safe renderer too and keeps escaping their cells', () => {
    const html = renderSafeMarkdown('| a | b |\n| - | - |\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |')
    expect(html).toContain('<div class="table-scroll" tabindex="0"><table>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('javascript:')
  })
})

describe('code blocks are keyboard scrollable', () => {
  it('makes the scrolling pre of a fenced block focusable, still escaped', () => {
    const html = useMarkdown().renderMarkdown('```ts\nconst wide = "<b>' + 'x'.repeat(200) + '</b>"\n```')
    expect(html).toContain('<pre tabindex="0"><code class="language-ts">')
    expect(html).not.toContain('<b>')
  })
})
