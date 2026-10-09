/** Separate loopback-only transport, never mounted on the main application. */
import { createServer } from 'node:http'
export function createHaHttpServer(handler:(request:Request)=>Promise<Response>) {
 const server=createServer(async(incoming,outgoing)=>{
  const abort=new AbortController()
  outgoing.on('close',()=>{if(!outgoing.writableEnded)abort.abort()})
  try {
   const headers=new Headers()
   for(const [key,value]of Object.entries(incoming.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value)
   // Origin is fixed; Host and absolute-form request targets cannot change it.
   const pathname=incoming.url?.startsWith('/')?incoming.url:'/'
   const init:RequestInit&{duplex?:'half'}={method:incoming.method,headers,signal:abort.signal}
   if(!['GET','HEAD'].includes(incoming.method??'GET')){init.body=incoming as unknown as RequestInit['body'];init.duplex='half'}
   const response=await handler(new Request('http://127.0.0.1'+pathname,init))
   if(outgoing.destroyed)return
   outgoing.writeHead(response.status,Object.fromEntries(response.headers))
   outgoing.end(Buffer.from(await response.arrayBuffer()))
  }catch{if(!outgoing.headersSent)outgoing.writeHead(500);outgoing.end()}
 })
 server.requestTimeout=125000
 server.headersTimeout=10000
 server.maxConnections=8
 return server
}
