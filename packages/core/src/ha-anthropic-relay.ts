/** HA -> existing Offtangent provider. No proxy process, alternate login or identity edits. */
import { parseHaJson } from './ha-json.js'
import type { Context } from '@earendil-works/pi-ai'
import { buildModel, loadProvidersDecrypted } from './provider-config.js'
import { checkAutomaticModelFor } from './data-policy.js'
import { streamSimple } from './pi-models.js'
import { HaProviderFault, resolveHaCredential, repairHaRejectedAccess } from './ha-provider-auth.js'
import type { HaCompletion, HaInferenceConfig } from './ha-inference.js'
export async function completeHaAnthropic(c: HaInferenceConfig, context: Context, signal: AbortSignal): Promise<HaCompletion> {
  const p = loadProvidersDecrypted().providers.find(p => p.id === c.providerId)
  if (!p || p.authMethod !== 'oauth' || p.providerType !== 'anthropic-oauth' || p.type !== 'anthropic-messages'
      || !p.enabledModels?.includes(c.model) || !checkAutomaticModelFor(p, c.model, 'isolated-inference').allowed) {
    throw new HaProviderFault(503, 'subscription_provider_unavailable', 'provider_unavailable')
  }
  // Auth before buildModel, exactly as the normal provider path; shared locked refresh.
  const apiKey = await resolveHaCredential(p)
  signal.throwIfAborted()
  const model = buildModel(p, c.model)
  if (model.id !== c.model || (model.compat as {allowedFallbackModels?: string[]})?.allowedFallbackModels?.length || model.api !== 'anthropic-messages' || model.baseUrl.replace(/\/$/, '') !== 'https://api.anthropic.com') {
    throw new HaProviderFault(503, 'subscription_endpoint_rejected')
  }
  let wireModel = ''; let completed = false; let wireUsage: unknown = null
  let fault: HaProviderFault | undefined; let rejected = false
  const failWire: (code: string) => never = (code) => { fault = new HaProviderFault(502, code); throw fault }
  const started = performance.now(); let ttftMs: number | null = null; let firstToolMs: number | null = null
  const wireFetch: typeof fetch = async (url, init) => {
    const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
    if (target.origin !== 'https://api.anthropic.com' || target.pathname !== '/v1/messages'
        || target.username || target.password || target.hash || !['', '?beta=true'].includes(target.search)) {
      throw new HaProviderFault(503, 'subscription_endpoint_rejected')
    }
    // Existing model/SDK headers and identity unchanged; no relay-specific spoofing.
    const response = await fetch(url, { ...init, redirect: 'error' })
    if (!response.ok) {
      rejected = response.status === 401
      fault = new HaProviderFault(response.status === 429 ? 429 : response.status === 403 ? 503 : 502,
        rejected ? 'provider_access_rejected' : response.status === 429 ? 'subscription_rate_limit' : response.status === 403 ? 'provider_access_blocked' : 'subscription_http_error')
      throw fault
    }
    if (!response.body) throw new HaProviderFault(502, 'empty_subscription_stream')
    const toolParts = new Map<number, string>()
    let buffer = ''; const decoder = new TextDecoder()
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      if (buffer.length > 1048576) failWire('subscription_event_too_large')
      let pos: number
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos).trimEnd(); buffer = buffer.slice(pos + 1)
        if (!line.startsWith('data: ')) continue
        let event: {type:string;index:number;content_block?:{type:string};delta?:{type:string;partial_json:string};message?:{model?:string;usage?:unknown};usage?:Record<string,unknown>}
        try { event = parseHaJson(line.slice(6)) as typeof event } catch { failWire('invalid_subscription_event') }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') toolParts.set(event.index, '')
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          const partial = (toolParts.get(event.index) ?? '') + event.delta.partial_json
          if (partial.length > 16384) failWire('invalid_subscription_arguments')
          toolParts.set(event.index, partial)
        }
        if (event.type === 'content_block_stop' && toolParts.has(event.index)) {
          try { parseHaJson(toolParts.get(event.index) || '{}') } catch { failWire('invalid_subscription_arguments') }
          toolParts.delete(event.index)
        }
        if (event.type === 'message_start') { wireModel = event.message?.model ?? ''; wireUsage = event.message?.usage }
        if (event.type === 'message_delta') wireUsage = { ...(wireUsage as object), ...event.usage }
        if (event.type === 'message_stop') completed = true
        if (event.type === 'error') fault = new HaProviderFault(502, 'subscription_stream_error')
      }
      controller.enqueue(chunk)
    } }))
    return new Response(body, { status: response.status, headers: response.headers })
  }
  const stream = streamSimple(model, context, { apiKey, signal, reasoning: c.thinking ?? 'low', maxTokens: 4096, maxRetries: 0, fetch: wireFetch })
  for await (const event of stream) {
    if (ttftMs === null && ['text_delta', 'toolcall_delta', 'thinking_delta'].includes(event.type)) ttftMs = performance.now() - started
    if (firstToolMs === null && ['toolcall_start', 'toolcall_delta'].includes(event.type)) firstToolMs = performance.now() - started
  }
  const message = await stream.result()
  if (rejected) return repairHaRejectedAccess(p, apiKey) // refresh only, no POST replay
  if (fault) throw fault
  if (!completed || !['stop', 'toolUse'].includes(message.stopReason)) throw new HaProviderFault(502, 'incomplete_subscription_stream')
  return { message, wireModel, completed, metrics: { ttftMs, firstToolMs, totalMs: performance.now() - started, wireUsage } }
}
