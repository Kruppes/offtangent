import type { Server } from 'node:http'
import { closeSharedMcpManager } from '@axiom/core'
import { startHttpBoundary } from './http-boundary.js'
import { createRuntimeComposition } from './runtime-composition.js'
import { BOOT_STALL_AFTER_LISTEN_MS, startBootStallMonitor } from './boot-stall-monitor.js'

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

  // Boot diagnostics: one log line with the event-loop stalls of the start.
  const bootStalls = startBootStallMonitor({ logger })
  let runtimeComposition
  try {
    runtimeComposition = await createRuntimeComposition({ logger })
  } catch (err) {
    bootStalls.finish()
    throw err
  }

  let httpBoundary
  try {
    httpBoundary = await startHttpBoundary(runtimeComposition, { host, port, logger })
  } catch (err) {
    await runtimeComposition.stopBackgroundServices().catch(() => {
      // ignore cleanup errors on startup failure
    })
    bootStalls.finish()
    throw err
  }

  // Short-timeout network services start only now that the server listens
  // and the boot work no longer holds the event loop.
  runtimeComposition.startDeferredServices()
  bootStalls.markListening()
  setTimeout(() => bootStalls.finish(), BOOT_STALL_AFTER_LISTEN_MS).unref?.()

  let stopPromise: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise

    stopPromise = (async () => {
      bootStalls.finish()
      await runtimeComposition.stopBackgroundServices()
      // MCP: close sessions and stop stdio server children. Bounded, so a
      // hanging server cannot delay the shutdown past the signal deadline.
      await Promise.race([
        closeSharedMcpManager().catch(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, 2500).unref?.()),
      ])
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
