/**
 * Tool results of the Google connector.
 *
 * `toolError` is the single place that decides what a failure tells the model.
 * It maps the known error shapes to a short sentence and a coarse code; an
 * unknown error contributes NOTHING but a generic code, because an upstream
 * message may quote a subject line, an address or a calendar title.
 */
import { ConnectorNotConnectedError, ConnectorReauthRequiredError } from '../access.js'
import { OAuthTokenError } from '../oauth.js'
import { GoogleApiError } from './api.js'

export interface ConnectorToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
}

export function toolText(text: string, details: Record<string, unknown> = {}): ConnectorToolResult {
  return { content: [{ type: 'text', text }], details }
}

export function toolError(err: unknown, details: Record<string, unknown> = {}): ConnectorToolResult {
  if (typeof err === 'string') return toolText(`Error: ${err}`, { ...details, error: true })

  if (err instanceof ConnectorReauthRequiredError) {
    return toolText(
      'Error: reauth_required — the connector has to be connected again on the connectors page.',
      { ...details, error: true, code: 'reauth_required' },
    )
  }
  if (err instanceof ConnectorNotConnectedError) {
    return toolText('Error: not_connected — the connector is not connected.', {
      ...details,
      error: true,
      code: 'not_connected',
    })
  }
  if (err instanceof OAuthTokenError) {
    // `err.code` is the OAuth2 `error` field (a fixed vocabulary), never content.
    const code = err.isInvalidGrant ? 'reauth_required' : `token_${err.code}`
    return toolText(`Error: ${code} — the access token could not be renewed.`, {
      ...details,
      error: true,
      code,
    })
  }
  if (err instanceof GoogleApiError) {
    // A withdrawn or missing scope is not a transient failure: the operator has
    // to consent again, so it must not read like "try later".
    if (err.code === 'reauth_required') {
      return toolText('Error: reauth_required — Neu verbinden nötig (Berechtigung fehlt).', {
        ...details,
        error: true,
        code: 'reauth_required',
        status: err.status,
      })
    }
    if (err.code === 'rate_limited') {
      const wait = err.retryAfterSeconds > 0
        ? ` Frühestens in ${err.retryAfterSeconds} Sekunden erneut versuchen.`
        : ' Später erneut versuchen.'
      return toolText(
        `Error: rate_limited — das Limit ist erreicht, nichts wurde gelesen.${wait} Nicht sofort wiederholen.`,
        { ...details, error: true, code: 'rate_limited', status: err.status, retryAfterSeconds: err.retryAfterSeconds },
      )
    }
    if (err.code === 'timeout') {
      return toolText('Error: upstream timeout — the request took too long. Nothing was read.', {
        ...details,
        error: true,
        code: 'timeout',
      })
    }
    return toolText(`Error: upstream ${err.code} — the request was refused. Nothing was read.`, {
      ...details,
      error: true,
      code: err.code,
    })
  }
  if (err instanceof Error && err.name === 'InvalidDateInputError') {
    return toolText(`Error: ${err.message}. Use YYYY-MM-DD or an ISO date-time.`, {
      ...details,
      error: true,
      code: 'invalid_date',
    })
  }
  return toolText('Error: unexpected_error — the request failed. Nothing was read.', {
    ...details,
    error: true,
    code: 'unexpected_error',
  })
}
