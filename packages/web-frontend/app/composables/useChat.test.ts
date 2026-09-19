import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import {
  applyAttachmentFrame,
  applySessionActivity,
  buildTurnRetryAction,
  isForeignFrame,
  mapHistoryRows,
  sessionErrorCodeOf,
  stripFailedAttempt,
  stripTrailingTurn,
  turnErrorFromHistoryMetadata,
  upsertErrorMessage,
  upsertStallMessage,
  useChat,
} from './useChat'
import type { ChatAttachment, ChatHistoryRow, ChatMessage, ChatStallInfo, ChatTurnErrorInfo, SessionActivity } from './useChat'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

function stall(overrides: Partial<ChatStallInfo> = {}): ChatStallInfo {
  return {
    messageId: 42,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 30_000,
    ...overrides,
  }
}

describe('stripTrailingTurn', () => {
  it('removes the partial turn rendered after the last user message', () => {
    const list = [
      msg('user', 'first question'),
      msg('assistant', 'first answer'),
      msg('user', 'second question'),
      msg('assistant', 'thinking…'),
      msg('tool', 'Tool: search'),
      msg('assistant', 'partial answer'),
    ]

    expect(stripTrailingTurn(list).map(m => m.content)).toEqual([
      'first question',
      'first answer',
      'second question',
    ])
  })

  it('keeps plain system messages that were interleaved into the running turn', () => {
    const list = [
      msg('user', 'question'),
      msg('system', 'Task aborted. No queued messages.'),
      msg('assistant', 'partial'),
    ]

    expect(stripTrailingTurn(list).map(m => m.role)).toEqual(['user', 'system'])
  })

  it('strips a stall notice together with the turn it belongs to', () => {
    const list: ChatMessage[] = [
      msg('user', 'question'),
      msg('assistant', 'thinking…'),
      { role: 'system', content: '⏳ Provider has not responded for 30s…', stallInfo: stall() },
      msg('assistant', 'partial'),
    ]

    expect(stripTrailingTurn(list).map(m => m.role)).toEqual(['user'])
  })

  it('strips a terminal error notice so the replay rebuilds it exactly once', () => {
    const list: ChatMessage[] = [
      msg('user', 'question'),
      msg('assistant', 'partial'),
      {
        id: 77,
        role: 'system',
        content: '❌ Provider error: 401 Unauthorized',
        errorInfo: {
          messageId: 77,
          cause: 'non_retryable',
          error: '401 Unauthorized',
          attempts: 0,
          retryable: false,
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]

    expect(stripTrailingTurn(list).map(m => m.role)).toEqual(['user'])
  })
})

describe('stripFailedAttempt', () => {
  it('removes the partial answer of the discarded attempt', () => {
    const list = [
      msg('user', 'question'),
      msg('assistant', 'thinking…'),
      msg('tool', 'Tool: search'),
      msg('assistant', 'half an answer'),
    ]

    expect(stripFailedAttempt(list).map(m => m.content)).toEqual(['question'])
  })

  it('keeps stall notices, which stay part of the persisted history', () => {
    const list: ChatMessage[] = [
      msg('user', 'question'),
      { role: 'system', content: '⚠️ Provider stopped responding', stallInfo: stall({ outcome: 'aborted' }) },
      msg('assistant', 'half an answer'),
    ]

    expect(stripFailedAttempt(list).map(m => m.role)).toEqual(['user', 'system'])
  })

  it('stops at the user message of an earlier, completed turn', () => {
    const list = [
      msg('user', 'first question'),
      msg('assistant', 'first answer'),
      msg('user', 'second question'),
      msg('assistant', 'half an answer'),
    ]

    expect(stripFailedAttempt(list).map(m => m.content)).toEqual([
      'first question',
      'first answer',
      'second question',
    ])
  })
})

function turnError(overrides: Partial<ChatTurnErrorInfo> = {}): ChatTurnErrorInfo {
  return {
    messageId: 77,
    cause: 'non_retryable',
    error: '401 Unauthorized: API key expired',
    attempts: 0,
    retryable: false,
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('upsertErrorMessage', () => {
  it('appends the terminal error as a system notice', () => {
    const updated = upsertErrorMessage(
      [msg('user', 'question')],
      turnError(),
      '❌ Provider error: 401 Unauthorized: API key expired',
    )

    expect(updated.map(m => m.role)).toEqual(['user', 'system'])
    expect(updated[1]!.content).toContain('401 Unauthorized')
    expect(updated[1]!.errorInfo?.cause).toBe('non_retryable')
    expect(updated[1]!.id).toBe(77)
  })

  it('updates the notice restored from history instead of duplicating it', () => {
    const fromHistory: ChatMessage[] = [
      msg('user', 'question'),
      { id: 77, role: 'system', content: 'old text', errorInfo: turnError() },
    ]

    const updated = upsertErrorMessage(fromHistory, turnError(), '❌ Provider error: 401 Unauthorized: API key expired')
    expect(updated).toHaveLength(2)
    expect(updated[1]!.content).toContain('401 Unauthorized')
  })

  it('appends an error that was not persisted', () => {
    const once = upsertErrorMessage([], turnError({ messageId: undefined }), 'boom')
    const twice = upsertErrorMessage(once, turnError({ messageId: undefined }), 'boom')
    expect(twice).toHaveLength(2)
  })

  it('hangs the retry button off the error notice', () => {
    const updated = upsertErrorMessage([], turnError({ retryActionId: 'turn-retry-1' }), 'boom')

    expect(updated[0]!.chatAction).toMatchObject({
      messageId: 'turn-retry-1',
      kind: 'turn_retry',
      refId: '77',
      actions: [{ actionId: 'retry' }],
    })
  })

  it('keeps an already-resolved retry resolved when the turn is replayed', () => {
    const resolved = upsertErrorMessage([], turnError({ retryActionId: 'turn-retry-1' }), 'boom')
    resolved[0]!.chatAction!.resolution = '🔄 Retrying…'

    const replayed = upsertErrorMessage(resolved, turnError({ retryActionId: 'turn-retry-1' }), 'boom')
    expect(replayed[0]!.chatAction?.resolution).toBe('🔄 Retrying…')
  })
})

describe('buildTurnRetryAction', () => {
  it('builds the button from the persisted action id', () => {
    expect(buildTurnRetryAction(turnError({ retryActionId: 'turn-retry-9' }), 'boom')).toEqual({
      messageId: 'turn-retry-9',
      kind: 'turn_retry',
      refId: '77',
      text: 'boom',
      actions: [{ actionId: 'retry', label: 'Retry', style: 'primary' }],
    })
  })

  it('omits the button for errors without a persisted row or action id', () => {
    expect(buildTurnRetryAction(turnError(), 'boom')).toBeUndefined()
    expect(buildTurnRetryAction(turnError({ messageId: undefined, retryActionId: 'x' }), 'boom')).toBeUndefined()
  })
})

describe('turnErrorFromHistoryMetadata', () => {
  it('rebuilds the error details of a persisted turn_error row', () => {
    const info = turnErrorFromHistoryMetadata({
      kind: 'turn_error',
      cause: 'retry_exhausted',
      error: '502 Bad Gateway',
      attempts: 3,
      retryable: true,
      occurredAt: '2026-01-01T00:00:00.000Z',
    }, 12)

    expect(info).toEqual({
      messageId: 12,
      cause: 'retry_exhausted',
      error: '502 Bad Gateway',
      attempts: 3,
      retryable: true,
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('ignores rows of other kinds', () => {
    expect(turnErrorFromHistoryMetadata({ kind: 'provider_stall' }, 1)).toBeNull()
    expect(turnErrorFromHistoryMetadata({}, 1)).toBeNull()
    expect(turnErrorFromHistoryMetadata(null, 1)).toBeNull()
  })

  it('falls back to a non-retryable cause for unknown values', () => {
    const info = turnErrorFromHistoryMetadata({ kind: 'turn_error', cause: 'weird', error: 'boom' }, 3)
    expect(info).toMatchObject({ cause: 'non_retryable', attempts: 0, retryable: false })
  })

  it('restores the retry action id so the button survives a reload', () => {
    const info = turnErrorFromHistoryMetadata({
      kind: 'turn_error',
      error: 'boom',
      retryActionId: 'turn-retry-42',
    }, 5)
    expect(info?.retryActionId).toBe('turn-retry-42')
  })
})

describe('upsertStallMessage', () => {
  it('appends the warning before trailing streaming messages', () => {
    const list: ChatMessage[] = [
      msg('user', 'question'),
      { role: 'assistant', content: 'partial', streaming: true },
    ]

    const updated = upsertStallMessage(list, stall(), '⏳ Provider has not responded for 30s…')
    expect(updated.map(m => m.role)).toEqual(['user', 'system', 'assistant'])
    expect(updated[1]!.content).toContain('has not responded for 30s')
    expect(updated[1]!.stallInfo?.outcome).toBeUndefined()
  })

  it('updates the existing notice in place when the stall resolves', () => {
    const warned = upsertStallMessage([msg('user', 'question')], stall(), '⏳ Provider has not responded for 30s…')
    const resolved = upsertStallMessage(warned, stall({
      resolvedAt: '2026-01-01T00:00:45.000Z',
      durationMs: 45_000,
      outcome: 'recovered',
    }), '✅ Provider recovered after 45s of silence')

    expect(resolved).toHaveLength(2)
    expect(resolved[1]!.stallInfo?.outcome).toBe('recovered')
    expect(resolved[1]!.content).toContain('recovered after 45s')
  })

  it('matches a notice restored from history by its persisted row id', () => {
    const fromHistory: ChatMessage[] = [
      msg('user', 'question'),
      {
        id: 42,
        role: 'system',
        content: '⏳ Provider has not responded for 30s…',
        stallInfo: stall(),
      },
    ]

    const resolved = upsertStallMessage(
      fromHistory,
      stall({ durationMs: 60_000, outcome: 'aborted' }),
      '⚠️ Provider stopped responding — aborted after 60s of silence',
    )
    expect(resolved).toHaveLength(2)
    expect(resolved[1]!.content).toContain('stopped responding')
  })

  it('appends a notice that has no persisted row id', () => {
    const updated = upsertStallMessage([msg('user', 'question')], stall({ messageId: undefined }), 'stalled')
    expect(updated).toHaveLength(2)
    const twice = upsertStallMessage(updated, stall({ messageId: undefined }), 'stalled')
    expect(twice).toHaveLength(3)
  })
})

describe('applyAttachmentFrame', () => {
  const apk: ChatAttachment = {
    kind: 'file',
    originalName: 'offtangent-0.9.1.apk',
    storedName: 'abc-offtangent-0.9.1.apk',
    relativePath: '2026/09/15/abc-offtangent-0.9.1.apk',
    urlPath: '/api/uploads/2026/09/15/abc-offtangent-0.9.1.apk',
    mimeType: 'application/octet-stream',
    size: 5_342_668,
  }
  const shot: ChatAttachment = { ...apk, originalName: 'shot.png', kind: 'image', relativePath: '2026/09/15/def-shot.png' }

  it('merges the file into the answer the running turn is streaming', () => {
    const list: ChatMessage[] = [
      msg('user', 'send me the build'),
      { role: 'assistant', content: 'Here you go.', streaming: true },
    ]

    const result = applyAttachmentFrame(list, apk)

    expect(result).toHaveLength(2)
    expect(result[1]!.attachments?.map(a => a.relativePath)).toEqual([apk.relativePath])
  })

  it('opens a streaming bubble when the file arrives before the answer text', () => {
    const list: ChatMessage[] = [
      msg('user', 'send me the build'),
      { role: 'tool', content: 'Tool: send_file_to_user', toolData: { toolName: 'send_file_to_user', toolCallId: 'tc-1' } },
    ]

    const result = applyAttachmentFrame(list, apk)

    expect(result).toHaveLength(3)
    // Streaming, so the text chunks of the same turn land in this very bubble
    // — which is how the persisted row looks: one row, text plus files.
    expect(result[2]).toMatchObject({ role: 'assistant', content: '', streaming: true })
    expect(result[2]!.attachments).toEqual([apk])
  })

  it('does not glue a task-delivered file onto an old, unrelated answer', () => {
    const list: ChatMessage[] = [
      msg('user', 'what is the plan?'),
      { id: 41, role: 'assistant', content: 'The plan is ready.', timestamp: '2026-09-15T06:00:00.000Z' },
    ]

    const result = applyAttachmentFrame(list, apk, { messageId: 42 })

    expect(result[1]!.attachments).toBeUndefined()
    expect(result).toHaveLength(3)
    // The background task wrote its own row; the live bubble carries its id and
    // is finished, exactly like the row a reload brings back.
    expect(result[2]).toMatchObject({ id: 42, role: 'assistant', content: '' })
    expect(result[2]!.streaming).toBeFalsy()
    expect(result[2]!.attachments).toEqual([apk])
  })

  it('renders a file the transcript already carries exactly once', () => {
    const list: ChatMessage[] = [
      { id: 42, role: 'assistant', content: '', attachments: [apk] },
      { role: 'system', content: '⏱ Task running: build the app' },
    ]

    expect(applyAttachmentFrame(list, apk, { messageId: 42 })).toBe(list)
  })

  it('ignores a repeated broadcast of the same upload', () => {
    const list: ChatMessage[] = [{ role: 'assistant', content: 'Here you go.', streaming: true }]

    const once = applyAttachmentFrame(list, apk)
    expect(applyAttachmentFrame(once, apk)).toBe(once)
  })

  it('keeps collecting further files of the same turn', () => {
    const list: ChatMessage[] = [{ role: 'assistant', content: 'Two files:', streaming: true }]

    const result = applyAttachmentFrame(applyAttachmentFrame(list, apk), shot)

    expect(result[0]!.attachments?.map(a => a.originalName)).toEqual([apk.originalName, shot.originalName])
  })
})

describe('isForeignFrame', () => {
  it('treats every frame as ours in legacy mode (no thread bound)', () => {
    expect(isForeignFrame(null, 'sess-other')).toBe(false)
    expect(isForeignFrame(null, undefined)).toBe(false)
  })

  it('accepts frames of the bound thread and frames without a session id', () => {
    expect(isForeignFrame('sess-a', 'sess-a')).toBe(false)
    expect(isForeignFrame('sess-a', undefined)).toBe(false)
  })

  it('rejects frames of another thread', () => {
    expect(isForeignFrame('sess-a', 'sess-b')).toBe(true)
  })
})

describe('sessionErrorCodeOf', () => {
  it('recognises the three session binding failures', () => {
    expect(sessionErrorCodeOf({ type: 'error', code: 'session_not_found' })).toBe('session_not_found')
    expect(sessionErrorCodeOf({ type: 'error', code: 'session_agent_mismatch' })).toBe('session_agent_mismatch')
    expect(sessionErrorCodeOf({ type: 'error', code: 'session_forbidden' })).toBe('session_forbidden')
  })

  it('ignores provider/connection errors and non-error frames', () => {
    expect(sessionErrorCodeOf({ type: 'error', code: 'provider_down' })).toBeNull()
    expect(sessionErrorCodeOf({ type: 'error' })).toBeNull()
    expect(sessionErrorCodeOf({ type: 'done', code: 'session_forbidden' })).toBeNull()
  })
})

describe('applySessionActivity', () => {
  it('marks a session as running while its turn streams', () => {
    const activity = applySessionActivity({}, { type: 'text', sessionId: 'sess-a' })
    expect(activity).toEqual({ 'sess-a': { state: 'running' } })
  })

  it('records the queue position of a waiting turn', () => {
    const activity = applySessionActivity({}, { type: 'queued', sessionId: 'sess-b', position: 2 })
    expect(activity).toEqual({ 'sess-b': { state: 'queued', position: 2 } })
  })

  it('clears the session when the turn ends', () => {
    const running: Record<string, SessionActivity> = { 'sess-a': { state: 'running' } }
    expect(applySessionActivity(running, { type: 'done', sessionId: 'sess-a' })).toEqual({})
    expect(applySessionActivity(running, { type: 'error', sessionId: 'sess-a' })).toEqual({})
  })

  it('keeps the map identical for frames without a session id or without effect', () => {
    const before: Record<string, SessionActivity> = { 'sess-a': { state: 'running' } }
    expect(applySessionActivity(before, { type: 'text' })).toBe(before)
    expect(applySessionActivity(before, { type: 'pong', sessionId: 'sess-a' })).toBe(before)
    expect(applySessionActivity(before, { type: 'text', sessionId: 'sess-a' })).toBe(before)
  })
})

describe('mapHistoryRows', () => {
  it('keeps the file of a task-injection answer, which carries two metadata kinds at once', () => {
    const rows: ChatHistoryRow[] = [{
      id: 89533,
      role: 'assistant',
      content: '**Task fertig, APK ist oben.**',
      timestamp: '2026-09-15T07:56:37.000Z',
      session_id: 'strand-1',
      metadata: JSON.stringify({
        type: 'task_injection_response',
        telegramDelivered: false,
        files: [{
          kind: 'file',
          originalName: 'offtangent-0.9.1-subtask-tree.apk',
          storedName: 'abc-offtangent.apk',
          relativePath: '2026/09/15/abc-offtangent.apk',
          urlPath: '/api/uploads/2026/09/15/abc-offtangent.apk',
          mimeType: 'application/octet-stream',
          size: 5_579_536,
        }],
      }),
    }]

    const [message] = mapHistoryRows(rows)

    expect(message!.isTaskInjection).toBe(true)
    expect(message!.attachments?.map(a => a.originalName)).toEqual(['offtangent-0.9.1-subtask-tree.apk'])
  })

  it('rebuilds plain and tool messages from history rows', () => {
    const rows: ChatHistoryRow[] = [
      { id: 1, role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z', session_id: 'sess-a' },
      {
        id: 2,
        role: 'tool',
        content: 'Tool: search',
        timestamp: '2026-01-01T00:00:01.000Z',
        session_id: 'sess-a',
        metadata: JSON.stringify({ toolName: 'search', toolCallId: 'call-1', toolArgs: { q: 'x' } }),
      },
      {
        id: 3,
        role: 'system',
        content: '',
        timestamp: '2026-01-01T00:00:02.000Z',
        session_id: 'sess-a',
        metadata: JSON.stringify({ type: 'session_divider', summary: 'we talked about roofs' }),
      },
    ]

    const mapped = mapHistoryRows(rows)
    expect(mapped.map(m => m.role)).toEqual(['user', 'tool', 'divider'])
    expect(mapped[1]!.toolData?.toolName).toBe('search')
    expect(mapped[2]!.content).toBe('we talked about roofs')
    expect(mapped[2]!.endedSessionId).toBe('sess-a')
  })

  it('renders rows of the same second in id order, not in the order they arrived', () => {
    // `chat_messages.timestamp` has second resolution: a quick exchange writes
    // several rows per second, and only `id` says which came first.
    const second = '2026-09-15T07:35:00.000Z'
    const rows: ChatHistoryRow[] = [
      { id: 12, role: 'assistant', content: 'meine antwort', timestamp: second, session_id: 's' },
      { id: 11, role: 'user', content: 'deine frage', timestamp: second, session_id: 's' },
      { id: 14, role: 'assistant', content: 'noch eine antwort', timestamp: second, session_id: 's' },
      { id: 13, role: 'user', content: 'noch eine frage', timestamp: second, session_id: 's' },
    ]

    expect(mapHistoryRows(rows).map(m => m.content)).toEqual([
      'deine frage',
      'meine antwort',
      'noch eine frage',
      'noch eine antwort',
    ])
  })

  it('does not mutate the array it was handed', () => {
    const rows: ChatHistoryRow[] = [
      { id: 2, role: 'user', content: 'b', timestamp: '2026-09-15T07:35:00.000Z', session_id: 's' },
      { id: 1, role: 'user', content: 'a', timestamp: '2026-09-15T07:35:00.000Z', session_id: 's' },
    ]
    mapHistoryRows(rows)
    expect(rows.map(r => r.id)).toEqual([2, 1])
  })

  it('carries the unambiguous timestamp straight through', () => {
    const rows: ChatHistoryRow[] = [{
      id: 1,
      role: 'user',
      content: 'hi',
      timestamp: '2026-09-15T06:15:53.000Z',
      timestampUtc: '2026-09-15T06:15:53.000Z',
      session_id: 's',
    }]
    expect(mapHistoryRows(rows)[0]!.timestamp).toBe('2026-09-15T06:15:53.000Z')
  })

  it('rebuilds a task card from the truncation metadata instead of a wall of text', () => {
    const rows: ChatHistoryRow[] = [{
      id: 7,
      role: 'system',
      content: '✅ Task completed: Long Report Task\n\nBuilt the thing…\n\n…5000 more characters — open the task card for the full report (task t-1).',
      timestamp: '2026-09-15T00:00:00.000Z',
      session_id: 'sess-a',
      metadata: JSON.stringify({
        type: 'task_result',
        taskId: 't-1',
        taskName: 'Long Report Task',
        taskResultStatus: 'completed',
        durationMinutes: 12,
        resultTruncated: true,
        resultFullLength: 5200,
      }),
    }]

    const mapped = mapHistoryRows(rows)
    expect(mapped[0]!.isTaskResult).toBe(true)
    expect(mapped[0]!.taskResultTaskId).toBe('t-1')
    expect(mapped[0]!.taskResultTruncated).toBe(true)
    expect(mapped[0]!.taskResultFullLength).toBe(5200)
    expect(mapped[0]!.content.length).toBeLessThan(400)
  })

  it('restores the answer of an interactive block from the message metadata', () => {
    const rows: ChatHistoryRow[] = [{
      id: 9,
      role: 'assistant',
      content: 'Your call.\n\n```offtangent\n{"block":"choice","id":"b1","question":"Hand this to Bob?","options":[{"id":"yes","label":"Hand over to Bob"},{"id":"stay","label":"Keep it here"}]}\n```',
      timestamp: '2026-09-15T00:00:00.000Z',
      session_id: 'sess-a',
      metadata: JSON.stringify({
        interactionAnswers: {
          b1: { blockId: 'b1', value: 'yes', label: 'Hand over to Bob', answeredAt: '2026-09-15T00:01:00.000Z', clientMessageId: 'c1', resumed: true },
        },
      }),
    }]

    const mapped = mapHistoryRows(rows)
    expect(mapped[0]!.interactionAnswers?.b1?.label).toBe('Hand over to Bob')
  })

  it('leaves a message without answers without an answer map', () => {
    const rows: ChatHistoryRow[] = [
      { id: 10, role: 'assistant', content: 'plain', timestamp: '2026-09-15T00:00:00.000Z', session_id: 'sess-a' },
    ]
    expect(mapHistoryRows(rows)[0]!.interactionAnswers).toBeUndefined()
  })
})

/*
 * Thread binding tests.
 *
 * `useChat` is a Nuxt composable: it relies on the auto-imported `useState`,
 * `useAuth`, `useApi` and `useRuntimeConfig`. We stub those as globals and swap
 * in a fake WebSocket so the real frame handling can be driven frame by frame.
 */

interface FakeSocket {
  readyState: number
  sent: string[]
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  send(data: string): void
  close(): void
}

let sockets: FakeSocket[] = []
let apiCalls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = []
let apiResponder: (path: string, options?: { method?: string; body?: unknown }) => unknown

function currentSocket(): FakeSocket {
  const socket = sockets[sockets.length - 1]
  if (!socket) throw new Error('no socket was opened')
  return socket
}

function receive(frame: Record<string, unknown>) {
  currentSocket().onmessage?.({ data: JSON.stringify(frame) })
}

function sentFrames(): Array<Record<string, unknown>> {
  return currentSocket().sent.map(raw => JSON.parse(raw) as Record<string, unknown>)
}

function historyRow(id: number, role: ChatHistoryRow['role'], content: string): ChatHistoryRow {
  return { id, role, content, timestamp: `2026-01-01T00:00:0${id}.000Z`, session_id: 'sess-a' }
}

const globals = globalThis as unknown as Record<string, unknown>
const originalWebSocket = globals.WebSocket

beforeEach(() => {
  sockets = []
  apiCalls = []
  apiResponder = () => ({})

  const states = new Map<string, Ref<unknown>>()
  globals.useState = <T>(key: string, init: () => T): Ref<T> => {
    if (!states.has(key)) states.set(key, ref(init()) as Ref<unknown>)
    return states.get(key) as Ref<T>
  }
  globals.useAuth = () => ({ getAccessToken: () => 'test-token' })
  globals.useRuntimeConfig = () => ({ public: { apiBase: 'http://localhost:3000' } })
  globals.useApi = () => ({
    apiFetch: async (path: string, options?: { method?: string; body?: unknown }) => {
      apiCalls.push({ path, options })
      return apiResponder(path, options)
    },
  })

  class FakeWebSocket implements FakeSocket {
    static readonly OPEN = 1
    readyState = 1
    sent: string[] = []
    onopen?: () => void
    onmessage?: (event: { data: string }) => void
    onclose?: () => void
    onerror?: () => void
    constructor(readonly url: string) { sockets.push(this) }
    send(data: string) { this.sent.push(data) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  globals.WebSocket = FakeWebSocket
})

afterEach(() => {
  useChat().disconnect()
  vi.clearAllTimers()
  globals.WebSocket = originalWebSocket
  delete globals.useState
  delete globals.useAuth
  delete globals.useRuntimeConfig
  delete globals.useApi
})

describe('useChat thread binding', () => {
  it('loads the thread transcript ascending and pages with the history cursor', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => historyRow(i + 1, 'user', `m${i + 1}`))
    apiResponder = (path) => {
      if (path.includes('since_id=0')) return { messages: firstPage }
      if (path.includes('since_id=100')) return { messages: [historyRow(101, 'assistant', 'last')] }
      return { messages: [] }
    }

    const chat = useChat()
    await chat.openThread('sess-a', 'bob')

    expect(apiCalls).toHaveLength(2)
    expect(apiCalls[0]!.path).toContain('session_id=sess-a')
    expect(apiCalls[0]!.path).toContain('since_id=0')
    expect(apiCalls[0]!.path).toContain('limit=100')
    expect(apiCalls[1]!.path).toContain('since_id=100')
    expect(chat.messages.value).toHaveLength(101)
    expect(chat.messages.value[0]!.content).toBe('m1')
    expect(chat.messages.value[100]!.content).toBe('last')
    expect(chat.boundSessionId.value).toBe('sess-a')
    expect(chat.sessionId.value).toBe('sess-a')
    expect(chat.loadingHistory.value).toBe(false)
  })

  it('sends the bound session id on the websocket frame', async () => {
    apiResponder = () => ({ messages: [] })
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    chat.connect()

    await chat.sendMessage('hello thread')

    expect(sentFrames()).toEqual([
      { type: 'message', content: 'hello thread', sessionId: 'sess-a', agentId: 'bob' },
    ])
  })

  it('sends the bound session id as a multipart field for attachments', async () => {
    apiResponder = (path) => {
      if (path === '/api/chat/message') {
        return { message: { session_id: 'sess-a', role: 'user', content: 'with file', timestamp: '2026-01-01T00:00:00.000Z' } }
      }
      return { messages: [] }
    }
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    chat.connect()

    await chat.sendMessage('with file', [new File(['x'], 'note.txt', { type: 'text/plain' })])

    const upload = apiCalls.find(call => call.path === '/api/chat/message')
    const body = upload!.options!.body as FormData
    expect(body.get('sessionId')).toBe('sess-a')
    expect(body.get('agentId')).toBe('bob')
    expect(sentFrames()[0]).toMatchObject({ type: 'message', sessionId: 'sess-a', skipSave: true })
  })

  it('omits the session fields in legacy mode so the old flow is untouched', async () => {
    const chat = useChat()
    chat.connect()

    await chat.sendMessage('legacy hello')

    expect(sentFrames()).toEqual([{ type: 'message', content: 'legacy hello' }])
    expect(chat.boundSessionId.value).toBeNull()
  })

  it('keeps frames of other threads out of the open thread and bumps the activity signal', async () => {
    apiResponder = () => ({ messages: [] })
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    chat.connect()

    receive({ type: 'text', text: 'mine', sessionId: 'sess-a' })
    receive({ type: 'text', text: 'not mine', sessionId: 'sess-b' })
    receive({ type: 'done', sessionId: 'sess-b' })

    expect(chat.messages.value.map(m => m.content)).toEqual(['mine'])
    expect(chat.threadActivity.value).toBe(2)
    expect(chat.sessionActivity.value['sess-a']).toEqual({ state: 'running' })
    expect(chat.sessionActivity.value['sess-b']).toBeUndefined()
  })

  it('drops unowned task completions, but permits a known persona fallback', async () => {
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    chat.connect()
    receive({ type: 'task_completed', taskName: 'Unowned' })
    receive({ type: 'text', text: 'unknown', agentId: 'other' })
    expect(chat.messages.value).toEqual([])
    receive({ type: 'text', text: 'owned', agentId: 'bob' })
    expect(chat.messages.value.map(m => m.content)).toEqual(['owned'])
  })

  it('stops locally without requiring an unowned backend stop reply or done frame', async () => {
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    chat.connect()
    await chat.sendMessage('hello')
    expect(chat.isStreaming.value).toBe(true)
    chat.stopTask()
    expect(chat.isStreaming.value).toBe(false)
    expect(chat.turnProgress.value['sess-a']?.phase).toBe('aborted')
    expect(chat.turnProgress.value['sess-a']?.endedAt).toBeTypeOf('number')
    const stopped = chat.turnProgress.value['sess-a']
    receive({ type: 'system', text: 'Task aborted. No queued messages.' })
    expect(chat.turnProgress.value['sess-a']).toBe(stopped)
    expect(chat.messages.value.map(m => m.content)).toEqual(['hello'])
  })

  it('does not install stale history after switching strands during a fetch', async () => {
    let release!: (value: unknown) => void
    apiResponder = (path) => path.includes('session_id=sess-a')
      ? new Promise(resolve => { release = resolve })
      : { messages: [{ ...historyRow(2, 'user', 'B'), session_id: 'sess-b' }] }
    const chat = useChat()
    const first = chat.openThread('sess-a', 'bob')
    await chat.openThread('sess-b', 'bob')
    release({ messages: [historyRow(1, 'user', 'A')] })
    await first
    expect(chat.messages.value.map(m => m.content)).toEqual(['B'])
  })

  it('catches up persisted interaction ids and artifacts after done', async () => {
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    chat.connect()
    receive({ type: 'text', text: 'answer', sessionId: 'sess-a' })
    apiResponder = () => ({ messages: [{ ...historyRow(9, 'assistant', 'answer'), artifacts: [{ id: 'artifact-1', title: 'Canvas' }] }] })
    receive({ type: 'done', sessionId: 'sess-a' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chat.messages.value[0]?.id).toBe(9)
    expect(chat.messages.value[0]?.artifacts).toEqual([{ id: 'artifact-1', title: 'Canvas' }])
  })

  it('tracks the queue position of another thread without touching the open one', async () => {
    apiResponder = () => ({ messages: [] })
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    chat.connect()

    receive({ type: 'queued', sessionId: 'sess-b', position: 3 })

    expect(chat.queuePosition.value).toBeNull()
    expect(chat.sessionActivity.value['sess-b']).toEqual({ state: 'queued', position: 3 })
  })

  it('shows the queue position of the open thread and clears it when the turn starts', async () => {
    apiResponder = () => ({ messages: [] })
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    chat.connect()

    receive({ type: 'queued', sessionId: 'sess-a', position: 2 })
    expect(chat.queuePosition.value).toBe(2)
    expect(chat.messages.value).toHaveLength(0)

    receive({ type: 'text', text: 'answer', sessionId: 'sess-a' })
    expect(chat.queuePosition.value).toBeNull()
  })

  it.each(['session_not_found', 'session_agent_mismatch', 'session_forbidden'])(
    'surfaces %s as a session error instead of a chat bubble',
    async (code) => {
      apiResponder = () => ({ messages: [] })
      const chat = useChat()
      await chat.openThread('sess-a', 'bob')
      chat.connect()

      receive({ type: 'error', code, error: 'nope', sessionId: 'sess-a' })

      expect(chat.sessionError.value).toBe(code)
      expect(chat.messages.value).toHaveLength(0)
      expect(chat.isStreaming.value).toBe(false)
    },
  )

  it('still renders provider errors as a bubble', async () => {
    apiResponder = () => ({ messages: [] })
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    chat.connect()

    receive({ type: 'error', error: '502 Bad Gateway', sessionId: 'sess-a' })

    expect(chat.sessionError.value).toBeNull()
    expect(chat.messages.value.map(m => m.role)).toEqual(['system'])
  })

  it('drops the binding when leaving the thread', async () => {
    apiResponder = () => ({ messages: [historyRow(1, 'user', 'hi')] })
    const chat = useChat()
    await chat.openThread('sess-a', 'bob')
    expect(chat.messages.value).toHaveLength(1)

    chat.leaveThread()

    expect(chat.boundSessionId.value).toBeNull()
    expect(chat.boundAgentId.value).toBeNull()
    expect(chat.messages.value).toHaveLength(0)
  })
})

describe('shared feed websocket integration', () => {
  it('resynchronizes feed rows and unread count when the shared socket opens', async () => {
    apiResponder = (path) => path === '/api/feed/unread-count' ? { count: 4 } : { items: [{ id: 'missed', readAt: null }] }
    const chat = useChat()
    chat.connect()
    currentSocket().onopen?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    const useState = globals.useState as <T>(key: string, init: () => T) => Ref<T>
    expect(useState('feed_items', () => []).value).toMatchObject([{ id: 'missed' }])
    expect(useState('feed_unread', () => 0).value).toBe(4)
    expect(apiCalls.map(call => call.path)).toContain('/api/feed?limit=200')
  })
  it.each(['item', 'feedItem'])('folds feed_item %s into shared feed state without adding a chat row or socket', (field) => {
    const chat = useChat()
    chat.connect()
    const before = chat.messages.value.length
    receive({ type: 'feed_item', [field]: { id: 'f-1', title: 'Report', kind: 'cron_report', readAt: null, body: null } })
    const state = (globals.useState as <T>(key: string, init: () => T) => Ref<T>)('feed_items', () => [])
    expect(state.value).toMatchObject([{ id: 'f-1' }])
    expect(chat.messages.value).toHaveLength(before)
    expect(sockets).toHaveLength(1)
  })
  it('retains the existing connection while shell navigation owns it', () => {
    const chat = useChat()
    const releaseDesktop = chat.retainConnection()
    const releaseMobile = chat.retainConnection()
    chat.disconnect()
    expect(currentSocket().readyState).toBe(1)
    expect(sockets).toHaveLength(1)
    releaseDesktop()
    expect(currentSocket().readyState).toBe(1)
    releaseMobile()
    expect(currentSocket().readyState).toBe(3)
    releaseMobile()
  })
})
