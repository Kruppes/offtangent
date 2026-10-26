// Independent review R2 (dashboard-v2/review/r2-token-source.test.ts, F5-R2) taken over
// verbatim as permanent regression tests; only the import path is local.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, logTokenUsage } from '@axiom/core'
import type { Database } from '@axiom/core'
import { buildStrandDetail, buildTokensReport } from './details.js'
const dbs: Database[]=[]; const dirs: string[]=[]
afterEach(()=>{for(const db of dbs.splice(0)) if(db.open) db.close();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true})})
function setup(filename=':memory:') {const db=initDatabase(filename);dbs.push(db);db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(1,'u','x','user')").run();db.prepare("INSERT INTO sessions(id,user_id,session_user,type,title) VALUES('s-measured',1,'1','interactive','x')").run();return db}
function log(db: Database, kind: 'request'|'voice_note', p=10,c=5,cr=100,cw=7){logTokenUsage(db,{provider:'test',model:'test',sessionId:'s-measured',kind,promptTokens:p,completionTokens:c,cacheRead:cr,cacheWrite:cw,estimatedCost:0})}
function detail(db:Database){const id=(db.prepare('SELECT id FROM sessions WHERE user_id=1').get() as {id:string}).id;return buildStrandDetail(db,{userId:1,privacy:false,strandId:id})!}
describe('R2 evidenced request tokens, actual production logger and migrations',()=>{
 it('mixed measured requests and side accounting: subtraction equals the actual request SUM',()=>{const db=setup();log(db,'request');log(db,'voice_note',40,10,3,2);const result=detail(db);console.log('MIXED_REAL_LOGGER',result.tokens);expect(result.tokens).toEqual({input:10,output:5,cache_read:100,cache_write:7,total:122})})
 it('a fresh strand without any provider request is unknown, not measured zero',()=>{const db=setup();const result=detail(db);console.log('NO_REQUEST_ROWS',result.tokens);expect(result.tokens).toBeNull()})
 it('side-accounting alone is not proof of any measured request',()=>{const db=setup();log(db,'voice_note',40,10,0,0);const result=detail(db);console.log('SIDE_ONLY_REAL_LOGGER',result.tokens);expect(result.tokens).toBeNull()})
 it('an explicitly logged zero provider request is a measured zero',()=>{const db=setup();log(db,'request',0,0,0,0);expect(detail(db).tokens).toEqual({input:0,output:0,cache_read:0,cache_write:0,total:0})})
 it('negative residual is fail-closed rather than an invented positive token total',()=>{const db=setup();log(db,'voice_note',40,10,0,0);db.prepare("UPDATE sessions SET prompt_tokens=1 WHERE id='s-measured'").run();expect(detail(db).tokens).toBeNull()})
 it('legacy session cache-column migration must not silently lose evidenced request caches',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r2-cache-migration-'));dirs.push(dir);const file=path.join(dir,'test.db');const db=setup(file);log(db,'request');expect(detail(db).tokens?.total).toBe(122);
 // Faithful state of a database before the session cache columns were added:
 // token_usage has provider cache counts; sessions still has prompt/completion.
 db.exec('ALTER TABLE sessions DROP COLUMN cache_read; ALTER TABLE sessions DROP COLUMN cache_write;');db.close();const reopened=initDatabase(file);dbs.push(reopened);const result=detail(reopened);const report=buildTokensReport(reopened,{userId:1});console.log('CACHE_MIGRATION',{strand:result.tokens,report:report.total,requestRows:reopened.prepare("SELECT COUNT(*) AS n FROM token_usage WHERE kind='request'").get()});expect(result.tokens).toEqual({input:10,output:5,cache_read:100,cache_write:7,total:122});
 })
})

describe('F5-R2 additional: strand tokens are the request SUM, never the session aggregate', () => {
  it('several requests across time are summed; inflated session aggregate is ignored', () => {
    const db = setup(); log(db, 'request'); log(db, 'request', 1, 2, 3, 4)
    db.prepare("UPDATE sessions SET prompt_tokens=99999, completion_tokens=99999, cache_read=99999, cache_write=99999 WHERE id='s-measured'").run()
    expect(detail(db).tokens).toEqual({ input: 11, output: 7, cache_read: 103, cache_write: 11, total: 132 })
  })
  it('session aggregate without any request row stays unknown even if non-zero', () => {
    const db = setup(); db.prepare("UPDATE sessions SET prompt_tokens=100, completion_tokens=20, cache_read=3000, cache_write=50 WHERE id='s-measured'").run()
    expect(detail(db).tokens).toBeNull()
  })
  it('request rows of another session are not counted', () => {
    const db = setup(); db.prepare("INSERT INTO sessions(id,user_id,session_user,type,title) VALUES('s-other',1,'1','interactive','y')").run()
    logTokenUsage(db, { provider: 'test', model: 'test', sessionId: 's-other', kind: 'request', promptTokens: 500, completionTokens: 0, cacheRead: 0, cacheWrite: 0, estimatedCost: 0 })
    log(db, 'request', 1, 0, 0, 0)
    expect(buildStrandDetail(db, { userId: 1, privacy: false, strandId: 's-measured' })!.tokens?.total).toBe(1)
  })
})
