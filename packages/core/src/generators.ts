/** Route-driven image generation. Configuration and credentials never enter tool results. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import yaml from 'js-yaml'
import { getDataDir } from './uploads.js'
import { getApiKeyForProvider, loadProvidersDecrypted } from './provider-config.js'

export interface GeneratorRoute {
  id: string; label: string; backend: 'comfyui' | 'fal' | 'openai-codex' | 'openai-codex-images'
  model: string; endpoint?: string; workflow?: string; triggers: string[]
  defaults: Record<string, string | number>; params_allowed: string[]
  cost: { eur_per_image?: number; usd_per_megapixel?: number; eur_per_usd?: number }
  status: string; key_file?: string; [key: string]: unknown
}
export interface GeneratorConfig {
  default_route: string; output_dir: string; size_presets: Record<string, number>
  ratios: string[]; routes: GeneratorRoute[]; errors: string[]; configPath: string
}
export const generatorConfigPath = () => process.env.GENERATORS_CONFIG_PATH || path.join(getDataDir(), 'config', 'generators.yaml')

export function loadGeneratorConfig(file = generatorConfigPath()): GeneratorConfig {
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.routes)) throw new Error('Invalid generator config: routes must be an array')
  const routes: GeneratorRoute[] = [], errors: string[] = [], ids = new Set<string>()
  raw.routes.forEach((value, index) => {
    const r = value as GeneratorRoute
    const id = typeof r?.id === 'string' ? r.id : `#${index + 1}`
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || ids.has(id)
      || !['comfyui', 'fal', 'openai-codex', 'openai-codex-images'].includes(r?.backend)
      || typeof r?.model !== 'string' || typeof r?.label !== 'string'
      || !Array.isArray(r?.params_allowed) || !r?.defaults || typeof r.defaults !== 'object'
      || !r?.cost || typeof r.cost !== 'object'
      || (r.backend === 'comfyui' && (!r.workflow || !r.endpoint))
      || (r.backend === 'fal' && !r.endpoint)) {
      errors.push(`Route ${id}: invalid or incomplete configuration`)
      return
    }
    ids.add(id)
    routes.push({ ...r, triggers: Array.isArray(r.triggers) ? r.triggers : [] })
  })
  return {
    default_route: String(raw.default_route || ''), output_dir: String(raw.output_dir || path.join(getDataDir(), 'generator')),
    size_presets: (raw.size_presets || { s: 512, m: 768, l: 1024 }) as Record<string, number>,
    ratios: (raw.ratios || ['1:1', '16:9', '9:16']) as string[], routes, errors, configPath: file,
  }
}

export const ratioWords: Record<string, string> = {
  '1:1': 'square', '16:9': 'widescreen landscape', '9:16': 'vertical portrait',
  '4:3': 'landscape', '3:4': 'portrait', '3:2': 'landscape', '2:3': 'portrait', '21:9': 'ultrawide panorama',
}
export function codexPrompt(prompt: string, ratio?: string): string {
  return ratio ? `${prompt.trimEnd()} Image format: ${ratio}${ratioWords[ratio] ? ` ${ratioWords[ratio]}` : ''}.` : prompt
}
export function generatorCost(route: GeneratorRoute, w: number, h: number, count = 1): number {
  const c = route.cost
  return Math.round((route.backend === 'fal' && c.usd_per_megapixel !== undefined
    ? c.usd_per_megapixel * (c.eur_per_usd ?? 1) * w * h / 1e6
    : (c.eur_per_image ?? 0)) * count * 1e5) / 1e5
}
export interface GenerateInput {
  prompt: string; route?: string; ratio?: string; size?: string; steps?: number; cfg?: number
  seed?: number; count?: number; background?: 'auto' | 'opaque' | 'transparent'; enhance?: boolean
}
export interface GeneratedImage { path: string; sidecar: string; width: number; height: number; seed: number; seconds: number; cost_eur: number }
export interface GenerateOptions {
  signal?: AbortSignal
  /** Synchronous accounting hook: called once for each persisted image, even if a later image fails. */
  onImage?: (image: GeneratedImage, route: GeneratorRoute) => void
}

function imageDims(b: Buffer): { width: number; height: number } {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  throw new Error('Generator returned a non-PNG image')
}
function fill(node: unknown, values: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map(v => fill(v, values))
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, values)]))
  if (typeof node === 'string' && node.startsWith('$') && node.slice(1) in values) return values[node.slice(1)]
  return node
}
async function request(url: string, init: RequestInit = {}, timeout = 120000): Promise<Response> {
  const deadline = AbortSignal.timeout(timeout)
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
  signal.throwIfAborted()
  const res = await fetch(url, { ...init, signal })
  if (!res.ok) throw new Error(`Image backend HTTP ${res.status}`) // never print response body or credentials
  return res
}
async function json(url: string, body?: unknown, headers?: Record<string, string>, timeout?: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return await (await request(url, body === undefined ? { signal } : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal }, timeout)).json() as Record<string, unknown>
}
async function comfy(route: GeneratorRoute, config: GeneratorConfig, prompt: string, dims: { width: number; height: number }, seed: number, steps: number, cfg: number, signal?: AbortSignal): Promise<Buffer> {
  const ep = route.endpoint!.replace(/\/$/, '')
  await json(`${ep}/system_stats`, undefined, undefined, undefined, signal)
  // Fail closed unless an operator-supplied executable has checked that mflux is idle.
  // Exit zero means idle; every other exit (including SSH failure) blocks generation.
  const guard = process.env.GENERATORS_MFLUX_GUARD
  if (!guard) throw new Error('GENERATORS_MFLUX_GUARD is required for ComfyUI')
  try { await promisify(execFile)(guard, [], { timeout: 20000, signal }) }
  catch { throw new Error('mflux guard failed or mflux is busy; ComfyUI generation blocked') }
  const waiting = Date.now()
  while (true) {
    const q = await json(`${ep}/queue`, undefined, undefined, undefined, signal) as {queue_running?: unknown[]; queue_pending?: unknown[]}
    if (!q.queue_running?.length && !q.queue_pending?.length) break
    if (Date.now() - waiting > 300000) throw new Error('ComfyUI queue occupied for 300 seconds')
    await sleep(5000, undefined, { signal })
  }
  const root = path.resolve(process.env.GENERATORS_WORKFLOW_DIR || path.dirname(config.configPath))
  const wfPath = path.resolve(root, route.workflow!)
  if (!wfPath.startsWith(root + path.sep)) throw new Error('Workflow must be inside the configured workflow directory')
  const workflow = fill(JSON.parse(fs.readFileSync(wfPath, 'utf8')), {
    prompt, ...dims, seed, steps, cfg, sampler: route.defaults.sampler || 'euler', scheduler: route.defaults.scheduler || 'simple',
  })
  // Workflow files may already contain the ComfyUI API envelope { prompt: { ...nodes } }.
  const payload = workflow && typeof workflow === 'object' && 'prompt' in workflow
    && typeof workflow.prompt === 'object' ? workflow : { prompt: workflow }
  const submitted = await json(`${ep}/prompt`, { ...payload, client_id: crypto.randomUUID() }, undefined, 30000, signal)
  if (!submitted.prompt_id || typeof submitted.prompt_id !== 'string') throw new Error('ComfyUI rejected workflow')
  for (let delay = 1000, start = Date.now(); Date.now() - start < 900000; delay = Math.min(delay * 1.3, 5000)) {
    const history = await json(`${ep}/history/${encodeURIComponent(submitted.prompt_id)}`, undefined, undefined, undefined, signal)
    const entry = history[submitted.prompt_id] as {status?: {status_str?: string}; outputs?: Record<string, unknown>} | undefined
    if (entry?.status?.status_str === 'error') throw new Error('ComfyUI workflow failed')
    for (const output of Object.values(entry?.outputs || {}) as Array<{images?: Array<{filename: string; subfolder?: string; type?: string}>}>) {
      if (output.images?.length) {
        const image = output.images[0]
        const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' })
        return Buffer.from(await (await request(`${ep}/view?${params}`, { signal }, 120000)).arrayBuffer())
      }
    }
    await sleep(delay, undefined, { signal })
  }
  throw new Error('ComfyUI generation timed out')
}
function falKey(route: GeneratorRoute): string {
  if (process.env.FAL_KEY) return process.env.FAL_KEY
  // Accept legacy route-specific credential-file keys without exposing their names.
  const file = route.key_file || Object.entries(route).find(([key, value]) => key.endsWith('_file') && typeof value === 'string')?.[1]
  if (!file) throw new Error('FAL_KEY or key_file is required')
  const match = fs.readFileSync(String(file), 'utf8').match(/^FAL_KEY=["']?([^\r\n"']+)/m)
  if (!match) throw new Error('FAL_KEY missing in key file')
  return match[1]
}
async function fal(route: GeneratorRoute, prompt: string, dims: { width: number; height: number }, seed: number, steps: number, signal?: AbortSignal): Promise<Buffer> {
  const result = await json(route.endpoint!, {
    prompt, image_size: dims, num_inference_steps: steps, seed, num_images: 1, output_format: 'png', enable_safety_checker: true,
  }, { Authorization: `Key ${falKey(route)}` }, 180000, signal)
  const url = (result.images as Array<{url?: string}> | undefined)?.[0]?.url
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('fal returned no secure image URL')
  return Buffer.from(await (await request(url, { signal })).arrayBuffer())
}
async function codex(route: GeneratorRoute, prompt: string, background?: string, signal?: AbortSignal): Promise<Buffer> {
  const provider = loadProvidersDecrypted().providers.find(p => p.provider === 'openai-codex' && p.authMethod === 'oauth')
  if (!provider?.oauthCredentials) throw new Error('No openai-codex login configured')
  // The provider's existing serialized OAuth refresh handles expired credentials.
  // Re-read the store after refresh: the access token may have rotated.
  signal?.throwIfAborted()
  await getApiKeyForProvider(provider)
  signal?.throwIfAborted()
  const access = loadProvidersDecrypted().providers.find(p => p.id === provider.id)?.oauthCredentials?.access
  if (!access) throw new Error('No openai-codex access token configured')
  let claims: {exp?: number; 'https://api.openai.com/auth'?: {chatgpt_account_id?: string}}
  try { claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()) as typeof claims } catch { throw new Error('Invalid Codex access token') }
  if (Number(claims.exp) - Date.now() / 1000 < 300) throw new Error('Codex access token expired; refresh via provider login')
  const account = claims['https://api.openai.com/auth']?.chatgpt_account_id
  if (!account) throw new Error('Codex account ID missing')
  // Only operator-owned YAML may specify an OAuth endpoint; never accept one from tool input.
  if (!route.endpoint) throw new Error('Codex image endpoint missing from route config')
  const target = new URL(route.endpoint)
  if (target.protocol !== 'https:' || target.pathname !== '/backend-api/codex/images/generations'
    || target.href !== target.origin + target.pathname) throw new Error('Invalid Codex image endpoint')
  const endpoint = target.toString()
  const result = await json(endpoint, {
    model: route.model, prompt, ...(background ? { background } : {}),
  }, { Authorization: `Bearer ${access}`, 'ChatGPT-Account-ID': account, originator: 'pi' }, 180000, signal)
  const encoded = (result.data as Array<{b64_json?: string}> | undefined)?.[0]?.b64_json
  if (!encoded) throw new Error('Codex returned no image')
  return Buffer.from(encoded, 'base64')
}

export async function generateImages(config: GeneratorConfig, input: GenerateInput, options: GenerateOptions = {}): Promise<{ route: GeneratorRoute; images: GeneratedImage[] }> {
  const { signal } = options
  signal?.throwIfAborted()
  if (!input.prompt?.trim() || input.prompt.length > 12000) throw new Error('Prompt must have 1–12000 characters')
  const routeId = input.route || config.routes.find(r => r.status === 'ok' && r.triggers.some(t => t && input.prompt.toLowerCase().includes(t.toLowerCase())))?.id || config.default_route
  const route = config.routes.find(r => r.id === routeId)
  if (!route || route.status !== 'ok') throw new Error(`Generator route ${routeId} is unavailable`)
  for (const key of ['ratio', 'size', 'steps', 'cfg', 'seed', 'count', 'background', 'enhance'] as const) {
    if (input[key] !== undefined && !route.params_allowed.includes(key)) throw new Error(`${key} is not allowed for route ${route.id}`)
  }
  if (input.enhance) throw new Error('Prompt enhancement is not yet supported by the native tool')
  const ratio = input.ratio || String(route.defaults.ratio || '1:1')
  if (!/^\d{1,3}:\d{1,3}$/.test(ratio) || !config.ratios.includes(ratio)) throw new Error('Invalid image ratio')
  const size = input.size || String(route.defaults.size || 'm')
  const explicit = /^(\d{2,4})x(\d{2,4})$/.exec(size)
  const base = config.size_presets[size]
  if (!explicit && (!Number.isFinite(base) || base < 64 || base > 2048)) throw new Error('Invalid size preset')
  const [rw, rh] = ratio.split(':').map(Number)
  const h = Math.floor(Math.sqrt(base * base * rh / rw))
  const dims = explicit ? { width: Number(explicit[1]), height: Number(explicit[2]) }
    : rw === rh ? { width: base, height: base }
      : { width: Math.max(64, Math.floor(h * rw / rh / 64) * 64), height: Math.max(64, Math.floor(h / 64) * 64) }
  if (dims.width < 64 || dims.height < 64 || dims.width > 4096 || dims.height > 4096) throw new Error('Image dimensions must be between 64 and 4096 pixels')
  const count = input.count ?? Number(route.defaults.count || 1)
  const steps = input.steps ?? Number(route.defaults.steps || 8)
  const cfg = input.cfg ?? Number(route.defaults.cfg ?? 1)
  if (!Number.isInteger(count) || count < 1 || count > 4 || !Number.isInteger(steps) || steps < 1 || steps > 100
    || !Number.isFinite(cfg) || cfg < 0 || cfg > 30) throw new Error('Invalid generation parameters')
  const seed = input.seed ?? crypto.randomInt(0, 2 ** 32)
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) throw new Error('Invalid seed')
  const outdir = path.join(config.output_dir, new Date().toISOString().slice(0, 10))
  fs.mkdirSync(outdir, { recursive: true })
  const images: GeneratedImage[] = []
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted()
    const currentSeed = (seed + i) % (2 ** 32), started = Date.now()
    const used = route.backend.startsWith('openai-codex') ? codexPrompt(input.prompt, input.ratio) : input.prompt
    const buffer = route.backend === 'comfyui' ? await comfy(route, config, used, dims, currentSeed, steps, cfg, signal)
      : route.backend === 'fal' ? await fal(route, used, dims, currentSeed, steps, signal)
        : await codex(route, used, input.background, signal)
    const actual = imageDims(buffer)
    const cost = generatorCost(route, dims.width, dims.height)
    const file = path.join(outdir, `${route.id}-${Date.now()}-${currentSeed}.png`)
    const sidecar = file + '.json'
    const seconds = Math.round((Date.now() - started) / 100) / 10
    fs.writeFileSync(file, buffer, { flag: 'wx' })
    fs.writeFileSync(sidecar, JSON.stringify({ prompt: input.prompt, prompt_used: used, route: route.id, backend: route.backend,
      model: route.model, workflow: route.workflow, params: { ratio, size, steps, cfg, background: input.background },
      seed: currentSeed, ...actual, seconds, cost_eur: cost, created_at: new Date().toISOString() }, null, 2), { flag: 'wx' })
    const image = { path: file, sidecar, ...actual, seed: currentSeed, seconds, cost_eur: cost }
    images.push(image)
    options.onImage?.(image, route)
    signal?.throwIfAborted()
  }
  return { route, images }
}
