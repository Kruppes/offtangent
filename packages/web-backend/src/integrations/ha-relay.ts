/** Opt-in, service-bearer-only relay in the existing backend process and OAuth lock domain. */
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { createHaInferenceHandler, validateHaConfig } from '@axiom/core'
export const HA_RELAY_MOUNT = '/ha-relay'
export function createHaRelayRouter(): express.Router {
  const router = express.Router()
  const file = path.join(process.env.DATA_DIR ?? '/data', 'config', 'ha-inference.json')
  if (!fs.existsSync(file)) return router
  const stat = fs.statSync(file)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('HA relay config must be a private regular file (0600)')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (raw.enabled === false) return router
  const handler = createHaInferenceHandler(validateHaConfig(raw))
  router.use(async (incoming, outgoing) => {
    const abort = new AbortController()
    outgoing.on('close', () => { if (!outgoing.writableEnded) abort.abort() })
    try {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value)
      const init: RequestInit & { duplex?: 'half' } = { method: incoming.method, headers, signal: abort.signal }
      if (!['GET', 'HEAD'].includes(incoming.method)) { init.body = incoming as unknown as RequestInit['body']; init.duplex = 'half' }
      const response = await handler(new Request('http://127.0.0.1' + incoming.url, init))
      if (outgoing.destroyed) return
      outgoing.status(response.status)
      outgoing.setHeader('Cache-Control', 'no-store')
      response.headers.forEach((value, name) => outgoing.setHeader(name, value))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch { if (!outgoing.headersSent) outgoing.status(500); outgoing.end() }
  })
  return router
}
