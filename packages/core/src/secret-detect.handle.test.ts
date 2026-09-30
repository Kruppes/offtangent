/**
 * F10 (review triage 19:25, report Integration 2, open point 1): a handle is
 * OUTPUT of the secret boundary and must never be read back as a value — not
 * even by a direct `detectSecrets` call. `trimValue()` strips the `{{`/`}}`
 * before `isPlaceholderValue()` looks at the value, so the slug was detected
 * as a token.
 *
 * Fixtures are synthetic, no credential literal in the repo.
 */
import { describe, it, expect } from 'vitest'
import { detectSecrets } from './secret-detect.js'

describe('detectSecrets never treats a handle as a value', () => {
  it('returns nothing for a handle after a context label (user tier)', () => {
    expect(detectSecrets('Passwort {{secret:router-1}} bitte', { tier: 'user' })).toEqual([])
  })

  it.each([
    'Passwort: {{secret:router-1}}',
    'password = {{secret:pin-2}}.',
    'Token ist {{secret:github-token-1}},',
    'PIN: ({{secret:pin-1}})',
    'API key: "{{secret:api-key-9}}"',
    'Kennwort lautet {{secret:redacted}}',
  ])('returns nothing for %s', text => {
    expect(detectSecrets(text, { tier: 'user' })).toEqual([])
  })

  it('still detects a real value next to a handle', () => {
    const value = ['Tr', '0ub', '4dor', '&3x'].join('')
    const spans = detectSecrets(`Passwort ${value}, altes {{secret:password-1}}`, { tier: 'user' })
    const text = `Passwort ${value}, altes {{secret:password-1}}`
    expect(spans.map(s => text.slice(s.start, s.end))).toEqual([value])
  })
})
