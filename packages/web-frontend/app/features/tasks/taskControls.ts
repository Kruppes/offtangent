import { TASK_REPLY_MAX_LENGTH } from '~/api/tasks'

/**
 * Pure rules of the task detail controls (the app's TaskDetailScreen): what a
 * status allows and how a reply text is checked before it is sent.
 */
export type TaskStatusKey = 'running' | 'paused' | 'completed' | 'failed' | 'unknown'
export function statusKey(status: string | null | undefined): TaskStatusKey {
  return status === 'running' || status === 'paused' || status === 'completed' || status === 'failed' ? status : 'unknown'
}

export interface TaskActions { canStop: boolean; canAnswer: boolean; canFollowUp: boolean }
/** Running and paused tasks can be stopped; a paused one waits for an answer; a finished one takes a follow-up. */
export function taskActions(status: string | null | undefined): TaskActions {
  const key = statusKey(status)
  return {
    canStop: key === 'running' || key === 'paused',
    canAnswer: key === 'paused',
    canFollowUp: key === 'completed' || key === 'failed',
  }
}

export type ReplyCheck = { ok: true; text: string } | { ok: false; reason: 'empty' | 'tooLong' }
/** Mirrors the server: trimmed, 1..8000 characters. */
export function checkReply(raw: string): ReplyCheck {
  const text = raw.trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (text.length > TASK_REPLY_MAX_LENGTH) return { ok: false, reason: 'tooLong' }
  return { ok: true, text }
}

/**
 * The question a paused task is waiting on: the newest `status_change` to
 * paused that carries a message, else the newest agent text. Null when none.
 */
export function pendingQuestion(events: readonly { type: string; status?: string; statusMessage?: string; text?: string }[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'status_change' && event.status === 'paused' && event.statusMessage?.trim()) return event.statusMessage.trim()
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'text_delta' && event.text?.trim()) return event.text.trim()
  }
  return null
}
