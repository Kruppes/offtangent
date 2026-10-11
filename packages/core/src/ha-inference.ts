/** HA-only chat-completions adapter. No agent, memory, logging, persistence or tool execution.
 * Deliberately separate from isolated-inference/interview.v1. Config absent => no listener.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { parseHaJson } from './ha-json.js'
import { Check } from 'typebox/value'
import type { AssistantMessage, Context, Message, Tool } from '@earendil-works/pi-ai'
import { buildModel, loadProvidersDecrypted } from './provider-config.js'
import { checkAutomaticModelFor } from './data-policy.js'
import { streamSimple } from './pi-models.js'
import { completeHaAnthropic } from './ha-anthropic-relay.js'
import { HaProviderFault, inspectHaAuth, recordHaAuthState, resolveHaCredential, repairHaRejectedAccess } from './ha-provider-auth.js'

export interface HaTool { name: string; description: string; parameters: Record<string, unknown> }
export interface HaInferenceConfig {
  enabled: true; tokenSha256: string; providerId: string; model: string; tools: HaTool[]
  timeoutMs: number; maxBodyBytes: number; maxCallsPerHour: number
  /** Uses the normal central subscription provider; no additional identity/header alterations. */
  transport?: 'codex' | 'anthropic-oauth'; thinking?: 'low'
}
export interface HaCompletion { message: AssistantMessage; wireModel: string; completed: boolean; metrics?: { ttftMs: number | null; firstToolMs: number | null; totalMs: number; wireUsage: unknown } }
export type HaComplete = (config: HaInferenceConfig, context: Context, signal: AbortSignal) => Promise<HaCompletion>
class Fault extends HaProviderFault {}
function fail(code = 'invalid_request'): never { throw new Fault(400, code) }
function obj(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail()
  return x as Record<string, unknown>
}
function keys(x: Record<string, unknown>, allowed: string[]) { if (Object.keys(x).some(k => !allowed.includes(k))) fail('unsupported_field') }
function str(x: unknown, max = 100000): string { if (typeof x !== 'string' || x.length > max) fail(); return x }
function canonical(x: unknown): string {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']'
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical((x as Record<string,unknown>)[k])).join(',') + '}'
  return JSON.stringify(x)
}
function args(tool: HaTool, raw: unknown): Extract<AssistantMessage['content'][number], {type: 'toolCall'}>['arguments'] {
  const value = obj(typeof raw === 'string' ? parseHaJson(str(raw, 16384)) : raw)
  if (JSON.stringify(value).length > 16384) fail('invalid_tool_arguments')
  if (!Check(tool.parameters, value)) fail('invalid_tool_arguments')
  return value as Extract<AssistantMessage['content'][number], {type: 'toolCall'}>['arguments']
}
export function validateHaConfig(raw: unknown): HaInferenceConfig {
  const c = obj(raw)
  keys(c, ['enabled','tokenSha256','providerId','model','tools','timeoutMs','maxBodyBytes','maxCallsPerHour','transport','thinking'])
  if (c.enabled !== true || typeof c.tokenSha256!=='string' || !/^[a-f0-9]{64}$/.test(c.tokenSha256) || typeof c.model!=='string' || !/^[a-zA-Z0-9-]{1,128}$/.test(c.model)) fail('invalid_config')
  if(!str(c.providerId,128))fail('invalid_config')
  if(c.transport!==undefined&&(typeof c.transport!=='string'||!['codex','anthropic-oauth'].includes(c.transport)))fail('invalid_config')
  if(c.thinking!==undefined&&c.thinking!=='low')fail('invalid_config')
  if(c.transport==='anthropic-oauth'&&(c.model!=='claude-haiku-5-5'||c.thinking===undefined))fail('invalid_config')
  if(c.transport!=='anthropic-oauth'&&c.thinking!==undefined)fail('invalid_config')
  for (const [k,lo,hi] of [['timeoutMs',1000,90000],['maxBodyBytes',1024,262144],['maxCallsPerHour',1,1000]] as const) {
    if (typeof c[k]!=='number' || !Number.isInteger(c[k]) || c[k]<lo || c[k]>hi) fail('invalid_config')
  }
  if (!Array.isArray(c.tools) || c.tools.length>32) fail('invalid_config')
  const seen = new Set<string>()
  for (const tool of c.tools) {
    const t = obj(tool); keys(t,['name','description','parameters'])
    if (typeof t.name!=='string' || !(/^(?:[a-z][a-z0-9_]{0,39}__)?(?:GetLiveContext|Hass[A-Z][A-Za-z0-9]{0,59})$/.test(t.name)) || seen.has(t.name)) fail('invalid_config')
    seen.add(t.name); str(t.description,2048); const parameters=obj(t.parameters)
    if (parameters.type !== 'object' || canonical(t.parameters).length>20000) fail('invalid_config')
  }
  return c as unknown as HaInferenceConfig
}
function requestContext(body: unknown, c: HaInferenceConfig): { context: Context; streaming: boolean; outputCap?:number } {
  const b = obj(body)
  keys(b,['model','messages','tools','stream','stream_options','tool_choice','max_tokens','max_completion_tokens','temperature','top_p','reasoning_effort','service_tier','ha_session'])
  if(c.transport==='anthropic-oauth'&&['temperature','top_p','reasoning_effort','service_tier'].some(key=>b[key]!==undefined))fail('unsupported_parameter')
  // Codex transport has no sampling/output-budget parameters. Neutral
  // client defaults are accepted explicitly; token cap is a post-completion fence.
  for(const [key,value]of [['temperature',1],['top_p',1],['reasoning_effort','minimal'],['service_tier','auto']] as const)if(b[key]!==undefined&&b[key]!==value)fail('unsupported_parameter')
  if(b.tool_choice!==undefined&&(typeof b.tool_choice!=='string'||!['auto','none'].includes(b.tool_choice)))fail('unsupported_tool_choice')
  if(b.max_tokens!==undefined&&b.max_completion_tokens!==undefined)fail('conflicting_output_caps')
  const outputCap=b.max_tokens??b.max_completion_tokens
  if(outputCap!==undefined&&(typeof outputCap!=='number'||!Number.isInteger(outputCap)||outputCap<1||outputCap>4096))fail('invalid_output_cap')
  if (b.model !== c.model) fail('model_is_pinned')
  if (b.stream !== undefined && typeof b.stream !== 'boolean') fail()
  if (b.stream_options !== undefined) { const o=obj(b.stream_options); keys(o,['include_usage']); if (typeof o.include_usage !== 'boolean') fail() }
  const tools: Tool[] = []; const byName = new Map<string,HaTool>()
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools) || b.tools.length>32) fail()
    for (const t0 of b.tools) {
      const t=obj(t0); keys(t,['type','function']); if (t.type!=='function') fail('unsupported_tool')
      const f=obj(t.function); keys(f,['name','description','parameters','strict'])
      const trusted=c.tools.find(t=>t.name===f.name)
      if (!trusted || byName.has(trusted.name) || canonical(f.parameters)!==canonical(trusted.parameters)) fail('tool_not_allowed')
      if (f.description!==undefined) str(f.description,2048)
      if (f.strict!==undefined && typeof f.strict!=='boolean') fail()
      byName.set(trusted.name,trusted); tools.push(trusted)
    }
  }
  if (!Array.isArray(b.messages) || b.messages.length<1 || b.messages.length>64) fail()
  const messages: Message[] = []; let systemPrompt=''; let started=false
  const pending=new Map<string,{name:string}>(); const ids=new Set<string>()
  for (const raw of b.messages) {
    const m=obj(raw); const role=m.role
    if (role==='system' || role==='developer') {
      keys(m,['role','content']); if(started) fail('system_must_be_first')
      systemPrompt += (systemPrompt?'\n':'')+str(m.content); continue
    }
    started=true
    if (role==='user') {
      keys(m,['role','content']); if(pending.size) fail('missing_tool_result')
      messages.push({role:'user',content:str(m.content),timestamp:Date.now()})
    } else if(role==='assistant') {
      keys(m,['role','content','tool_calls']); if(pending.size) fail('missing_tool_result')
      const content: AssistantMessage['content']=[]
      if(m.content!==null && m.content!==undefined) content.push({type:'text',text:str(m.content)})
      if(m.tool_calls!==undefined) {
        if(!Array.isArray(m.tool_calls) || m.tool_calls.length>16) fail()
        for(const rawCall of m.tool_calls) {
          const tc=obj(rawCall); keys(tc,['id','type','function']); const f=obj(tc.function); keys(f,['name','arguments'])
          const id=str(tc.id,128); const t=byName.get(f.name as string)
          if(tc.type!=='function'||!id||ids.has(id)||!t) fail('invalid_tool_history')
          content.push({type:'toolCall',id,name:t.name,arguments:args(t,f.arguments)}); pending.set(id,{name:t.name}); ids.add(id)
        }
      }
      messages.push({role:'assistant',content,api:c.transport==='anthropic-oauth'?'anthropic-messages':'openai-codex-responses',provider:c.transport==='anthropic-oauth'?'anthropic':'openai-codex',model:c.model,
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:pending.size?'toolUse':'stop',timestamp:Date.now()})
    } else if(role==='tool') {
      keys(m,['role','tool_call_id','content']); const id=str(m.tool_call_id,128); const tc=pending.get(id)
      if(!tc) fail('orphan_tool_result'); pending.delete(id)
      messages.push({role:'toolResult',toolCallId:id,toolName:tc.name,content:[{type:'text',text:str(m.content)}],isError:toolResultIsError(m.content),timestamp:Date.now()})
    } else fail('unsupported_role')
  }
  if(pending.size || !messages.length || !['user','toolResult'].includes(messages.at(-1)!.role)) fail('invalid_history_end')
  return {context:{systemPrompt,messages,tools:b.tool_choice==='none'?[]:tools},streaming:b.stream===true,outputCap}
}
/** HA tools return structured intent results. Transport error signaling is not a truth checker. */
function toolResultIsError(content: unknown): boolean {
  try {const r=parseHaJson(str(content)) as {error?:unknown;success?:unknown;response?:{response_type?:unknown;data?:{failed?:unknown[]}};response_type?:unknown;data?:{failed?:unknown[]}} | null;const response=r?.response??r;return !!r?.error || r?.success===false || response?.response_type==='error' || (Array.isArray(response?.data?.failed)&&response.data.failed.length>0)}catch{return false}
}
/** Reuses existing OAuth lifecycle. Never attempts API billing or another model. */
export const completeHaSubscription: HaComplete = async (c, context, signal) => {
  if(c.transport==='anthropic-oauth')return completeHaAnthropic(c,context,signal)
  const p=loadProvidersDecrypted().providers.find(p=>p.id===c.providerId)
  if(!p || p.authMethod!=='oauth' || p.providerType!=='openai-codex' || p.type!=='openai-codex-responses'
    || !p.enabledModels?.includes(c.model) || !checkAutomaticModelFor(p,c.model,'isolated-inference').allowed) throw new Fault(503,'subscription_provider_unavailable')
  const model=buildModel(p,c.model)
  // Existing Codex provider only. A custom URL must never receive the account token.
  if (!['https://chatgpt.com/backend-api','https://chatgpt.com/backend-api/codex'].includes(model.baseUrl.replace(/\/$/,''))) throw new Fault(503,'subscription_endpoint_rejected')
  const started=performance.now(); let ttftMs: number|null=null; let firstToolMs: number|null=null; let wireUsage: unknown=null
  let wireModel=''; let completed=false; let wireError=''; let rejected=false; let transportFault:Fault|undefined
  const wireFetch: typeof fetch = async (url, init) => {
    const target=new URL(typeof url==='string'?url:url instanceof URL?url.href:url.url)
    if(target.origin!=='https://chatgpt.com' || target.pathname!=='/backend-api/codex/responses' || target.username || target.password || target.search || target.hash) throw new Fault(503,'subscription_endpoint_rejected')
    const r=await fetch(url,{...init,redirect:'error'})
    if(!r.ok) {rejected=r.status===401;transportFault=new Fault(r.status===429?429:502,r.status===429?'subscription_rate_limit':'subscription_http_error');throw transportFault}
    if(!r.body) throw new Fault(502,'empty_subscription_stream')
    let buffer=''; const decoder=new TextDecoder()
    const body=r.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
      buffer+=decoder.decode(chunk,{stream:true}); if(buffer.length>1048576) throw new Fault(502,'subscription_event_too_large')
      let pos: number
      while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos).trimEnd();buffer=buffer.slice(pos+1)
        if(line.startsWith('data: ')) {const data=line.slice(6); if(data==='[DONE]')continue
          let event: { type: string; arguments: string; code?: string; error?: { code?: string }; response?: { model?: string; output?: { type: string; arguments: string }[]; status?: string; usage?: unknown; error?: { code?: string } } }; try {event=parseHaJson(data) as typeof event} catch {throw new Fault(502,'invalid_subscription_event')}
          if(event.response?.model) {if(wireModel && wireModel!==event.response.model)throw new Fault(502,'upstream_model_changed');wireModel=event.response.model}
          if(event.type==='response.function_call_arguments.done') {try {parseHaJson(event.arguments)} catch {throw new Fault(502,'invalid_subscription_arguments')}}
          for(const item of event.response?.output ?? []) if(item.type==='function_call') {try {parseHaJson(item.arguments)} catch {throw new Fault(502,'invalid_subscription_arguments')}}
          if(event.type==='response.completed') {completed=event.response?.status==='completed';wireUsage=event.response?.usage}
          if(['response.failed','response.incomplete','error'].includes(event.type)) wireError=event.response?.error?.code || event.error?.code || event.code || event.type
        }
      } controller.enqueue(chunk)
    }}))
    return new Response(body,{status:r.status,statusText:r.statusText,headers:r.headers})
  }
  const apiKey=await resolveHaCredential(p)
  const stream=streamSimple(model,context,{apiKey,signal,reasoning:'minimal',maxRetries:0,transport:'sse',fetch:wireFetch})
  for await(const event of stream) {
    if(ttftMs===null && ['text_delta','toolcall_delta','thinking_delta'].includes(event.type))ttftMs=performance.now()-started
    if(firstToolMs===null && ['toolcall_start','toolcall_delta'].includes(event.type))firstToolMs=performance.now()-started
  }
  const message=await stream.result()
  if(rejected)return repairHaRejectedAccess(p,apiKey) // repair NEXT turn only, no inference replay
  if(transportFault)throw transportFault
  if(wireError) throw new Fault(wireError.includes('usage_limit')?429:502,wireError.includes('usage_limit')?'subscription_usage_limit':'subscription_failed')
  return {message,wireModel,completed,metrics:{ttftMs,firstToolMs,totalMs:performance.now()-started,wireUsage}}
}
function errorResponse(status: number, code: string) {return Response.json({error:{message:code,type:'ha_inference_error',code}},{status})}
/** All output (including SSE) is buffered until upstream completed + validated. No partial actions. */
export function createHaInferenceHandler(config: HaInferenceConfig, complete: HaComplete = completeHaSubscription) {
  const c=structuredClone(validateHaConfig(config)); let active=0; let hour=Date.now(); let calls=0
  // Ephemeral native transcript vault; thinking/signatures never leave this process.
  // One-use handles bind to the exact authenticated HA exchange. No persistence.
  const sessions=new Map<string,{expires:number;prefix:unknown[];context:Context;toolSpec:string}>()
  const sessionTtlMs=300000
  const toolSpec=(b:Record<string,unknown>)=>canonical({tools:b.tools??[],tool_choice:b.tool_choice??'auto'})
  return async (req: Request): Promise<Response> => {
    const url=new URL(req.url);const catalog=req.method==='GET'&&url.pathname==='/v1/models'
    const status=req.method==='GET'&&url.pathname==='/v1/status'
    const discard=req.method==='POST'&&url.pathname==='/v1/session/discard'
    if(url.search || (!catalog&&!status&&!discard&&(req.method!=='POST'||url.pathname!=='/v1/chat/completions')))return errorResponse(404,'not_found')
    const token=req.headers.get('authorization')?.match(/^Bearer ([^\s]{16,512})$/)?.[1]
    const hash=createHash('sha256').update(token??'').digest(); const want=Buffer.from(c.tokenSha256,'hex')
    if(!token || !timingSafeEqual(hash,want)) return errorResponse(401,'unauthorized')
    if(status){try{return Response.json({auth:inspectHaAuth(c.providerId),model:c.model})}catch{return errorResponse(503,'auth_status_unavailable')}}
    if(catalog)return Response.json({object:'list',data:[{id:c.model,object:'model',created:0,owned_by:'ha-subscription-pin'}]})
    if(active>=1) return errorResponse(429,'ha_busy')
    if(Date.now()-hour>=3600000){hour=Date.now();calls=0}
    if(calls>=c.maxCallsPerHour) return errorResponse(429,'ha_hourly_limit')
    active++; const signal=AbortSignal.any([req.signal,AbortSignal.timeout(c.timeoutMs)])
    let removeAbort=()=>{}
    const aborted=new Promise<never>((_,reject)=>{const onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});removeAbort=()=>signal.removeEventListener('abort',onAbort)})
    try {
      signal.throwIfAborted()
      if(!req.headers.get('content-type')?.startsWith('application/json')) fail('content_type')
      const reader=req.body?.getReader(); if(!reader) fail()
      const parts: Uint8Array[]=[];let size=0
      while(true){signal.throwIfAborted();const part=await Promise.race([reader.read(),aborted]);if(part.done)break
        size+=part.value.length;if(size>c.maxBodyBytes){void reader.cancel();throw new Fault(413,'body_too_large')}parts.push(part.value)
      }
      const parsed=parseHaJson(Buffer.concat(parts).toString('utf8'));
      const b=parsed as Record<string,unknown> & {messages:Record<string,unknown>[];stream_options?:{include_usage?:boolean}};
      if(discard){const d=obj(parsed);keys(d,['ha_session']);const id=str(d.ha_session,128);if(!sessions.delete(id))fail('invalid_ha_session');return Response.json({discarded:true})}
      const {context,streaming,outputCap}=requestContext(parsed,c)
      const anthropic=c.transport==='anthropic-oauth'
      for(const [id,s]of sessions)if(s.expires<=Date.now())sessions.delete(id)
      if(anthropic){
        if(b.ha_session!==undefined){
          const id=str(b.ha_session,128);const stored=sessions.get(id)
          if(!stored||stored.toolSpec!==toolSpec(b)||canonical(b.messages.slice(0,stored.prefix.length))!==canonical(stored.prefix))fail('invalid_ha_session')
          // Require exactly the pending tool results, no extra user/assistant data.
          const n=(stored.context.messages.at(-1) as AssistantMessage).content.filter(x=>x.type==='toolCall').length
          const tail=b.messages.slice(stored.prefix.length)
          if(!n||tail.length!==n||tail.some(m=>m.role!=='tool'))fail('invalid_ha_session')
          const parsedTail=context.messages.slice(-n)
          context.messages=[...structuredClone(stored.context.messages),...parsedTail]
          // Consume before inference: failure/cancel cannot replay an action batch.
          sessions.delete(id)
        }else if(b.messages.some(m=>m.role==='tool'||m.tool_calls!==undefined))fail('ha_session_required')
      }else if(b.ha_session!==undefined)fail('unsupported_field')
      calls++
      const result=await Promise.race([complete(c,context,signal),aborted])
      if(JSON.stringify(result.message).length>262144)throw new Fault(502,'native_output_limit')
      if(!result.completed || result.wireModel!==c.model || result.message.model!==c.model || (c.transport==='anthropic-oauth'&&result.message.api!=='anthropic-messages') || !['stop','toolUse'].includes(result.message.stopReason)) throw new Fault(502,'incomplete_or_wrong_model')
      if(outputCap!==undefined&&(!Number.isInteger(result.message.usage.output)||result.message.usage.output>outputCap))throw new Fault(502,'output_token_cap_exceeded')
      const toolCalls=[];let text='';const seen=new Set<string>()
      for(const block of result.message.content){
        if(block.type==='text') text+=block.text
        else if(block.type==='toolCall') {
          const t=c.tools.find(t=>t.name===block.name && context.tools?.some(s=>s.name===block.name)); if(!t || seen.has(block.id) || typeof block.id!=='string' || !block.id || block.id.length>128 || toolCalls.length>=16)throw new Fault(502,'invalid_output_tool')
          try {args(t,block.arguments)}catch {throw new Fault(502,'invalid_output_arguments')}
          seen.add(block.id);toolCalls.push({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.arguments)}})
        } // reasoning/signatures are never emitted
      }
      signal.throwIfAborted()
      if((toolCalls.length>0)!==(result.message.stopReason==='toolUse'))throw new Fault(502,'inconsistent_finish_reason')
      if(text.length>32768 || (!text && !toolCalls.length) || JSON.stringify(toolCalls).length>65536)throw new Fault(502,'output_limit')
      let session: string|undefined
      if(anthropic&&toolCalls.length){
        if(sessions.size>=16)throw new Fault(429,'ha_session_limit')
        session=randomUUID()
        sessions.set(session,{expires:Date.now()+sessionTtlMs,prefix:[...structuredClone(b.messages),{role:'assistant',content:text||null,tool_calls:toolCalls}],context:{...structuredClone(context),messages:[...structuredClone(context.messages),structuredClone(result.message)]},toolSpec:toolSpec(b)})
      }
      const usage=result.message.usage; const completion={id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model:result.wireModel,...(session?{ha_session:session}:{}),
        choices:[{index:0,message:{role:'assistant',content:text||null,...(toolCalls.length?{tool_calls:toolCalls}:{})},finish_reason:toolCalls.length?'tool_calls':'stop'}],
        usage:{prompt_tokens:usage.input+usage.cacheRead+usage.cacheWrite,completion_tokens:usage.output,total_tokens:usage.totalTokens,prompt_tokens_details:{cached_tokens:usage.cacheRead}}}
      recordHaAuthState(c.providerId,'ready')
      if(!streaming) return Response.json(completion)
      const base={id:completion.id,object:'chat.completion.chunk',created:completion.created,model:completion.model,...(session?{ha_session:session}:{})}
      const events: {choices:{index:number;delta:Record<string,unknown>;finish_reason:string|null}[];id:string;object:string;created:number;model:string;ha_session?:string}[]=[{...base,choices:[{index:0,delta:{role:'assistant',...(text?{content:text}:{})},finish_reason:null}]}]
      if(toolCalls.length) events.push({...base,choices:[{index:0,delta:{tool_calls:toolCalls.map((t,index)=>({index,...t}))},finish_reason:null}]})
      events.push({...base,choices:[{index:0,delta:{},finish_reason:completion.choices[0].finish_reason}]})
      const wire=events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+(b.stream_options?.include_usage?'data: '+JSON.stringify({...base,choices:[],usage:completion.usage})+'\n\n':'')+'data: [DONE]\n\n'
      return new Response(wire,{headers:{'content-type':'text/event-stream','cache-control':'no-store'}})
    }catch(e){
      if(signal.aborted) return errorResponse(req.signal.aborted?499:504,req.signal.aborted?'cancelled':'timeout')
      if(e instanceof HaProviderFault){if(e.authState)recordHaAuthState(c.providerId,e.authState);return errorResponse(e.status,e.code)}
      if(e instanceof SyntaxError)return errorResponse(400,'invalid_json')
      return errorResponse(502,'subscription_error') // Never leak provider errors, credentials, prompt, URL.
    }finally{removeAbort();active--}
  }
}
