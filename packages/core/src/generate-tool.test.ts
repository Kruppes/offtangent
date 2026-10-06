import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDatabase, type Database } from './database.js'
import { createGenerateTool } from './generate-tool.js'
import type { GenerateOptions, GeneratedImage, GeneratorRoute } from './generators.js'

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

function mockImages(result: { route: Partial<GeneratorRoute>; images: Partial<GeneratedImage>[] }) {
  mocks.generate.mockImplementation(async (_config, _input, options: GenerateOptions) => {
    for (const image of result.images) options.onImage?.(image as GeneratedImage, result.route as GeneratorRoute)
    return result
  })
}
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
    mockImages({ route: { id: 'fal', cost: { eur_per_usd: 0.93 } }, images: [
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
  it('books a completed image even when a subsequent generation fails', async () => {
    db = initDatabase(':memory:')
    mocks.generate.mockImplementation(async (_config, _input, options: GenerateOptions) => {
      options.onImage!({ cost_eur: 0.0093 } as GeneratedImage, { id: 'synthetic', cost: { eur_per_usd: 0.93 } } as GeneratorRoute)
      throw new Error('Image backend HTTP 503')
    })
    const result = await createGenerateTool({ db, getCurrentToolUserId: () => 1 }).execute('test-id', { prompt: 'Synthetic scene', count: 2 }, new AbortController().signal)
    expect(result.details).toEqual({ error: true })
    expect((db.prepare('SELECT estimated_cost FROM token_usage').get() as { estimated_cost: number }).estimated_cost).toBeCloseTo(0.01)
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('never delivers after cancellation, but retains completed-image usage', async () => {
    db = initDatabase(':memory:')
    const controller = new AbortController()
    mocks.generate.mockImplementation(async (_config, _input, options: GenerateOptions) => {
      expect(options.signal).toBe(controller.signal)
      const image = { path: '/workspace/synthetic.png', cost_eur: 0 } as GeneratedImage
      const route = { id: 'synthetic', cost: { eur_per_image: 0 } } as GeneratorRoute
      options.onImage!(image, route)
      controller.abort()
      return { route, images: [image] }
    })
    const result = await createGenerateTool({ db, getCurrentToolUserId: () => 1 }).execute('test-id', { prompt: 'Synthetic scene' }, controller.signal)
    expect(result.details).toEqual({ error: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM token_usage').get()).toEqual({ n: 1 })
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('still books generated images if file delivery fails', async () => {
    db = initDatabase(':memory:')
    mockImages({ route: { id: 'subscription', cost: { eur_per_image: 0 } }, images: [
      { path: '/workspace/image.png', width: 512, height: 512, cost_eur: 0 },
    ] })
    mocks.send.mockResolvedValue({ details: { error: true } })
    const tool = createGenerateTool({ db, getCurrentToolUserId: () => 1 })
    const result = await tool.execute('test-id', { prompt: 'A test' }, new AbortController().signal)
    expect(result.details).toEqual({ error: true })
    expect(db.prepare('SELECT kind, estimated_cost FROM token_usage').get()).toEqual({ kind: 'image_generation', estimated_cost: 0 })
  })
})
