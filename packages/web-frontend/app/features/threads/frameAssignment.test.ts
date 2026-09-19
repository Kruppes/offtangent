import { describe, expect, it } from 'vitest'
import { resolveFrameSession } from './frameAssignment'
describe('frame strand assignment', () => {
  it('uses explicit session even with another persona last active', () => {
    expect(resolveFrameSession({ sessionId: 'a', agentId: 'bob' }, { bob: 'b' })).toBe('a')
  })
  it('falls back only to the same explicitly identified persona', () => {
    expect(resolveFrameSession({ agentId: 'bob' }, { bob: 'b', main: 'a' })).toBe('b')
    expect(resolveFrameSession({ agentId: 'unknown' }, { bob: 'b' })).toBeNull()
  })
  it('drops unattributed background results instead of guessing', () => {
    expect(resolveFrameSession({}, { bob: 'b' })).toBeNull()
    expect(resolveFrameSession({ agentId: 'toString' }, {})).toBeNull()
    expect(resolveFrameSession({ sessionId: '', agentId: '' }, {})).toBeNull()
  })
})
