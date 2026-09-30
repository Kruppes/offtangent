/**
 * The shared sandbox contract. Canvas artifacts and `html_view.v1` boards both
 * serve bytes a model or a skill wrote and a browser executes, and both now
 * read their headers from here — so this is the single place where a weakened
 * policy would silently weaken two features at once.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  safeContentFilename,
  sandboxEmbedContract,
  sandboxedContentHeaders,
  sandboxedContentOrigin,
  sandboxedContentSecurityPolicy,
} from './sandboxed-document.js'

const saved = { ...process.env }
afterEach(() => {
  process.env.ARTIFACT_FRAME_ANCESTORS = saved.ARTIFACT_FRAME_ANCESTORS
  process.env.ARTIFACT_ORIGIN = saved.ARTIFACT_ORIGIN
  if (saved.ARTIFACT_FRAME_ANCESTORS === undefined) delete process.env.ARTIFACT_FRAME_ANCESTORS
  if (saved.ARTIFACT_ORIGIN === undefined) delete process.env.ARTIFACT_ORIGIN
})

describe('sandboxedContentSecurityPolicy', () => {
  it('puts an executable document in an opaque origin with no way out', () => {
    const csp = sandboxedContentSecurityPolicy('html')
    expect(csp).toContain('sandbox allow-scripts')
    // The one directive that must never appear: with allow-scripts it would
    // hand the document the app origin, its cookies and its access token.
    expect(csp).not.toContain('allow-same-origin')
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "frame-ancestors 'self'",
    ]) expect(csp).toContain(directive)
  })

  it('gives data (svg, png) no script budget at all', () => {
    const csp = sandboxedContentSecurityPolicy('data')
    expect(csp).toContain("script-src 'none'")
    expect(csp).toContain('; sandbox')
    expect(csp).not.toContain('allow-scripts')
  })

  it('honours a configured frame-ancestors allow list', () => {
    process.env.ARTIFACT_FRAME_ANCESTORS = 'https://app.example https://alt.example'
    expect(sandboxedContentSecurityPolicy('html'))
      .toContain('frame-ancestors https://app.example https://alt.example')
  })
})

describe('sandboxedContentHeaders', () => {
  const input = { kind: 'html' as const, contentType: 'text/html; charset=utf-8', byteLength: 12, filename: 'x.html' }

  it('ships the full header set and never caches a capability URL', () => {
    const headers = sandboxedContentHeaders(input)
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(headers['Content-Length']).toBe('12')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Referrer-Policy']).toBe('no-referrer')
    expect(headers['Cache-Control']).toBe('private, no-store, max-age=0')
    expect(headers['Cross-Origin-Resource-Policy']).toBe('cross-origin')
    expect(headers['Content-Disposition']).toBe('inline; filename="x.html"')
    expect(headers['Permissions-Policy']).toContain('geolocation=()')
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN')
  })

  it('drops X-Frame-Options once an allow list is configured, so a legit embed is not blocked', () => {
    process.env.ARTIFACT_FRAME_ANCESTORS = 'https://app.example'
    expect(sandboxedContentHeaders(input)['X-Frame-Options']).toBeUndefined()
  })
})

describe('sandboxEmbedContract', () => {
  it('describes the same denials to both clients', () => {
    const contract = sandboxEmbedContract('html', false)
    expect(contract.iframeSandbox).toBe('allow-scripts')
    expect(contract.iframeSandbox).not.toContain('same-origin')
    expect(contract.iframeReferrerPolicy).toBe('no-referrer')
    expect(contract.denies).toEqual(['same-origin', 'cookies', 'localStorage', 'network', 'top-navigation'])
    expect(sandboxEmbedContract('data', true)).toMatchObject({ iframeSandbox: '', separateOrigin: true })
  })
})

describe('sandboxedContentOrigin', () => {
  it('accepts an http(s) origin and rejects anything else', () => {
    process.env.ARTIFACT_ORIGIN = 'https://content.example/'
    expect(sandboxedContentOrigin()).toBe('https://content.example')
    process.env.ARTIFACT_ORIGIN = 'javascript:alert(1)'
    expect(sandboxedContentOrigin()).toBeNull()
    delete process.env.ARTIFACT_ORIGIN
    expect(sandboxedContentOrigin()).toBeNull()
  })
})

describe('safeContentFilename', () => {
  it('strips everything a Content-Disposition header could choke on', () => {
    expect(safeContentFilename('Wheel check', 'html', 'board')).toBe('Wheel_check.html')
    // No quote (which would break out of the header) and no slash survives.
    expect(safeContentFilename('a"; rm -rf /', 'html', 'board')).toBe('a__rm_-rf__.html')
    expect(safeContentFilename('///', 'html', 'board')).toBe('_.html')
    expect(safeContentFilename('', 'svg', 'artifact')).toBe('artifact.svg')
  })
})
