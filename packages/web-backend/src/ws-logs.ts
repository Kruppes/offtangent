import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { verifyAccessToken } from './auth.js'
import type { JwtPayload } from './auth.js'
import { URL } from 'node:url'
import type { ToolCallRecord } from '@axiom/core'

/**
 * Set up WebSocket server for real-time log streaming at /ws/logs
 * Uses noServer mode to avoid conflicting with other WebSocket servers.
 */
export function setupWebSocketLogs(server: Server): {
  wss: WebSocketServer
  broadcast: (record: ToolCallRecord) => void
} {
  const wss = new WebSocketServer({ noServer: true })

  const authenticatedClients = new Map<WebSocket, JwtPayload>()

  // Handle upgrade requests for /ws/logs path
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '', 'http://localhost').pathname
    if (pathname !== '/ws/logs') return

    // Authenticate before upgrading
    let user: JwtPayload | null = null
    try {
      const url = new URL(request.url ?? '', 'http://localhost')
      const token = url.searchParams.get('token')
      if (token) {
        user = verifyAccessToken(token)
      }
    } catch {
      // ignore
    }

    if (!user || user.role !== 'admin') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      authenticatedClients.set(ws, user!)
      ws.send(JSON.stringify({ type: 'connected' }))

      ws.on('close', () => {
        authenticatedClients.delete(ws)
      })

      ws.on('error', () => {
        authenticatedClients.delete(ws)
      })
    })
  })

  function broadcast(record: ToolCallRecord): void {
    const data = JSON.stringify({ type: 'log_entry', data: record })
    for (const [client] of authenticatedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    }
  }

  return { wss, broadcast }
}
