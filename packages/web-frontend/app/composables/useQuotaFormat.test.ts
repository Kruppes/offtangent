import { describe, expect, it } from 'vitest'
import { useQuotaFormat } from './useQuotaFormat'

describe('formatBalanceAmount', () => {
  const { formatBalanceAmount } = useQuotaFormat()
  const balance = { amount: 13.505731, currency: 'USD', cash: 13.505731, voucher: 0 }

  it('formats a USD balance per locale', () => {
    expect(formatBalanceAmount(balance, 'en')).toBe('$13.51')
    expect(formatBalanceAmount(balance, 'de').replace(/\u00a0/g, ' ')).toBe('13,51 $')
  })

  it('formats a CNY balance', () => {
    expect(formatBalanceAmount({ ...balance, currency: 'CNY' }, 'en')).toMatch(/13\.51/)
    expect(formatBalanceAmount({ ...balance, currency: 'CNY' }, 'en')).toMatch(/CN¥|¥/)
  })

  it('shows nothing for a missing or unusable balance', () => {
    expect(formatBalanceAmount(null, 'en')).toBe('')
    expect(formatBalanceAmount(undefined, 'en')).toBe('')
    expect(formatBalanceAmount({ ...balance, amount: Number.NaN }, 'en')).toBe('')
  })

  it('does not throw on an odd currency code', () => {
    expect(formatBalanceAmount({ ...balance, currency: 'dollars' }, 'en')).toBe('13.51')
  })
})
