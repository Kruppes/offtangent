import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brokerPassword, publicSettings, readSettings, saveSettings, validateUpdate } from './config.js'
let dir = ''
const old = process.env.DATA_DIR
beforeEach(() => { dir = fs.mkdtempSync(path.join(process.cwd(), '.mqtt-test-')); process.env.DATA_DIR = dir })
afterEach(() => { if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old; fs.rmSync(dir, { recursive: true, force: true }) })
describe('MQTT settings', () => {
  it('defaults to off; validates topics, port and group booleans', () => {
    expect(readSettings().enabled).toBe(false)
    expect(() => validateUpdate({ enabled: true })).toThrow('Broker host required')
    expect(() => validateUpdate({ baseTopic: 'a/b' })).toThrow()
    expect(() => validateUpdate({ port: 65536 })).toThrow()
    expect(() => validateUpdate({ groups: { usage: 'false' } })).toThrow()
    expect(() => validateUpdate({ passwordSecret: 'forged' })).toThrow()
  })
  it('stores password via secret handle, never exposes it on GET or in settings.json', () => {
    const input = { host: 'example.invalid', password: 'example-test-password-unique' }
    const next = saveSettings(validateUpdate(input), input)
    expect(next.passwordSecret).toBeTruthy()
    expect(brokerPassword(readSettings())).toBe(input.password)
    expect(publicSettings()).toMatchObject({ passwordSet: true, host: 'example.invalid' })
    expect(JSON.stringify(publicSettings())).not.toContain(input.password)
    expect(fs.readFileSync(path.join(dir, 'config/settings.json'), 'utf8')).not.toContain(input.password)
    saveSettings(validateUpdate({ clearPassword: true }), { clearPassword: true })
    expect(publicSettings().passwordSet).toBe(false)
  })
})
