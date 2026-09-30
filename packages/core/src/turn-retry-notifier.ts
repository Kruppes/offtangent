/**
 * Cross-channel boundary for the manual-retry button.
 *
 * A Retry button for the same `turn_error` row can be visible in several
 * channels at once (web chat bubble, Telegram inline keyboard). Whoever taps
 * first decides; every other channel has to disable its own button with the
 * same wording. Channels register here and the retry service announces the
 * outcome exactly once, no matter which channel produced it.
 *
 * Mirrors `email-approval-notifier.ts` — same shape, same in-memory,
 * process-local trade-off.
 */

export interface TurnRetryResolution {
  /** `chat_messages` row id of the `turn_error` the button belongs to. */
  errorMessageId: number
  /** True when the retry actually started. */
  ok: boolean
  /** Text that replaces the button in every channel. */
  resolution: string
}

export interface TurnRetryNotifier {
  retryResolved?: (resolution: TurnRetryResolution) => void | Promise<void>
}

const notifiers = new Set<TurnRetryNotifier>()

export function registerTurnRetryNotifier(notifier: TurnRetryNotifier): () => void {
  notifiers.add(notifier)
  return () => notifiers.delete(notifier)
}

export function clearTurnRetryNotifiers(): void {
  notifiers.clear()
}

/** Tell every channel that the button was answered, so stale ones go away. */
export async function notifyTurnRetryResolved(resolution: TurnRetryResolution): Promise<void> {
  for (const notifier of [...notifiers]) {
    try {
      await notifier.retryResolved?.(resolution)
    } catch (err) {
      console.error('[turn-retry] notifier failed:', (err as Error).message)
    }
  }
}
