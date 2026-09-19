import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMarkdown, writeClipboardText } from './useMarkdown'

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
