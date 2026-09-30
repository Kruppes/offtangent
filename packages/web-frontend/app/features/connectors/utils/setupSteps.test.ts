import { describe, expect, it } from 'vitest'
import type { ConnectorSetupStepContract } from '@axiom/core/contracts'
import { setupStepCopyLabel, setupStepCopyValue } from './setupSteps'

/** A complete wire step: the contract always carries `url` and `copy`, empty when unused. */
function step(id: string, copy: ConnectorSetupStepContract['copy'] = ''): ConnectorSetupStepContract {
  return { id, url: '', copy }
}

const scopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly']

describe('setupStepCopyValue', () => {
  it('joins scopes with newlines, one scope per line', () => {
    const value = setupStepCopyValue(step('scopes', 'scopes'), { redirectUri: 'https://x.test/cb', scopes })
    expect(value).toBe(`${scopes[0]}\n${scopes[1]}`)
    expect(value.split('\n')).toHaveLength(2)
    expect(value).not.toContain(',')
    expect(value).not.toContain(' ')
  })

  it('copies the redirect URI verbatim', () => {
    expect(setupStepCopyValue(step('client', 'redirectUri'), { redirectUri: 'https://x.test/cb', scopes }))
      .toBe('https://x.test/cb')
  })

  it('returns an empty string for a step without a copy slot', () => {
    expect(setupStepCopyValue(step('project'), { redirectUri: 'https://x.test/cb', scopes })).toBe('')
  })

  it('returns an empty string when the value is missing', () => {
    expect(setupStepCopyValue(step('client', 'redirectUri'), { redirectUri: '', scopes })).toBe('')
    expect(setupStepCopyValue(step('scopes', 'scopes'), { redirectUri: 'https://x.test/cb', scopes: [] })).toBe('')
  })
})

describe('setupStepCopyLabel', () => {
  it('labels the scope and redirect URI buttons', () => {
    expect(setupStepCopyLabel(step('scopes', 'scopes'), { redirectUri: '', scopes }))
      .toBe('connectors.setup.copyScopes')
    expect(setupStepCopyLabel(step('client', 'redirectUri'), { redirectUri: 'https://x.test/cb', scopes }))
      .toBe('connectors.setup.copyRedirectUri')
  })

  it('has no label when there is nothing to copy', () => {
    expect(setupStepCopyLabel(step('project'), { redirectUri: 'https://x.test/cb', scopes })).toBe('')
    expect(setupStepCopyLabel(step('client', 'redirectUri'), { redirectUri: '', scopes })).toBe('')
    expect(setupStepCopyLabel(step('scopes', 'scopes'), { redirectUri: '', scopes: [] })).toBe('')
  })
})
