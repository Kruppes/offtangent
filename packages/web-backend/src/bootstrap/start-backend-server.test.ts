import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateAccessToken } from '../auth.js'
import { startBackendServer } from './start-backend-server.js'

describe('backend bootstrap composition root', () => {
  let previousDataDir: string | undefined
  let tempDataDir: string
  let started: Awaited<ReturnType<typeof startBackendServer>> | null = null

  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-bootstrap-'))
    process.env.DATA_DIR = tempDataDir
  })

  afterEach(async () => {
    if (started) {
      await started.stop()
      started = null
    }

    fs.rmSync(tempDataDir, { recursive: true, force: true })
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR
    } else {
      process.env.DATA_DIR = previousDataDir
    }
  })

  it('starts app/server/realtime boundaries and stops cleanly', async () => {
    started = await startBackendServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    })

    const baseUrl = `http://127.0.0.1:${started.port}`
    const healthRes = await fetch(`${baseUrl}/health`)
    const healthBody = (await healthRes.json()) as { status: string }
    expect(healthRes.status).toBe(200)
    expect(healthBody.status).toBe('ok')

    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
    const authMessage = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${started!.port}/ws/chat?token=${token}`)

      ws.on('message', (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        ws.close()
      })
      ws.on('error', reject)
    })

    expect(authMessage.type).toBe('system')
    expect(authMessage.text).toBe('Authenticated')

    await started.stop()
    started = null

    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow()
  })
})
