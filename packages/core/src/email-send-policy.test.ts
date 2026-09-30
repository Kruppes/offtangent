import { describe, expect, it } from 'vitest'
import { evaluateEmailSendPolicy, isRecipientAllowed } from './email-send-policy.js'
import type { EmailSendDecision, EmailSendPolicyRecipients } from './email-send-policy.js'

const allowlist = { addresses: ['boss@example.com'], domains: ['partner.org'] }

interface Case {
  name: string
  recipients: EmailSendPolicyRecipients
  requireApproval?: boolean
  allowlist?: { addresses: string[]; domains: string[] }
  expected: EmailSendDecision
}

const cases: Case[] = [
  { name: 'exact address match', recipients: { to: ['boss@example.com'] }, expected: 'allow' },
  { name: 'domain match', recipients: { to: ['anyone@partner.org'] }, expected: 'allow' },
  { name: 'case-insensitive exact match', recipients: { to: ['BOSS@Example.COM'] }, expected: 'allow' },
  { name: 'case-insensitive domain match', recipients: { to: ['Someone@PARTNER.org'] }, expected: 'allow' },
  { name: 'display-name form is unwrapped', recipients: { to: ['Boss <boss@example.com>'] }, expected: 'allow' },
  { name: 'subdomain is not covered by the domain entry', recipients: { to: ['a@mail.partner.org'] }, expected: 'blocked' },
  { name: 'unknown address is blocked', recipients: { to: ['stranger@evil.com'] }, expected: 'blocked' },
  { name: 'unknown address is pending with approval', recipients: { to: ['stranger@evil.com'] }, requireApproval: true, expected: 'pending' },
  { name: 'allowlisted address stays allow with approval enabled', recipients: { to: ['boss@example.com'] }, requireApproval: true, expected: 'allow' },
  { name: 'cc violation blocks an otherwise allowed mail', recipients: { to: ['boss@example.com'], cc: ['stranger@evil.com'] }, expected: 'blocked' },
  { name: 'bcc violation blocks an otherwise allowed mail', recipients: { to: ['boss@example.com'], bcc: ['stranger@evil.com'] }, expected: 'blocked' },
  { name: 'bcc violation becomes pending with approval', recipients: { to: ['boss@example.com'], bcc: ['stranger@evil.com'] }, requireApproval: true, expected: 'pending' },
  { name: 'all fields allowlisted', recipients: { to: ['boss@example.com'], cc: ['a@partner.org'], bcc: ['b@partner.org'] }, expected: 'allow' },
  { name: 'empty allowlist blocks everything', recipients: { to: ['boss@example.com'] }, allowlist: { addresses: [], domains: [] }, expected: 'blocked' },
  { name: 'empty allowlist with approval is pending', recipients: { to: ['boss@example.com'] }, allowlist: { addresses: [], domains: [] }, requireApproval: true, expected: 'pending' },
  { name: 'no recipients is blocked even with approval', recipients: {}, requireApproval: true, expected: 'blocked' },
  // Smuggling: one string that SMTP expands into several recipients.
  { name: 'comma-smuggled recipient is blocked', recipients: { to: ['stranger@evil.com, boss@example.com'] }, expected: 'blocked' },
  { name: 'comma-smuggled recipient behind a domain entry is blocked', recipients: { to: ['stranger@evil.com, anyone@partner.org'] }, expected: 'blocked' },
  { name: 'nested display-name address is blocked', recipients: { to: ['"x <boss@example.com>" <stranger@evil.com>'] }, expected: 'blocked' },
  { name: 'group syntax is expanded', recipients: { to: ['Team: boss@example.com, stranger@evil.com;'] }, expected: 'blocked' },
  { name: 'multiple allowed addresses in one string stay allowed', recipients: { to: ['boss@example.com, anyone@partner.org'] }, expected: 'allow' },
]

describe('evaluateEmailSendPolicy', () => {
  it.each(cases)('$name → $expected', testCase => {
    const result = evaluateEmailSendPolicy(testCase.recipients, {
      allowlist: testCase.allowlist ?? allowlist,
      requireApproval: testCase.requireApproval ?? false,
    })
    expect(result.decision).toBe(testCase.expected)
  })

  it('reports every violating address with its field', () => {
    const result = evaluateEmailSendPolicy(
      { to: ['boss@example.com', 'x@evil.com'], cc: ['y@evil.com'], bcc: ['z@partner.org'] },
      { allowlist, requireApproval: false },
    )

    expect(result.violations).toEqual([
      { field: 'to', address: 'x@evil.com' },
      { field: 'cc', address: 'y@evil.com' },
    ])
    expect(result.reason).toContain('x@evil.com')
    expect(result.reason).toContain('y@evil.com')
    expect(result.recipients).toHaveLength(4)
  })

  it('mentions approval in the reason when pending', () => {
    const result = evaluateEmailSendPolicy(
      { to: ['x@evil.com'] },
      { allowlist, requireApproval: true },
    )
    expect(result.reason).toMatch(/approval/i)
  })
})

describe('isRecipientAllowed', () => {
  it('accepts allowlisted domains written with a leading @', () => {
    expect(isRecipientAllowed('a@partner.org', { addresses: [], domains: ['@partner.org'] })).toBe(true)
  })

  it('rejects malformed addresses', () => {
    expect(isRecipientAllowed('not-an-address', allowlist)).toBe(false)
    expect(isRecipientAllowed('', allowlist)).toBe(false)
  })
})
