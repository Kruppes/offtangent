import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import {
  parseCreateEmailAccountBody,
  parseEmailConnectionBody,
  parseEmailSendLogQuery,
  parseUpdateEmailAccountBody,
} from './schema.js'
import {
  createEmailService,
  EmailAccountConflictError,
  EmailApprovalError,
  EmailAccountNotFoundError,
  EmailConnectionInputError,
  EmailSendLogNotFoundError,
} from './service.js'
import type { EmailServiceOptions } from './service.js'

export interface EmailControllerOptions extends EmailServiceOptions {
  onAccountsChanged?: () => void
}

export interface EmailController {
  isConfigured: (req: AuthenticatedRequest, res: Response) => void
  listAccounts: (req: AuthenticatedRequest, res: Response) => void
  getAccount: (req: AuthenticatedRequest, res: Response) => void
  createAccount: (req: AuthenticatedRequest, res: Response) => void
  updateAccount: (req: AuthenticatedRequest, res: Response) => void
  deleteAccount: (req: AuthenticatedRequest, res: Response) => void
  testConnection: (req: AuthenticatedRequest, res: Response) => Promise<void>
  listFolders: (req: AuthenticatedRequest, res: Response) => Promise<void>
  listSendLog: (req: AuthenticatedRequest, res: Response) => void
  getSendLogEntry: (req: AuthenticatedRequest, res: Response) => void
  approveSendLogEntry: (req: AuthenticatedRequest, res: Response) => Promise<void>
  rejectSendLogEntry: (req: AuthenticatedRequest, res: Response) => Promise<void>
  retrySendLogEntry: (req: AuthenticatedRequest, res: Response) => Promise<void>
}

const APPROVAL_ERROR_STATUS: Record<EmailApprovalError['code'], number> = {
  already_decided: 409,
  not_retryable: 409,
  account_missing: 502,
  send_failed: 502,
}

function handleError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof EmailApprovalError) {
    res.status(APPROVAL_ERROR_STATUS[err.code]).json({ error: err.message, code: err.code, entry: err.entry })
    return
  }
  if (err instanceof EmailAccountNotFoundError || err instanceof EmailSendLogNotFoundError) {
    res.status(404).json({ error: err.message })
    return
  }
  if (err instanceof EmailAccountConflictError) {
    res.status(409).json({ error: err.message })
    return
  }
  if (err instanceof EmailConnectionInputError) {
    res.status(400).json({ error: err.message })
    return
  }
  res.status(500).json({ error: `${fallback}: ${(err as Error).message}` })
}

export function createEmailController(options: EmailControllerOptions): EmailController {
  const service = createEmailService(options)
  const accountsChanged = options.onAccountsChanged ?? (() => {})

  return {
    isConfigured(_req, res) {
      try {
        res.json({ configured: service.listAccounts().length > 0 })
      } catch (err) {
        handleError(res, err, 'Failed to check email configuration')
      }
    },

    listAccounts(_req, res) {
      try {
        res.json({ accounts: service.listAccounts() })
      } catch (err) {
        handleError(res, err, 'Failed to list email accounts')
      }
    },

    getAccount(req, res) {
      try {
        res.json({ account: service.getAccount(String(req.params.id)) })
      } catch (err) {
        handleError(res, err, 'Failed to get email account')
      }
    },

    createAccount(req, res) {
      const parsed = parseCreateEmailAccountBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        const account = service.createAccount(parsed.value)
        accountsChanged()
        res.status(201).json({ account })
      } catch (err) {
        handleError(res, err, 'Failed to create email account')
      }
    },

    updateAccount(req, res) {
      const parsed = parseUpdateEmailAccountBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        const account = service.updateAccount(String(req.params.id), parsed.value)
        accountsChanged()
        res.json({ account })
      } catch (err) {
        handleError(res, err, 'Failed to update email account')
      }
    },

    deleteAccount(req, res) {
      try {
        service.deleteAccount(String(req.params.id))
        accountsChanged()
        res.json({ success: true })
      } catch (err) {
        handleError(res, err, 'Failed to delete email account')
      }
    },

    async testConnection(req, res) {
      const parsed = parseEmailConnectionBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        const result = await service.testConnection(parsed.value)
        res.json({ ...result, ok: (result.imap?.ok ?? true) && (result.smtp?.ok ?? true) })
      } catch (err) {
        handleError(res, err, 'Failed to test email connection')
      }
    },

    async listFolders(req, res) {
      const parsed = parseEmailConnectionBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        res.json({ folders: await service.listFolders(parsed.value) })
      } catch (err) {
        handleError(res, err, 'Failed to list email folders')
      }
    },

    listSendLog(req, res) {
      const parsed = parseEmailSendLogQuery(req.query)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        res.json(service.listSendLog(parsed.value))
      } catch (err) {
        handleError(res, err, 'Failed to list email send log')
      }
    },

    getSendLogEntry(req, res) {
      try {
        res.json({ entry: service.getSendLogEntry(String(req.params.id)) })
      } catch (err) {
        handleError(res, err, 'Failed to get email send log entry')
      }
    },

    approveSendLogEntry: decide('approveSendLogEntry', 'Failed to approve email'),
    rejectSendLogEntry: decide('rejectSendLogEntry', 'Failed to reject email'),
    retrySendLogEntry: decide('retrySendLogEntry', 'Failed to retry email'),
  }

  function decide(
    action: 'approveSendLogEntry' | 'rejectSendLogEntry' | 'retrySendLogEntry',
    fallback: string,
  ) {
    return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const decider = req.user?.username
      if (!decider) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }

      try {
        res.json({ entry: await service[action](String(req.params.id), { name: decider }) })
      } catch (err) {
        handleError(res, err, fallback)
      }
    }
  }
}
