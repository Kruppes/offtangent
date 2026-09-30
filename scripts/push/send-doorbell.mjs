#!/usr/bin/env node
/**
 * Send one doorbell through the backend's own sender (PROTOCOL chapter 7).
 *
 * It imports the compiled `packages/web-backend/dist/push/*` so what goes out
 * here is exactly what the running backend sends: same OAuth grant, same
 * envelope, same data only payload. Run `npm run build` first.
 *
 * Usage:
 *   node scripts/push/send-doorbell.mjs --token <FCM token> [options]
 *   node scripts/push/send-doorbell.mjs --token-file <file with FCM_DEVICE_TOKEN=...>
 *
 * Options:
 *   --kind      turn_done | task_done | question | error   (default turn_done)
 *   --strand    strand id, also the collapse key           (default a random uuid)
 *   --persona   persona id                                 (default main)
 *   --title     short label, never message content
 *   --body      short label, never message content
 *   --service-account  path to the service account JSON
 *                      (default $FCM_SERVICE_ACCOUNT_FILE or
 *                      /data/secrets/firebase/service-account.json)
 *
 * The token is an address, not a secret, but it is never printed in full.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, '../../packages/web-backend/dist/push')

if (!fs.existsSync(path.join(distDir, 'fcm-client.js'))) {
  console.error(`Build output missing at ${distDir}. Run: npm run build`)
  process.exit(2)
}

const { FcmClient, resolveServiceAccountFile } = await import(path.join(distDir, 'fcm-client.js'))
const { buildPayload, priorityFor } = await import(path.join(distDir, 'sender.js'))

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index === process.argv.length - 1) return fallback
  return process.argv[index + 1]
}

function readTokenFile(file) {
  const raw = fs.readFileSync(file, 'utf-8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    const value = separator === -1 ? trimmed : trimmed.slice(separator + 1)
    const cleaned = value.trim().replace(/^["']|["']$/g, '')
    if (cleaned) return cleaned
  }
  throw new Error(`No token found in ${file}`)
}

const tokenFile = arg('token-file')
const token = arg('token') ?? (tokenFile ? readTokenFile(tokenFile) : process.env.FCM_DEVICE_TOKEN)
if (!token) {
  console.error('No device token. Pass --token, --token-file or set FCM_DEVICE_TOKEN.')
  process.exit(2)
}

const kind = arg('kind', 'turn_done')
const strandId = arg('strand', crypto.randomUUID())
const persona = arg('persona', 'main')
const serviceAccountFile = arg('service-account') ?? resolveServiceAccountFile()

const client = new FcmClient({ serviceAccountFile })
if (!client.isConfigured()) {
  console.error(`No usable service account at ${serviceAccountFile}`)
  process.exit(2)
}

const data = buildPayload({
  userId: 0,
  kind,
  strandId,
  agentId: persona,
  title: arg('title'),
  body: arg('body'),
  messageId: arg('message-id'),
}, new Date().toISOString())

const masked = `${token.slice(0, 6)}...${token.slice(-4)} (${token.length} chars)`
console.log(`project=${client.projectId} token=${masked} kind=${kind} strand=${strandId} priority=${priorityFor(kind)}`)

const result = await client.send({
  token,
  data,
  priority: priorityFor(kind),
  ttlSeconds: 600,
  collapseKey: strandId,
})

console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
