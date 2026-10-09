/** HA-only chat-completions adapter. No agent, memory, logging, persistence or tool execution.
 * Deliberately separate from isolated-inference/interview.v1. Config absent => no listener.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Check } from 'typebox/value'
import type { AssistantMessage, Context, Message, Tool } from '@earendil-works/pi-ai'
import { buildModel, getApiKeyForProvider, loadProvidersDecrypted } from './provider-config.js'
import { checkAutomaticModelFor } from './data-policy.js'
import { streamSimple } from './pi-models.js'

export interface HaTool { name: string; description: string; parameters: Record<string, unknown> }
export interface HaInferenceConfig {
  enabled: true; tokenSha256: string; providerId: string; model: string; tools: HaTool[]
  timeoutMs: number; maxBodyBytes: number; maxCallsPerHour: number
}
export interface HaCompletion { message: AssistantMessage; wireModel: string; completed: boolean; metrics?: { ttftMs: number | null; firstToolMs: number | null; totalMs: number; wireUsage: unknown } }
export type HaComplete = (config: HaInferenceConfig, context: Context, signal: AbortSignal) => Promise<HaCompletion>
class Fault extends Error { constructor(public status: number, public code: string) { super(code) } }
function fail(code = 'invalid_request'): never { throw new Fault(400, code) }
function obj(x: unknown): Record<string, any> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail()
  return x as Record<string, any>
}
function keys(x: Record<string, unknown>, allowed: string[]) { if (Object.keys(x).some(k => !allowed.includes(k))) fail('unsupported_field') }
function str(x: unknown, max = 100000): string { if (typeof x !== 'string' || x.length > max) fail(); return x }
function canonical(x: unknown): string {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']'
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical((x as Record<string,unknown>)[k])).join(',') + '}'
  return JSON.stringify(x)
}
function args(tool: HaTool, raw: unknown): Extract<AssistantMessage['content'][number], {type: 'toolCall'}>['arguments'] {
  const value = obj(typeof raw === 'string' ? JSON.parse(str(raw, 16384)) : raw)
  if (!Check(tool.parameters, value)) fail('invalid_tool_arguments')
  return value as Extract<AssistantMessage['content'][number], {type: 'toolCall'}>['arguments']
}
export function validateHaConfig(raw: unknown): HaInferenceConfig {
  const c = obj(raw)
  keys(c, ['enabled','tokenSha256','providerId','model','tools','timeoutMs','maxBodyBytes','maxCallsPerHour'])
  if (c.enabled !== true || typeof c.tokenSha256!=='string' || !/^[a-f0-9]{64}$/.test(c.tokenSha256) || typeof c.model!=='string' || !/^[a-zA-Z0-9-]{1,128}$/.test(c.model)) fail('invalid_config')
  if(!str(c.providerId,128))fail('invalid_config')
  for (const [k,lo,hi] of [['timeoutMs',1000,120000],['maxBodyBytes',1024,262144],['maxCallsPerHour',1,1000]] as const) {
    if (!Number.isInteger(c[k]) || c[k]<lo || c[k]>hi) fail('invalid_config')
  }
  if (!Array.isArray(c.tools) || c.tools.length>32) fail('invalid_config')
  const seen = new Set<string>()
  for (const tool of c.tools) {
    const t = obj(tool); keys(t,['name','description','parameters'])
    if (typeof t.name!=='string' || !(t.name==='GetLiveContext' || /^Hass[A-Z][A-Za-z0-9]{0,59}$/.test(t.name)) || seen.has(t.name)) fail('invalid_config')
    seen.add(t.name); str(t.description,2048); obj(t.parameters)
    if (t.parameters.type !== 'object' || canonical(t.parameters).length>20000) fail('invalid_config')
  }
  return c as HaInferenceConfig
}
function requestContext(body: unknown, c: HaInferenceConfig): { context: Context; streaming: boolean; outputCap?:number } {
  const b = obj(body)
  keys(b,['model','messages','tools','stream','stream_options','tool_choice','max_tokens','max_completion_tokens','temperature','top_p','reasoning_effort','service_tier'])
  // Subscription transport has no sampling/output-budget parameters. Neutral
  // client defaults are accepted explicitly; token cap is a post-completion fence.
  for(const [key,value]of [['temperature',1],['top_p',1],['reasoning_effort','minimal'],['service_tier','auto']] as const)if(b[key]!==undefined&&b[key]!==value)fail('unsupported_parameter')
  if(b.tool_choice!==undefined&&!['auto','none'].includes(b.tool_choice))fail('unsupported_tool_choice')
  if(b.max_tokens!==undefined&&b.max_completion_tokens!==undefined)fail('conflicting_output_caps')
  const outputCap=b.max_tokens??b.max_completion_tokens
  if(outputCap!==undefined&&(!Number.isInteger(outputCap)||outputCap<1||outputCap>4096))fail('invalid_output_cap')
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
          const id=str(tc.id,128); const t=byName.get(f.name)
          if(tc.type!=='function'||!id||ids.has(id)||!t) fail('invalid_tool_history')
          content.push({type:'toolCall',id,name:t.name,arguments:args(t,f.arguments)}); pending.set(id,{name:t.name}); ids.add(id)
        }
      }
      messages.push({role:'assistant',content,api:'openai-codex-responses',provider:'openai-codex',model:c.model,
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:pending.size?'toolUse':'stop',timestamp:Date.now()})
    } else if(role==='tool') {
      keys(m,['role','tool_call_id','content']); const id=str(m.tool_call_id,128); const tc=pending.get(id)
      if(!tc) fail('orphan_tool_result'); pending.delete(id)
      messages.push({role:'toolResult',toolCallId:id,toolName:tc.name,content:[{type:'text',text:str(m.content)}],isError:false,timestamp:Date.now()})
    } else fail('unsupported_role')
  }
  if(pending.size || !messages.length || !['user','toolResult'].includes(messages.at(-1)!.role)) fail('invalid_history_end')
  return {context:{systemPrompt,messages,tools:b.tool_choice==='none'?[]:tools},streaming:b.stream===true,outputCap}
}
/** Reuses existing OAuth lifecycle. Never attempts API billing or another model. */
export const completeHaSubscription: HaComplete = async (c, context, signal) => {
  const p=loadProvidersDecrypted().providers.find(p=>p.id===c.providerId)
  if(!p || p.authMethod!=='oauth' || p.providerType!=='openai-codex' || p.type!=='openai-codex-responses'
    || !p.enabledModels?.includes(c.model) || !checkAutomaticModelFor(p,c.model,'isolated-inference').allowed) throw new Fault(503,'subscription_provider_unavailable')
  const model=buildModel(p,c.model)
  // Existing Codex provider only. A custom URL must never receive the account token.
  if (!['https://chatgpt.com/backend-api','https://chatgpt.com/backend-api/codex'].includes(model.baseUrl.replace(/\/$/,''))) throw new Fault(503,'subscription_endpoint_rejected')
  const started=performance.now(); let ttftMs: number|null=null; let firstToolMs: number|null=null; let wireUsage: unknown=null
  let wireModel=''; let completed=false; let wireError=''; let transportFault:Fault|undefined
  const wireFetch: typeof fetch = async (url, init) => {
    const target=new URL(typeof url==='string'?url:url instanceof URL?url.href:url.url)
    if(target.origin!=='https://chatgpt.com' || target.pathname!=='/backend-api/codex/responses' || target.username || target.password || target.search || target.hash) throw new Fault(503,'subscription_endpoint_rejected')
    const r=await fetch(url,{...init,redirect:'error'})
    if(!r.ok) {transportFault=new Fault(r.status===429?429:502,r.status===429?'subscription_rate_limit':'subscription_http_error');throw transportFault}
    if(!r.body) throw new Fault(502,'empty_subscription_stream')
    let buffer=''; const decoder=new TextDecoder()
    const body=r.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
      buffer+=decoder.decode(chunk,{stream:true}); if(buffer.length>1048576) throw new Fault(502,'subscription_event_too_large')
      let pos: number
      while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos).trimEnd();buffer=buffer.slice(pos+1)
        if(line.startsWith('data: ')) {const data=line.slice(6); if(data==='[DONE]')continue
          let event: any; try {event=JSON.parse(data)} catch {throw new Fault(502,'invalid_subscription_event')}
          if(event.response?.model) {if(wireModel && wireModel!==event.response.model)throw new Fault(502,'upstream_model_changed');wireModel=event.response.model}
          if(event.type==='response.completed') {completed=event.response?.status==='completed';wireUsage=event.response?.usage}
          if(['response.failed','response.incomplete','error'].includes(event.type)) wireError=event.response?.error?.code || event.error?.code || event.code || event.type
        }
      } controller.enqueue(chunk)
    }}))
    return new Response(body,{status:r.status,statusText:r.statusText,headers:r.headers})
  }
  const stream=streamSimple(model,context,{apiKey:await getApiKeyForProvider(p),signal,reasoning:'minimal',maxRetries:0,transport:'sse',fetch:wireFetch})
  for await(const event of stream) {
    if(ttftMs===null && ['text_delta','toolcall_delta','thinking_delta'].includes(event.type))ttftMs=performance.now()-started
    if(firstToolMs===null && ['toolcall_start','toolcall_delta'].includes(event.type))firstToolMs=performance.now()-started
  }
  const message=await stream.result()
  if(transportFault)throw transportFault
  if(wireError) throw new Fault(wireError.includes('usage_limit')?429:502,wireError.includes('usage_limit')?'subscription_usage_limit':'subscription_failed')
  return {message,wireModel,completed,metrics:{ttftMs,firstToolMs,totalMs:performance.now()-started,wireUsage}}
}
function errorResponse(status: number, code: string) {return Response.json({error:{message:code,type:'ha_inference_error',code}},{status})}
/** All output (including SSE) is buffered until upstream completed + validated. No partial actions. */
export function createHaInferenceHandler(config: HaInferenceConfig, complete: HaComplete = completeHaSubscription) {
  const c=structuredClone(validateHaConfig(config)); let active=0; let hour=Date.now(); let calls=0
  return async (req: Request): Promise<Response> => {
    const url=new URL(req.url);const catalog=req.method==='GET'&&url.pathname==='/v1/models'
    if(url.search || (!catalog&&(req.method!=='POST'||url.pathname!=='/v1/chat/completions')))return errorResponse(404,'not_found')
    const token=req.headers.get('authorization')?.match(/^Bearer ([^\s]{16,512})$/)?.[1]
    const hash=createHash('sha256').update(token??'').digest(); const want=Buffer.from(c.tokenSha256,'hex')
    if(!token || !timingSafeEqual(hash,want)) return errorResponse(401,'unauthorized')
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
      const b=JSON.parse(Buffer.concat(parts).toString('utf8')); const {context,streaming,outputCap}=requestContext(b,c); calls++
      const result=await Promise.race([complete(c,context,signal),aborted])
      if(!result.completed || result.wireModel!==c.model || !['stop','toolUse'].includes(result.message.stopReason)) throw new Fault(502,'incomplete_or_wrong_model')
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
      if((toolCalls.length>0)!==(result.message.stopReason==='toolUse'))throw new Fault(502,'inconsistent_finish_reason')
      if(text.length>32768 || (!text && !toolCalls.length) || JSON.stringify(toolCalls).length>65536)throw new Fault(502,'output_limit')
      const usage=result.message.usage; const completion={id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model:result.wireModel,
        choices:[{index:0,message:{role:'assistant',content:text||null,...(toolCalls.length?{tool_calls:toolCalls}:{})},finish_reason:toolCalls.length?'tool_calls':'stop'}],
        usage:{prompt_tokens:usage.input+usage.cacheRead+usage.cacheWrite,completion_tokens:usage.output,total_tokens:usage.totalTokens,prompt_tokens_details:{cached_tokens:usage.cacheRead}}}
      if(!streaming) return Response.json(completion)
      const base={id:completion.id,object:'chat.completion.chunk',created:completion.created,model:completion.model}
      const events=[{...base,choices:[{index:0,delta:{role:'assistant',...(text?{content:text}:{})},finish_reason:null}]}]
      if(toolCalls.length) events.push({...base,choices:[{index:0,delta:{tool_calls:toolCalls.map((t,index)=>({index,...t}))} as any,finish_reason:null}]})
      events.push({...base,choices:[{index:0,delta:{} as any,finish_reason:completion.choices[0].finish_reason as any}]})
      const wire=events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+(b.stream_options?.include_usage?'data: '+JSON.stringify({...base,choices:[],usage:completion.usage})+'\n\n':'')+'data: [DONE]\n\n'
      return new Response(wire,{headers:{'content-type':'text/event-stream','cache-control':'no-store'}})
    }catch(e){
      if(signal.aborted) return errorResponse(req.signal.aborted?499:504,req.signal.aborted?'cancelled':'timeout')
      if(e instanceof Fault)return errorResponse(e.status,e.code)
      if(e instanceof SyntaxError)return errorResponse(400,'invalid_json')
      return errorResponse(502,'subscription_error') // Never leak provider errors, credentials, prompt, URL.
    }finally{removeAbort();active--}
  }
}
