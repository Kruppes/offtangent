import { addressDomain, normalizeAddress, parseAddressList } from './email-client.js'

/**
 * Pure send-rule evaluation. Every recipient of every field is expanded into the
 * addresses SMTP will actually deliver to and checked on its own — there are no
 * implicit exceptions (not even for replies).
 */

export type EmailSendDecision = 'allow' | 'pending' | 'blocked'

export type EmailRecipientField = 'to' | 'cc' | 'bcc'

export interface EmailSendPolicyRecipients {
  to?: string[]
  cc?: string[]
  bcc?: string[]
}

export interface EmailSendPolicyAccount {
  allowlist: { addresses: string[]; domains: string[] }
  requireApproval: boolean
}

export interface EmailRecipientViolation {
  field: EmailRecipientField
  address: string
}

export interface EmailSendPolicyResult {
  decision: EmailSendDecision
  reason: string
  recipients: { field: EmailRecipientField; address: string }[]
  violations: EmailRecipientViolation[]
}

const FIELDS: EmailRecipientField[] = ['to', 'cc', 'bcc']

function normalizeList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => {
    const parsed = parseAddressList(value)
    // An entry the parser cannot resolve is kept verbatim so it shows up as a
    // violation instead of silently vanishing from the check.
    return parsed.length > 0 ? parsed : [normalizeAddress(String(value))].filter(Boolean)
  })
}

export function isRecipientAllowed(address: string, allowlist: EmailSendPolicyAccount['allowlist']): boolean {
  const normalized = normalizeAddress(address)
  if (!normalized) return false

  const addresses = (allowlist.addresses ?? []).map(entry => normalizeAddress(entry)).filter(Boolean)
  if (addresses.includes(normalized)) return true

  const domain = addressDomain(normalized)
  if (!domain) return false

  const domains = (allowlist.domains ?? [])
    .map(entry => String(entry).trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
  return domains.includes(domain)
}

export function evaluateEmailSendPolicy(
  recipients: EmailSendPolicyRecipients,
  account: EmailSendPolicyAccount,
): EmailSendPolicyResult {
  const all: { field: EmailRecipientField; address: string }[] = []
  for (const field of FIELDS) {
    for (const address of normalizeList(recipients[field])) {
      all.push({ field, address })
    }
  }

  if (all.length === 0) {
    return {
      decision: 'blocked',
      reason: 'No recipients given.',
      recipients: [],
      violations: [],
    }
  }

  const violations = all.filter(entry => !isRecipientAllowed(entry.address, account.allowlist))

  if (violations.length === 0) {
    return {
      decision: 'allow',
      reason: 'All recipients are on the allowlist.',
      recipients: all,
      violations: [],
    }
  }

  const listed = violations.map(entry => `${entry.address} (${entry.field})`).join(', ')
  return {
    decision: account.requireApproval ? 'pending' : 'blocked',
    reason: account.requireApproval
      ? `Recipients outside the allowlist require human approval: ${listed}`
      : `Recipients are not on the allowlist: ${listed}`,
    recipients: all,
    violations,
  }
}
