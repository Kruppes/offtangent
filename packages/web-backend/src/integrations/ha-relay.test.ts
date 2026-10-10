import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import express from 'express'
import type {Server} from 'node:http'
const mocks=vi.hoisted(()=>({complete:vi.fn()}))
vi.mock('@axiom/core',async()=>{
  const actual=await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
  return {...actual,createHaInferenceHandler:(config:Parameters<typeof actual.createHaInferenceHandler>[0])=>actual.createHaInferenceHandler(config,mocks.complete)}
})
import {createHaRelayRouter,HA_RELAY_MOUNT} from './ha-relay.js'
let server:Server|undefined, base:string, file:string
const token='synthetic-relay-only-'.repeat(3)
const config={enabled:true,transport:'anthropic-oauth',thinking:'low',tokenSha256:createHash('sha256').update(token).digest('hex'),providerId:'synthetic-existing-provider',model:'claude-haiku-5-5',tools:[],timeoutMs:1000,maxBodyBytes:262144,maxCallsPerHour:20}
const headers={authorization:'Bearer '+token,'content-type':'application/json'}
const body={model:config.model,messages:[{role:'system',content:'HA isolated'},{role:'user',content:'Harmless synthetic greeting'}],tools:[]}
beforeEach(()=>{
  file=path.join(process.env.DATA_DIR!,'config','ha-inference.json');fs.mkdirSync(path.dirname(file),{recursive:true})
  mocks.complete.mockReset().mockResolvedValue({completed:true,wireModel:config.model,message:{role:'assistant',content:[{type:'text',text:'Synthetic OK'}],stopReason:'stop',model:config.model,api:'anthropic-messages',provider:'anthropic',usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:1}})
})
afterEach(async()=>{if(server){const closing=new Promise<void>(resolve=>server!.close(()=>resolve()));server.closeAllConnections();await closing;server=undefined}if(fs.existsSync(file))fs.unlinkSync(file)})
function write(data=config,mode=0o600){fs.writeFileSync(file,JSON.stringify(data),{mode});fs.chmodSync(file,mode)}
async function start(){const app=express();app.use(HA_RELAY_MOUNT,createHaRelayRouter());app.use(express.json());app.get('/api/private',(_req,res)=>res.status(401).end());server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as any).port}`}
describe('backend HA relay mount, actual loopback HTTP and bounded raw Request bridge',()=>{
  it('is opt-in: absent or disabled configuration never makes an inference route',async()=>{
    await start();expect((await fetch(base+'/ha-relay/v1/models',{headers})).status).toBe(404);expect(mocks.complete).not.toHaveBeenCalled()
  })
  it('rejects non-private configuration and honors explicit disabled private config',async()=>{
    write(config,0o644);expect(()=>createHaRelayRouter()).toThrow('private regular file')
    write({...config,enabled:false});await start();expect((await fetch(base+'/ha-relay/v1/models',{headers})).status).toBe(404)
  })
  it('exposes read-only models/status to its bearer only; neither status nor catalog imply inference',async()=>{
    write();await start()
    expect((await fetch(base+'/ha-relay/v1/status')).status).toBe(401)
    const status=await(await fetch(base+'/ha-relay/v1/status',{headers})).json()
    expect(status).toMatchObject({model:config.model,auth:{state:'provider_unavailable',reloginRequired:false}})
    expect(JSON.stringify(status)).not.toContain(token)
    expect((await fetch(base+'/ha-relay/v1/models',{headers})).status).toBe(200)
    expect((await fetch(base+'/api/private',{headers})).status).toBe(401)
    expect(mocks.complete).not.toHaveBeenCalled()
  })
  it('streams incoming raw JSON before global express.json and returns validated completion',async()=>{
    write();await start()
    const response=await fetch(base+'/ha-relay/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(body)})
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect((await response.json() as any).choices[0].message.content).toBe('Synthetic OK')
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(mocks.complete.mock.calls[0][1].messages).toHaveLength(1)
    expect(mocks.complete.mock.calls[0][1].systemPrompt).toBe('HA isolated')
  })
  it('actual Python aiohttp client accepts mounted backend URL and performs status/catalog/completion without HA services',async()=>{
    write();await start()
    const python = `import asyncio, json, sys
from custom_components.offtangent_conversation.client import AdapterClient
async def main():
    client = AdapterClient(sys.argv[1], sys.argv[2], sys.argv[3])
    try:
        await client.check_model()
        status = await client.auth_status()
        result = await client.complete([{"role":"system","content":"HA isolated"},{"role":"user","content":"Harmless synthetic greeting"}], [])
        print(json.dumps({"mode":"OFFLINE: actual aiohttp -> Express relay; synthetic provider; no HA instance/services", "mount":"/ha-relay/v1", "model":client.model, "auth_state":status["auth"]["state"], "text":result.message["content"], "tool_calls":len(result.message.get("tool_calls", []))}))
    finally:
        await client.close()
asyncio.run(main())`
    const {stdout} = await promisify(execFile)(process.env.HA_TEST_PYTHON ?? 'python3', ['-c', python, base + '/ha-relay/v1', token, config.model], {
      env: {...process.env, PYTHONPATH:fileURLToPath(new URL('../../../../integrations/home_assistant',import.meta.url)), PYTHONDONTWRITEBYTECODE:'1'}, timeout:15000,
    })
    const evidence = JSON.parse(stdout)
    expect(evidence).toMatchObject({mount:'/ha-relay/v1',model:config.model,auth_state:'provider_unavailable',text:'Synthetic OK',tool_calls:0})
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    if(process.env.HA_RELAY_BRIDGE_EVIDENCE_PATH) fs.writeFileSync(process.env.HA_RELAY_BRIDGE_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n')
  },20000)
  it('client disconnect aborts provider and does not hold the relay admission slot',async()=>{
    write();await start()
    let aborted = false
    let entered!:()=>void
    const started = new Promise<void>(resolve=>{entered=resolve})
    const normal = mocks.complete.getMockImplementation()!
    mocks.complete.mockImplementationOnce((_config, _context, signal:AbortSignal)=>new Promise((_,reject)=>{
      signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)}, {once:true});entered()
    }))
    const controller = new AbortController()
    const pending = fetch(base+'/ha-relay/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal}).catch(()=>null)
    await started;controller.abort();await pending
    await vi.waitFor(()=>expect(aborted).toBe(true), {timeout:1000,interval:10})
    mocks.complete.mockImplementation(normal)
    expect((await fetch(base+'/ha-relay/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(200)
    expect(mocks.complete).toHaveBeenCalledTimes(2)
  })
  it('wrong bearer, malformed/oversized JSON and off-scope endpoints fail before provider',async()=>{
    write();await start()
    expect((await fetch(base+'/ha-relay/v1/chat/completions',{method:'POST',headers:{...headers,authorization:'Bearer wrong'},body:JSON.stringify(body)})).status).toBe(401)
    expect((await fetch(base+'/ha-relay/v1/chat/completions',{method:'POST',headers,body:'{'})).status).toBe(400)
    expect((await fetch(base+'/ha-relay/v1/chat/completions',{method:'POST',headers,body:'x'.repeat(262145)})).status).toBe(413)
    expect((await fetch(base+'/ha-relay/v1/responses',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(404)
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})
