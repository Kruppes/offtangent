import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { Database } from '@axiom/core'
import type { TaskEventBus, TaskEvent } from '@axiom/core'
import { TaskStore } from '@axiom/core'
import { getToolCalls, INTERNAL_METRIC_TOOL_NAMES } from '@axiom/core'
import { toIsoUtc, timestampSortKey } from '@axiom/core'
import { verifyAccessToken } from './auth.js'
import { URL } from 'node:url'

export interface WebSocketTaskOptions {
  server: Server
  db: Database
  taskEventBus: TaskEventBus
}

interface TaskWsMessage {
  type: string
  [key: string]: unknown
}

/**
 * Set up WebSocket server for live task event streaming at /ws/task/:id
 *
 * Authentication via ?token=<jwt> query parameter (same pattern as ws/chat).
 * On connection:
 *  - If the task is running, sends full event backlog then streams live events.
 *  - If the task is completed/failed, sends a "load_from_rest" hint (client uses REST API).
 */
export function setupWebSocketTask(options: WebSocketTaskOptions): WebSocketServer {
  const { server, db, taskEventBus } = options
  const wss = new WebSocketServer({ noServer: true })
  const store = new TaskStore(db)

  // Handle upgrade requests for /ws/task/:id path
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', 'http://localhost')
    const match = url.pathname.match(/^\/ws\/task\/([^/]+)$/)
    if (!match) return

    const taskId = match[1]

    // Authenticate via token query param
    const token = url.searchParams.get('token')
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    const user = verifyAccessToken(token)
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleTaskConnection(ws, taskId)
    })
  })

  function handleTaskConnection(ws: WebSocket, taskId: string): void {
    // Verify task exists
    const task = store.getById(taskId)
    if (!task) {
      sendMessage(ws, { type: 'error', error: 'Task not found' })
      ws.close()
      return
    }

    // Send task metadata
    sendMessage(ws, {
      type: 'task_info',
      taskId: task.id,
      name: task.name,
      status: task.status,
      prompt: task.prompt,
      resultSummary: task.resultSummary,
      errorMessage: task.errorMessage,
    })

    if (task.status === 'running' || task.status === 'paused') {
      // Send backlog of events for late joiners
      const backlog = taskEventBus.getBacklog(taskId)
      if (backlog.length > 0) {
        sendMessage(ws, { type: 'backlog_start', count: backlog.length })
        for (const event of backlog) {
          sendMessage(ws, taskEventToWsMessage(event))
        }
        sendMessage(ws, { type: 'backlog_end' })
      }

      // Subscribe to live events
      const unsubscribe = taskEventBus.subscribeToTask(taskId, (event: TaskEvent) => {
        if (ws.readyState === WebSocket.OPEN) {
          sendMessage(ws, taskEventToWsMessage(event))
        }
      })

      ws.on('close', () => {
        unsubscribe()
      })

      ws.on('error', () => {
        unsubscribe()
      })
    } else {
      // Task is completed/failed — send historical data from DB.
      // If the task has no sessionId (legacy / pre-migration data), there is
      // nothing to load — just send an empty history block.
      if (!task.sessionId) {
        sendMessage(ws, { type: 'history_start', count: 0 })
        sendMessage(ws, { type: 'history_end' })
        return
      }
      sendHistoricalEvents(ws, task.id, task.sessionId)
    }
  }

  function sendHistoricalEvents(ws: WebSocket, taskId: string, sessionId: string): void {
    try {
      // Get tool calls
      const toolCalls = getToolCalls(db, { sessionId })
        .reverse()
        // Metric rows (SPEC 12.2, e.g. `task_history` context trims) live in
        // the same table but are not tool calls the task made.
        .filter(tc => !INTERNAL_METRIC_TOOL_NAMES.has(tc.toolName))
        .map(tc => ({
          type: 'tool_call_end' as const,
          taskId,
          // Normalized like every other timestamp on the wire — and the merge
          // below depends on both sides speaking the same format.
          timestamp: tc.timestamp ? toIsoUtc(tc.timestamp) : new Date().toISOString(),
          toolName: tc.toolName,
          toolArgs: safeParseJson(tc.input),
          toolResult: safeParseJson(tc.output),
          toolIsError: tc.status === 'error',
          durationMs: tc.durationMs,
        }))

      // Get chat messages
      const messages = (db.prepare(
        // `id` breaks the tie: `timestamp` has second resolution and a task
        // writes several rows per second.
        'SELECT role, content, metadata, timestamp FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC'
      ).all(sessionId) as { role: string; content: string; metadata: string | null; timestamp: string }[])
        .filter(m => m.role === 'assistant')
        .map(m => {
          const meta = m.metadata ? safeParseJson(m.metadata) as Record<string, unknown> | null : null
          return {
            type: 'text_delta' as const,
            taskId,
            timestamp: toIsoUtc(m.timestamp),
            text: m.content,
            thinking: meta?.thinking as string | undefined,
          }
        })

      // Merge chronologically. Compare instants, not strings: a string compare
      // would put every ISO row after every naked SQLite row (`'T' > ' '`), and
      // a stable sort keeps the per-source order for equal instants.
      const events = [...toolCalls, ...messages].sort((a, b) =>
        timestampSortKey(a.timestamp) - timestampSortKey(b.timestamp)
      )

      sendMessage(ws, { type: 'history_start', count: events.length })
      for (const event of events) {
        sendMessage(ws, event)
      }
      sendMessage(ws, { type: 'history_end' })
    } catch (err) {
      sendMessage(ws, { type: 'error', error: `Failed to load history: ${(err as Error).message}` })
    }
  }

  return wss
}

function sendMessage(ws: WebSocket, msg: TaskWsMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function taskEventToWsMessage(event: TaskEvent): TaskWsMessage {
  return {
    type: event.type,
    taskId: event.taskId,
    timestamp: event.timestamp,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    toolArgs: event.toolArgs,
    toolResult: event.toolResult,
    toolIsError: event.toolIsError,
    durationMs: event.durationMs,
    text: event.text,
    status: event.status,
    statusMessage: event.statusMessage,
  }
}

function safeParseJson(str: string | undefined | null): unknown {
  if (!str) return null
  try {
    return JSON.parse(str)
  } catch {
    return str
  }
}
