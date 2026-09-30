import http from 'node:http'
import { createApp } from '../app.js'
import { setupWebSocketChat } from '../ws-chat.js'
import { setupWebSocketLogs } from '../ws-logs.js'
import { setupWebSocketTask } from '../ws-task.js'
import type { RuntimeComposition } from './runtime-composition.js'

export interface HttpBoundaryOptions {
  host: string
  port: number
  logger?: Pick<typeof console, 'log'>
}

export interface StartedHttpBoundary {
  server: http.Server
  host: string
  port: number
  stopHttp: () => Promise<void>
}

export async function startHttpBoundary(
  runtimeComposition: RuntimeComposition,
  options: HttpBoundaryOptions,
): Promise<StartedHttpBoundary> {
  const logger = options.logger ?? console

  const app = createApp({
    db: runtimeComposition.db,
    getAgentCore: runtimeComposition.getAgentCore,
    healthMonitorService: runtimeComposition.healthMonitorService,
    getQuotaSnapshot: () => runtimeComposition.quotaMonitorService.getSnapshot(),
    refreshQuota: (providerId) => runtimeComposition.quotaMonitorService.refreshProvider(providerId),
    runtimeMetrics: runtimeComposition.runtimeMetrics,
    consolidationScheduler: runtimeComposition.consolidationScheduler,
    agentHeartbeatService: runtimeComposition.agentHeartbeatService,
    onAgentHeartbeatSettingsChanged: () => {},
    getTaskRuntime: runtimeComposition.getTaskRuntime,
    replyToTask: runtimeComposition.replyToTask,
    resolveProvider: runtimeComposition.resolveProvider,
    // Tasks created through the HTTP API carry trigger_type='user', so the
    // `task:user` role of the model policy applies to them.
    getTaskDefaultProvider: () => runtimeComposition.getTaskDefaultProvider(null, 'user'),
    getBackgroundTaskToolNames: runtimeComposition.getBackgroundTaskToolNames,
    getTelegramBot: runtimeComposition.getTelegramBot,
    onTelegramSettingsChanged: runtimeComposition.onTelegramSettingsChanged,
    onActiveProviderChanged: runtimeComposition.onActiveProviderChanged,
    taskEventBus: runtimeComposition.taskEventBus,
    chatActions: runtimeComposition.chatActions,
    chatEventBus: runtimeComposition.chatEventBus,
    getTurnRunner: () => runtimeComposition.turnRunner,
    getPushSender: () => runtimeComposition.pushSender,
  })

  const server = http.createServer(app)

  const wsChat = setupWebSocketChat(
    server,
    runtimeComposition.db,
    runtimeComposition.getAgentCore,
    runtimeComposition.runtimeMetrics,
    runtimeComposition.chatEventBus,
    runtimeComposition.chatActions,
    runtimeComposition.turnRunner,
    runtimeComposition.onActiveProviderChanged,
  )
  runtimeComposition.setWebSocketChatPresenceChecker(wsChat)

  setupWebSocketTask({
    server,
    db: runtimeComposition.db,
    taskEventBus: runtimeComposition.taskEventBus,
  })

  const { wss: _logsWss, broadcast: broadcastLog } = setupWebSocketLogs(server)
  void broadcastLog

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${options.port} on ${options.host} is already in use — is another Offtangent instance running?`))
        return
      }
      reject(err)
    }
    server.once('error', onError)
    server.listen(options.port, options.host, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : options.port

  logger.log(`[axiom] Server running at http://${options.host}:${actualPort}`)
  logger.log(`[axiom] Health check: http://${options.host}:${actualPort}/health`)
  logger.log(`[axiom] WebSocket chat: ws://${options.host}:${actualPort}/ws/chat`)
  logger.log(`[axiom] WebSocket logs: ws://${options.host}:${actualPort}/ws/logs`)
  logger.log(`[axiom] WebSocket task viewer: ws://${options.host}:${actualPort}/ws/task/:id`)

  return {
    server,
    host: options.host,
    port: actualPort,
    stopHttp: async () => {
      runtimeComposition.setWebSocketChatPresenceChecker(null)
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        })
      })
    },
  }
}
