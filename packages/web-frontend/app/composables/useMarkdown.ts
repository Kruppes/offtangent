import { marked, type Tokens } from 'marked'
import TurndownService from 'turndown'

// Configure marked for clean, minimal output
marked.setOptions({
  breaks: true,
  gfm: true,
})

const renderer = new marked.Renderer()

function escapeHtml(value: string, encode = false): string {
  const pattern = encode
    ? /[&<>"']/g
    : /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g

  return value.replace(pattern, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return char
    }
  })
}

function codeLanguageLabel(lang?: string): string {
  return lang?.match(/^\S*/)?.[0] || 'code'
}

renderer.link = ({ href, title, tokens }) => {
  const text = marked.Parser.parseInline(tokens)
  const safeHref = href || ''
  const titleAttr = title ? ` title="${title}"` : ''

  return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
}

renderer.code = ({ text, lang, escaped }: Tokens.Code) => {
  const language = codeLanguageLabel(lang)
  const languageAttr = language === 'code' ? '' : ` class="language-${escapeHtml(language)}"`
  const code = `${text.replace(/\n$/, '')}\n`
  const escapedCode = escaped ? code : escapeHtml(code, true)
  const escapedLanguage = escapeHtml(language)

  return `<div class="code-block-wrapper" data-language="${escapedLanguage}">`
    + '<div class="code-block-header" data-code-block-header="true">'
    + `<span class="code-block-language">${escapedLanguage}</span>`
    + '<button type="button" class="code-block-copy-button" data-code-copy-button="true" aria-label="Copy code" title="Copy code">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>'
    + '</svg>'
    + '</button>'
    + '</div>'
    + `<pre><code${languageAttr}>${escapedCode}</code></pre>`
    + '</div>\n'
}

// Configure turndown for HTML → Markdown conversion (used on copy)
const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
})

function closestPre(container: Node): HTMLPreElement | null {
  const element = container instanceof HTMLElement ? container : container.parentElement
  return element?.closest('pre') ?? null
}

export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // A denied clipboard permission must not become an unhandled rejection.
    return false
  }
}

/**
 * Render markdown string to HTML and provide copy-as-markdown support.
 */
export function useMarkdown() {
  function renderMarkdown(text: string): string {
    if (!text) return ''
    const html = marked.parse(text, { renderer }) as string
    return html
  }

  /**
   * Attach to a container element to intercept copy events inside `.prose-chat`
   * and place the markdown equivalent into the clipboard.
   */
  function handleCopyAsMarkdown(event: ClipboardEvent) {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    // Check if the selection is inside (or overlaps) a .prose-chat element
    const range = selection.getRangeAt(0)
    const ancestor = range.commonAncestorContainer
    const proseEl =
      ancestor instanceof HTMLElement
        ? ancestor.closest('.prose-chat') ?? ancestor.querySelector('.prose-chat')
        : ancestor.parentElement?.closest('.prose-chat')

    if (!proseEl) return // Not inside rendered markdown — let default copy work

    // Selection inside a code block: default copy already yields exactly the
    // selected plain text — no markdown conversion wanted.
    if (closestPre(ancestor)) return

    // Clone the selected fragment and convert HTML → Markdown
    const fragment = range.cloneContents()
    const wrapper = document.createElement('div')
    wrapper.appendChild(fragment)
    wrapper.querySelectorAll('[data-code-block-header="true"]').forEach((el) => el.remove())

    const md = turndown.turndown(wrapper.innerHTML)

    event.preventDefault()
    event.clipboardData?.setData('text/plain', md)
    // Also keep the HTML version for rich-paste targets
    event.clipboardData?.setData('text/html', wrapper.innerHTML)
  }

  function handleMarkdownCodeCopy(event: MouseEvent) {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-code-copy-button="true"]')
    if (!(button instanceof HTMLButtonElement)) return

    const wrapper = button.closest('.code-block-wrapper')
    const pre = wrapper?.querySelector('pre')
    if (!(pre instanceof HTMLPreElement)) return

    event.preventDefault()
    event.stopPropagation()
    void writeClipboardText(pre.textContent ?? '')
  }

  return { renderMarkdown, handleCopyAsMarkdown, handleMarkdownCodeCopy }
}
