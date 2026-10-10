/** OFFLINE ONLY. Real installed SDK; every request intercepted, credentials synthetic.
 * Identity capture intentionally demonstrates WHY the production OAuth route is blocked.
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {once} from 'node:events'
import {createHaHttpServer} from './ha-inference-http.js'
import type {Context, Model} from '@earendil-works/pi-ai'
import {streamSimple} from './pi-models.js'
import {createHaInferenceHandler,completeHaSubscription,validateHaConfig,type HaInferenceConfig,type HaComplete} from './ha-inference.js'
const auth=vi.hoisted(()=>({load:vi.fn(()=>{throw new Error('must not load credentials')}),key:vi.fn()}))
vi.mock('./provider-config.js',()=>({loadProvidersDecrypted:auth.load,getApiKeyForProvider:auth.key,buildModel:vi.fn()}))
vi.mock('./data-policy.js',()=>({checkAutomaticModelFor:vi.fn()}))
const token='ha-fixture-'.repeat(4) // deliberately obvious non-production test material
const tool={name:'homeassistant__HassTurnOff',description:'Synthetic Assist tool. Never executes.',parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}}
const c:HaInferenceConfig={enabled:true,transport:'anthropic-oauth',thinking:'low',tokenSha256:createHash('sha256').update(token).digest('hex'),providerId:'existing-anthropic-oauth',model:'claude-haiku-5-5',tools:[tool],timeoutMs:1000,maxBodyBytes:262144,maxCallsPerHour:100}
const model:Model<'anthropic-messages'>={id:c.model,name:c.model,api:'anthropic-messages',provider:'anthropic',baseUrl:'https://api.anthropic.com',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:128000,compat:{forceAdaptiveThinking:true,supportsTemperature:false,supportsStrictTools:true},thinkingLevelMap:{off:null,minimal:null,low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'}}
const usage={input:3,output:4,cacheRead:0,cacheWrite:0,totalTokens:7,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}
function result(content:any[],stopReason='toolUse',wireModel=c.model):any{return {completed:true,wireModel,message:{role:'assistant',content,api:'anthropic-messages',provider:'anthropic',model:wireModel,usage,stopReason,timestamp:1}}}
const toolContent=[{type:'thinking',thinking:'synthetic-private-thinking',thinkingSignature:'synthetic-signed-opaque'},{type:'toolCall',id:'call_synthetic1',name:tool.name,arguments:{name:'Simuliertes Licht'}}]
function body():any{return {model:c.model,messages:[{role:'system',content:'Nur synthetische HA Werkzeuge, kein Offtangent-Agent.'},{role:'user',content:'Schalte simuliertes Licht aus.'}],tools:[{type:'function',function:tool}]}}
const req=(data=body(),bearer=token)=>new Request('http://localhost/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify(data)})
function continuation(b:any,r:any){return {...b,ha_session:r.ha_session,messages:[...b.messages,r.choices[0].message,{role:'tool',tool_call_id:'call_synthetic1',content:JSON.stringify({response_type:'action_done',data:{success:[{id:'synthetic-light'}],failed:[]}})}]}}
function events(toolRound=true):any[]{
 const e:any[]=[{type:'message_start',message:{id:'msg_synthetic',type:'message',role:'assistant',model:c.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:0}}}]
 if(toolRound)e.push(
  {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
  {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'synthetic-private-thinking'}},
  {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'synthetic-signed-opaque'}},
  {type:'content_block_stop',index:0},
  {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'call_synthetic1',name:tool.name,input:{}}},
  {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:JSON.stringify({name:'Simuliertes Licht'})}},
  {type:'content_block_stop',index:1})
 else e.push({type:'content_block_start',index:0,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Home Assistant hat die simulierte Aktion bestätigt.'}},{type:'content_block_stop',index:0})
 e.push({type:'message_delta',delta:{stop_reason:toolRound?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:4}},{type:'message_stop'})
 return e
}
const sse=(e:any[])=>new Response(e.map(x=>`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})
function sdkFixture(status=200,wireEvents?:any[]){
 const captures:any[]=[]
 const complete:HaComplete=async(_c,context,signal)=>{
  let wireModel='';let terminal=false
  const transport=vi.fn(async(url:any,init:any)=>{
   expect(String(url)).toBe('https://api.anthropic.com/v1/messages?beta=true')
   const payload=JSON.parse(init.body as string)
   captures.push({url:String(url),headers:Object.fromEntries(new Headers(init.headers)),payload})
   if(status!==200)return new Response(JSON.stringify({type:'error',error:{type:'rate_limit_error',message:'synthetic'}}),{status,headers:{'content-type':'application/json'}})
   const e=structuredClone(wireEvents??events(captures.length===1))
   wireModel=e.find(x=>x.type==='message_start')?.message.model??''
   terminal=e.some(x=>x.type==='message_stop')
   return sse(e)
  })
  const stream=streamSimple(model,context,{apiKey:'sk-ant-oat01-haiku',signal,reasoning:'low',maxTokens:4096,maxRetries:0,fetch:transport})
  for await(const _ of stream) { /* drain actual provider parser */ }
  const message=await stream.result()
  return {completed:terminal,wireModel,message}
 }
 return {complete,captures}
}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('UNEXPECTED LIVE NETWORK')})))
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})
describe('Haiku auth and exact-model configuration',()=>{
 it('blocks before resolving any credentials or issuing any request',async()=>{
  await expect(completeHaSubscription(c,{messages:[]},new AbortController().signal)).rejects.toThrow('anthropic_subscription_auth_blocked')
  expect(auth.load).not.toHaveBeenCalled();expect(auth.key).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
  const response=await createHaInferenceHandler(c)(req());expect(response.status).toBe(503);expect(await response.json()).toEqual({error:{message:'anthropic_subscription_auth_blocked',type:'ha_inference_error',code:'anthropic_subscription_auth_blocked'}})
 })
 it('pins Haiku and supported low effort; rejects unavailable off or arbitrary transport',()=>{
  expect(validateHaConfig(c)).toEqual(c)
  for(const changes of [{model:'claude-opus-4-7'},{thinking:undefined},{thinking:'off'},{transport:'api-key'},{transport:undefined}])expect(()=>validateHaConfig({...c,...changes} as any)).toThrow('invalid_config')
 })
 it('isolates bearer, rejects caller agent fields and unsupported tools before completion',async()=>{
  const complete=vi.fn(async()=>result(toolContent));const handler=createHaInferenceHandler(c,complete)
  expect((await handler(req(body(),'wrong-token'))).status).toBe(401)
  expect((await handler(req({...body(),agent:'bob'}))).status).toBe(400)
  expect((await handler(req({...body(),tools:[{type:'function',function:{...tool,name:'shell__exec'}}]}))).status).toBe(400)
  expect(complete).not.toHaveBeenCalled()
 })
})
describe('native signed assistant transcript vault',()=>{
 it('preserves thinking/signatures, maps confirmed tool result, emits only final text',async()=>{
  let round=0;let native:Context|undefined
  const handler=createHaInferenceHandler(c,async(_c,context)=>{native=structuredClone(context);return ++round===1?result(toolContent):result([{type:'text',text:'Bestätigt.'}],'stop')})
  const b=body();const first=await(await handler(req(b))).json() as any
  expect(first.ha_session).toEqual(expect.any(String));expect(JSON.stringify(first)).not.toContain('synthetic-private-thinking');expect(JSON.stringify(first)).not.toContain('signed-opaque')
  const next=continuation(b,first);const final=await(await handler(req(next))).json() as any
  expect(final.choices[0].message.content).toBe('Bestätigt.')
  expect(native?.messages[1]).toMatchObject({content:toolContent});expect(native?.messages[2]).toMatchObject({role:'toolResult',isError:false})
  expect((await handler(req(next))).status).toBe(400) // single-use, no action replay
 })
 it.each(['content','tool_spec','session','extra_user'])('rejects altered continuation: %s',async(kind)=>{
  const complete=vi.fn(async()=>result(toolContent));const handler=createHaInferenceHandler(c,complete);const b=body();const first=await(await handler(req(b))).json() as any;const next=continuation(b,first)
  if(kind==='content')next.messages[1].content='changed prompt'
  if(kind==='tool_spec')next.tools=[]
  if(kind==='session')next.ha_session='other-session'
  if(kind==='extra_user')next.messages.push({role:'user',content:'different command'})
  expect((await handler(req(next))).status).toBe(400);expect(complete).toHaveBeenCalledTimes(1)
 })
 it('does not reconstruct unsigned prior assistant messages without a vault handle',async()=>{
  const handler=createHaInferenceHandler(c,async()=>result(toolContent));const b=body();const r=await(await handler(req(b))).json() as any;const next=continuation(b,r);delete next.ha_session
  const failed=await handler(req(next));expect(failed.status).toBe(400);expect(JSON.stringify(await failed.json())).toContain('ha_session_required')
 })
 it.each([{error:'ambiguous_entity'},{success:false},{response:{response_type:'error',data:{code:'no_valid_targets'}}}])('preserves failure signaling without treating prose as truth: %j',async(error)=>{
  let native:Context|undefined;let round=0;const handler=createHaInferenceHandler(c,async(_c,ctx)=>{native=ctx;return ++round===1?result(toolContent):result([{type:'text',text:'Nicht bestätigt.'}],'stop')})
  const b=body();const r=await(await handler(req(b))).json() as any;const next=continuation(b,r);next.messages.at(-1).content=JSON.stringify(error)
  expect((await handler(req(next))).status).toBe(200);expect(native?.messages.at(-1)).toMatchObject({isError:true})
 })
 it('times out and consumes a continuation instead of allowing replay',async()=>{
  let n=0;const handler=createHaInferenceHandler({...c,timeoutMs:1000},async(_c,_ctx,signal)=>++n===1?result(toolContent):new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})))
  const b=body();const r=await(await handler(req(b))).json() as any;const next=continuation(b,r)
  expect((await handler(req(next))).status).toBe(504);expect((await handler(req(next))).status).toBe(400)
 })
 it.each(['wrong_model','bad_tool','truncated','unfinished','oversize'])('fails closed on %s before exposing an action batch',async(kind)=>{
  const complete:HaComplete=async()=>{
   if(kind==='wrong_model')return result(toolContent,'toolUse','claude-other')
   if(kind==='bad_tool')return result([{type:'toolCall',id:'call1',name:'bash',arguments:{}}])
   if(kind==='truncated')return result(toolContent,'length')
   if(kind==='unfinished')return {...result(toolContent),completed:false}
   return result([{type:'thinking',thinking:'x'.repeat(262145)},{type:'toolCall',id:'call1',name:tool.name,arguments:{name:'x'}}])
  }
  const response=await createHaInferenceHandler(c,complete)(req());expect(response.status).toBe(502);expect(await response.text()).not.toContain('tool_calls')
 })
})
describe('real pi-ai Anthropic SDK with entirely simulated wire',()=>{
 it('performs toolcall/result/final and records explicit adaptive low effort + OAuth identity injection',async()=>{
  const fixture=sdkFixture();const handler=createHaInferenceHandler(c,fixture.complete);const b=body();const r=await(await handler(req(b))).json() as any
  expect(r.choices[0].message.tool_calls[0].function.name).toBe(tool.name)
  const final=await handler(req(continuation(b,r)));expect(final.status).toBe(200);expect((await final.json() as any).choices[0].message.content).toBe('Home Assistant hat die simulierte Aktion bestätigt.')
  expect(fixture.captures).toHaveLength(2)
  for(const capture of fixture.captures){expect(capture.payload).toMatchObject({model:c.model,max_tokens:4096,stream:true,thinking:{type:'adaptive',display:'summarized'},output_config:{effort:'low'}});expect(capture.payload.temperature).toBeUndefined();expect(capture.payload.fallbacks).toBeUndefined();expect(capture.headers['user-agent']).toContain('claude-cli');expect(capture.headers['x-app']).toBe('cli')}
  const wire=fixture.captures[1].payload.messages
  expect(wire[1].content).toContainEqual({type:'thinking',thinking:'synthetic-private-thinking',signature:'synthetic-signed-opaque'})
  expect(wire[2].content).toContainEqual(expect.objectContaining({type:'tool_result',tool_use_id:'call_synthetic1',is_error:false}))
  expect(fixture.captures[0].payload.system[0].text).toContain('Claude Code')
  expect(fetch).not.toHaveBeenCalled()
  if(process.env.HA_WIRE_EVIDENCE_PATH)writeFileSync(process.env.HA_WIRE_EVIDENCE_PATH,JSON.stringify({
   mode:'OFFLINE ONLY — all Anthropic requests intercepted; synthetic credential and tools; no HA services',
   model:c.model,productionStatus:'503 anthropic_subscription_auth_blocked before loading any credentials',
   captures:fixture.captures.map(capture=>({url:capture.url,headers:Object.fromEntries(
    ['user-agent','x-app','anthropic-beta','anthropic-version'].filter(name=>capture.headers[name]).map(name=>[name,capture.headers[name]])),payload:capture.payload})),
   firstTool:r.choices[0].message.tool_calls[0].function,final:'Home Assistant hat die simulierte Aktion bestätigt.',
  },null,2)+'\n')
 })
 it('refuses a native model or API mismatch even when the outer wire model claims the pin',async()=>{
  for(const patch of [{model:'wrong-model'},{api:'openai-codex-responses'}]){
   const h=createHaInferenceHandler(c,async()=>({...result(toolContent),message:{...result(toolContent).message,...patch} as any}))
   const r=await h(req(body()));expect(r.status).toBe(502);expect(await r.text()).not.toContain('simulierte')
  }
 })
 it('marks structured HA failure as SDK tool_result is_error=true without losing signature',async()=>{
  for(const failure of [{response:{response_type:'error',data:{code:'ambiguous_name'}}},{response_type:'error',data:{code:'ambiguous_name'}},{response_type:'action_done',data:{success:[{id:'synthetic'}],failed:[{id:'synthetic-other'}]}},{success:false},{error:'simulated'}]){
   const f=sdkFixture();const h=createHaInferenceHandler(c,f.complete);const b=body();const r=await(await h(req(b))).json() as any
   const next=continuation(b,r);next.messages.at(-1).content=JSON.stringify(failure)
   expect((await h(req(next))).status).toBe(200)
   expect(f.captures[1].payload.messages[2].content).toContainEqual(expect.objectContaining({type:'tool_result',tool_use_id:'call_synthetic1',is_error:true}))
   expect(f.captures[1].payload.messages[1].content).toContainEqual(expect.objectContaining({type:'thinking',signature:'synthetic-signed-opaque'}))
   expect(fetch).not.toHaveBeenCalled()
  }
 })
 it('bridges the real Python client and one simulated tool through loopback HTTP and actual SDK parser',async()=>{
  const f=sdkFixture();const server=createHaHttpServer(createHaInferenceHandler(c,f.complete))
  server.listen(0,'127.0.0.1');await once(server,'listening')
  try {
   const port=(server.address() as {port:number}).port
   const {stdout}=await promisify(execFile)(process.env.HA_TEST_PYTHON??'python3',[
    'integrations/home_assistant/tests/bridge_smoke.py',`http://127.0.0.1:${port}/v1`,
   ],{timeout:10000,maxBuffer:16384,env:{PYTHONPATH:process.cwd()+'/integrations/home_assistant',PYTHONDONTWRITEBYTECODE:'1'}})
   const bridge=JSON.parse(stdout);expect(bridge.simulated_calls).toHaveLength(1)
   expect(bridge.final).toBe('Home Assistant hat die Aktion bestätigt.');expect(f.captures).toHaveLength(2)
   expect(f.captures[1].payload.messages[1].content).toContainEqual(expect.objectContaining({type:'thinking',signature:'synthetic-signed-opaque'}))
   expect(f.captures[1].payload.messages[2].content).toContainEqual(expect.objectContaining({type:'tool_result',is_error:false}))
   expect(fetch).not.toHaveBeenCalled()
   if(process.env.HA_BRIDGE_EVIDENCE_PATH)writeFileSync(process.env.HA_BRIDGE_EVIDENCE_PATH,JSON.stringify(bridge,null,2)+'\n')
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
 },15000)
 it('never retries SDK 429 and exposes no partial model text',async()=>{
  const f=sdkFixture(429);const r=await createHaInferenceHandler(c,f.complete)(req());expect(r.status).toBe(502);expect(f.captures).toHaveLength(1);expect(await r.text()).not.toContain('tool_calls')
 })
 it('rejects incomplete SDK SSE even when tool/text blocks were delivered',async()=>{
  const f=sdkFixture(200,events().filter(e=>e.type!=='message_stop'));expect((await createHaInferenceHandler(c,f.complete)(req())).status).toBe(502);expect(f.captures).toHaveLength(1)
 })
})
