import type { ChatMessage } from '../../composables/useChat'

export interface TranscriptRow {
  message: ChatMessage
  index: number
  key: string
  tools?: ChatMessage[]
}

/** Presentation only: keep message identity and order for picker/action dispatch. */
export function groupTranscript(messages: readonly ChatMessage[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  messages.forEach((message, index) => {
    const tool = message.role === 'tool' && !!message.toolData
    const previous = rows[rows.length - 1]
    if (tool && previous?.tools) {
      previous.tools.push(message)
    } else {
      rows.push({ message, index, key: String(message.id ?? `${message.role}:${index}`), ...(tool ? { tools: [message] } : {}) })
    }
  })
  return rows
}

export function transcriptState(error: boolean, loading: boolean, count: number) {
  return error ? 'error' : loading ? 'loading' : count === 0 ? 'empty' : 'ready'
}

export function toolState(message: ChatMessage, active = true): 'running' | 'complete' | 'error' | 'unknown' {
  if (message.toolData?.toolIsError) return 'error'
  if (message.toolData?.toolResult !== undefined || message.toolData?.toolIsError === false) return 'complete'
  // Persisted rows without a result are not evidence of a still-running call.
  return active && message.id === undefined ? 'running' : 'unknown'
}

export function elapsedToolSeconds(message: ChatMessage, now: number): number | null {
  if (!message.timestamp) return null
  const end = message.toolData?.completedAt ? Date.parse(message.toolData.completedAt) : now
  if (toolState(message) !== 'running' && !message.toolData?.completedAt) return null
  const start = Date.parse(message.timestamp)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : null
}
