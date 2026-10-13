/** OFFLINE ONLY. toolPolicy 'ha-assist': relay forwards HA 2026.9 native Assist tools (dynamic, exposure-dependent schemas). Nothing executes tools here. */
import { describe, it, expect } from 'vitest'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import type {AssistantMessage, Context, JsonObject, Tool} from '@earendil-works/pi-ai'
import {createHaInferenceHandler, validateHaConfig, type HaInferenceConfig, type HaComplete} from './ha-inference.js'
const token='ha-only-fixture-token-assist-123456'
const config:HaInferenceConfig={enabled:true,tokenSha256:createHash('sha256').update(token).digest('hex'),providerId:'subscription-only',model:'gpt-6-luna',tools:[],toolPolicy:'ha-assist',timeoutMs:1000,maxBodyBytes:262144,maxCallsPerHour:100}
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}
const result=(content:AssistantMessage['content']=[{type:'text',text:'ok'}])=>({completed:true,wireModel:config.model,message:{role:'assistant' as const,content,api:'openai-codex-responses' as const,provider:'openai-codex',model:config.model,usage,stopReason:content.some(c=>c.type==='toolCall')?'toolUse' as const:'stop' as const,timestamp:1}})
const obj=(properties:Record<string, unknown>={},required:string[]=[])=>({type:'object',properties,required})
// Names/shapes as produced by HA 2026.9.4 llm platforms (homeassistant/, llm/, todo/, script/, light/, intent/, media_player/, vacuum/).
const assistTools=[
 {name:'homeassistant__GetLiveContext',description:'Live context',parameters:obj({name:{type:'string'},area:{type:'string'},domain:{anyOf:[{type:'string'},{type:'array',items:{type:'string'}}]}})},
 {name:'llm__GetDateTime',description:'Date and time',parameters:obj()},
 {name:'todo__get_items',description:'Todo items',parameters:obj({todo_list:{type:'string',enum:['Zuhause']},status:{type:'string',enum:['needs_action','completed','all']}},['todo_list'])},
 {name:'todo__HassListAddItem',description:'Add item',parameters:obj({item:{type:'string'},name:{type:'string'}},['item','name'])},
 {name:'script__abendstimmung',description:'Script',parameters:obj()},
 {name:'intent__HassTurnOn',description:'Turn on',parameters:obj({name:{type:'string'},area:{type:'string'},domain:{type:'array',items:{type:'string'}}})},
 {name:'intent__HassTurnOff',description:'Turn off',parameters:obj({name:{type:'string'}})},
 {name:'intent__HassSetPosition',description:'Cover position',parameters:obj({name:{type:'string'},position:{type:'integer',minimum:0,maximum:100}},['position'])},
 {name:'light__HassLightSet',description:'Light set',parameters:obj({name:{type:'string'},brightness:{type:'integer',minimum:0,maximum:100}})},
 {name:'media_player__HassMediaPause',description:'Pause',parameters:obj({name:{type:'string'}})},
 {name:'vacuum__HassVacuumStart',description:'Vacuum',parameters:obj({name:{type:'string'}})},
 {name:'intent__HassGetWeather',description:'Weather',parameters:obj({name:{type:'string'}})},
]
const body=(tools:Record<string, unknown>[]=assistTools)=>({model:config.model,messages:[{role:'system',content:'HA prompt'},{role:'user',content:'Wie spät ist es?'}],tools:tools.map(t=>({type:'function',function:structuredClone(t)}))})
const req=(data:unknown)=>new Request('http://localhost/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(data)})
/** Context captured from the fake provider; toolsOf() fails loudly if nothing was forwarded. */
type Captured={ctx?:Context}
const toolsOf=(c:Captured):Tool[]=>{if(!c.ctx?.tools)throw new Error('no tools reached inference');return c.ctx.tools}
type ChatCompletionResponse={choices:{message:{tool_calls:{function:unknown}[]}}[]}
const setup=(complete:HaComplete,overrides:Partial<HaInferenceConfig>={})=>createHaInferenceHandler({...config,...overrides},complete)

describe('HA relay toolPolicy ha-assist (full native Assist tool parity)', () => {
 it('config: ha-assist requires an empty pinned list; unknown policy rejected; legacy configs unchanged', () => {
  expect(validateHaConfig(config).toolPolicy).toBe('ha-assist')
  expect(()=>validateHaConfig({...config,tools:[assistTools[0]]})).toThrow()
  expect(()=>validateHaConfig({...config,toolPolicy:'all'})).toThrow()
  const {toolPolicy:_,...legacy}=config
  expect(validateHaConfig(legacy).toolPolicy).toBeUndefined()
 })
 it('forwards every HA-provided Assist tool with its exact schema to inference', async () => {
  const seen:Captured={}
  const res=await setup(async(_c,context)=>{seen.ctx=context;return result()})(req(body()))
  expect(res.status).toBe(200)
  expect(toolsOf(seen).map(t=>t.name)).toEqual(assistTools.map(t=>t.name))
  expect(toolsOf(seen).map(t=>t.parameters)).toEqual(assistTools.map(t=>t.parameters))
 })
 it('legacy pinned empty list (current live config) rejects every Assist tool', async () => {
  let called=false
  const res=await setup(async()=>{called=true;return result()},{toolPolicy:undefined})(req(body([assistTools[1]])))
  expect(res.status).toBe(400); expect(await res.json()).toMatchObject({error:{code:'tool_not_allowed'}}); expect(called).toBe(false)
 })
 it('no arbitrary tool-count cap: 150 HA tools pass, only the byte budget (maxBodyBytes) bounds the list', async () => {
  const many=(n:number)=>Array.from({length:n},(_,i)=>({name:`script__s${i}`,description:'s',parameters:obj()}))
  expect((await setup(async()=>result())(req(body(many(150))))).status).toBe(200)
  const res=await setup(async()=>result(),{maxBodyBytes:4096})(req(body(many(150))))
  expect(res.status).toBe(413)
 })
 it('every name HA api.tools can produce is carried: custom integrations, script__1_x, intent_script__, no namespace filter', async () => {
  const names=['script__1_morgens','intent_script__Abendmodus','my_custom__do_thing','shell__exec','bash','x-y','1abc']
  const seen:Captured={}
  const res=await setup(async(_c,ctx)=>{seen.ctx=ctx;return result()})(req(body(names.map(name=>({name,description:'d',parameters:obj()})))))
  expect(res.status).toBe(200); expect(toolsOf(seen).map(t=>t.name)).toEqual(names)
 })
 it('rejects only provider-unsendable names, oversized or non-object schemas, duplicates', async () => {
  for (const bad of [
   [{name:'bad name',description:'x',parameters:obj()}],
   [{name:'a.b',description:'x',parameters:obj()}],
   [{name:'a__'+'x'.repeat(70),description:'x',parameters:obj()}],
   [{name:'script__x',description:'x',parameters:{type:'string'}}],
   [{name:'script__x',description:'x',parameters:obj({p:{type:'string',description:'y'.repeat(20001)}})}],
   [assistTools[1],assistTools[1]],
  ]) expect((await setup(async()=>result())(req(body(bad)))).status).toBe(400)
 })
 it('schema validation is bounded: pattern/format never evaluated (no ReDoS), $ref not resolved, depth/node limits, nullable', async () => {
  const evil={name:'my_custom__re',description:'d',parameters:obj({s:{type:'string',pattern:'^(a+)+$',format:'email'},
   self:{$ref:'#'},n:{type:'integer',nullable:true},m:{type:'string',not:{enum:['x']},minLength:1}})}
  const call=(args:JsonObject)=>async()=>result([{type:'toolCall',id:'c1',name:'my_custom__re',arguments:args}])
  const t0=Date.now()
  const ok=await setup(call({s:'a'.repeat(5000)+'!',self:{anything:1},n:null,m:'x'}))(req(body([evil])))
  expect(ok.status).toBe(200); expect(Date.now()-t0).toBeLessThan(1000)
  const seen:Captured={}; await setup(async(_c,ctx)=>{seen.ctx=ctx;return result()})(req(body([evil])))
  expect(toolsOf(seen)[0].parameters).toEqual(evil.parameters) // model sees HA's schema verbatim
  expect(Object.keys(toolsOf(seen)[0])).toEqual(['name','description','parameters']) // validation copy never leaks to provider
  expect((await setup(call({s:'a',n:'nope'}))(req(body([evil])))).status).toBe(502) // structural keywords still enforced
  expect((await setup(call({s:'a',m:''}))(req(body([evil])))).status).toBe(502)
  let deep:Record<string, unknown>={type:'string'}; for(let i=0;i<20;i++)deep={type:'object',properties:{d:deep}}
  expect((await setup(async()=>result())(req(body([{name:'deep',description:'d',parameters:deep}])))).status).toBe(400)
  const wide=obj(Object.fromEntries(Array.from({length:2100},(_,i)=>[`p${i}`,true])))
  expect((await setup(async()=>result())(req(body([{name:'wide',description:'d',parameters:wide}])))).status).toBe(400)
 })
 it('model tool call must name a tool offered in this request and match its schema', async () => {
  const call=(name:string,args:JsonObject)=>async()=>result([{type:'toolCall',id:'c1',name,arguments:args}])
  const ok=await setup(call('todo__get_items',{todo_list:'Zuhause'}))(req(body()))
  expect(ok.status).toBe(200)
  expect(((await ok.json()) as ChatCompletionResponse).choices[0].message.tool_calls[0].function).toEqual({name:'todo__get_items',arguments:JSON.stringify({todo_list:'Zuhause'})})
  expect((await setup(call('script__not_offered',{}))(req(body()))).status).toBe(502)
  expect((await setup(call('todo__get_items',{todo_list:'Fremd'}))(req(body()))).status).toBe(502)
  expect((await setup(call('intent__HassSetPosition',{position:500}))(req(body()))).status).toBe(502)
 })

 // Real probatio.to_openapi output (OpenAPI 3.0 default) from the HA 2026.9.4 venv, see ha-inference.probatio-fixtures.json.
 const P=JSON.parse(readFileSync(new URL('./ha-inference.probatio-fixtures.json',import.meta.url),'utf8'))
 const callP=(name:string,args:JsonObject):HaComplete=>async()=>result([{type:'toolCall',id:'c1',name,arguments:args}])
 const run=(schema:unknown,args:JsonObject)=>setup(callP('my_custom__p',args))(req(body([{name:'my_custom__p',description:'d',parameters:schema},assistTools[1]])))
 it('N1: OpenAPI 3.0 boolean exclusiveMinimum/Maximum (probatio Range min_included=False) is accepted and enforced exclusively', async () => {
  expect(P._ha_version).toBe('2026.9.4'); expect(P.excl.properties.temp.exclusiveMinimum).toBe(true)
  expect((await setup(async()=>result())(req(body([{name:'my_custom__p',description:'d',parameters:P.excl},assistTools[1]])))).status).toBe(200) // reviewer probe A
  expect((await run(P.excl,{temp:0.5})).status).toBe(200)
  expect((await run(P.excl,{})).status).toBe(200)
  expect((await run(P.excl,{temp:0})).status).toBe(502) // exclusive bound
  expect((await run(P.excl,{temp:-1})).status).toBe(502)
  expect((await run(P.exclmax,{pct:50})).status).toBe(200)
  for(const pct of [0,100,101,-1])expect((await run(P.exclmax,{pct})).status).toBe(502)
  for(const pct of [0,100])expect((await run(P.inclrange,{pct})).status).toBe(200) // inclusive Range unchanged
  expect((await run(P.inclrange,{pct:101})).status).toBe(502)
  // false => plain inclusive bound; Draft-2020 number form unchanged; unexpected value not evaluated (HA validates)
  const f=obj({v:{type:'number',minimum:0,exclusiveMinimum:false,maximum:10,exclusiveMaximum:false}})
  for(const v of [0,10])expect((await run(f,{v})).status).toBe(200)
  expect((await run(f,{v:10.5})).status).toBe(502)
  const d=obj({v:{type:'number',exclusiveMinimum:0,exclusiveMaximum:10}})
  expect((await run(d,{v:5})).status).toBe(200)
  for(const v of [0,10])expect((await run(d,{v})).status).toBe(502)
  expect((await run(obj({v:{type:'number',exclusiveMinimum:'x'}}),{v:1})).status).toBe(200)
  expect((await run(obj({v:{type:'number',exclusiveMinimum:true}}),{v:-5})).status).toBe(200) // true without minimum: no bound
  const seen:Captured={}; await setup(async(_c,ctx)=>{seen.ctx=ctx;return result()})(req(body([{name:'my_custom__p',description:'d',parameters:P.excl}])))
  expect(toolsOf(seen)[0].parameters).toEqual(P.excl) // model still sees HA's OpenAPI 3.0 schema verbatim
 })
 it('N2: oneOf is checked as anyOf so dropping "not" never rejects a valid probatio Inclusive/Exclusive call', async () => {
  expect(P.incl.allOf[0].oneOf[1]).toHaveProperty('not')
  expect((await run(P.incl,{lat:1,lon:2})).status).toBe(200) // reviewer probe B (was 502)
  expect((await run(P.incl,{})).status).toBe(200)
  expect((await run(P.incl,{lat:1})).status).toBe(200) // reviewer probe B2: looser than HA, HA's voluptuous rejects it
  expect((await run(P.incl,{lat:'x',lon:2})).status).toBe(502) // structural keywords still enforced
  expect((await run(P.exclgrp,{a:'x'})).status).toBe(200) // reviewer probe C
  // oneOf and anyOf on the same node: both constraints kept (none overwrites the other)
  const both=obj({v:{anyOf:[{type:'string'},{type:'integer'}],oneOf:[{type:'integer'},{type:'number'}]}})
  expect((await run(both,{v:3})).status).toBe(200) // integer matches both oneOf branches: accepted (was oneOf-rejected)
  expect((await run(both,{v:'s'})).status).toBe(502) // fails former oneOf
  expect((await run(both,{v:1.5})).status).toBe(502) // fails anyOf
  const withAll=obj({v:{allOf:[{type:'number'}],oneOf:[{minimum:0},{maximum:10}]}})
  expect((await run(withAll,{v:5})).status).toBe(200)
  expect((await run(withAll,{v:'s'})).status).toBe(502)
 })
})

