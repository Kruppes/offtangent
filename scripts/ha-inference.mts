/** Opt-in standalone loopback listener. Does NOT change the Offtangent app/router. */
import fs from 'node:fs'
import { createHaHttpServer } from '../packages/core/src/ha-inference-http.js'
import { createHaInferenceHandler, validateHaConfig } from '../packages/core/src/ha-inference.js'
const file=process.argv[2]
if(!file)throw Error('Usage: tsx scripts/ha-inference.mts /absolute/path/ha-inference.json [port]')
const stat=fs.statSync(file)
if((stat.mode&0o077)!==0)throw Error('Config must be mode 0600 (or stricter)')
const handler=createHaInferenceHandler(validateHaConfig(JSON.parse(fs.readFileSync(file,'utf8'))))
const port=Number(process.argv[3]??3107)
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port')
const server=createHaHttpServer(handler)
server.listen(port,'127.0.0.1',()=>console.log('HA inference loopback listener on '+port))
for(const sig of ['SIGTERM','SIGINT'] as const)process.on(sig,()=>server.close(()=>process.exit()))
