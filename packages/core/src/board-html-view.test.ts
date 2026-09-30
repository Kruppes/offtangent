/**
 * `html_view.v1` payload contract. The board tool is the only gate between a
 * skill and a document a browser will execute, so the rules are tested here
 * rather than assumed: a payload that passes must be renderable, and a payload
 * that fails must fail loudly instead of producing an empty board.
 */
import { describe, it, expect } from 'vitest'
import {
  HTML_VIEW_HTML_MAX_BYTES,
  HTML_VIEW_KIND,
  readHtmlViewPayload,
  validateHtmlViewPayload,
} from './board-html-view.js'

const doc = '<!doctype html><html><body><p>hello</p></body></html>'

describe('validateHtmlViewPayload', () => {
  it('accepts a minimal payload', () => {
    expect(validateHtmlViewPayload({ html: doc })).toBeNull()
  })

  it('accepts the documented optional hints', () => {
    expect(validateHtmlViewPayload({
      schema_version: HTML_VIEW_KIND,
      html: doc,
      supports_theme: true,
      aspect_ratio: 1.5,
      min_height_px: 360,
    })).toBeNull()
  })

  it('requires a non-empty html string', () => {
    expect(validateHtmlViewPayload({})).toMatch(/payload.html is required/)
    expect(validateHtmlViewPayload({ html: '' })).toMatch(/payload.html is required/)
    expect(validateHtmlViewPayload({ html: '   ' })).toMatch(/payload.html is required/)
    expect(validateHtmlViewPayload({ html: 42 })).toMatch(/payload.html is required/)
  })

  it('rejects a document past the byte cap', () => {
    const tooBig = `<html>${'x'.repeat(HTML_VIEW_HTML_MAX_BYTES)}</html>`
    expect(validateHtmlViewPayload({ html: tooBig })).toMatch(/at most 1024000 bytes/)
  })

  it('counts bytes, not code points', () => {
    // 'ä' is two bytes: a document that fits as characters can still bust the cap.
    const justOver = 'ä'.repeat(HTML_VIEW_HTML_MAX_BYTES / 2 + 1)
    expect(validateHtmlViewPayload({ html: justOver })).toMatch(/at most 1024000 bytes/)
  })

  it('rejects a foreign schema_version', () => {
    expect(validateHtmlViewPayload({ html: doc, schema_version: 'portfolio_digest.v1' }))
      .toMatch(/schema_version/)
  })

  it('rejects malformed hints instead of clamping them', () => {
    expect(validateHtmlViewPayload({ html: doc, supports_theme: 'yes' })).toMatch(/supports_theme/)
    expect(validateHtmlViewPayload({ html: doc, aspect_ratio: 0 })).toMatch(/aspect_ratio/)
    expect(validateHtmlViewPayload({ html: doc, aspect_ratio: 99 })).toMatch(/aspect_ratio/)
    expect(validateHtmlViewPayload({ html: doc, aspect_ratio: 'wide' })).toMatch(/aspect_ratio/)
    expect(validateHtmlViewPayload({ html: doc, min_height_px: 12 })).toMatch(/min_height_px/)
    expect(validateHtmlViewPayload({ html: doc, min_height_px: 10_000 })).toMatch(/min_height_px/)
    expect(validateHtmlViewPayload({ html: doc, min_height_px: 300.5 })).toMatch(/min_height_px/)
  })

  it('leaves the document untouched — no sanitising, no rewriting', () => {
    // The sandbox is the protection, not a filter: what the skill published is what
    // the renderer gets, byte for byte.
    const hostile = '<script>parent.postMessage(document.cookie,"*")</script>'
    expect(validateHtmlViewPayload({ html: hostile })).toBeNull()
    expect(readHtmlViewPayload({ html: hostile })?.html).toBe(hostile)
  })
})

describe('readHtmlViewPayload', () => {
  it('reads the hints with defaults', () => {
    expect(readHtmlViewPayload({ html: doc })).toEqual({
      html: doc, supportsTheme: false, aspectRatio: null, minHeightPx: null,
    })
    expect(readHtmlViewPayload({ html: doc, supports_theme: true, aspect_ratio: 2, min_height_px: 200 })).toEqual({
      html: doc, supportsTheme: true, aspectRatio: 2, minHeightPx: 200,
    })
  })

  it('returns null for anything unrenderable', () => {
    expect(readHtmlViewPayload(null)).toBeNull()
    expect(readHtmlViewPayload('<html>')).toBeNull()
    expect(readHtmlViewPayload([])).toBeNull()
    expect(readHtmlViewPayload({})).toBeNull()
    expect(readHtmlViewPayload({ html: '' })).toBeNull()
  })
})
