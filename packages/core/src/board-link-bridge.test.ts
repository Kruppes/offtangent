/**
 * The bridge is the only code the server adds to a foreign document, so the
 * test pins the two properties that make it safe: it stays out of the way
 * when the document is NOT framed (the Android WebView case, where the app
 * intercepts the navigation itself), and it forwards nothing but http(s).
 *
 * The behaviour is checked by EXECUTING the served script source against a
 * minimal DOM stub — the repo has no jsdom, and asserting on the source text
 * would prove nothing about what the browser does. The stub implements only
 * what the script touches: capture listeners on `document`, `event.target`,
 * `preventDefault`, the anchor chain and `window.parent.postMessage`.
 */
import { describe, it, expect } from 'vitest'
import {
  BOARD_LINK_BRIDGE_MARKER,
  BOARD_LINK_BRIDGE_SCRIPT,
  BOARD_OPEN_LINK_MESSAGE,
  injectBoardLinkBridge,
} from './board-link-bridge.js'

describe('injectBoardLinkBridge', () => {
  it('inserts the script before </body>', () => {
    const out = injectBoardLinkBridge('<!doctype html><html><head></head><body><p>x</p></body></html>')
    expect(out.indexOf(BOARD_LINK_BRIDGE_MARKER)).toBeGreaterThan(out.indexOf('<p>x</p>'))
    expect(out.indexOf(BOARD_LINK_BRIDGE_MARKER)).toBeLessThan(out.indexOf('</body>'))
  })

  it('falls back to </html>, then to the end of the document', () => {
    const withHtml = injectBoardLinkBridge('<html><p>x</p></html>')
    expect(withHtml.indexOf(BOARD_LINK_BRIDGE_MARKER)).toBeLessThan(withHtml.indexOf('</html>'))
    expect(injectBoardLinkBridge('<p>x</p>').startsWith('<p>x</p><script ')).toBe(true)
  })

  it('leaves the document otherwise byte identical', () => {
    const html = '<!doctype html><html><head><title>T</title></head><body><p>unchanged</p></body></html>'
    const out = injectBoardLinkBridge(html)
    const tag = /<script data-offtangent-link-bridge>[\s\S]*?<\/script>/.exec(out)
    expect(tag).not.toBeNull()
    expect(out.replace(tag![0], '')).toBe(html)
  })

  it('never injects twice', () => {
    const once = injectBoardLinkBridge('<body></body>')
    expect(injectBoardLinkBridge(once)).toBe(once)
  })
})

// --- a DOM small enough to read, real enough to run the script against ------

interface StubNode {
  nodeType: number
  tagName: string
  attributes: Record<string, string>
  getAttribute: (name: string) => string | null
  parentElement: StubNode | null
}

function element(tagName: string, attributes: Record<string, string> = {}): StubNode {
  return {
    nodeType: 1,
    tagName,
    attributes,
    getAttribute: name => attributes[name] ?? null,
    parentElement: null,
  }
}

interface StubEvent {
  type: string
  target: StubNode
  defaultPrevented: boolean
  button: number
  key?: string
  keyCode?: number
  preventDefault: () => void
}

function runBridge(framed: boolean) {
  const posted: unknown[] = []
  const listeners: { type: string; handler: (event: StubEvent) => void }[] = []
  const documentStub = {
    addEventListener: (type: string, handler: (event: StubEvent) => void) => { listeners.push({ type, handler }) },
    baseURI: 'https://api.example.test/api/boards/demo/content',
  }
  const windowStub: Record<string, unknown> = {
    postMessage: (message: unknown) => { posted.push(message) },
  }
  // Not framed = the document IS the top frame, exactly like the WebView case.
  windowStub.parent = framed ? { postMessage: (message: unknown) => { posted.push(message) } } : windowStub
  new Function('window', 'document', 'URL', BOARD_LINK_BRIDGE_SCRIPT)(windowStub, documentStub, URL)

  function dispatch(type: string, target: StubNode, extra: Partial<StubEvent> = {}): StubEvent {
    const event: StubEvent = {
      type,
      target,
      defaultPrevented: false,
      button: 0,
      preventDefault() { this.defaultPrevented = true },
      ...extra,
    }
    for (const listener of listeners) if (listener.type === type) listener.handler(event)
    return event
  }

  return { posted, dispatch }
}

function anchor(href: string): StubNode {
  return element('A', { href })
}

describe('the injected script', () => {
  it('posts an absolute https url to the parent and cancels the navigation', () => {
    const { posted, dispatch } = runBridge(true)
    const event = dispatch('click', anchor('https://example.com/a?b=1#c'))
    expect(posted).toEqual([{ type: BOARD_OPEN_LINK_MESSAGE, url: 'https://example.com/a?b=1#c' }])
    expect(event.defaultPrevented).toBe(true)
  })

  it('walks up from the clicked child to the link', () => {
    const { posted, dispatch } = runBridge(true)
    const link = anchor('http://example.com/')
    const span = element('SPAN')
    span.parentElement = link
    dispatch('click', span)
    expect(posted).toEqual([{ type: BOARD_OPEN_LINK_MESSAGE, url: 'http://example.com/' }])
  })

  it('fires on Enter, so the keyboard reaches the same link', () => {
    const { posted, dispatch } = runBridge(true)
    const event = dispatch('keydown', anchor('https://example.com/'), { key: 'Enter' })
    expect(posted).toEqual([{ type: BOARD_OPEN_LINK_MESSAGE, url: 'https://example.com/' }])
    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores any other key', () => {
    const { posted, dispatch } = runBridge(true)
    dispatch('keydown', anchor('https://example.com/'), { key: 'a' })
    expect(posted).toEqual([])
  })

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<h1>x</h1>'],
    ['mailto:someone@example.com'],
    ['intent://example#Intent;end'],
    ['#section'],
    ['/api/boards/demo/content'],
    ['//example.com/protocol-relative'],
    ['ftp://example.com/file'],
  ])('never forwards %s', href => {
    const { posted, dispatch } = runBridge(true)
    const event = dispatch('click', anchor(href))
    expect(posted).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores a click that is not on a link at all', () => {
    const { posted, dispatch } = runBridge(true)
    dispatch('click', element('DIV'))
    expect(posted).toEqual([])
  })

  it('does nothing when the document is the top frame (Android WebView)', () => {
    const { posted, dispatch } = runBridge(false)
    const event = dispatch('click', anchor('https://example.com/'))
    expect(posted).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves a click another handler already took alone', () => {
    const { posted, dispatch } = runBridge(true)
    dispatch('click', anchor('https://example.com/'), { defaultPrevented: true })
    expect(posted).toEqual([])
  })

  it('ignores a middle or right click', () => {
    const { posted, dispatch } = runBridge(true)
    dispatch('click', anchor('https://example.com/'), { button: 1 })
    expect(posted).toEqual([])
  })
})
