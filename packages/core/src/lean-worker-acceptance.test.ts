import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TaskRunner } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import { TaskEventBus } from './task-event-bus.js'
import { checkLeanPreconditions, parseLeanOutputSchema } from './lean-worker-profile.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'

const mock = vi.hoisted(() => ({ answers: [] as any[], calls: 0 }))
vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: vi.fn().mockImplementation(() => {
 const messages: any[] = []
 return { state: { messages }, subscribe: () => () => {}, abort: vi.fn(), prompt: async () => {
  mock.calls++
  let answer = mock.answers.shift() ?? 'STATUS: completed\nSUMMARY:\n{"total":"12"}'
  if (answer instanceof Error) throw answer
  if (typeof answer === 'function') answer = answer()
  messages.push({ role: 'assistant', content: [{ type: 'text', text: answer }] })
 } }
}) }))

const provider: any = { id: 'review-local', name: 'ReviewLocal', providerType: 'ollama', type: 'ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', enabledModels: ['review-model'], models: [], status: 'connected', authMethod: 'api-key' }
const schema = JSON.stringify({ type: 'object', required: ['total'], properties: { total: { type: 'string' } }, additionalProperties: false })
const long = 'Which invoice year?\n' + 'z'.repeat(9000)
const wait = async () => { await new Promise(r => setTimeout(r, 40)) }
let db: any, runner: TaskRunner, events: TaskEventBus, delivered: string[], paused: string[]
function create(s: string | undefined = schema, lean = true) {
 return runner.getStore().create({ name: 'independent', prompt: 'Extract invoice total', triggerType: 'agent', provider: provider.name, model: 'review-model', workerProfile: lean ? 'lean_local' : undefined, outputSchema: s })
}
async function run(answers: any[], s = schema, lean = true) {
 mock.answers.push(...answers)
 const task = create(s, lean)
 try { await runner.startTask(task, provider) } catch {}
 await wait()
 return runner.getStore().getById(task.id)!
}
function statusMessage(task: any) { return events.getBacklog(task.id).filter(e => e.type === 'status_change').at(-1)?.statusMessage ?? '' }

beforeEach(() => {
 setHeuristicsOverrideForTests({ delegation: { minBriefChars: 0 } })
 db = initDatabase(':memory:')
 events = new TaskEventBus(); delivered = []; paused = []
 runner = new TaskRunner({ db, buildModel: () => ({ id: 'review-model' } as any), getApiKey: async () => '', tools: [], sessionManager: new SessionManager({ db }), taskEventBus: events, onTaskComplete: (_id, text) => delivered.push(text), onTaskPaused: (_id, text) => paused.push(text) })
 mock.answers = []; mock.calls = 0
})
afterEach(() => { runner.dispose(); db.close(); setHeuristicsOverrideForTests(null) })

describe('lean_local acceptance probes (review of 7665793f)', () => {
 it.each(['{bad', '{"type":"array"}', '[]', ''])('P1 rejects syntactically/top-level unusable schema: %s', async bad => {
  const t = await run([], bad)
  expect(t.status).toBe('failed'); expect(mock.calls).toBe(0)
 })
 it.each([
  '{"type":"object","required":"total"}',
  '{"type":"object","properties":{"total":{"type":"nonsense"}}}',
  '{"type":"object","properties":{"total":7}}',
 ])('P1 rejects malformed nested/keyword schema before execution: %s', async bad => {
  const t = await run([], bad)
  expect(t.status).toBe('failed'); expect(mock.calls).toBe(0)
 })
 it('P1 rejects an unevaluable regex before spending two model rounds', async () => {
  const bad = '{"type":"object","properties":{"total":{"type":"string","pattern":"["}}}'
  expect(checkLeanPreconditions({ provider, outputSchema: bad })).not.toBeNull()
 })
 it('P1 recovery must not restart a malformed semantic schema', async () => {
  const t = create('{"type":"object","properties":{"total":7}}')
  runner.getStore().update(t.id, { status: 'running' })
  const r = await runner.recoverTasks(name => name === provider.name ? provider : null, { ...provider, name:'Cloud', providerType:'anthropic', baseUrl:'https://api.anthropic.com' })
  await wait()
  expect(r).toEqual({ resumed: 0, failed: 1 }); expect(mock.calls).toBe(0)
 })
 it('P1 mid-run missing schema fails closed', async () => {
  const t = create()
  mock.answers.push(() => { db.prepare('UPDATE tasks SET output_schema=NULL WHERE id=?').run(t.id); return 'STATUS: completed\nSUMMARY:\n{"total":"12"}' })
  await runner.startTask(t, provider); await wait()
  expect(runner.getStore().getById(t.id)!.status).toBe('failed')
  expect(delivered[0]).not.toContain('"total":"12"')
 })
 it('P2 correction strips all surrounding prose in persisted value and injection', async () => {
  const t = await run(['STATUS: completed\nSUMMARY:\n{"total":12}', 'STATUS: completed\nSUMMARY:\nSECRET PREFIX\n```json\n{ "total": "12" }\n```\nSECRET SUFFIX'])
  expect(mock.calls).toBe(2); expect(t.resultSummary).toBe('{"total":"12"}')
  expect(delivered[0]).not.toContain('SECRET'); expect(statusMessage(t)).toBe('{"total":"12"}')
 })
 it('P2 schema-valid large successes are deliberately not truncated', async () => {
  const json = JSON.stringify({total:'x'.repeat(6000)})
  const t = await run(['STATUS: completed\nSUMMARY:\nPrefix\n```json\n' + json + '\n```\nSuffix'])
  expect(t.status).toBe('completed'); expect(t.resultSummary).toBe(json)
 })
 it('P3 long reported failure row, handoff and delivered body stay capped', async () => {
  const t = await run(['STATUS: failed\nSUMMARY:\n' + long])
  expect(t.resultSummary!.length).toBeLessThanOrEqual(2000); expect(t.handoff!.length).toBeLessThanOrEqual(2000)
  expect(statusMessage(t).length).toBeLessThanOrEqual(2000)
  expect(delivered[0]).toContain(t.resultSummary!); expect(delivered[0]).not.toContain(long)
 })
 it('P3 long question stays paused and has capped status-event return', async () => {
  const t = await run(['STATUS: question\nSUMMARY:\n' + long])
  expect(t.status).toBe('paused'); expect(t.resultStatus).toBe('question'); expect(runner.isPaused(t.id)).toBe(true)
  expect(t.resultSummary!.length).toBeLessThanOrEqual(2000); expect(paused[0]).not.toContain(long)
  expect(statusMessage(t).length).toBeLessThanOrEqual(2000)
 })
 it('P3 long provider error has capped status-event return', async () => {
  const t = await run([new Error(long)])
  expect(t.status).toBe('failed'); expect(t.errorMessage!.length).toBeLessThanOrEqual(2000)
  expect(statusMessage(t).length).toBeLessThanOrEqual(2000)
 })
 it('P3 paused question can resume, JSON release stays clean', async () => {
  const t = await run(['STATUS: question\nSUMMARY:\n' + long])
  mock.answers.push('STATUS: completed\nSUMMARY:\nPrefix\n```json\n{"total":"15"}\n```\nSuffix')
  await runner.resumeTask(t.id, 'Year 2026'); await wait()
  const after = runner.getStore().getById(t.id)!
  expect(after.status).toBe('completed'); expect(after.resultSummary).toBe('{"total":"15"}')
 })
 it('P3 second question after resume also has capped status event', async () => {
  const t = await run(['STATUS: question\nSUMMARY:\nFirst short question?'])
  mock.answers.push('STATUS: question\nSUMMARY:\n' + long)
  await runner.resumeTask(t.id, 'Year 2026'); await wait()
  const after = runner.getStore().getById(t.id)!
  expect(after.status).toBe('paused'); expect(after.resultSummary!.length).toBeLessThanOrEqual(2000)
  expect(statusMessage(t).length).toBeLessThanOrEqual(2000)
 })
 it('P3 zombie abort caps all non-success return channels', () => {
  const t = create()
  runner.abortTask(t.id, long)
  const after = runner.getStore().getById(t.id)!
  expect(after.resultSummary!.length).toBeLessThanOrEqual(2000)
  expect(statusMessage(t).length).toBeLessThanOrEqual(2000)
 })
 it('Normal task control: question event and summary stay unchanged', async () => {
  const t = await run(['STATUS: question\nSUMMARY:\n' + long], schema, false)
  expect(t.resultSummary).toBe(long); expect(statusMessage(t)).toBe(long)
 })
 it('Normal task control: valid schema result retains surrounding prose', async () => {
  const raw = 'Prefix\n```json\n{"total":"12"}\n```\nSuffix'
  const t = await run(['STATUS: completed\nSUMMARY:\n' + raw], schema, false)
  expect(t.resultSummary).toBe(raw)
 })
 it('P1 mid-run syntactically valid but malformed schema must not authorize success', async () => {
  const t = create()
  mock.answers.push(() => { db.prepare('UPDATE tasks SET output_schema=? WHERE id=?').run('{"type":"object","properties":{"total":7}}', t.id); return 'STATUS: completed\nSUMMARY:\n{"total":"12"}' })
  await runner.startTask(t, provider); await wait()
  expect(runner.getStore().getById(t.id)!.status).toBe('failed')
 })
 it('P1 invalid regex must fail before model run, not after two unusable validation attempts', async () => {
  const t = await run([], '{"type":"object","properties":{"total":{"type":"string","pattern":"["}}}')
  expect(t.status).toBe('failed')
  expect(mock.calls).toBe(0)
 })
 it('P1 missing local provider in recovery never falls back to cloud', async () => {
  const t = create()
  runner.getStore().update(t.id, { status: 'running' })
  const r = await runner.recoverTasks(() => null, { ...provider, name:'Cloud', providerType:'anthropic', baseUrl:'https://api.anthropic.com' })
  await wait()
  expect(r).toEqual({ resumed:0, failed:1 }); expect(mock.calls).toBe(0)
 })
 it('P3 resumed error also has capped status event', async () => {
  const t = await run(['STATUS: question\nSUMMARY:\nFirst short question?'])
  mock.answers.push(new Error(long))
  await runner.resumeTask(t.id, 'Year 2026'); await wait()
  const after = runner.getStore().getById(t.id)!
  expect(after.status).toBe('failed'); expect(after.errorMessage!.length).toBeLessThanOrEqual(2000)
  expect(statusMessage(t).length).toBeLessThanOrEqual(2000)
 })
 it('Normal task control: long failure and handoff retain previous limits', async () => {
  const t = await run(['STATUS: failed\nSUMMARY:\n' + long], schema, false)
  expect(t.resultSummary).toBe(long); expect(t.handoff!.length).toBeGreaterThan(2000)
  expect(statusMessage(t)).toBe(long)
 })

 it('Normal task control: a malformed nested schema keeps the previous permissive handling', async () => {
  const t = await run([], '{"type":"object","properties":{"total":7}}', false)
  expect(mock.calls).toBe(1); expect(t.status).toBe('completed')
 })
})

describe('parseLeanOutputSchema (supported dialect)', () => {
 it.each([
  schema,
  '{"type":"object","required":["total"],"properties":{"total":{"type":"string"}}}',
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"ids":{"type":"array","items":{"type":"string","pattern":"^[A-Z]{2}\\\\d+$"},"maxItems":20},"n":{"type":["integer","null"],"minimum":0},"kind":{"enum":["a","b"]},"when":{"type":"string","format":"date"},"x":{"anyOf":[{"type":"string"},{"type":"number","multipleOf":0.5}]}},"additionalProperties":false}',
 ])('accepts a supported schema: %s', s => {
  expect(parseLeanOutputSchema(s).ok).toBe(true)
 })
 it.each([
  '{"type":"object","required":"total"}',
  '{"type":"object","properties":{"total":{"type":"nonsense"}}}',
  '{"type":"object","properties":{"total":7}}',
  '{"type":"object","properties":{"total":{"type":"string","pattern":"["}}}',
  '{"type":"object","properties":{"total":{"$ref":"#/$defs/t"}},"$defs":{"t":{"type":"string"}}}',
  '{"type":"object","properties":{"total":{"type":"string","format":"no-such-format"}}}',
  '{"type":"object","properties":{"total":{"type":"string","maxLength":-1}}}',
  '{"type":"object","propertes":{"total":{"type":"string"}}}',
 ])('refuses an invalid or unsupported schema: %s', s => {
  const r = parseLeanOutputSchema(s)
  expect(r.ok).toBe(false)
 })
})

describe('lean_local stored-schema lifecycle guard (review of 4190688c)', () => {
 it('refuses a malformed stored schema before the resumed model prompt', async () => {
  const t = await run(['STATUS: question\nSUMMARY:\nWhich year?'])
  expect(t.status).toBe('paused'); expect(mock.calls).toBe(1)
  db.prepare('UPDATE tasks SET output_schema=? WHERE id=?').run('{"type":"object","properties":{"total":{"type":"string","pattern":"["}}}', t.id)
  await runner.resumeTask(t.id, '2026'); await wait()
  const after = runner.getStore().getById(t.id)!
  expect(after.status).toBe('failed'); expect(mock.calls).toBe(1)
 })
 it('refuses a removed stored schema before the resumed model prompt', async () => {
  const t = await run(['STATUS: question\nSUMMARY:\nWhich year?'])
  db.prepare('UPDATE tasks SET output_schema=NULL WHERE id=?').run(t.id)
  await runner.resumeTask(t.id, '2026'); await wait()
  expect(runner.getStore().getById(t.id)!.status).toBe('failed'); expect(mock.calls).toBe(1)
 })
 it('resume with an intact stored schema still releases the validated JSON', async () => {
  const t = await run(['STATUS: question\nSUMMARY:\nWhich year?'])
  mock.answers.push('STATUS: completed\nSUMMARY:\nHere: {"total":"12"}')
  await runner.resumeTask(t.id, '2026'); await wait()
  const after = runner.getStore().getById(t.id)!
  expect(after.status).toBe('completed'); expect(after.resultSummary).toBe('{"total":"12"}'); expect(mock.calls).toBe(2)
 })
 it('does not release a corrected success after the stored schema became invalid', async () => {
  const t = create()
  mock.answers.push('STATUS: completed\nSUMMARY:\n{"total":12}', () => {
   db.prepare('UPDATE tasks SET output_schema=? WHERE id=?').run('{"type":"object","properties":{"total":7}}', t.id)
   return 'STATUS: completed\nSUMMARY:\n{"total":"12"}'
  })
  await runner.startTask(t, provider); await wait()
  const after = runner.getStore().getById(t.id)!
  expect(after.status).toBe('failed'); expect(mock.calls).toBe(2)
  expect(delivered.join('\n')).not.toContain('"total":"12"')
 })
 it('does not release a corrected success after the stored schema changed to another valid contract', async () => {
  const t = create()
  mock.answers.push('STATUS: completed\nSUMMARY:\n{"total":12}', () => {
   db.prepare('UPDATE tasks SET output_schema=? WHERE id=?').run(JSON.stringify({ type: 'object', required: ['total', 'currency'], properties: { total: { type: 'string' }, currency: { type: 'string' } } }), t.id)
   return 'STATUS: completed\nSUMMARY:\n{"total":"12"}'
  })
  await runner.startTask(t, provider); await wait()
  const after = runner.getStore().getById(t.id)!
  expect(after.status).toBe('failed'); expect(mock.calls).toBe(2)
  expect(after.resultSummary).toContain('changed')
 })
 it('corrected success with an unchanged contract releases only the current validated JSON', async () => {
  const t = await run(['STATUS: completed\nSUMMARY:\n{"total":12}', 'STATUS: completed\nSUMMARY:\nFixed: {"total":"12"} done'])
  expect(t.status).toBe('completed'); expect(t.resultSummary).toBe('{"total":"12"}'); expect(mock.calls).toBe(2)
 })
 it('Normal task control: schema change during correction keeps the previous snapshot behaviour', async () => {
  const t = create(schema, false)
  mock.answers.push('STATUS: completed\nSUMMARY:\n{"total":12}', () => {
   db.prepare('UPDATE tasks SET output_schema=? WHERE id=?').run('{"type":"object","properties":{"total":7}}', t.id)
   return 'STATUS: completed\nSUMMARY:\n{"total":"12"}'
  })
  await runner.startTask(t, provider); await wait()
  const after = runner.getStore().getById(t.id)!
  expect(after.status).toBe('completed'); expect(after.resultSummary).toBe('{"total":"12"}')
 })
})
