import type { Server } from 'node:http'
import { startHttpBoundary } from './http-boundary.js'
import { createRuntimeComposition } from './runtime-composition.js'

export interface StartBackendServerOptions {
  port?: number
  host?: string
  installSignalHandlers?: boolean
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>
  exitProcess?: (code: number) => void
}

export interface StartedBackendServer {
  server: Server
  host: string
  port: number
  stop: () => Promise<void>
}

export async function startBackendServer(options: StartBackendServerOptions = {}): Promise<StartedBackendServer> {
  const logger = options.logger ?? console
  const port = options.port ?? Number.parseInt(process.env.PORT ?? '3000', 10)
  const host = options.host ?? process.env.HOST ?? '0.0.0.0'

  const runtimeComposition = await createRuntimeComposition({ logger })

  let httpBoundary
  try {
    httpBoundary = await startHttpBoundary(runtimeComposition, { host, port, logger })
  } catch (err) {
    await runtimeComposition.stopBackgroundServices().catch(() => {
      // ignore cleanup errors on startup failure
    })
    throw err
  }

  let stopPromise: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise

    stopPromise = (async () => {
      await runtimeComposition.stopBackgroundServices()
      await httpBoundary.stopHttp()
    })()

    return stopPromise
  }

  if (options.installSignalHandlers ?? true) {
    installUnhandledRejectionGuard(logger)
    installShutdownSignalHandlers({
      stop,
      logger,
      exitProcess: options.exitProcess ?? ((code: number) => process.exit(code)),
    })
  }

  return {
    server: httpBoundary.server,
    host: httpBoundary.host,
    port: httpBoundary.port,
    stop,
  }
}

// Node's default since v15 is to exit on unhandled rejections, which turns any
// missed `.catch()` in a background service into a container crash-loop
// (restart: unless-stopped). Log loudly and keep serving instead.
function installUnhandledRejectionGuard(logger: Pick<typeof console, 'error'>): void {
  process.on('unhandledRejection', (reason) => {
    logger.error('[axiom] Unhandled promise rejection (continuing):', reason)
  })
}

interface InstallShutdownSignalHandlersOptions {
  stop: () => Promise<void>
  logger: Pick<typeof console, 'log'>
  exitProcess: (code: number) => void
}

function installShutdownSignalHandlers(options: InstallShutdownSignalHandlersOptions): void {
  let shuttingDown = false

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return
      shuttingDown = true

      options.logger.log(`\n[axiom] Received ${signal}, shutting down...`)

      options.stop().then(() => {
        options.logger.log('[axiom] Server closed.')
        options.exitProcess(0)
      }).catch(() => {
        options.exitProcess(1)
      })

      setTimeout(() => options.exitProcess(1), 3000).unref()
    })
  }
}
