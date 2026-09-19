import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import express from 'express'
import type { Database } from '@axiom/core'
import type { AgentCore } from '@axiom/core'
import { createAuthRouter } from './routes/auth.js'
import { createChatRouter } from './routes/chat.js'
import { createThreadsRouter } from './routes/threads.js'
import { createModelsRouter } from './routes/models.js'
import { createProjectsRouter } from './routes/projects.js'
import { createLogsRouter } from './routes/logs.js'
import { createProvidersRouter } from './api/modules/providers/route.js'
import { createMemoryRouter } from './api/modules/memory/route.js'
import { createMemoryViewRouter } from './api/modules/memory-view/route.js'
import { createModelPolicyRouter } from './api/modules/model-policy/route.js'
import { createSettingsRouter } from './api/modules/settings/route.js'
import { createPersonasRouter } from './api/modules/personas/route.js'
import { createPersonasClientRouter } from './routes/personas-client.js'
import { createUsersRouter } from './routes/users.js'
import { createTelegramUsersRouter } from './routes/telegram-users.js'
import type { TelegramBot } from '@axiom/telegram'
import { createSkillsRouter } from './routes/skills.js'
import { createStatsRouter } from './routes/stats.js'
import { createHealthRouter } from './routes/health.js'
import { createTasksRouter } from './api/modules/tasks/route.js'
import type { ReplyToTask } from './task-reply.js'
import { createEmailRouter } from './api/modules/email/route.js'
import { createCronjobsRouter } from './routes/cronjobs.js'
import { createSecretsRouter } from './routes/secrets.js'
import { createTtsRouter } from './routes/tts.js'
import { createSttRouter } from './routes/stt.js'
import { createDeepgramRouter } from './routes/deepgram.js'
import { createCapturesRouters } from './api/modules/captures/route.js'
import { createFeedRouter } from './api/modules/feed/route.js'
import { createInteractionsRouter } from './api/modules/interactions/route.js'
import type { CaptureTurnStarter } from './api/modules/captures/service.js'
import type { StrandTurnGuard } from './api/modules/strands/service.js'
import type { PersonaTurnGuard } from './api/modules/personas/service.js'
import { createStrandsRouters } from './api/modules/strands/route.js'
import { createPushRouter } from './api/modules/push/route.js'
import type { PushSender } from './push/sender.js'
import { sendCaptureDoorbell } from './push/triggers.js'
import { createArtifactsRouter } from './api/modules/artifacts/route.js'
import { createSpeechRouter } from './api/modules/speech/route.js'
import { SPEECH_BODY_LIMIT } from './api/modules/speech/schema.js'
import type { ChatEventBus } from './chat-event-bus.js'
import type { ProviderConfig, TaskRuntimeBoundary, TaskEventBus, AgentHeartbeatService } from '@axiom/core'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { ensureAdminUser, jwtHeaderOrQueryMiddleware } from './auth.js'
import type { HealthMonitorService } from './health-monitor.js'
import type { RuntimeMetrics } from './runtime-metrics.js'
import type { MemoryConsolidationScheduler } from './memory-consolidation-scheduler.js'
import { createUploadsRouter } from './routes/uploads.js'
import type { ChatActionRegistry } from './chat-actions.js'

const startTime = Date.now()

export interface AppOptions {
  db: Database
  agentCore?: AgentCore | null
  getAgentCore?: () => AgentCore | null
  healthMonitorService?: HealthMonitorService | null
  runtimeMetrics?: RuntimeMetrics | null
  consolidationScheduler?: MemoryConsolidationScheduler | null
  agentHeartbeatService?: AgentHeartbeatService | null
  onAgentHeartbeatSettingsChanged?: () => void
  getTelegramBot?: () => TelegramBot | null
  onTelegramSettingsChanged?: () => void
  onActiveProviderChanged?: () => void
  getTaskRuntime?: () => TaskRuntimeBoundary | null
  /**
   * Answer a background task (`POST /api/tasks/:id/reply`). Built once in the
   * runtime composition and handed in here so the HTTP route shares the exact
   * decision tree of a Telegram reply. Omitted in tests that never reply — the
   * route then answers 503.
   */
  replyToTask?: ReplyToTask
  /**
   * Look up a provider by id/name. Used by the tasks restart endpoint to
   * resolve the (optionally overridden) provider the user picked in the
   * edit form.
   */
  resolveProvider?: (nameOrId: string) => ProviderConfig | null
  /**
   * Configured task default provider. Used by the tasks restart endpoint
   * when neither the user nor the original task pinned a provider/model.
   */
  getTaskDefaultProvider?: () => ProviderConfig | null
  /**
   * Returns the names of the tools available to background task agents.
   * Used by the cronjob UI to render the tool-override list dynamically.
   * If omitted, the meta endpoint falls back to an empty list.
   */
  getBackgroundTaskToolNames?: () => string[]
  taskEventBus?: TaskEventBus | null
  /** Backs the interactive action buttons rendered inside chat messages. */
  chatActions?: ChatActionRegistry | null
  /**
   * Returns the latest cached subscriber usage snapshots keyed by provider id.
   * Used by the providers list endpoint to surface quota in the UI without
   * blocking the request on a live usage fetch.
   */
  getQuotaSnapshot?: () => Record<string, ProviderQuotaContract>
  refreshQuota?: (providerId: string) => Promise<ProviderQuotaContract | null>
  /**
   * Offtangent captures: the shared chat event bus (routing and now set
   * frames on /ws/chat) and the process wide turn runner (an `ask` capture
   * starts a turn in its strand).
   */
  chatEventBus?: ChatEventBus | null
  getTurnRunner?: () => (CaptureTurnStarter & StrandTurnGuard & PersonaTurnGuard) | null
  /**
   * The process wide push sender (PROTOCOL chapter 7). Used by the captures
   * path: when the router files a capture as a note but the text might be
   * addressed at the persona, the service writes one question into the strand
   * and rings for it. No turn runs there, so no other doorbell would.
   */
  getPushSender?: () => PushSender | null
}

export function createApp(options?: AppOptions): express.Express {
  const app = express()

  // The speech routes accept an inline message text of up to
  // SPEECH_TEXT_MAX_CHARS (200.000 chars), which does not fit the 100 kB
  // default below. This path scoped parser runs first; the generic
  // `express.json()` then sees an already parsed body and skips it. Without
  // it express would answer 413 and the documented
  // `400 { error: 'text_too_large' }` could never reach a client.
  app.use('/api/speech', express.json({ limit: SPEECH_BODY_LIMIT }))
  app.use(express.json())

  // CORS: allow frontend dev server (different port) to access API
  app.use((_req, res, next) => {
    const origin = _req.headers.origin
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    if (_req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  app.get('/health', (_req, res) => {
    const uptimeMs = Date.now() - startTime
    const uptimeSeconds = Math.floor(uptimeMs / 1000)

    res.json({
      status: 'ok',
      uptime: uptimeSeconds,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    })
  })

  // Build dynamic agentCore getter: prefer explicit getter, fall back to static reference
  const getAgentCore = options?.getAgentCore ?? (() => options?.agentCore ?? null)

  if (options?.db) {
    ensureAdminUser(options.db)
    // Uploads are user content: require a valid access token. The token may be
    // passed as `?token=` because <img src>/<a href> cannot send headers.
    app.use('/api/uploads', jwtHeaderOrQueryMiddleware, createUploadsRouter())
    app.use('/api/auth', createAuthRouter(options.db))
    app.use('/api/chat', createChatRouter({
      db: options.db,
      getAgentCore,
      chatActions: options.chatActions ?? null,
    }))
    app.use('/api/threads', createThreadsRouter({ getAgentCore }))
    app.use('/api/models', createModelsRouter(options.getQuotaSnapshot))
    app.use('/api/projects', createProjectsRouter({ db: options.db }))
    // Offtangent (SPEC 6.1 to 6.3): captures + router, strands, tags, now set, resurface.
    const capturesDb = options.db
    const captureRouters = createCapturesRouters({
      db: capturesDb,
      getAgentCore,
      chatEventBus: options.chatEventBus ?? null,
      getTurnRunner: options.getTurnRunner,
      sendDoorbell: (input) => {
        const sender = options.getPushSender?.()
        if (!sender) return
        sendCaptureDoorbell(capturesDb, sender, input)
      },
    })
    app.use('/api/captures', captureRouters.captures)
    app.use('/api/router', captureRouters.router)
    // Offtangent (SPEC 6.4): the feed. `ask` reuses the captures service so a
    // question about a feed item takes the ordinary router path.
    app.use('/api/feed', createFeedRouter({
      db: options.db,
      getCaptureCreator: () => captureRouters.service,
    }))
    // Offtangent (SPEC 7.4c): answering an interactive block. The answer is
    // filed as an ordinary user message in the strand, so it shares the turn
    // runner with the captures path.
    app.use('/api/interactions', createInteractionsRouter({
      db: options.db,
      getTurnRunner: options.getTurnRunner,
      chatEventBus: options.chatEventBus ?? null,
      // The confirmation card of a filed note is answered here, but resolved
      // by the captures service: same instance as the one that wrote it, so
      // "answer it" takes exactly the path the `needs_review` confirmation
      // takes.
      getCaptureConfirmer: () => captureRouters.service,
    }))
    const strandRouters = createStrandsRouters({
      db: options.db,
      getAgentCore,
      chatEventBus: options.chatEventBus ?? null,
      getTurnRunner: options.getTurnRunner,
      getQuotaSnapshot: options.getQuotaSnapshot,
    })
    app.use('/api/strands', strandRouters.strands)
    app.use('/api/tags', strandRouters.tags)
    app.use('/api/now', strandRouters.now)
    app.use('/api/resurface', strandRouters.resurface)
    // Offtangent (SPEC 7.4b): canvas artifacts. Its content route brings its
    // own capability-token auth, so it is NOT behind the generic JWT gate.
    app.use('/api/artifacts', createArtifactsRouter({ db: options.db }))
    // Companion app "summarize aloud": a spoken short form of one message.
    app.use('/api/speech', createSpeechRouter({ db: options.db }))
    app.use('/api/push', createPushRouter({ db: options.db }))
    app.use('/api/logs', createLogsRouter(options.db))
    app.use('/api/providers', createProvidersRouter({
      getQuotaSnapshot: options.getQuotaSnapshot,
      refreshQuota: options.refreshQuota,
      onActiveProviderChanged: () => {
        options.healthMonitorService?.restart({ resetState: true })
        options.onActiveProviderChanged?.()
      },
    }))
    // Offtangent (SPEC 6.4): the structured memory view is readable by every
    // logged-in user and therefore mounted BEFORE the admin memory router.
    // It only claims /tree, /graph, /fact/:id and /facts?node=...; everything
    // else falls through to the admin router unchanged.
    app.use('/api/memory', createMemoryViewRouter({ db: options.db }))
    app.use('/api/memory', createMemoryRouter({
      db: options.db,
      getAgentCore,
      consolidationScheduler: options.consolidationScheduler ?? null,
    }))
    app.use('/api/model-policy', createModelPolicyRouter())
    app.use('/api/settings', createSettingsRouter({
      getAgentCore,
      onHealthMonitorSettingsChanged: () => {
        options.healthMonitorService?.restart()
      },
      onConsolidationSettingsChanged: () => {
        options.consolidationScheduler?.restart()
      },
      onAgentHeartbeatSettingsChanged: () => {
        options.agentHeartbeatService?.restart()
        options.onAgentHeartbeatSettingsChanged?.()
      },
      onTelegramSettingsChanged: () => {
        options.onTelegramSettingsChanged?.()
      },
    }))
    // Mounted BEFORE the admin router: its `GET /:id` would otherwise swallow
    // `/client`. Every logged-in user may read this minimal projection.
    app.use('/api/personas/client', createPersonasClientRouter({ db: options.db }))
    app.use('/api/personas', createPersonasRouter({
      db: options.db,
      getTurnRunner: options.getTurnRunner,
    }))
    app.use('/api/users', createUsersRouter(options.db))
    app.use('/api/telegram-users', createTelegramUsersRouter({
      db: options.db,
      getTelegramBot: options.getTelegramBot ?? (() => null),
    }))
    app.use('/api/skills', createSkillsRouter({
      getAgentCore,
    }))
    app.use('/api/stats', createStatsRouter(options.db))
    app.use('/api/tasks', createTasksRouter({
      db: options.db,
      getTaskRuntime: () => options.getTaskRuntime?.()?.tasks ?? null,
      replyToTask: options.replyToTask,
      resolveProvider: options.resolveProvider,
      getDefaultProvider: options.getTaskDefaultProvider,
    }))
    app.use('/api/cronjobs', createCronjobsRouter({
      db: options.db,
      getTaskRuntime: () => options.getTaskRuntime?.()?.schedules ?? null,
      getBackgroundTaskToolNames: options.getBackgroundTaskToolNames,
    }))
    // Email tools are baked into the tool sets at build time, so an account
    // change must trigger the same rebuild a provider switch does.
    app.use('/api/email', createEmailRouter({
      db: options.db,
      onAccountsChanged: () => options.onActiveProviderChanged?.(),
    }))
    app.use('/api/secrets', createSecretsRouter())
    app.use('/api/tts', createTtsRouter())
    app.use('/api/stt', createSttRouter())
    app.use('/api/deepgram', createDeepgramRouter())

    if (options.healthMonitorService && options.runtimeMetrics) {
      app.use('/api/health', createHealthRouter({
        db: options.db,
        healthMonitorService: options.healthMonitorService,
        runtimeMetrics: options.runtimeMetrics,
        getQuotaSnapshot: options.getQuotaSnapshot,
      }))
    }
  }

  // Serve frontend static files (SPA)
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  // Resolve frontend dir: works from both src/ (dev) and dist/ (production)
  const candidatePaths = [
    process.env.FRONTEND_DIR,
    path.resolve(__dirname, '../../web-frontend/.output/public'),
    path.resolve(__dirname, '../../../web-frontend/.output/public'),
  ].filter(Boolean) as string[]
  const frontendDir = candidatePaths.find(p => fs.existsSync(path.join(p, 'index.html'))) || candidatePaths[0]

  if (fs.existsSync(frontendDir)) {
    console.log(`[axiom] Serving frontend from ${frontendDir}`)
    // The generated frontend is client-only: its middleware cannot emit HTTP
    // status codes. Keep old web deep links permanent at the serving boundary.
    app.get('/chat/:id', (req, res) => {
      const queryIndex = req.originalUrl.indexOf('?')
      const query = queryIndex < 0 ? '' : req.originalUrl.slice(queryIndex)
      res.redirect(301, `/strands/${encodeURIComponent(String(req.params.id))}${query}`)
    })
    app.use(express.static(frontendDir))

    // SPA fallback: serve index.html for all non-API/non-WS routes
    app.get('{*path}', (req, res, next) => {
      // Skip API and WebSocket paths — let them 404 naturally with JSON
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws/') || req.path === '/health') {
        next()
        return
      }
      const indexPath = path.join(frontendDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        // `root` + relative name: without it, `send` checks EVERY segment of
        // the absolute path for dotfiles and refuses Nuxt's `.output/` with a
        // 404, so deep links / reloads on nested routes (`/strands/<id>`) died.
        res.sendFile('index.html', { root: frontendDir }, (err) => {
          if (err && !res.headersSent) {
            res.status(404).send('Frontend not found')
          }
        })
      } else {
        res.status(404).send('Frontend not found')
      }
    })
  }

  return app
}
