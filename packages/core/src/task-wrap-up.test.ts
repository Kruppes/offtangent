import { describe, it, expect } from 'vitest'
import { planWrapUp, buildWrapUpMessage } from './task-wrap-up.js'

const BASE = { budgetFraction: 0.8, minLeadSeconds: 60 }

describe('planWrapUp', () => {
  it('schedules the wrap-up at 80% of a fresh budget', () => {
    const plan = planWrapUp({ ...BASE, budgetMinutes: 60, remainingMs: 60 * 60_000 })
    expect(plan).not.toBeNull()
    // 80 % of 60 min = 48 min from now, 12 min of lead time left.
    expect(plan!.delayMs).toBe(48 * 60_000)
    expect(plan!.remainingMinutesAtWrapUp).toBe(12)
  })

  it('accounts for time already spent (resume mid-budget)', () => {
    // 60 min budget, 30 min already gone: wrap-up in 18 min, not in 48.
    const plan = planWrapUp({ ...BASE, budgetMinutes: 60, remainingMs: 30 * 60_000 })
    expect(plan!.delayMs).toBe(18 * 60_000)
    expect(plan!.remainingMinutesAtWrapUp).toBe(12)
  })

  it('returns null when the wrap-up point has already passed', () => {
    const plan = planWrapUp({ ...BASE, budgetMinutes: 60, remainingMs: 5 * 60_000 })
    expect(plan).toBeNull()
  })

  it('returns null when the lead time is below minLeadSeconds', () => {
    // 2 min budget -> 24 s of lead time, below the 60 s floor: a wrap-up the
    // task cannot act on would only burn a turn.
    expect(planWrapUp({ ...BASE, budgetMinutes: 2, remainingMs: 2 * 60_000 })).toBeNull()
    // 5 min budget -> exactly 60 s lead: allowed.
    expect(planWrapUp({ ...BASE, budgetMinutes: 5, remainingMs: 5 * 60_000 })).not.toBeNull()
  })

  it('is disabled for fractions outside (0,1)', () => {
    for (const budgetFraction of [0, 1, -0.5, 1.5]) {
      expect(planWrapUp({ ...BASE, budgetFraction, budgetMinutes: 60, remainingMs: 60 * 60_000 })).toBeNull()
    }
  })

  it('returns null without a budget', () => {
    expect(planWrapUp({ ...BASE, budgetMinutes: 0, remainingMs: 60_000 })).toBeNull()
    expect(planWrapUp({ ...BASE, budgetMinutes: 60, remainingMs: 0 })).toBeNull()
  })

  it('honours a custom fraction', () => {
    const plan = planWrapUp({ ...BASE, budgetFraction: 0.5, budgetMinutes: 60, remainingMs: 60 * 60_000 })
    expect(plan!.delayMs).toBe(30 * 60_000)
  })
})

describe('buildWrapUpMessage', () => {
  it('names the remaining time and forbids new work', () => {
    const msg = buildWrapUpMessage(12, 60)
    expect(msg).toContain('<time_budget_warning>')
    expect(msg).toContain('60 min')
    expect(msg).toContain('about 12 minute(s)')
    expect(msg).toMatch(/no new work/i)
    expect(msg).toContain('HANDOFF')
    expect(msg).toContain('STATUS/SUMMARY')
  })
})
