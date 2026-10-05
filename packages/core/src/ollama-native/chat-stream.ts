/**
 * Native Ollama `/api/chat` stream for pi-ai (custom API module).
 *
 * This is an ADDITIONAL api (`ollama-chat`) next to the existing OpenAI-compatible
 * `/v1` Ollama adapter, which is left untouched. Contract per Ollama docs/api.md:
 * POST {baseUrl}/api/chat, body { model, messages, tools?, think?, options?, stream },
 * response = NDJSON objects `{ message: { content, thinking?, tool_calls? }, done }`,
 * the final one with `done: true`, `done_reason`, `prompt_eval_count`, `eval_count`.
 *
 * Lifecycle guarantees (no fake success):
 * - HTTP error, `{"error": ...}` line, malformed JSON line, stream end without
 *   `done: true` and unparseable tool-call arguments all end in an `error` event.
 * - Abort ends in an `error` event with reason `aborted`.
 * - `done_reason: "length"` maps to stopReason `length`, tool calls to `toolUse`.
 * - `options.num_ctx` is only sent when the caller passes `ollamaNumCtx`
 *   explicitly (per-strand Eco choice decided by context-window.ts).
 */
import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentTools,
  getSystemMessageText,
  resolveTranscript,
} from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { isValidNumCtx } from './context-window.js'

export const OLLAMA_CHAT_API = 'ollama-chat'

export interface OllamaChatOptions extends SimpleStreamOptions {
  /** Explicit per-request `options.num_ctx`. Omitted = key not sent. */
  ollamaNumCtx?: number
}

interface OllamaToolCall {
  id?: string
  function: { name: string; arguments: unknown; index?: number }
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  images?: string[]
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

export interface OllamaChatBody {
  model: string
  messages: OllamaMessage[]
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>
  think?: boolean
  options?: { num_ctx?: number; num_predict?: number; temperature?: number }
  stream: true
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
}

function imagesOf(content: ReadonlyArray<{ type: string; data?: string }>): string[] {
  return content.filter((c) => c.type === 'image' && typeof c.data === 'string').map((c) => c.data as string)
}

function convertTool(tool: Tool) {
  return {
    type: 'function' as const,
    // JSON round-trip drops TypeBox symbol keys; schema stays logically identical.
    function: { name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)) as unknown },
  }
}

export function buildOllamaChatBody(model: Model<string>, context: TranscriptContext, options: OllamaChatOptions): OllamaChatBody {
  // Ollama has no mid-conversation system messages: collapse to one leading system message.
  const transcript = resolveTranscript(context, false)
  const tools = getCurrentTools(transcript.messages)
  const messages: OllamaMessage[] = []
  const transformed = transformMessages(transcript.messages, model)
  for (const msg of transformed) {
    if (msg.role === 'system') {
      const text = getSystemMessageText(msg)
      if (text.length > 0) messages.push({ role: 'system', content: text })
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content })
      } else {
        const images = imagesOf(msg.content)
        messages.push({ role: 'user', content: textOf(msg.content), ...(images.length > 0 ? { images } : {}) })
      }
    } else if (msg.role === 'assistant') {
      const text = msg.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('')
      const thinking = msg.content.filter((c): c is ThinkingContent => c.type === 'thinking').map((c) => c.thinking).join('')
      const calls = msg.content.filter((c): c is ToolCall => c.type === 'toolCall')
      const out: OllamaMessage = { role: 'assistant', content: text }
      if (thinking.length > 0) out.thinking = thinking
      if (calls.length > 0) out.tool_calls = calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }))
      messages.push(out)
    } else if (msg.role === 'toolResult') {
      const images = imagesOf(msg.content)
      messages.push({ role: 'tool', content: textOf(msg.content), tool_name: msg.toolName, ...(images.length > 0 ? { images } : {}) })
    }
  }
  const body: OllamaChatBody = { model: model.id, messages, stream: true }
  if (tools.length > 0) body.tools = tools.map(convertTool)
  if (model.reasoning && options.reasoning) body.think = true
  const opts: NonNullable<OllamaChatBody['options']> = {}
  if (options.ollamaNumCtx !== undefined) {
    if (!isValidNumCtx(options.ollamaNumCtx)) throw new Error(`invalid num_ctx ${String(options.ollamaNumCtx)}`)
    opts.num_ctx = options.ollamaNumCtx
  }
  if (options.maxTokens !== undefined && Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0) opts.num_predict = options.maxTokens
  if (options.temperature !== undefined) opts.temperature = options.temperature
  if (Object.keys(opts).length > 0) body.options = opts
  return body
}

function emptyUsage(): AssistantMessage['usage'] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

class StreamFailure extends Error {}

function chatUrl(baseUrl: string): string {
  // Accept both "http://host:11434" and a mistakenly configured ".../v1" base.
  const trimmed = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  return `${trimmed}/api/chat`
}

export function streamOllamaChat(model: Model<string>, context: TranscriptContext, options: OllamaChatOptions = {}): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  } as AssistantMessage
  void run()
  return stream

  async function run(): Promise<void> {
    let open: { kind: 'text' | 'thinking'; index: number } | undefined
    const closeOpen = () => {
      if (!open) return
      const block = output.content[open.index]
      if (open.kind === 'text' && block?.type === 'text') stream.push({ type: 'text_end', contentIndex: open.index, content: block.text, partial: output })
      if (open.kind === 'thinking' && block?.type === 'thinking') stream.push({ type: 'thinking_end', contentIndex: open.index, content: block.thinking, partial: output })
      open = undefined
    }
    const appendDelta = (kind: 'text' | 'thinking', delta: string) => {
      if (delta.length === 0) return
      if (!open || open.kind !== kind) {
        closeOpen()
        output.content.push(kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' })
        open = { kind, index: output.content.length - 1 }
        stream.push({ type: kind === 'text' ? 'text_start' : 'thinking_start', contentIndex: open.index, partial: output })
      }
      const block = output.content[open.index]
      if (block?.type === 'text') block.text += delta
      if (block?.type === 'thinking') block.thinking += delta
      stream.push({ type: kind === 'text' ? 'text_delta' : 'thinking_delta', contentIndex: open.index, delta, partial: output })
    }
    const callPrefix = `ollama_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    let callCount = 0
    const addToolCalls = (calls: OllamaToolCall[]) => {
      closeOpen()
      for (const call of calls) {
        const name = call?.function?.name
        if (typeof name !== 'string' || name.length === 0) throw new StreamFailure('Ollama returned a tool call without a function name')
        let args: unknown = call.function.arguments ?? {}
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            throw new StreamFailure(`Ollama returned unparseable arguments for tool call "${name}"`)
          }
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new StreamFailure(`Ollama returned non-object arguments for tool call "${name}"`)
        const toolCall: ToolCall = { type: 'toolCall', id: typeof call.id === 'string' && call.id ? call.id : `${callPrefix}_${callCount}`, name, arguments: args as JsonObject }
        callCount += 1
        output.content.push(toolCall)
        const index = output.content.length - 1
        stream.push({ type: 'toolcall_start', contentIndex: index, partial: output })
        stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(args), partial: output })
        stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: output })
      }
    }

    try {
      let body: unknown = buildOllamaChatBody(model, context, options)
      if (options.onPayload) {
        const replaced = await options.onPayload(body, model)
        if (replaced !== undefined) body = replaced
      }
      const fetchFn = options.fetch ?? fetch
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(model.headers ?? {}) }
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
      const response = await (fetchFn as typeof fetch)(chatUrl(model.baseUrl), { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let detail = text
        try {
          const parsed = JSON.parse(text) as { error?: unknown }
          if (typeof parsed.error === 'string') detail = parsed.error
        } catch { /* keep raw text */ }
        throw new StreamFailure(`Ollama HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`)
      }
      if (!response.body) throw new StreamFailure('Ollama response has no body')
      stream.push({ type: 'start', partial: output })

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let finished = false
      const handleLine = (lineText: string) => {
        if (lineText.trim().length === 0) return
        if (finished) return
        let chunk: {
          error?: unknown; done?: boolean; done_reason?: string; model?: string
          message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] }
          prompt_eval_count?: number; eval_count?: number
        }
        try {
          chunk = JSON.parse(lineText) as typeof chunk
        } catch {
          throw new StreamFailure(`Ollama stream contained a malformed line: ${lineText.slice(0, 200)}`)
        }
        if (chunk.error !== undefined) throw new StreamFailure(`Ollama error: ${typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error)}`)
        if (typeof chunk.model === 'string' && chunk.model !== model.id) output.responseModel = chunk.model
        const m = chunk.message
        if (m) {
          if (typeof m.thinking === 'string') appendDelta('thinking', m.thinking)
          if (typeof m.content === 'string') appendDelta('text', m.content)
          if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) addToolCalls(m.tool_calls)
        }
        if (chunk.done === true) {
          finished = true
          const input = Number.isSafeInteger(chunk.prompt_eval_count) ? (chunk.prompt_eval_count as number) : 0
          const out = Number.isSafeInteger(chunk.eval_count) ? (chunk.eval_count as number) : 0
          output.usage = { ...emptyUsage(), input, output: out, totalTokens: input + out }
          output.usage.cost = calculateCost(model, output.usage)
          if (chunk.done_reason !== undefined) output.rawStopReason = chunk.done_reason
          const hasCalls = output.content.some((c) => c.type === 'toolCall')
          output.stopReason = chunk.done_reason === 'length' ? 'length' : hasCalls ? 'toolUse' : 'stop'
        }
      }
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          handleLine(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
        }
      }
      buffer += decoder.decode()
      handleLine(buffer)
      if (!finished) throw new StreamFailure('Ollama stream ended before done:true (truncated response)')
      closeOpen()
      const reason = output.stopReason as 'stop' | 'length' | 'toolUse'
      stream.push({ type: 'done', reason, message: output })
      stream.end(output)
    } catch (err) {
      closeOpen()
      const aborted = options.signal?.aborted === true
      output.stopReason = aborted ? 'aborted' : 'error'
      output.errorMessage = aborted ? 'Request aborted' : err instanceof Error ? err.message : String(err)
      stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: output })
      stream.end(output)
    }
  }
}

/** pi-ai `ProviderStreams` for `createProvider({ api: OLLAMA_CHAT_API, streams })`. */
export const ollamaChatStreams = {
  stream: (model: Model<string>, context: TranscriptContext, options?: OllamaChatOptions) => streamOllamaChat(model, context, options),
  streamSimple: (model: Model<string>, context: TranscriptContext, options?: OllamaChatOptions) => streamOllamaChat(model, context, options),
}
