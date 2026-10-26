// B-01-R-NEW-01 regression: port of the independent re-review repro
// (/workspace/dash-v2-review-4393a5e0/repros/own-admission.test.ts,
// "new sessionless task with contradictory|cycle parent"). A sessionless task
// resolves to `none` before start; materializing its session with a
// contradictory or cyclic parent session turns the persisted lineage invalid.
// The runner must re-check the gate after the materialization and refuse
// before model, credential, agent and prompt (0/0/0/0), quarantine the row
// with the refusal marker and free the slot. owner/none positive controls.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager, resolveTaskOwnershipForTask, resolveTaskOwnerUserIdForTask, runWithTaskExecutionContext, withSecretBoundary, getCurrentTaskExecutionContext } from '@axiom/core'
import { createRuntimeComposition } from './runtime-composition.js'
import { TaskExecutionRefusedError, TASK_EXECUTION_REFUSED_PREFIX } from '@axiom/core'
const captured = vi.hoisted(() => ({ runner: null as any, onPrompt: null as any, buildModel: 0, apiKey: 0, atBuild: null as any, atKey: null as any, agents: 0, prompts: 0 }))
vi.mock('@earendil-works/pi-agent-core',()=>({Agent:class {options:any;subscriber:any;state={messages:[] as any[]};constructor(options:any){this.options=options;captured.agents++}subscribe(fn:any){this.subscriber=fn;return ()=>{}}abort(){}async prompt(){captured.prompts++;if(captured.onPrompt)await captured.onPrompt(this.options.initialState.tools);const message={role:'assistant',content:[{type:'text',text:'STATUS: completed\nSUMMARY: Synthetic model result'}],provider:'synthetic',model:'synthetic',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}};this.state.messages.push(message);this.subscriber?.({type:'message_end',message});this.subscriber?.({type:'agent_end',messages:this.state.messages})}}}))
vi.mock('@axiom/core', async original => {
  const core = await original<any>()
  return { ...core, createTaskRuntime: (options:any) => { captured.runner = options.runner; options.runner.buildModel=()=>{captured.buildModel++;captured.atBuild?.();return {}}; options.runner.getApiKey=async()=>{captured.apiKey++;captured.atKey?.();return  'synthetic-not-a-real-key'}; return core.createTaskRuntime(options) } }
})
let app:any, dir:string, sessions:SessionManager, s2:string, s3:string
beforeEach(async()=>{
 captured.onPrompt=null;captured.atBuild=null;captured.atKey=null;captured.buildModel=0;captured.apiKey=0;captured.agents=0;captured.prompts=0
 dir=fs.mkdtempSync(path.join(process.cwd(),'.b01r-session-mat-'))
 process.env.DATA_DIR=dir
 app=await createRuntimeComposition({logger:{log(){},warn(){},error(){}}})
 for(const id of [1,2,3]) app.db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,?,'x',?)").run(id,`synthetic-review-${id}`,id===1?'admin':'user')
 sessions=new SessionManager({db:app.db,memoryDir:path.join(dir,'memory'),timeoutMinutes:0})
 s2=sessions.createThread('2','main','User two').id
 s3=sessions.createThread('3','main','User three').id
})
afterEach(async()=>{vi.restoreAllMocks();await app?.stopBackgroundServices();fs.rmSync(dir,{recursive:true,force:true})})
function task(opts:any={}) {return app.getTaskRuntime().tasks.create({name:'Synthetic',prompt:'synthetic',agentId:'main',triggerType:'agent',sessionId:sessions.createSession({type:'task',source:'system'}).id,...opts})}
const settle=()=>new Promise(resolve=>setTimeout(resolve,25))
const provider:any={id:'b01r-synthetic',name:'b01r-synthetic',type:'openai',providerType:'openai',provider:'openai',baseUrl:'http://127.0.0.1:1',enabledModels:['synthetic-model'],models:[],status:'connected',authMethod:'api-key'}
function counts(){return {model:captured.buildModel,key:captured.apiKey,agents:captured.agents,prompts:captured.prompts}}
function slots(){const info=app.getTaskRuntime().runner.getQueueInfo('b01r-probe');return {running:info.running,queued:info.queued_count}}
describe('B-01-R-NEW-01: gate re-check after task session materialization',()=>{
 it.each(['contradictory','cycle'])('new sessionless task with %s parent is refused before model/key/agent/prompt',async kind=>{
  let parent=s2
  if(kind==='contradictory'){
   parent=sessions.createSession({type:'task',source:'system',parentSessionId:s2}).id
   app.db.prepare("UPDATE sessions SET session_user='3',user_id=3 WHERE id=?").run(parent)
  } else app.db.prepare('UPDATE sessions SET parent_session_id=? WHERE id=?').run(s2,s2)
  const t=task({triggerType:'user',sessionId:undefined})
  expect(t.sessionId??null).toBeNull()
  expect(resolveTaskOwnershipForTask(app.db,t)).toEqual({kind:'none'})
  const phases:any[]=[]
  captured.atBuild=()=>phases.push('atBuild');captured.atKey=()=>phases.push('atKey')
  expect(slots()).toEqual({running:0,queued:0})
  const result=await app.getTaskRuntime().tasks.start(t,provider,undefined,parent).then(()=>'admitted',(e:any)=>e)
  await settle(); await settle()
  expect(result).toBeInstanceOf(TaskExecutionRefusedError)
  const persisted=app.getTaskRuntime().tasks.getById(t.id)
  // the session really was materialized and is what makes the lineage invalid
  expect(persisted.sessionId).toBeTruthy()
  expect(resolveTaskOwnershipForTask(app.db,persisted)).toEqual({kind:'invalid'})
  expect(counts()).toEqual({model:0,key:0,agents:0,prompts:0})
  expect(phases).toEqual([])
  expect(persisted.status).toBe('failed')
  expect(persisted.resultStatus).toBe('failed')
  expect(String(persisted.errorMessage)).toContain(TASK_EXECUTION_REFUSED_PREFIX)
  expect(String(persisted.resultSummary)).toContain(TASK_EXECUTION_REFUSED_PREFIX)
  // slot freed: nothing running, nothing waiting, the task holds no slot
  expect(slots()).toEqual({running:0,queued:0})
  expect(app.getTaskRuntime().runner.getQueueInfo(t.id)).toMatchObject({queued:false,position:0,running:0})
 })
 it.each(['owner','none'])('fresh session materialization %s positive control still runs',async kind=>{
  const t=task({triggerType:kind==='owner'?'user':'cronjob',sessionId:undefined})
  await app.getTaskRuntime().tasks.start(t,provider,undefined,kind==='owner'?s2:null)
  await vi.waitFor(()=>expect(captured.prompts).toBe(1))
  const row=app.getTaskRuntime().tasks.getById(t.id)
  expect(row.sessionId).toBeTruthy()
  expect(resolveTaskOwnershipForTask(app.db,row)).toEqual(kind==='owner'?{kind:'owner',userId:2}:{kind:'none'})
  expect(captured.buildModel).toBeGreaterThanOrEqual(1);expect(captured.apiKey).toBeGreaterThanOrEqual(1);expect(captured.agents).toBe(1);expect(captured.prompts).toBe(1)
  expect(String(row.errorMessage??'')).not.toContain(TASK_EXECUTION_REFUSED_PREFIX)
  await vi.waitFor(()=>expect(slots()).toEqual({running:0,queued:0}))
 })
})
