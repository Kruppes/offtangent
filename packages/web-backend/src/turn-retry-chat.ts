import {
  TURN_RETRY_ACTION_ID,
  TURN_RETRY_ACTION_KIND,
  createTurnRetryService,
  registerTurnRetryNotifier,
} from '@axiom/core'
import type { Database, TurnErrorInfo, TurnInfo, TurnRetryRunnerLike } from '@axiom/core'
import type { ChatActionRegistry } from './chat-actions.js'

/**
 * Webchat channel for the manual retry: every persisted terminal error gets a
 * Retry button registered in the chat-action registry, keyed by the id the
 * runner stored on the error row. Because the click is resolved server-side
 * the button still works after a page reload; after a process restart the
 * (in-memory) registry no longer knows the id and answers "no longer
 * available", the same trade-off email approvals make.
 */

export interface TurnRetryChatChannelDeps {
  chatActions: ChatActionRegistry
  db: Database
  runner: TurnRetryRunnerLike
}

export interface TurnRetryChatChannel {
  /** Register the Retry button of a freshly persisted `turn_error` row. */
  attachRetryAction: (failure: { turn: TurnInfo; error: TurnErrorInfo }) => void
  unregister: () => void
}

export function registerTurnRetryChatChannel(deps: TurnRetryChatChannelDeps): TurnRetryChatChannel {
  const service = createTurnRetryService({ db: deps.db, runner: deps.runner })

  const unregisterHandler = deps.chatActions.registerHandler(
    TURN_RETRY_ACTION_KIND,
    ({ refId }) => service.retry(Number(refId)),
  )

  // A retry answered elsewhere (Telegram) must disable the web bubble's
  // button too — the registry broadcasts the resolution to every client.
  const unregisterNotifier = registerTurnRetryNotifier({
    retryResolved: ({ errorMessageId, resolution }) => {
      deps.chatActions.resolve(TURN_RETRY_ACTION_KIND, String(errorMessageId), resolution)
    },
  })

  return {
    attachRetryAction: ({ error }) => {
      if (!error.retryActionId || error.messageId === undefined) return
      deps.chatActions.attach({
        messageId: error.retryActionId,
        kind: TURN_RETRY_ACTION_KIND,
        refId: String(error.messageId),
        // The error bubble is the persisted row itself; channels render their
        // own (localized) label, this text is only the fallback.
        text: error.error,
        actions: [{ actionId: TURN_RETRY_ACTION_ID, label: 'Retry', style: 'primary' }],
      })
    },
    unregister: () => {
      unregisterHandler()
      unregisterNotifier()
    },
  }
}
