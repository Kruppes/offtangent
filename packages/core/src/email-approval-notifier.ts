import type { EmailSendLogEntry } from './email-send-log.js'

/**
 * Channels (webchat, telegram, …) implement this to show approval prompts and
 * to invalidate their buttons once any channel has decided.
 *
 * Lives in its own module so the send path (`email-tools`) can announce a new
 * pending entry without importing the approval orchestration — which in turn
 * imports `email-tools`.
 */
export interface EmailApprovalNotifier {
  approvalRequested?: (entry: EmailSendLogEntry) => void | Promise<void>
  approvalResolved?: (entry: EmailSendLogEntry) => void | Promise<void>
}

const notifiers = new Set<EmailApprovalNotifier>()

export function registerEmailApprovalNotifier(notifier: EmailApprovalNotifier): () => void {
  notifiers.add(notifier)
  return () => notifiers.delete(notifier)
}

export function clearEmailApprovalNotifiers(): void {
  notifiers.clear()
}

async function notify(hook: keyof EmailApprovalNotifier, entry: EmailSendLogEntry): Promise<void> {
  for (const notifier of [...notifiers]) {
    try {
      await notifier[hook]?.(entry)
    } catch (err) {
      console.error(`[email-approval] notifier "${hook}" failed:`, (err as Error).message)
    }
  }
}

/** Announce a freshly created pending entry to every registered channel. */
export function notifyEmailApprovalRequested(entry: EmailSendLogEntry): Promise<void> {
  return notify('approvalRequested', entry)
}

/** Tell every channel that the entry was decided, so stale buttons go away. */
export function notifyEmailApprovalResolved(entry: EmailSendLogEntry): Promise<void> {
  return notify('approvalResolved', entry)
}
