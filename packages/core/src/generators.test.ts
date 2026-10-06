import { describe, expect, it, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as providerConfig from './provider-config.js'
import { loadGeneratorConfig, codexPrompt, generatorCost, generateImages, type GeneratorRoute } from './generators.js'

const dirs: string[] = []
afterEach(() => { delete process.env.FAL_KEY; delete process.env.GENERATORS_MFLUX_GUARD; vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
function temp() { const dir = fs.mkdtempSync(path.join(process.cwd(), '.generator-test-')); dirs.push(dir); return dir }
const route: GeneratorRoute = { id: 'test', label: 'Test', backend: 'fal', model: 'test-model', endpoint: 'https://<test-endpoint>/test',
  defaults: { size: 's', ratio: '1:1', count: 1, steps: 8 }, triggers: [], params_allowed: ['ratio', 'count'],
  cost: { usd_per_megapixel: 0.005, eur_per_usd: 0.93 }, status: 'ok' }
const png = Buffer.alloc(32); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(512, 16); png.writeUInt32BE(512, 20)
describe('generator routes', () => {
  it('skips malformed entries while loading healthy routes', () => {
    const dir = temp(), file = path.join(dir, 'routes.yaml')
    fs.writeFileSync(file, `default_route: valid\nroutes:\n - {id: broken, backend: comfyui}\n - id: valid\n   label: Valid\n   backend: fal\n   model: example\n   endpoint: https://<test-endpoint>/test\n   defaults: {size: s}\n   params_allowed: [ratio]\n   cost: {eur_per_image: 0}\n   status: ok\n`)
    const config = loadGeneratorConfig(file)
    expect(config.routes.map(r => r.id)).toEqual(['valid'])
    expect(config.errors).toHaveLength(1)
    expect(config.errors[0]).toContain('broken')
  })
  it('appends ratio to Codex prompt and calculates per-megapixel EUR', () => {
    expect(codexPrompt('A subject', '16:9')).toBe('A subject Image format: 16:9 widescreen landscape.')
    expect(codexPrompt('A subject')).toBe('A subject')
    expect(generatorCost(route, 1024, 1024)).toBe(0.00488)
    expect(generatorCost({ ...route, backend: 'openai-codex' }, 1024, 1024)).toBe(0)
  })
  it('uses the configured fal route, saves PNG+sidecar and rejects unallowed parameters', async () => {
    const dir = temp()
    const config = { configPath: path.join(dir, 'routes.yaml'), default_route: 'test', output_dir: dir,
      routes: [route], ratios: ['1:1'], size_presets: { s: 512 }, errors: [] }
    process.env.FAL_KEY = 'unit-test-key'
    const mock = vi.fn(async (url: string) => url === route.endpoint
      ? new Response(JSON.stringify({ images: [{ url: 'https://<test-image>/image.png' }] }), { status: 200 })
      : new Response(png, { status: 200 }))
    vi.stubGlobal('fetch', mock)
    await expect(generateImages(config, { prompt: 'A test', steps: 9 })).rejects.toThrow('not allowed')
    const result = await generateImages(config, { prompt: 'A test' })
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatchObject({ width: 512, height: 512 })
    expect(JSON.parse(fs.readFileSync(result.images[0].sidecar, 'utf8'))).toMatchObject({ prompt: 'A test', route: 'test', cost_eur: 0.00122 })
    expect(mock).toHaveBeenCalledTimes(2)
    delete process.env.FAL_KEY
  })
  it.each(['raw', 'enveloped'])('checks mflux guard and runs a %s ComfyUI workflow', async (format) => {
    const dir = temp()
    fs.mkdirSync(path.join(dir, 'workflows'))
    fs.writeFileSync(path.join(dir, 'workflows', 'local.json'), JSON.stringify(format === 'enveloped'
      ? { prompt: { node: { prompt: '$prompt', width: '$width' } } }
      : { prompt: '$prompt', width: '$width' }))
    const guard = path.join(dir, 'guard.sh')
    fs.writeFileSync(guard, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const localRoute: GeneratorRoute = { ...route, id: 'local', backend: 'comfyui', endpoint: 'http://<test-backend>',
      workflow: 'workflows/local.json', cost: { eur_per_image: 0 } }
    const config = { configPath: path.join(dir, 'routes.yaml'), default_route: 'local', output_dir: dir,
      routes: [localRoute], ratios: ['1:1'], size_presets: { s: 512 }, errors: [] }
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/system_stats')) return Response.json({})
      if (url.endsWith('/queue')) return Response.json({ queue_running: [], queue_pending: [] })
      if (url.endsWith('/prompt')) {
        expect(JSON.parse(options!.body as string)).toMatchObject(format === 'enveloped'
          ? { prompt: { node: { prompt: 'Local test', width: 512 } } }
          : { prompt: { prompt: 'Local test', width: 512 } })
        return Response.json({ prompt_id: 'one' })
      }
      if (url.endsWith('/history/one')) return Response.json({ one: { outputs: { output: { images: [{ filename: 'test.png' }] } } } })
      return new Response(png, { status: 200 })
    }))
    delete process.env.GENERATORS_MFLUX_GUARD
    await expect(generateImages(config, { prompt: 'Local test' })).rejects.toThrow('GENERATORS_MFLUX_GUARD')
    process.env.GENERATORS_MFLUX_GUARD = guard
    const result = await generateImages(config, { prompt: 'Local test' })
    expect(result.images).toHaveLength(1)
    expect(result.images[0].cost_eur).toBe(0)
    delete process.env.GENERATORS_MFLUX_GUARD
  })

  it('uses Codex OAuth access token without refreshing and requests the format only in prompt text', async () => {
    const dir = temp()
    const jwt = `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.signature`
    vi.spyOn(providerConfig, 'loadProvidersDecrypted').mockReturnValue({ providers: [
      { id: 'codex-provider', provider: 'openai-codex', authMethod: 'oauth', oauthCredentials: { access: jwt } },
    ] } as ReturnType<typeof providerConfig.loadProvidersDecrypted>)
    const refresh = vi.spyOn(providerConfig, 'getApiKeyForProvider').mockResolvedValue(jwt)
    const endpoint = 'https://sample.test/backend-api/codex/images/generations'
    const codexRoute: GeneratorRoute = { ...route, id: 'codex', backend: 'openai-codex', endpoint,
      model: 'gpt-image-2', defaults: { count: 1 }, params_allowed: ['ratio', 'count', 'background'], cost: { eur_per_image: 0 } }
    const config = { configPath: path.join(dir, 'routes.yaml'), default_route: 'codex', output_dir: dir,
      routes: [codexRoute], ratios: ['1:1', '16:9'], size_presets: { m: 768 }, errors: [] }
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, string>
      expect(body).toEqual({ model: 'gpt-image-2', prompt: 'A scene Image format: 16:9 widescreen landscape.', background: 'opaque' })
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${jwt}`)
      return Response.json({ data: [{ b64_json: png.toString('base64') }] })
    })
    vi.stubGlobal('fetch', mock)
    const result = await generateImages(config, { prompt: 'A scene', ratio: '16:9', background: 'opaque' })
    expect(result.images).toHaveLength(1)
    expect(mock).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(result.images[0].cost_eur).toBe(0)
    expect(JSON.parse(fs.readFileSync(result.images[0].sidecar, 'utf8')).prompt_used).toContain('Image format: 16:9')
    vi.restoreAllMocks()
  })
  it('rejects explicit size, quality and steps on subscription route before any request', async () => {
    const dir = temp()
    const codexRoute: GeneratorRoute = { ...route, backend: 'openai-codex',
      defaults: { count: 1 }, params_allowed: ['ratio', 'count'], cost: { eur_per_image: 0 } }
    const config = { configPath: path.join(dir, 'routes.yaml'), default_route: 'test', output_dir: dir,
      routes: [codexRoute], ratios: ['1:1'], size_presets: { m: 768 }, errors: [] }
    await expect(generateImages(config, { prompt: 'A scene', size: 'm' })).rejects.toThrow('size is not allowed')
    await expect(generateImages(config, { prompt: 'A scene', steps: 3 })).rejects.toThrow('steps is not allowed')
  })

})
