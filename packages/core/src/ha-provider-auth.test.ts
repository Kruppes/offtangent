import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { ProviderConfig } from './provider-config.js'
const central = vi.hoisted(() => ({ load: vi.fn(), key: vi.fn(), refresh: vi.fn(), auth: vi.fn(), stored: vi.fn(), build:vi.fn() }))
vi.mock('./provider-config.js', () => ({ loadProvidersDecrypted: central.load, getApiKeyForProvider: central.key,
  refreshOAuthCredentialsLocked: central.refresh, getPiOAuthAuth: central.auth, storedToOAuthCredentials: central.stored, buildModel:central.build }))
import { inspectHaAuth as getHaProviderAuthState, resolveHaCredential, repairHaRejectedAccess } from './ha-provider-auth.js'
import { createHaInferenceHandler } from './ha-inference.js'
import { completeHaAnthropic } from './ha-anthropic-relay.js'
// Existing installed stream/SDK is exercised; only central storage and network are synthetic.
vi.mock('./data-policy.js', () => ({ checkAutomaticModelFor: () => ({ allowed: true }) }))
vi.mock('./pi-models.js', async () => {
  const actual = await vi.importActual<typeof import('./pi-models.js')>('./pi-models.js')
  return actual
})
afterEach(()=>vi.restoreAllMocks())
let n = 0, provider: ProviderConfig
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks()
  provider = { id: `synthetic-auth-${++n}`, providerType: 'anthropic-oauth', authMethod: 'oauth',
    type: 'anthropic-messages', oauthCredentials: { access: `synthetic-access-${n}`, refresh: 'synthetic-refresh', expires: Date.now() + 3600000 } } as ProviderConfig
  central.load.mockImplementation(() => ({ providers: [provider] }))
  central.key.mockResolvedValue('synthetic-new-access')
  central.auth.mockReturnValue({ name: 'existing-central-oauth' })
  central.stored.mockImplementation(x => ({ ...x, type: 'oauth' }))
  central.refresh.mockResolvedValue({ type: 'oauth', access: 'synthetic-new-access', refresh: 'synthetic-rotated', expires: Date.now()+3600000 })
})
describe('HA central auth lifecycle, no independent token keeper or inference replay', () => {
  it('reports Access expiry separately and resolves via existing central resolver', async () => {
    provider.oauthCredentials!.expires = Date.now()-1
    expect(getHaProviderAuthState(provider.id).state).toBe('access_expired')
    expect(getHaProviderAuthState(provider.id).reloginRequired).toBe(false)
    expect(getHaProviderAuthState(provider.id).refreshExpiresAt).toBeNull()
    expect(await resolveHaCredential(provider)).toBe('synthetic-new-access')
    expect(central.key).toHaveBeenCalledWith(provider)
    // Mock storage deliberately remains expired: resolving a key is NOT verified inference.
    expect(getHaProviderAuthState(provider.id).state).toBe('access_expired')
    expect(central.refresh).not.toHaveBeenCalled()
  })
  it('missing refresh only requires relogin when access is expired', async () => {
    provider.oauthCredentials!.refresh = ''
    expect(await resolveHaCredential(provider)).toBe('synthetic-new-access')
    provider.oauthCredentials!.expires = Date.now()-1
    await expect(resolveHaCredential(provider)).rejects.toMatchObject({ code:'provider_relogin_required' })
    expect(getHaProviderAuthState(provider.id)).toMatchObject({ state:'relogin_required', reloginRequired:true })
    expect(central.key).toHaveBeenCalledTimes(1)
  })
  it.each([{status:401}, {code:'invalid_grant'}, new Error('OAuth refresh failed status=401'), new Error('Invalid refresh token')])('classifies revoked/expired refresh without exposing credentials: %s', async error => {
    central.key.mockRejectedValue(error)
    await expect(resolveHaCredential(provider)).rejects.toMatchObject({ code:'provider_relogin_required' })
    expect(getHaProviderAuthState(provider.id).reloginRequired).toBe(true)
  })
  it('temporary refresh outage is NOT reported as expired login', async () => {
    central.key.mockRejectedValue(new Error('synthetic network outage with secret details'))
    await expect(resolveHaCredential(provider)).rejects.toMatchObject({ code:'provider_refresh_unavailable' })
    expect(getHaProviderAuthState(provider.id)).toMatchObject({state:'refresh_unavailable', reloginRequired:false})
  })
  it('401 uses existing central forced lock, deduplicates concurrent repair, never replays inference', async () => {
    const rejected = provider.oauthCredentials!.access
    const results = await Promise.allSettled([repairHaRejectedAccess(provider,rejected),repairHaRejectedAccess(provider,rejected)])
    expect(results.every(x => x.status==='rejected' && x.reason.code==='provider_access_rejected')).toBe(true)
    expect(central.refresh).toHaveBeenCalledTimes(1)
    expect(central.refresh).toHaveBeenCalledWith(provider.id, central.auth.mock.results[0].value,
      expect.objectContaining({access:rejected}), {force:true, expectedProviderType: provider.providerType})
    await expect(repairHaRejectedAccess(provider,rejected)).rejects.toMatchObject({code:'provider_access_rejected'})
    expect(central.refresh).toHaveBeenCalledTimes(1)
    expect(central.key).not.toHaveBeenCalled()
  })
  it('passes actually rejected access so central lock can recognize a newer stored access', async () => {
    await expect(repairHaRejectedAccess(provider,'synthetic-old-rejected-access')).rejects.toMatchObject({code:'provider_access_rejected'})
    expect(central.refresh.mock.calls[0][2].access).toBe('synthetic-old-rejected-access')
  })
  it('401 + invalid refresh shows relogin, not a fabricated successful roundtrip', async () => {
    central.refresh.mockRejectedValue(new Error('OAuth refresh failed status=401'))
    await expect(repairHaRejectedAccess(provider,provider.oauthCredentials!.access)).rejects.toMatchObject({code:'provider_relogin_required'})
    expect(getHaProviderAuthState(provider.id).reloginRequired).toBe(true)
  })
  it('new central login clears cached relogin condition; status never leaks either bearer', async () => {
    central.key.mockRejectedValueOnce({code:'invalid_grant'})
    await expect(resolveHaCredential(provider)).rejects.toThrow('provider_relogin_required')
    provider.oauthCredentials!.access = 'synthetic-manually-new-login'
    const status=getHaProviderAuthState(provider.id)
    expect(status).toMatchObject({state:'unknown', reloginRequired:false})
    expect(JSON.stringify(status)).not.toMatch(/synthetic-access|synthetic-refresh|synthetic-manually/)
    expect(await resolveHaCredential(provider)).toBe('synthetic-new-access')
  })
  it('missing central provider is explicit, not an API-credit fallback', () => {
    central.load.mockReturnValue({providers:[]})
    expect(getHaProviderAuthState(provider.id)).toMatchObject({state:'provider_unavailable',reloginRequired:false})
  })
})

describe('existing Anthropic SDK HTTP authentication faults, synthetic network only', () => {
  const modelId='claude-haiku-5-5'
  const config=()=>({enabled:true as const,transport:'anthropic-oauth' as const,thinking:'low' as const,tokenSha256:createHash('sha256').update('synthetic-relay-only').digest('hex'),providerId:provider.id,model:modelId,tools:[],timeoutMs:1000,maxBodyBytes:262144,maxCallsPerHour:20})
  const setup=(status:number)=>{
    provider.enabledModels=[modelId]
    central.key.mockResolvedValue('sk-ant-oat01-central')
    central.build.mockReturnValue({id:modelId,name:modelId,api:'anthropic-messages',provider:'anthropic',baseUrl:'https://api.anthropic.com',reasoning:true,input:['text'],contextWindow:200000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{forceAdaptiveThinking:true,supportsTemperature:false}})
    return vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({type:'error',error:{type:'authentication_error',message:'untrusted upstream credential details'}}),{status,headers:{'content-type':'application/json'}}))
  }
  it('measures 401: exactly one inference POST, one central refresh, explicit rejected access',async()=>{
    const http=setup(401)
    await expect(completeHaAnthropic(config(),{messages:[{role:'user',content:'Synthetic harmless greeting',timestamp:1}]},new AbortController().signal)).rejects.toMatchObject({code:'provider_access_rejected'})
    expect(http).toHaveBeenCalledTimes(1);expect(central.refresh).toHaveBeenCalledTimes(1)
    const headers=new Headers(http.mock.calls[0][1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-central')
    expect(headers.has('x-api-key')).toBe(false)
    expect(getHaProviderAuthState(provider.id)).toMatchObject({state:'access_rejected',reloginRequired:false})
  })
  it('401 with revoked refresh: one inference POST, HA relogin signal',async()=>{
    const http=setup(401);central.refresh.mockRejectedValue({code:'invalid_grant'})
    await expect(completeHaAnthropic(config(),{messages:[]},new AbortController().signal)).rejects.toMatchObject({code:'provider_relogin_required'})
    expect(http).toHaveBeenCalledTimes(1);expect(getHaProviderAuthState(provider.id).reloginRequired).toBe(true)
  })
  it.each([[403,'provider_access_blocked'],[429,'subscription_rate_limit'],[400,'subscription_http_error']])('HTTP %s never changes identity, retries or switches to credits',async(status,code)=>{
    const http=setup(status as number)
    await expect(completeHaAnthropic(config(),{messages:[]},new AbortController().signal)).rejects.toMatchObject({code})
    expect(http).toHaveBeenCalledTimes(1);expect(central.refresh).not.toHaveBeenCalled()
  })
  it.each(['{"name":"synthetic"}', '{"name":"first","name":"second"}', '{"name":"synthetic","number":1e999}', '{"name":"synthetic","number":NaN}'])('native production relay validates raw SDK argument JSON before any dispatch: %s', async argumentsJSON => {
    const http=setup(200)
    const events=[
      {type:'message_start',message:{id:'synthetic-message',type:'message',role:'assistant',model:modelId,content:[],usage:{input_tokens:1,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic-call',name:'HassTurnOff',input:{}}},
      {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:argumentsJSON}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:2}},
      {type:'message_stop'},
    ]
    http.mockImplementation(async()=>new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}}))
    const tool={name:'HassTurnOff',description:'Simulated only; never dispatched',parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}}
    const handler=createHaInferenceHandler({...config(),tools:[tool]})
    const response=await handler(new Request('http://localhost/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer synthetic-relay-only','content-type':'application/json'},body:JSON.stringify({model:modelId,messages:[{role:'user',content:'Offline simulated test only'}],tools:[{type:'function',function:tool}]})}))
    const body=await response.json() as {choices:{message:{content:string;tool_calls:Array<{function:{arguments:string}}>}}[];error:{code:string}}
    expect(http).toHaveBeenCalledTimes(1)
    expect(central.refresh).not.toHaveBeenCalled()
    if(argumentsJSON==='{"name":"synthetic"}') {
      expect(response.status).toBe(200)
      expect(body.choices[0].message.tool_calls[0].function.arguments).toBe(argumentsJSON)
      expect(getHaProviderAuthState(provider.id).state).toBe('ready')
    } else {
      expect(response.status).toBe(502)
      expect(body.error.code).toBe('invalid_subscription_arguments')
      expect(body.choices).toBeUndefined()
      expect(getHaProviderAuthState(provider.id).state).not.toBe('ready')
    }
  })

})
