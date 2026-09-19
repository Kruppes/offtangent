import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase, insertFeedItem } from '@axiom/core'
import type { AgentCore, ResponseChunk } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { ChatEventBus } from './chat-event-bus.js'
import { ChatActionRegistry } from './chat-actions.js'

interface BufferedWs {
  ws: WebSocket
  waitForMessage: () => Promise<Record<string, unknown>>
  expectNoMessageWithin: (ms: number) => Promise<void>
}

function connectWs(port: number, token: string): Promise<BufferedWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/chat?token=${token}`)
    const messages: Record<string, unknown>[] = []
    let pendingResolve: ((msg: Record<string, unknown>) => void) | null = null

    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>
      if (pendingResolve) {
        const current = pendingResolve
        pendingResolve = null
        current(parsed)
      } else {
        messages.push(parsed)
      }
    })

    ws.on('open', () => {
      resolve({
        ws,
        waitForMessage: () => {
          if (messages.length > 0) {
            return Promise.resolve(messages.shift()!)
          }

          return new Promise((res) => {
            pendingResolve = res
          })
        },
        expectNoMessageWithin: async (ms: number) => {
          if (messages.length > 0) {
            throw new Error(`Expected no queued message, got: ${JSON.stringify(messages[0])}`)
          }

          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, ms)
            pendingResolve = (msg) => {
              clearTimeout(timer)
              pendingResolve = null
              reject(new Error(`Expected no message within ${ms}ms, got: ${JSON.stringify(msg)}`))
            }
          })
        },
      })
    })

    ws.on('error', reject)
  })
}

describe('setupWebSocketChat kill switch', () => {
  it('aborts the active agent task when /stop is sent from web chat', async () => {
    const db = initDatabase(':memory:')
    let releaseTask!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseTask = resolve
    })

    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-1-mock', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Working...' }
        await blocked
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'message', content: 'hello' }))
      const firstChunk = await waitForMessage()
      expect(firstChunk.type).toBe('text')
      expect(firstChunk.text).toBe('Working...')

      ws.send(JSON.stringify({ type: 'command', content: '/stop' }))
      const stopMessage = await waitForMessage()
      expect(stopMessage.type).toBe('system')
      expect(stopMessage.text).toBe('Task aborted. No queued messages.')
      expect(agentCore.abort).toHaveBeenCalledTimes(1)

      releaseTask()
      ws.close()
    } finally {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('immediately announces the new session on /new without waiting for the background summary', async () => {
    const db = initDatabase(':memory:')
    const chatEventBus = new ChatEventBus()
    const newSession = {
      id: 'session-new-async',
      userId: '1',
      source: 'web',
      startedAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      summaryWritten: false,
      restored: false,
    }
    let summaryResolved = false
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => newSession),
    }
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      // The new code path: resetSessionAsync returns synchronously with the
      // newly minted session. It must NOT block on summary generation.
      resetSessionAsync: vi.fn(() => {
        // Pretend the background summary completes 1 second later. The
        // /new handler must respond well before that.
        setTimeout(() => {
          summaryResolved = true
        }, 1000)
        return newSession
      }),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, chatEventBus)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage, expectNoMessageWithin } = await connectWs(port, token)
      await waitForMessage() // authenticated

      const before = Date.now()
      ws.send(JSON.stringify({ type: 'command', content: '/new' }))
      const sessionEnd = await waitForMessage()
      const elapsed = Date.now() - before

      expect(sessionEnd.type).toBe('session_end')
      expect(sessionEnd.sessionId).toBe('session-new-async')
      expect(sessionEnd.text).toBeUndefined()
      // The response must arrive synchronously, well before the simulated
      // background summary completes.
      expect(elapsed).toBeLessThan(500)
      expect(summaryResolved).toBe(false)
      await expectNoMessageWithin(30)
      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('forwards a late session_summary chat-event-bus broadcast to the connected client', async () => {
    const db = initDatabase(':memory:')
    const chatEventBus = new ChatEventBus()
    const newSession = {
      id: 'new-session-id',
      userId: '1',
      source: 'web',
      startedAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      summaryWritten: false,
      restored: false,
    }
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => newSession),
    }
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      resetSessionAsync: vi.fn(() => newSession),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, chatEventBus)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'command', content: '/new' }))
      const sessionEnd = await waitForMessage()
      expect(sessionEnd.type).toBe('session_end')
      expect(sessionEnd.sessionId).toBe('new-session-id')
      expect(sessionEnd.text).toBeUndefined()

      // Simulate the background summary completing and being broadcast
      // by runtime-composition's onSessionEnd handler.
      chatEventBus.broadcast({
        type: 'session_summary',
        userId: 1,
        source: 'web',
        sessionId: 'old-session-id',
        text: 'Late-arriving background summary.',
      })

      const summaryEvent = await waitForMessage()
      expect(summaryEvent.type).toBe('session_summary')
      expect(summaryEvent.sessionId).toBe('old-session-id')
      expect(summaryEvent.text).toBe('Late-arriving background summary.')
      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('streams thinking chunks, persists them with metadata.kind=thinking, and fans them out to every tab', async () => {
    const db = initDatabase(':memory:')
    const chatEventBus = new ChatEventBus()
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-thinking', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'thinking', thinking: 'Hmm,' }
        yield { type: 'thinking', thinking: ' let me think.' }
        yield { type: 'text', text: 'Answer.' }
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, chatEventBus)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated
      // A second tab of the same user attaches to the same turn stream.
      const second = await connectWs(port, token)
      await second.waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'message', content: 'hello' }))

      const firstThinking = await waitForMessage()
      expect(firstThinking.type).toBe('thinking')
      expect(firstThinking.thinking).toBe('Hmm,')

      const secondThinking = await waitForMessage()
      expect(secondThinking.type).toBe('thinking')
      expect(secondThinking.thinking).toBe(' let me think.')

      const text = await waitForMessage()
      expect(text.type).toBe('text')
      expect(text.text).toBe('Answer.')

      const done = await waitForMessage()
      expect(done.type).toBe('done')

      // Thinking block persisted as its own assistant row with metadata.kind === 'thinking'
      const rows = db.prepare(
        "SELECT role, content, metadata FROM chat_messages WHERE session_id = 'session-thinking' ORDER BY id"
      ).all() as Array<{ role: string; content: string; metadata: string | null }>
      const thinkingRows = rows.filter(r => {
        if (!r.metadata) return false
        try {
          return (JSON.parse(r.metadata) as { kind?: string }).kind === 'thinking'
        } catch { return false }
      })
      expect(thinkingRows.length).toBe(1)
      expect(thinkingRows[0]!.role).toBe('assistant')
      expect(thinkingRows[0]!.content).toBe('Hmm, let me think.')

      // Assistant text persisted as its own row without thinking metadata
      const assistantTextRows = rows.filter(r => r.role === 'assistant' && (!r.metadata || !(() => { try { return (JSON.parse(r.metadata!) as { kind?: string }).kind === 'thinking' } catch { return false } })()))
      expect(assistantTextRows.length).toBe(1)
      expect(assistantTextRows[0]!.content).toBe('Answer.')

      // The second tab sees the identical stream via the turn runner.
      const secondStream: Array<Record<string, unknown>> = []
      for (let i = 0; i < 10; i++) {
        const msg = await second.waitForMessage()
        if (msg.type === 'external_user_message') continue
        secondStream.push(msg)
        if (msg.type === 'done') break
      }
      expect(secondStream.map(m => m.type)).toEqual(['thinking', 'thinking', 'text', 'done'])
      expect(secondStream[0]!.thinking).toBe('Hmm,')
      expect(secondStream[1]!.thinking).toBe(' let me think.')

      second.ws.close()
      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('forwards uploads attached to a tool_call_end chunk as an `attachment` ws message and persists them on the assistant row', async () => {
    const db = initDatabase(':memory:')
    const chatEventBus = new ChatEventBus()
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-file', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const uploadDescriptor = {
      kind: 'file' as const,
      originalName: 'report.md',
      storedName: 'abc-report.md',
      relativePath: '2026/04/20/abc-report.md',
      urlPath: '/api/uploads/2026/04/20/abc-report.md',
      mimeType: 'text/markdown',
      size: 42,
    }
    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'tool_call_start', toolName: 'send_file_to_user', toolCallId: 'tc-1', toolArgs: { path: 'report.md' } }
        yield {
          type: 'tool_call_end',
          toolName: 'send_file_to_user',
          toolCallId: 'tc-1',
          toolResult: { details: { uploadedFile: uploadDescriptor } },
        }
        yield { type: 'text', text: 'Here you go.' }
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, chatEventBus)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'message', content: 'send me the report' }))

      // Drain chunks until we see both the attachment ws msg and the done.
      const seen: string[] = []
      let attachmentMsg: Record<string, unknown> | null = null
      for (let i = 0; i < 20; i++) {
        const msg = await waitForMessage()
        seen.push(msg.type as string)
        if (msg.type === 'attachment') attachmentMsg = msg
        if (msg.type === 'done') break
      }

      expect(seen).toContain('attachment')
      expect(seen).toContain('done')
      expect(attachmentMsg?.attachment).toMatchObject({
        relativePath: uploadDescriptor.relativePath,
        originalName: uploadDescriptor.originalName,
      })
      // No `messageId`: the turn's row is written when the turn ends, so this
      // file belongs to the answer that is still streaming.
      expect(attachmentMsg?.messageId).toBeUndefined()

      // Assistant row persists the upload as metadata.files so history reload
      // shows the download card
      const assistantRow = db.prepare(
        "SELECT content, metadata FROM chat_messages WHERE session_id = 'session-file' AND role = 'assistant'"
      ).get() as { content: string; metadata: string } | undefined
      expect(assistantRow).toBeDefined()
      expect(assistantRow!.content).toBe('Here you go.')
      const meta = JSON.parse(assistantRow!.metadata) as { files: Array<{ relativePath: string }> }
      expect(meta.files).toHaveLength(1)
      expect(meta.files[0]!.relativePath).toBe(uploadDescriptor.relativePath)

      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('forwards a chat-event-bus `attachment` with the session and persona it was broadcast for', async () => {
    const db = initDatabase(':memory:')
    const chatEventBus = new ChatEventBus()
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-web', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, chatEventBus)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      // A Telegram turn (or a background task) broadcasts its attachment on
      // the bus; the web client must be able to route it to a strand.
      chatEventBus.broadcast({
        type: 'attachment',
        userId: 1,
        source: 'telegram',
        sessionId: 'session-telegram',
        agentId: 'fable',
        attachment: {
          kind: 'file',
          originalName: 'report.md',
          storedName: 'abc-report.md',
          relativePath: '2026/09/14/abc-report.md',
          urlPath: '/api/uploads/2026/09/14/abc-report.md',
          mimeType: 'text/markdown',
          size: 42,
          caption: 'The weekly report',
        },
        messageId: 4711,
      })

      const frame = await waitForMessage()
      expect(frame.type).toBe('attachment')
      expect(frame.sessionId).toBe('session-telegram')
      expect(frame.agentId).toBe('fable')
      expect(frame.attachment).toMatchObject({
        relativePath: '2026/09/14/abc-report.md',
        caption: 'The weekly report',
      })
      // The file already has its own persisted row; naming it keeps the live
      // card and the reloaded row the same one message.
      expect(frame.messageId).toBe(4711)

      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('forwards a chat-event-bus `feed_item` as an additive frame', async () => {
    const db = initDatabase(':memory:')
    const chatEventBus = new ChatEventBus()
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-web', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, chatEventBus)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      const item = insertFeedItem(db, {
        userId: '1',
        kind: 'cron_report',
        title: 'Morning report',
        body: 'Nothing urgent',
        taskId: 'task-42',
        agentId: 'main',
      })
      chatEventBus.broadcast({ type: 'feed_item', userId: 1, source: 'task', feedItem: item })

      const frame = await waitForMessage()
      expect(frame.type).toBe('feed_item')
      expect(frame.item).toMatchObject({ id: item.id, kind: 'cron_report', title: 'Morning report', taskId: 'task-42' })

      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('keeps the turn running after the driving socket closes and replays it to a reconnecting client', async () => {
    const db = initDatabase(':memory:')
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => { releaseTail = resolve })

    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-reattach', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'thinking', thinking: 'pondering' }
        yield { type: 'text', text: 'first half' }
        await tail
        yield { type: 'text', text: ' second half' }
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss, turnRunner } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const first = await connectWs(port, token)
      await first.waitForMessage() // authenticated
      first.ws.send(JSON.stringify({ type: 'message', content: 'hello' }))

      expect((await first.waitForMessage()).thinking).toBe('pondering')
      expect((await first.waitForMessage()).text).toBe('first half')

      // Simulate a page reload: the socket dies mid-turn.
      first.ws.close()
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      expect(agentCore.abort).not.toHaveBeenCalled()
      expect(turnRunner.hasActiveTurn(1)).toBe(true)

      // The reconnecting client replays the partial turn, then continues live.
      const second = await connectWs(port, token)
      await second.waitForMessage() // authenticated
      expect((await second.waitForMessage()).type).toBe('turn_replay_start')
      expect(await second.waitForMessage()).toMatchObject({ type: 'thinking', thinking: 'pondering' })
      expect(await second.waitForMessage()).toMatchObject({ type: 'text', text: 'first half' })

      releaseTail()
      expect(await second.waitForMessage()).toMatchObject({ type: 'text', text: ' second half' })
      expect((await second.waitForMessage()).type).toBe('done')

      // The full response is persisted even though the original socket is gone.
      const assistantRow = db.prepare(
        "SELECT content FROM chat_messages WHERE session_id = 'session-reattach' AND role = 'assistant' AND metadata IS NULL"
      ).get() as { content: string } | undefined
      expect(assistantRow?.content).toBe('first half second half')

      second.ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('persists the assistant response when the turn finishes with no client connected', async () => {
    const db = initDatabase(':memory:')
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => { releaseTail = resolve })

    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-detached', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'started' }
        await tail
        yield { type: 'text', text: ' and finished' }
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss, turnRunner } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated
      ws.send(JSON.stringify({ type: 'message', content: 'hello' }))
      expect((await waitForMessage()).text).toBe('started')

      ws.close()
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      releaseTail()

      await vi.waitFor(() => expect(turnRunner.hasActiveTurn(1)).toBe(false))

      const assistantRow = db.prepare(
        "SELECT content FROM chat_messages WHERE session_id = 'session-detached' AND role = 'assistant'"
      ).get() as { content: string } | undefined
      expect(assistantRow?.content).toBe('started and finished')
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('responds to /help with a system message listing slash commands', async () => {
    const db = initDatabase(':memory:')
    const mockSessionManager3 = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-1-mock', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager3),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'command', content: '/help' }))
      const helpMessage = await waitForMessage()
      expect(helpMessage.type).toBe('system')
      const text = (helpMessage.text as string) ?? ''
      expect(text).toContain('/help')
      expect(text).toContain('/new')
      expect(text).toContain('/stop')
      expect(text).toContain('/tasks')
      expect(text).toContain('/cronjobs')
      expect(text).toContain('/model')
      expect(text).not.toContain('/settings')
      expect(agentCore.sendMessage).not.toHaveBeenCalled()
      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('responds to /unknown with a system message and does not forward to the agent', async () => {
    const db = initDatabase(':memory:')
    const mockSessionManager4 = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-1-mock', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager4),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'command', content: '/doesnotexist' }))
      const reply = await waitForMessage()
      expect(reply.type).toBe('system')
      expect(reply.text).toContain('Unknown command')
      expect(agentCore.sendMessage).not.toHaveBeenCalled()
      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('treats /kill as an alias for /stop over web chat', async () => {
    const db = initDatabase(':memory:')
    const mockSessionManager2 = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-1-mock', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager2),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'command', content: '/kill' }))
      const stopMessage = await waitForMessage()
      expect(stopMessage.type).toBe('system')
      expect(stopMessage.text).toBe('Nothing to stop.')
      expect(agentCore.abort).not.toHaveBeenCalled()
      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })
  it('streams a stall warning, persists it and resolves it in place across a reconnect', async () => {
    const originalDataDir = process.env.DATA_DIR
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-stall-'))
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
    fs.writeFileSync(
      path.join(dataDir, 'config', 'settings.json'),
      JSON.stringify({ watchdog: { stallWarnMs: 100, stallAbortMs: 60_000 } }),
      'utf-8',
    )
    process.env.DATA_DIR = dataDir

    const db = initDatabase(':memory:')
    let releaseTail!: () => void
    const tail = new Promise<void>((resolve) => { releaseTail = resolve })

    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-stall', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'starting' }
        await tail
        yield { type: 'text', text: ' finished' }
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const first = await connectWs(port, token)
      await first.waitForMessage() // authenticated
      first.ws.send(JSON.stringify({ type: 'message', content: 'hello' }))
      expect((await first.waitForMessage()).text).toBe('starting')

      const warning = await first.waitForMessage()
      expect(warning.type).toBe('stall_warning')
      expect(warning.text).toContain('Provider has not responded')
      const warned = warning.stall as { messageId: number; startedAt: string; durationMs: number }
      expect(warned.messageId).toBeGreaterThan(0)

      const stallRow = db.prepare(
        'SELECT id, role, content, metadata FROM chat_messages WHERE id = ?'
      ).get(warned.messageId) as { id: number; role: string; content: string; metadata: string }
      expect(stallRow.role).toBe('system')
      expect(JSON.parse(stallRow.metadata)).toMatchObject({
        kind: 'provider_stall',
        outcome: null,
        resolvedAt: null,
      })

      // Page refresh while stalled: the warning is replayed to the new socket.
      first.ws.close()
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      const second = await connectWs(port, token)
      await second.waitForMessage() // authenticated
      expect((await second.waitForMessage()).type).toBe('turn_replay_start')
      expect(await second.waitForMessage()).toMatchObject({ type: 'text', text: 'starting' })
      const replayedWarning = await second.waitForMessage()
      expect(replayedWarning.type).toBe('stall_warning')
      expect((replayedWarning.stall as { messageId: number }).messageId).toBe(warned.messageId)

      releaseTail()
      const resolved = await second.waitForMessage()
      expect(resolved.type).toBe('stall_resolved')
      expect(resolved.text).toContain('Provider recovered')
      expect(resolved.stall).toMatchObject({ messageId: warned.messageId, outcome: 'recovered' })

      // Same row, updated instead of duplicated.
      const rowsAfter = db.prepare(
        "SELECT id, metadata FROM chat_messages WHERE session_id = 'session-stall' AND role = 'system'"
      ).all() as Array<{ id: number; metadata: string }>
      expect(rowsAfter).toHaveLength(1)
      expect(rowsAfter[0]!.id).toBe(warned.messageId)
      expect(JSON.parse(rowsAfter[0]!.metadata)).toMatchObject({ kind: 'provider_stall', outcome: 'recovered' })

      second.ws.close()
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = originalDataDir
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('streams a retry status and the answer of the retried turn', async () => {
    const originalDataDir = process.env.DATA_DIR
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-retry-'))
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
    fs.writeFileSync(
      path.join(dataDir, 'config', 'settings.json'),
      JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } }),
      'utf-8',
    )
    process.env.DATA_DIR = dataDir

    const db = initDatabase(':memory:')
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-retry', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }

    let attempts = 0
    const stream = async function* (): AsyncGenerator<ResponseChunk> {
      attempts++
      if (attempts === 1) {
        yield { type: 'text', text: 'half an answer' }
        yield { type: 'error', error: '429 Too Many Requests' }
        return
      }
      yield { type: 'text', text: 'the real answer' }
      yield { type: 'done' }
    }

    const agentCore = {
      sendMessage: vi.fn(stream),
      retryTurn: vi.fn(stream),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const client = await connectWs(port, token)
      await client.waitForMessage() // authenticated
      client.ws.send(JSON.stringify({ type: 'message', content: 'hello' }))

      expect((await client.waitForMessage()).text).toBe('half an answer')

      const retry = await client.waitForMessage()
      expect(retry.type).toBe('retry_scheduled')
      expect(retry.retry).toMatchObject({ attempt: 1, maxRetries: 2, delayMs: 10 })
      expect(retry.text).toContain('retrying (1/2)')

      expect(await client.waitForMessage()).toMatchObject({ type: 'text', text: 'the real answer' })
      expect((await client.waitForMessage()).type).toBe('done')

      // The discarded attempt left nothing behind — only the user message and
      // the answer of the successful attempt are persisted.
      const persisted = db.prepare(
        "SELECT role, content FROM chat_messages WHERE session_id = 'session-retry' ORDER BY id"
      ).all() as Array<{ role: string; content: string }>
      expect(persisted).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'the real answer' },
      ])

      client.ws.close()
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = originalDataDir
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('persists a terminal provider error and replays it to a reconnecting client', async () => {
    const db = initDatabase(':memory:')
    const providerError = 'AuthenticationError: 401 Unauthorized — OAuth token refresh failed'
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-error', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }

    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'error', error: providerError }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const first = await connectWs(port, token)
      await first.waitForMessage() // authenticated
      first.ws.send(JSON.stringify({ type: 'message', content: 'hello' }))

      const error = await first.waitForMessage()
      expect(error.type).toBe('error')
      expect(error.error).toBe(providerError)
      expect(error.text).toContain(providerError)
      const errorInfo = error.errorInfo as { messageId: number; cause: string; retryable: boolean }
      expect(errorInfo).toMatchObject({ cause: 'non_retryable', retryable: false })
      expect((await first.waitForMessage()).type).toBe('done')

      // The failure is a durable row (full provider text included), so a reload
      // still shows it instead of the turn dying silently.
      const row = db.prepare(
        'SELECT role, content, metadata FROM chat_messages WHERE id = ?'
      ).get(errorInfo.messageId) as { role: string; content: string; metadata: string }
      expect(row.role).toBe('system')
      expect(row.content).toBe(error.text)
      expect(JSON.parse(row.metadata)).toMatchObject({
        kind: 'turn_error',
        cause: 'non_retryable',
        error: providerError,
        attempts: 0,
        retryable: false,
      })

      // Reload: the replay carries the same row id so the client rebuilds the
      // very same error bubble instead of appending a second one.
      first.ws.close()
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      const second = await connectWs(port, token)
      await second.waitForMessage() // authenticated
      expect((await second.waitForMessage()).type).toBe('turn_replay_start')
      const replayedError = await second.waitForMessage()
      expect(replayedError.type).toBe('error')
      expect((replayedError.errorInfo as { messageId: number }).messageId).toBe(errorInfo.messageId)

      second.ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('re-runs a failed turn through the Retry button without re-sending the user message', async () => {
    const db = initDatabase(':memory:')
    const sessionId = 'session-manual-retry'

    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: sessionId, userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }

    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'error', error: '401 invalid x-api-key' }
      }),
      retryTurn: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Recovered.' }
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const resolutions: string[] = []
    const chatActions = new ChatActionRegistry({
      publishToClients: event => resolutions.push(event.message.resolution ?? ''),
    })

    const app = createApp({ db, chatActions })
    // The retry checks the session is still open, so it needs a real row
    // (`createApp` seeded the admin user this session belongs to).
    db.prepare(
      'INSERT INTO sessions (id, user_id, source, type) VALUES (?, ?, ?, ?)'
    ).run(sessionId, 1, 'web', 'interactive')
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, undefined, chatActions)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated
      ws.send(JSON.stringify({ type: 'message', content: 'summarize my inbox' }))

      const error = await waitForMessage()
      const errorInfo = error.errorInfo as { messageId: number; retryActionId: string }
      expect(errorInfo.retryActionId).toMatch(/^turn-retry-/)
      expect((await waitForMessage()).type).toBe('done')

      const res = await fetch(`http://127.0.0.1:${port}/api/chat/actions/${errorInfo.retryActionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId: 'retry' }),
      })
      expect(res.status).toBe(200)
      expect(resolutions).toHaveLength(1)

      // The retried turn streams to the still-connected client like any other.
      const text = await waitForMessage()
      expect(text).toMatchObject({ type: 'text', text: 'Recovered.' })
      expect((await waitForMessage()).type).toBe('done')

      // Continue-style: the transcript keeps exactly one user message.
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      const rows = db.prepare(
        'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id'
      ).all(sessionId) as { role: string; content: string }[]
      expect(rows.filter(r => r.role === 'user')).toEqual([{ role: 'user', content: 'summarize my inbox' }])
      expect(rows[rows.length - 1]).toEqual({ role: 'assistant', content: 'Recovered.' })

      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })
})
