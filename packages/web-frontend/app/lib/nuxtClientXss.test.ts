/**
 * Regression guard for the client-side XSS advisories of the Nuxt version that
 * ships in our browser bundle.
 *
 * Why this lives here and not in an audit script: the frontend is built with
 * `nuxt generate` and served as a static SPA by the backend, so the *client*
 * runtime of Nuxt (`NuxtLink`, `navigateTo`) is shipped to every visitor.
 * A static build removes the server-side advisories (no Nitro server, no server
 * islands) but it does NOT remove the client ones. These three were exploitable
 * with our deployment shape:
 *
 *   - GHSA-934w-87qh-qr26  `<NuxtLink>` renders an unsanitised `javascript:` /
 *                          `data:` href                      (patched 4.4.7)
 *   - GHSA-fx6j-w5w5-h468  reflected XSS in `navigateTo()` external redirect
 *                                                            (patched 4.4.6)
 *   - GHSA-m3q2-p4fw-w38m  XSS via `<NoScript>` slot content (patched 4.4.7)
 *
 * The test asserts against the *installed* artefacts under `node_modules/nuxt`,
 * i.e. exactly the code that ends up in the bundle, not against a version
 * string in a package.json we could edit without updating anything.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isScriptProtocol } from 'ufo'

const require_ = createRequire(import.meta.url)
const nuxtPkgPath = require_.resolve('nuxt/package.json')
const nuxtRoot = path.dirname(nuxtPkgPath)
const nuxtVersion = JSON.parse(readFileSync(nuxtPkgPath, 'utf8')).version as string

function readNuxtDist(relative: string): string {
  return readFileSync(path.join(nuxtRoot, relative), 'utf8')
}

function compare(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map(Number)
  const pb = b.split('-')[0]!.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  // a prerelease of the same triple is lower than the release
  const ra = a.includes('-') ? 0 : 1
  const rb = b.includes('-') ? 0 : 1
  return ra - rb
}

/**
 * Pull the shipped `sanitizeExternalHref` out of the installed client bundle and
 * run it. This executes Nuxt's own fix, not a reimplementation of it.
 */
function loadShippedHrefSanitizer(): (value: string) => string | null {
  const source = readNuxtDist('dist/app/components/nuxt-link.js')
  const start = source.indexOf('function sanitizeExternalHref(')
  expect(
    start,
    'installed nuxt has no sanitizeExternalHref in dist/app/components/nuxt-link.js',
  ).toBeGreaterThan(-1)
  // Balance braces to cut exactly the function body out of the bundle.
  let depth = 0
  let end = -1
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  expect(end, 'could not delimit sanitizeExternalHref').toBeGreaterThan(start)
  const body = source.slice(start, end)
  const factory = new Function('isScriptProtocol', `${body}; return sanitizeExternalHref;`)
  return factory(isScriptProtocol) as (value: string) => string | null
}

describe('nuxt client XSS advisories', () => {
  it('ships a nuxt version that carries the client-side fixes', () => {
    // 4.4.6: navigateTo redirect XSS, 4.4.7: NuxtLink + NoScript XSS.
    expect(compare(nuxtVersion, '4.4.7')).toBeGreaterThanOrEqual(0)
  })

  it('GHSA-934w-87qh-qr26: NuxtLink drops script-capable hrefs', () => {
    const sanitize = loadShippedHrefSanitizer()
    for (const payload of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      ' javascript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'blob:https://example.test/abc',
      'view-source:javascript:alert(1)',
      'view-source:view-source:javascript:alert(1)',
    ]) {
      expect(sanitize(payload), `payload survived sanitisation: ${payload}`).toBeNull()
    }
  })

  it('GHSA-934w-87qh-qr26: NuxtLink keeps legitimate hrefs untouched', () => {
    const sanitize = loadShippedHrefSanitizer()
    for (const ok of [
      'https://example.test/a?b=c#d',
      'http://127.0.0.1:3000/boards/ki-news',
      '/strands/42',
      'mailto:someone@example.test',
      'tel:+15550100',
      './relative/path',
      '#anchor',
    ]) {
      expect(sanitize(ok), `legit href was dropped: ${ok}`).toBe(ok)
    }
  })

  it('GHSA-934w-87qh-qr26: the sanitizer is applied on every href path of NuxtLink', () => {
    const source = readNuxtDist('dist/app/components/nuxt-link.js')
    const calls = source.match(/sanitizeExternalHref\(/g) ?? []
    // one definition + at least the two computed href branches (internal/external)
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })

  it('GHSA-fx6j-w5w5-h468: navigateTo rejects script protocols and escapes the redirect attribute', () => {
    const source = readNuxtDist('dist/app/composables/router.js')
    expect(source).toContain('isScriptProtocol')
    // the meta-refresh / location fallback must not interpolate raw URLs
    expect(source).toMatch(/HTML_ATTR_UNSAFE_RE|encodeHtmlAttribute/)
  })
})
