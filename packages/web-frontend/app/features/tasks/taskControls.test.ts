import { describe, expect, it } from 'vitest'
import { checkReply, pendingQuestion, statusKey, taskActions } from './taskControls'

describe('taskActions', () => {
  it.each([
    ['running', { canStop: true, canAnswer: false, canFollowUp: false }],
    ['paused', { canStop: true, canAnswer: true, canFollowUp: false }],
    ['completed', { canStop: false, canAnswer: false, canFollowUp: true }],
    ['failed', { canStop: false, canAnswer: false, canFollowUp: true }],
    ['weird', { canStop: false, canAnswer: false, canFollowUp: false }],
  ])('%s', (status, expected) => {
    expect(taskActions(status)).toEqual(expected)
  })
  it('maps unknown statuses', () => {
    expect(statusKey(undefined)).toBe('unknown')
    expect(statusKey('paused')).toBe('paused')
  })
})

describe('checkReply', () => {
  it('trims and bounds the text like the server', () => {
    expect(checkReply('  yes please  ')).toEqual({ ok: true, text: 'yes please' })
    expect(checkReply('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(checkReply('x'.repeat(8001))).toEqual({ ok: false, reason: 'tooLong' })
    expect(checkReply('x'.repeat(8000)).ok).toBe(true)
  })
})

describe('pendingQuestion', () => {
  it('prefers the paused status message, then the last agent text', () => {
    expect(pendingQuestion([{ type: 'text_delta', text: 'Working' }, { type: 'status_change', status: 'paused', statusMessage: 'Which file?' }, { type: 'text_delta', text: 'Later' }])).toBe('Which file?')
    expect(pendingQuestion([{ type: 'text_delta', text: 'First' }, { type: 'text_delta', text: ' Second ' }])).toBe('Second')
    expect(pendingQuestion([{ type: 'status_change', status: 'paused', statusMessage: ' ' }])).toBeNull()
    expect(pendingQuestion([])).toBeNull()
  })
})
