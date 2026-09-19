export interface EmailAllowlist {
  addresses: string[]
  domains: string[]
}

export type EmailFolderMode = 'all' | 'selected'

export type EmailSecurity = 'ssl' | 'starttls' | 'none'

export type EmailProtocol = 'imap' | 'smtp'

export interface EmailFolder {
  path: string
  name: string
  delimiter: string
  specialUse?: string
  subscribed: boolean
}

export interface EmailConnectionPayload {
  accountId?: string
  protocol?: EmailProtocol
  imapHost?: string
  imapPort?: number
  imapUser?: string
  imapPassword?: string
  imapSecurity?: EmailSecurity
  smtpHost?: string
  smtpPort?: number
  smtpUser?: string
  smtpPassword?: string
  smtpSecurity?: EmailSecurity
  allowSelfSignedCert?: boolean
}

export interface EmailConnectionTestResult {
  ok: boolean
  imap?: { ok: boolean; error?: string }
  smtp?: { ok: boolean; error?: string }
}

export interface EmailAccount {
  id: string
  name: string
  imapHost: string
  imapPort: number
  imapUser: string
  imapSecurity: EmailSecurity
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpSecurity: EmailSecurity
  imapPasswordSet: boolean
  smtpPasswordSet: boolean
  allowSelfSignedCert: boolean
  canSend: boolean
  canManage: boolean
  canDelete: boolean
  canDownloadAttachments: boolean
  requireApproval: boolean
  allowlist: EmailAllowlist
  folderMode: EmailFolderMode
  allowedFolders: string[]
  displayName: string
  signature: string
  appendToSentFolder: boolean
  allowHtml: boolean
  attachmentDownloadPath: string
  createdAt: string
  updatedAt: string
}

export interface EmailAccountPayload {
  name: string
  imapHost: string
  imapPort: number
  imapUser: string
  imapPassword?: string
  imapSecurity: EmailSecurity
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPassword?: string
  smtpSecurity: EmailSecurity
  allowSelfSignedCert: boolean
  canSend: boolean
  canManage: boolean
  canDelete: boolean
  canDownloadAttachments: boolean
  requireApproval: boolean
  allowlist: EmailAllowlist
  folderMode: EmailFolderMode
  allowedFolders: string[]
  displayName: string
  signature: string
  appendToSentFolder: boolean
  allowHtml: boolean
  attachmentDownloadPath: string
}

export type EmailSendLogStatus = 'sent' | 'pending' | 'approved' | 'rejected' | 'blocked' | 'failed'

export const EMAIL_SEND_LOG_STATUSES: EmailSendLogStatus[] = [
  'sent',
  'pending',
  'approved',
  'rejected',
  'blocked',
  'failed',
]

export interface EmailSendLogAttachment {
  filename: string
  path?: string
  size: number
  contentType?: string
}

export interface EmailSendLogEntry {
  id: string
  accountId: string
  accountName: string
  status: EmailSendLogStatus
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyText: string
  bodyHtml: string | null
  attachments: EmailSendLogAttachment[]
  inReplyTo: string | null
  references: string[]
  reason: string | null
  errorMessage: string | null
  messageId: string | null
  sessionId: string | null
  decidedBy: string | null
  decidedAt: string | null
  sentAt: string | null
  createdAt: string
  updatedAt: string
}

export interface EmailSendLogQuery {
  accountId?: string
  status?: EmailSendLogStatus[]
  recipient?: string
  search?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}

export type EmailSendLogDecision = 'approve' | 'reject' | 'retry'

interface EmailSendLogPage {
  entries: EmailSendLogEntry[]
  total: number
  limit: number
  offset: number
}

function sendLogQueryString(query: EmailSendLogQuery): string {
  const params = new URLSearchParams()
  if (query.accountId) params.set('accountId', query.accountId)
  if (query.status?.length) params.set('status', query.status.join(','))
  if (query.recipient) params.set('recipient', query.recipient)
  if (query.search) params.set('search', query.search)
  if (query.dateFrom) params.set('dateFrom', query.dateFrom)
  if (query.dateTo) params.set('dateTo', query.dateTo)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export function useEmailApi() {
  const { apiFetch } = useApi()

  const isConfigured = () =>
    apiFetch<{ configured: boolean }>('/api/email/configured')

  const listAccounts = () =>
    apiFetch<{ accounts: EmailAccount[] }>('/api/email/accounts')

  const createAccount = (payload: EmailAccountPayload) =>
    apiFetch<{ account: EmailAccount }>('/api/email/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  const updateAccount = (id: string, payload: Partial<EmailAccountPayload>) =>
    apiFetch<{ account: EmailAccount }>(`/api/email/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })

  const deleteAccount = (id: string) =>
    apiFetch<{ success: boolean }>(`/api/email/accounts/${id}`, { method: 'DELETE' })

  const testConnection = (payload: EmailConnectionPayload) =>
    apiFetch<EmailConnectionTestResult>('/api/email/accounts/test-connection', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  const listFolders = (payload: EmailConnectionPayload) =>
    apiFetch<{ folders: EmailFolder[] }>('/api/email/accounts/folders', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  const listSendLog = (query: EmailSendLogQuery = {}) =>
    apiFetch<EmailSendLogPage>(`/api/email/sent-log${sendLogQueryString(query)}`)

  const getSendLogEntry = (id: string) =>
    apiFetch<{ entry: EmailSendLogEntry }>(`/api/email/sent-log/${id}`)

  const decideSendLogEntry = (id: string, action: EmailSendLogDecision) =>
    apiFetch<{ entry: EmailSendLogEntry }>(`/api/email/sent-log/${id}/${action}`, { method: 'POST' })

  return {
    isConfigured,
    listAccounts,
    createAccount,
    updateAccount,
    deleteAccount,
    testConnection,
    listFolders,
    listSendLog,
    getSendLogEntry,
    decideSendLogEntry,
  }
}
