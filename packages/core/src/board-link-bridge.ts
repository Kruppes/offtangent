/**
 * board-link-bridge.ts — how a link inside a sandboxed board document reaches
 * the outside world.
 *
 * The document runs under `Content-Security-Policy: … sandbox allow-scripts`
 * (see `sandboxed-document.ts`): opaque origin, no `allow-popups`, no
 * `allow-top-navigation`. That is deliberate — a document written by a model
 * must not be able to open or navigate anything by itself. The consequence is
 * that a plain `<a href="https://…">` does nothing at all.
 *
 * So the HOST opens the link, not the document. The server appends a small
 * script to every board document it serves; the script turns a click (or
 * Enter) on an http(s) link into
 *
 *   parent.postMessage({ type: 'offtangent.open-link', url: '<absolute url>' }, '*')
 *
 * and the embedder decides. Two rules keep this honest:
 *
 *  - It only intervenes when the document is framed (`window.parent !== window`).
 *    The Android app loads the document TOP LEVEL in a WebView, where there is
 *    no parent to talk to; there the script must stay out of the way so the
 *    normal navigation happens and `shouldOverrideUrlLoading` can catch it.
 *  - Only `http:`/`https:` links are forwarded. `javascript:`, `data:`,
 *    `mailto:`, `intent:` and in-document anchors are left to the document
 *    itself (an anchor scrolls, the rest is inert under the sandbox).
 *
 * The message target is `'*'` because the document sits in an opaque origin
 * and cannot know the embedder's origin; the trust decision belongs to the
 * receiver, which checks `event.source === iframe.contentWindow` and
 * re-validates the URL before opening it.
 *
 * CSP note: the policy allows `script-src 'unsafe-inline'` (a self contained
 * document IS inline script), so this needs no nonce and no hash. If that
 * directive is ever tightened, this script needs a hash — the test in
 * `board-link-bridge.test.ts` pins the pairing.
 */

/** Message type the host listens for. */
export const BOARD_OPEN_LINK_MESSAGE = 'offtangent.open-link'

/** Marker attribute, so an injected bridge is recognisable (and never injected twice). */
export const BOARD_LINK_BRIDGE_MARKER = 'data-offtangent-link-bridge'

/**
 * The injected script, as it is served. Written in ES5-ish style on purpose:
 * it runs inside foreign documents in a WebView as well as a browser, and it
 * must never throw into the renderer's own code.
 */
export const BOARD_LINK_BRIDGE_SCRIPT = `(function () {
  if (window.parent === window) return;
  function anchorOf(node) {
    while (node && node.nodeType === 1) {
      if (node.tagName === 'A' && node.getAttribute('href')) return node;
      node = node.parentElement;
    }
    return null;
  }
  function open(anchor, event) {
    var href = anchor.getAttribute('href') || '';
    if (!/^https?:\\/\\//i.test(href)) return;
    var url;
    try { url = new URL(href); } catch (error) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    event.preventDefault();
    try {
      window.parent.postMessage({ type: '${BOARD_OPEN_LINK_MESSAGE}', url: url.href }, '*');
    } catch (error) { /* a host that refuses the message is not the document's problem */ }
  }
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button > 0) return;
    var anchor = anchorOf(event.target);
    if (anchor) open(anchor, event);
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || (event.key !== 'Enter' && event.keyCode !== 13)) return;
    var anchor = anchorOf(event.target);
    if (anchor) open(anchor, event);
  }, true);
})();`

/** The script element as injected, including its marker attribute. */
export function boardLinkBridgeTag(): string {
  return `<script ${BOARD_LINK_BRIDGE_MARKER}>${BOARD_LINK_BRIDGE_SCRIPT}</script>`
}

/**
 * Append the bridge to a document. The rest of the document is untouched,
 * byte for byte: a producer tested its page as it is, and a rewritten
 * document would silently differ from what it tested.
 *
 * Placement: before `</body>`, else before `</html>`, else appended. The
 * listeners are registered on `document` in the capture phase, so an early
 * or late position makes no behavioural difference; the goal is only to keep
 * the document well formed.
 */
export function injectBoardLinkBridge(html: string): string {
  if (html.includes(BOARD_LINK_BRIDGE_MARKER)) return html
  const tag = boardLinkBridgeTag()
  const closingBody = /<\/body\s*>/i.exec(html)
  if (closingBody) return `${html.slice(0, closingBody.index)}${tag}${html.slice(closingBody.index)}`
  const closingHtml = /<\/html\s*>/i.exec(html)
  if (closingHtml) return `${html.slice(0, closingHtml.index)}${tag}${html.slice(closingHtml.index)}`
  return `${html}${tag}`
}
