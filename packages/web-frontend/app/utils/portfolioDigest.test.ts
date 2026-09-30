import { describe, expect, it } from 'vitest'
import { parsePortfolioDigest, urgencyIcon } from './portfolioDigest'

describe('portfolio digest payload reader', () => {
  it('never throws on a malformed payload and reports nothing as present', () => {
    for (const payload of [null, undefined, 'text', 42, [], { overview: 'nope', signals: {}, movers: 7, footer: [] }]) {
      const digest = parsePortfolioDigest(payload)
      expect(digest.overview).toBeUndefined()
      expect(digest.signals).toEqual([])
      expect(digest.gainers).toEqual([])
      expect(digest.footer).toBeUndefined()
    }
  })

  it('reads the contract fields and ignores unknown ones', () => {
    const digest = parsePortfolioDigest({
      overview: { securities_eur: 100, cash_eur: 20, total_eur: 120, day: { delta_eur: 1, delta_pct: 0.5 }, nonsense: 1 },
      data_issues: [{ severity: 'warn', code: 'c', message: 'm', isin: 'XX0000000001', value_eur: 3 }],
      signals: [{ id: 's', urgency: 'trim', name: 'Alpha Corp', status: 'carried', trigger: { type: 'price', op: 'gte', value: 9 } }],
      movers: { gainers: [{ name: 'Alpha Corp', delta_pct: 1, impact_eur: 2, driver: 'news' }], losers: [] },
      allocation: { positions: [{ name: 'Alpha Corp', weight_pct: 40 }], clusters: [{ label: 'AI', weight_pct: 20, members: ['Alpha Corp', 7] }] },
      changes_since: { compared_to_run: 'r1', items: ['one', 2] },
      footer: { sources: ['a'], positions_valid: 1, positions_total: 2, cost_eur: 0.1 },
      news: [{ title: 't', summary_de: 'de' }],
    })
    expect(digest.overview?.securitiesEur).toBe(100)
    expect(digest.overview?.day).toEqual({ deltaEur: 1, deltaPct: 0.5 })
    expect(digest.dataIssues[0]).toEqual({ severity: 'warn', code: 'c', message: 'm', valueEur: 3 })
    expect(digest.signals[0]?.trigger).toEqual({ type: 'price', op: 'gte', value: 9 })
    expect(digest.gainers[0]?.explanation).toBe('news')
    expect(digest.clusters[0]?.members).toEqual(['Alpha Corp'])
    expect(digest.changesSince).toEqual(['one'])
    expect(digest.news[0]?.summary).toBe('de')
    expect(digest.footer?.sources).toEqual(['a'])
  })

  it('maps every documented urgency and keeps unknown ones neutral', () => {
    for (const urgency of ['buy', 'add', 'trim', 'sell', 'hedge', 'watch', 'idea', 'urgent']) {
      expect(urgencyIcon(urgency)).not.toBe('•')
    }
    expect(urgencyIcon('teleport')).toBe('•')
    expect(urgencyIcon(undefined)).toBe('•')
  })
})
