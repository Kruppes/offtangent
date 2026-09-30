/**
 * The SPA fallback must serve index.html for nested client routes even when
 * the frontend lives under a dot-directory (Nuxt: `.output/public`). Without
 * `root`, `send` treats `.output` as a dotfile and answers 404, which breaks
 * every deep link / reload on `/strands/<id>`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from './app.js'
import { initDatabase } from '@axiom/core'

let server: http.Server
let baseUrl: string
let tmp: string
let previousFrontendDir: string | undefined
let previousDataDir: string | undefined

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-fallback-'))
  const frontendDir = path.join(tmp, '.output', 'public')
  fs.mkdirSync(path.join(frontendDir, 'chat'), { recursive: true })
  fs.writeFileSync(path.join(frontendDir, 'index.html'), '<!doctype html><title>spa</title>')
  fs.writeFileSync(path.join(frontendDir, 'chat', 'index.html'), '<!doctype html><title>chat</title>')
  previousFrontendDir = process.env.FRONTEND_DIR
  previousDataDir = process.env.DATA_DIR
  process.env.FRONTEND_DIR = frontendDir
  process.env.DATA_DIR = path.join(tmp, 'data')
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })

  const db = initDatabase(':memory:')
  const app = createApp({ db, getAgentCore: () => null })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (previousFrontendDir === undefined) delete process.env.FRONTEND_DIR
  else process.env.FRONTEND_DIR = previousFrontendDir
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('SPA fallback', () => {
  it('serves index.html for a nested client route under a dot-directory frontend', async () => {
    const res = await fetch(`${baseUrl}/strands/12b9b375-7424-47be-afdc-fbfa0facc9e6`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>spa</title>')
  })

  it('permanently redirects legacy web links while preserving query strings', async () => {
    const res = await fetch(`${baseUrl}/chat/strand%20one?tab=files&from=push`, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/strands/strand%20one?tab=files&from=push')
  })

  it('still serves real static files and leaves API paths to their own 404', async () => {
    const chat = await fetch(`${baseUrl}/chat/`)
    expect(chat.status).toBe(200)
    expect(await chat.text()).toContain('<title>chat</title>')

    const api = await fetch(`${baseUrl}/api/does-not-exist`)
    expect(api.status).toBe(404)
    expect((await api.text()).includes('<title>spa</title>')).toBe(false)
  })
})
