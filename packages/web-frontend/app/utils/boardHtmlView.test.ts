/**
 * Embedding rules for an `html_view.v1` board.
 *
 * The document is skill written HTML, so the interesting cases are the ones
 * where the frame must stay empty: a URL that does not point at the board
 * content route, an access token smuggled next to the capability token, a
 * `javascript:` src. None of these can be caught by a screenshot, so they are
 * pinned here.
 */
import { describe, it, expect } from 'vitest'
import type { BoardContentRef } from '~/api/boards'
import { BOARD_LINK_MAX_LENGTH, HTML_VIEW_SANDBOX, boardLinkFromMessage, htmlViewHeight, htmlViewSrc } from './boardHtmlView'

function ref(overrides: Partial<BoardContentRef> = {}): BoardContentRef {
  return {
    url: '/api/boards/wheel-demo/content?t=b1.wheel-demo.0.1.9999999999.sig',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    embed: {
      iframeSandbox: 'allow-scripts',
      iframeReferrerPolicy: 'no-referrer',
      separateOrigin: false,
      denies: ['same-origin', 'cookies', 'localStorage', 'network', 'top-navigation'],
    },
    supportsTheme: false,
    aspectRatio: null,
    minHeightPx: null,
    ...overrides,
  }
}

describe('htmlViewSrc', () => {
  it('keeps the minted content URL as it is', () => {
    const src = htmlViewSrc(ref(), false)
    expect(src).not.toBeNull()
    const url = new URL(src!)
    expect(url.pathname).toBe('/api/boards/wheel-demo/content')
    expect(url.searchParams.get('t')).toBe('b1.wheel-demo.0.1.9999999999.sig')
    // No theme hint for a page that did not declare support for one.
    expect(url.searchParams.has('theme')).toBe(false)
  })

  it('appends the theme hint only when the page declared support', () => {
    const dark = new URL(htmlViewSrc(ref({ supportsTheme: true }), true)!)
    expect(dark.searchParams.get('theme')).toBe('dark')
    const light = new URL(htmlViewSrc(ref({ supportsTheme: true }), false)!)
    expect(light.searchParams.get('theme')).toBe('light')
  })

  it('accepts a revision content URL, so history shows the document of that revision', () => {
    const src = htmlViewSrc(ref({ url: '/api/boards/wheel-demo/revisions/3/content?t=tok' }), false)
    expect(new URL(src!).pathname).toBe('/api/boards/wheel-demo/revisions/3/content')
  })

  it('refuses anything that is not a board content URL with a capability token', () => {
    expect(htmlViewSrc(undefined, false)).toBeNull()
    expect(htmlViewSrc(ref({ url: '' }), false)).toBeNull()
    // Not the content route.
    expect(htmlViewSrc(ref({ url: '/api/boards/wheel-demo?t=tok' }), false)).toBeNull()
    expect(htmlViewSrc(ref({ url: '/api/artifacts/7/content?t=tok' }), false)).toBeNull()
    // No capability token.
    expect(htmlViewSrc(ref({ url: '/api/boards/wheel-demo/content' }), false)).toBeNull()
    // An access token next to the document would be readable by the document.
    expect(htmlViewSrc(ref({ url: '/api/boards/wheel-demo/content?t=tok&token=jwt' }), false)).toBeNull()
    // Script and data URLs never become a frame src.
    expect(htmlViewSrc(ref({ url: 'javascript:alert(1)' }), false)).toBeNull()
    expect(htmlViewSrc(ref({ url: 'data:text/html,<script>alert(1)</script>' }), false)).toBeNull()
    // Credentials in the URL.
    expect(htmlViewSrc(ref({ url: 'http://u:p@host/api/boards/x/content?t=tok' }), false)).toBeNull()
  })

  it('never offers same-origin to the frame', () => {
    expect(HTML_VIEW_SANDBOX).toBe('allow-scripts')
    expect(HTML_VIEW_SANDBOX).not.toContain('same-origin')
  })
})

describe('htmlViewHeight', () => {
  it('falls back to a usable default without hints', () => {
    expect(htmlViewHeight(ref(), 0)).toBe(320)
    expect(htmlViewHeight(undefined, 800)).toBe(320)
  })

  it('honours a minimum height hint', () => {
    expect(htmlViewHeight(ref({ minHeightPx: 540 }), 0)).toBe(540)
  })

  it('derives the height from the aspect ratio and the measured width', () => {
    expect(htmlViewHeight(ref({ aspectRatio: 1 }), 600)).toBe(600)
    expect(htmlViewHeight(ref({ aspectRatio: 2 }), 600)).toBe(300)
  })

  it('clamps an absurd result', () => {
    expect(htmlViewHeight(ref({ aspectRatio: 0.1 }), 100000)).toBe(4000)
    expect(htmlViewHeight(ref({ aspectRatio: 10 }), 100)).toBe(120)
  })
})

/**
 * The receiving half of the link bridge. The document is hostile by
 * assumption, so every case that must NOT open a window is pinned here.
 */
describe('boardLinkFromMessage', () => {
  const frame = { name: 'board-frame' }
  const link = (url: unknown, type: unknown = 'offtangent.open-link') => ({ data: { type, url }, source: frame })

  it('accepts an https link from our own frame', () => {
    expect(boardLinkFromMessage(link('https://example.com/a?b=1'), frame)).toBe('https://example.com/a?b=1')
  })

  it('accepts http as well', () => {
    expect(boardLinkFromMessage(link('http://example.com/'), frame)).toBe('http://example.com/')
  })

  it('ignores a message from any other window', () => {
    expect(boardLinkFromMessage(link('https://example.com/'), { name: 'other' })).toBeNull()
    expect(boardLinkFromMessage({ data: { type: 'offtangent.open-link', url: 'https://example.com/' }, source: undefined }, frame)).toBeNull()
    expect(boardLinkFromMessage(link('https://example.com/'), null)).toBeNull()
  })

  it('ignores another message type', () => {
    expect(boardLinkFromMessage(link('https://example.com/', 'offtangent.open-link '), frame)).toBeNull()
    expect(boardLinkFromMessage(link('https://example.com/', 'resize'), frame)).toBeNull()
    expect(boardLinkFromMessage({ data: 'offtangent.open-link', source: frame }, frame)).toBeNull()
    expect(boardLinkFromMessage({ data: null, source: frame }, frame)).toBeNull()
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'blob:https://example.com/1234',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'about:blank',
    '/relative/path',
    'not a url',
    '',
  ])('refuses %j', url => {
    expect(boardLinkFromMessage(link(url), frame)).toBeNull()
  })

  it('refuses a url longer than the limit', () => {
    expect(boardLinkFromMessage(link(`https://example.com/${'a'.repeat(BOARD_LINK_MAX_LENGTH)}`), frame)).toBeNull()
  })

  it('refuses a non-string url', () => {
    expect(boardLinkFromMessage(link(42), frame)).toBeNull()
    expect(boardLinkFromMessage(link(undefined), frame)).toBeNull()
  })

  // `https://trusted.example@evil.example/` reads as the trusted host but opens
  // the other one; a board has no reason to carry credentials in a link.
  it.each([
    'https://trusted.example@evil.example/',
    'https://user:secret@example.com/',
    'https://:secret@example.com/',
  ])('refuses a url with credentials %j', url => {
    expect(boardLinkFromMessage(link(url), frame)).toBeNull()
  })

  // Activation of a click inside the frame propagates to the host, so a message
  // without it was sent by a script on its own and must not open a window.
  it('refuses a link when the host reports no user activation', () => {
    expect(boardLinkFromMessage(link('https://example.com/'), frame, { isActive: false })).toBeNull()
    expect(boardLinkFromMessage(link('https://example.com/'), frame, { isActive: true })).toBe('https://example.com/')
  })

  it('does not require activation where the browser cannot report it', () => {
    expect(boardLinkFromMessage(link('https://example.com/'), frame, undefined)).toBe('https://example.com/')
  })
})
