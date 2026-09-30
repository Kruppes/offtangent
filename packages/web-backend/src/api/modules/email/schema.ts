import { EMAIL_SEND_LOG_STATUSES } from '@axiom/core'
import type {
  CreateEmailAccountInput,
  EmailProtocol,
  EmailSecurity,
  EmailSendLogStatus,
  ListEmailSendLogOptions,
  UpdateEmailAccountInput,
} from '@axiom/core'

interface ParseSuccess<T> {
  ok: true
  value: T
}

interface ParseFailure {
  ok: false
  error: string
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure

const BOOLEAN_FIELDS = [
  'allowSelfSignedCert',
  'canSend',
  'canManage',
  'canDelete',
  'canDownloadAttachments',
  'requireApproval',
  'appendToSentFolder',
  'allowHtml',
] as const

const OPTIONAL_STRING_FIELDS = ['displayName', 'signature', 'attachmentDownloadPath'] as const

const CONNECTION_STRING_FIELDS = [
  'imapHost',
  'imapUser',
  'imapPassword',
  'smtpHost',
  'smtpUser',
  'smtpPassword',
] as const

const SECURITY_VALUES = ['ssl', 'starttls', 'none'] as const

function parseSecurityFields(
  body: Record<string, unknown>,
  out: { imapSecurity?: EmailSecurity; smtpSecurity?: EmailSecurity },
): ParseFailure | null {
  for (const field of ['imapSecurity', 'smtpSecurity'] as const) {
    const raw = body[field]
    if (raw === undefined) continue
    if (!(SECURITY_VALUES as readonly unknown[]).includes(raw)) {
      return { ok: false, error: `${field} must be one of: ${SECURITY_VALUES.join(', ')}` }
    }
    out[field] = raw as EmailSecurity
  }
  return null
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parsePort(value: unknown, field: string): ParseResult<number> {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `${field} must be an integer between 1 and 65535` }
  }
  return { ok: true, value: port }
}

function parseStringList(value: unknown, field: string): ParseResult<string[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be an array of strings` }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, error: `${field} must be an array of strings` }
    const trimmed = entry.trim()
    if (trimmed) out.push(trimmed)
  }
  return { ok: true, value: out }
}

function parseAllowlist(value: unknown): ParseResult<{ addresses: string[]; domains: string[] }> {
  const record = toRecord(value)
  const addresses = parseStringList(record.addresses ?? [], 'allowlist.addresses')
  if (!addresses.ok) return addresses
  const domains = parseStringList(record.domains ?? [], 'allowlist.domains')
  if (!domains.ok) return domains
  return { ok: true, value: { addresses: addresses.value, domains: domains.value } }
}

function applyOptionalFields(
  body: Record<string, unknown>,
  out: UpdateEmailAccountInput,
): ParseFailure | null {
  for (const field of BOOLEAN_FIELDS) {
    const raw = body[field]
    if (raw === undefined) continue
    if (typeof raw !== 'boolean') return { ok: false, error: `${field} must be a boolean` }
    out[field] = raw
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    const raw = body[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string') return { ok: false, error: `${field} must be a string` }
    out[field] = raw
  }

  const securityFailure = parseSecurityFields(body, out)
  if (securityFailure) return securityFailure

  if (body.allowlist !== undefined) {
    const allowlist = parseAllowlist(body.allowlist)
    if (!allowlist.ok) return allowlist
    out.allowlist = allowlist.value
  }

  if (body.folderMode !== undefined) {
    if (body.folderMode !== 'all' && body.folderMode !== 'selected') {
      return { ok: false, error: 'folderMode must be "all" or "selected"' }
    }
    out.folderMode = body.folderMode
  }

  if (body.allowedFolders !== undefined) {
    const folders = parseStringList(body.allowedFolders, 'allowedFolders')
    if (!folders.ok) return folders
    out.allowedFolders = folders.value
  }

  return null
}

export interface EmailConnectionBody {
  accountId?: string
  protocol?: EmailProtocol
  imapSecurity?: EmailSecurity
  smtpSecurity?: EmailSecurity
  imapHost?: string
  imapPort?: number
  imapUser?: string
  imapPassword?: string
  smtpHost?: string
  smtpPort?: number
  smtpUser?: string
  smtpPassword?: string
  allowSelfSignedCert?: boolean
}

export function parseEmailConnectionBody(body: unknown): ParseResult<EmailConnectionBody> {
  const b = toRecord(body)
  const out: EmailConnectionBody = {}

  if (b.accountId !== undefined) {
    if (typeof b.accountId !== 'string' || !b.accountId.trim()) {
      return { ok: false, error: 'accountId must be a non-empty string' }
    }
    out.accountId = b.accountId.trim()
  }

  for (const field of CONNECTION_STRING_FIELDS) {
    const raw = b[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string') return { ok: false, error: `${field} must be a string` }
    if (raw) out[field] = field.endsWith('Password') ? raw : raw.trim()
  }

  for (const field of ['imapPort', 'smtpPort'] as const) {
    if (b[field] === undefined || b[field] === '') continue
    const port = parsePort(b[field], field)
    if (!port.ok) return port
    out[field] = port.value
  }

  if (b.allowSelfSignedCert !== undefined) {
    if (typeof b.allowSelfSignedCert !== 'boolean') {
      return { ok: false, error: 'allowSelfSignedCert must be a boolean' }
    }
    out.allowSelfSignedCert = b.allowSelfSignedCert
  }

  if (b.protocol !== undefined) {
    if (b.protocol !== 'imap' && b.protocol !== 'smtp') {
      return { ok: false, error: 'protocol must be "imap" or "smtp"' }
    }
    out.protocol = b.protocol
  }

  const securityFailure = parseSecurityFields(b, out)
  if (securityFailure) return securityFailure

  return { ok: true, value: out }
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstString(value[0])
  return typeof value === 'string' ? value : undefined
}

function parseStatusFilter(value: unknown): ParseResult<EmailSendLogStatus[]> {
  const raw = Array.isArray(value) ? value : [value]
  const out: EmailSendLogStatus[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    for (const part of entry.split(',')) {
      const status = part.trim()
      if (!status) continue
      if (!(EMAIL_SEND_LOG_STATUSES as string[]).includes(status)) {
        return { ok: false, error: `status must be one of: ${EMAIL_SEND_LOG_STATUSES.join(', ')}` }
      }
      if (!out.includes(status as EmailSendLogStatus)) out.push(status as EmailSendLogStatus)
    }
  }
  return { ok: true, value: out }
}

function parseNonNegativeInt(value: string, field: string): ParseResult<number> {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { ok: false, error: `${field} must be a non-negative integer` }
  }
  return { ok: true, value: parsed }
}

export function parseEmailSendLogQuery(query: unknown): ParseResult<ListEmailSendLogOptions> {
  const q = toRecord(query)
  const out: ListEmailSendLogOptions = {}

  for (const field of ['accountId', 'recipient', 'search', 'dateFrom', 'dateTo'] as const) {
    const raw = firstString(q[field])?.trim()
    if (raw) out[field] = raw
  }

  for (const field of ['dateFrom', 'dateTo'] as const) {
    const raw = out[field]
    if (!raw) continue
    if (Number.isNaN(Date.parse(raw))) {
      return { ok: false, error: `${field} must be an ISO date string` }
    }
    // Date-only input from the filter bar must cover the whole day, otherwise
    // `created_at <= '2026-01-05'` would drop every entry of that day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      out[field] = field === 'dateFrom' ? `${raw}T00:00:00.000Z` : `${raw}T23:59:59.999Z`
    }
  }

  if (q.status !== undefined) {
    const status = parseStatusFilter(q.status)
    if (!status.ok) return status
    if (status.value.length > 0) out.status = status.value
  }

  for (const field of ['limit', 'offset'] as const) {
    const raw = firstString(q[field])?.trim()
    if (!raw) continue
    const parsed = parseNonNegativeInt(raw, field)
    if (!parsed.ok) return parsed
    out[field] = parsed.value
  }

  return { ok: true, value: out }
}

export function parseCreateEmailAccountBody(body: unknown): ParseResult<CreateEmailAccountInput> {
  const b = toRecord(body)

  const requiredStrings = ['name', 'imapHost', 'imapUser', 'smtpHost', 'smtpUser'] as const
  const values: Record<string, string> = {}
  for (const field of requiredStrings) {
    const raw = b[field]
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: `${field} is required` }
    }
    values[field] = raw.trim()
  }

  const imapPort = parsePort(b.imapPort, 'imapPort')
  if (!imapPort.ok) return imapPort
  const smtpPort = parsePort(b.smtpPort, 'smtpPort')
  if (!smtpPort.ok) return smtpPort

  if (b.imapPassword !== undefined && typeof b.imapPassword !== 'string') {
    return { ok: false, error: 'imapPassword must be a string' }
  }
  if (b.smtpPassword !== undefined && typeof b.smtpPassword !== 'string') {
    return { ok: false, error: 'smtpPassword must be a string' }
  }

  const out: CreateEmailAccountInput = {
    name: values.name!,
    imapHost: values.imapHost!,
    imapPort: imapPort.value,
    imapUser: values.imapUser!,
    smtpHost: values.smtpHost!,
    smtpPort: smtpPort.value,
    smtpUser: values.smtpUser!,
  }

  if (typeof b.imapPassword === 'string') out.imapPassword = b.imapPassword
  if (typeof b.smtpPassword === 'string') out.smtpPassword = b.smtpPassword

  const failure = applyOptionalFields(b, out)
  if (failure) return failure

  return { ok: true, value: out }
}

export function parseUpdateEmailAccountBody(body: unknown): ParseResult<UpdateEmailAccountInput> {
  const b = toRecord(body)
  const out: UpdateEmailAccountInput = {}

  for (const field of ['name', 'imapHost', 'imapUser', 'smtpHost', 'smtpUser'] as const) {
    const raw = b[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: `${field} must be a non-empty string` }
    }
    out[field] = raw.trim()
  }

  for (const field of ['imapPort', 'smtpPort'] as const) {
    if (b[field] === undefined) continue
    const port = parsePort(b[field], field)
    if (!port.ok) return port
    out[field] = port.value
  }

  for (const field of ['imapPassword', 'smtpPassword'] as const) {
    const raw = b[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string') return { ok: false, error: `${field} must be a string` }
    if (raw) out[field] = raw
  }

  const failure = applyOptionalFields(b, out)
  if (failure) return failure

  return { ok: true, value: out }
}
