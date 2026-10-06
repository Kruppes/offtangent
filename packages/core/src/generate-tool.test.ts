import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDatabase, type Database } from './database.js'
import { createGenerateTool } from './generate-tool.js'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  send: vi.fn(),
}))
vi.mock('./generators.js', () => ({
  loadGeneratorConfig: () => ({ routes: [] }),
  generateImages: mocks.generate,
}))
vi.mock('./send-file-tool.js', () => ({
  createSendFileTool: () => ({ execute: mocks.send }),
}))

let db: Database | undefined
afterEach(() => { db?.close(); db = undefined; vi.resetAllMocks() })

describe('generate tool', () => {
  it('exposes a compact built-in with optional route and no image bytes input', () => {
    const tool = createGenerateTool({ db: {} as Database, getCurrentToolUserId: () => undefined })
    expect(tool.name).toBe('generate')
    const schema = tool.parameters as unknown as { properties: Record<string, unknown>; required: string[] }
    expect(schema.required).toEqual(['prompt'])
    expect(schema.properties).toHaveProperty('ratio')
    expect(schema.properties).not.toHaveProperty('image_base64')
  })
  it('delivers the image and books its EUR cost as USD in the usage ledger', async () => {
    db = initDatabase(':memory:')
    db.prepare('INSERT INTO sessions (id, source) VALUES (?, ?)').run('test-session', 'web')
    mocks.generate.mockResolvedValue({ route: { id: 'fal', cost: { eur_per_usd: 0.93 } }, images: [
      { path: '/workspace/example.png', sidecar: '/workspace/example.png.json', width: 512, height: 512,
        seconds: 3.2, seed: 12, cost_eur: 0.0093 },
    ] })
    mocks.send.mockResolvedValue({ details: { uploadedFile: { id: 'example' } } })
    const tool = createGenerateTool({ db, getCurrentToolUserId: () => 1,
      getCurrentInteractiveSessionId: () => 'test-session' })
    const result = await tool.execute('test-id', { prompt: 'A test' }, new AbortController().signal)
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(result.details).toEqual({ uploadedFiles: [{ id: 'example' }] })
    expect(JSON.stringify(result.content)).not.toContain('base64')
    const row = db.prepare('SELECT kind, provider, model, estimated_cost, session_id FROM token_usage').get() as Record<string, unknown>
    expect(row).toMatchObject({ kind: 'image_generation', provider: 'image-generation', model: 'fal', session_id: 'test-session' })
    expect(row.estimated_cost).toBeCloseTo(0.01)
  })
  it('still books generated images if file delivery fails', async () => {
    db = initDatabase(':memory:')
    mocks.generate.mockResolvedValue({ route: { id: 'subscription', cost: { eur_per_image: 0 } }, images: [
      { path: '/workspace/image.png', width: 512, height: 512, cost_eur: 0 },
    ] })
    mocks.send.mockResolvedValue({ details: { error: true } })
    const tool = createGenerateTool({ db, getCurrentToolUserId: () => 1 })
    const result = await tool.execute('test-id', { prompt: 'A test' }, new AbortController().signal)
    expect(result.details).toEqual({ error: true })
    expect(db.prepare('SELECT kind, estimated_cost FROM token_usage').get()).toEqual({ kind: 'image_generation', estimated_cost: 0 })
  })
})
