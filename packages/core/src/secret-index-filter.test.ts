/**
 * S0-A / A1 (UX report 2026-10-23 § 6.3): the global known-value index must
 * never rewrite project words, protocol terms or low-entropy runs, and a hit
 * replaces only the matched value, never the surrounding output.
 *
 * All values here are synthetic test strings.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { INTERACTION_BLOCK_KINDS, INTERACTION_FENCE_LANGUAGE } from './contracts/interaction-blocks.js'
import { NEWS_DIGEST_KIND, NEWS_DIGEST_V2_KIND } from './board-news-digest.js'
import { PORTFOLIO_DIGEST_KIND } from './board-tool.js'
import { HTML_VIEW_KIND } from './board-html-view.js'
import { buildInteractiveQuestionsPrompt } from './interactive-questions-prompt.js'
import { invalidateKnownValues, knownIndexStats, redactKnown, resolveHandles, secretHandle } from './secret-boundary.js'
import {
  HARNESS_PLACEHOLDER_TEXTS,
  SECRET_INDEX_ALLOWLIST,
  configuredHostTerms,
  indexSkipReason,
  shannonEntropy,
} from './secret-index-filter.js'
import { invalidateSecretHandleCache, sealSecret } from './secret-store.js'
import { resetSealingStats, sealingStatsSnapshot } from './secret-sealing-stats.js'

let tmpDir: string
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-index-filter-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = {
    DATA_DIR: process.env.DATA_DIR,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-index-filter'
  delete process.env.PUBLIC_BASE_URL
  invalidateSecretHandleCache()
  invalidateKnownValues()
  resetSealingStats()
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
  resetSealingStats()
})

describe('A1: allowlist', () => {
  it('contains the fence language, every block kind, the board kinds and package names', () => {
    expect(SECRET_INDEX_ALLOWLIST.has(INTERACTION_FENCE_LANGUAGE)).toBe(true)
    for (const kind of INTERACTION_BLOCK_KINDS) expect(SECRET_INDEX_ALLOWLIST.has(kind)).toBe(true)
    for (const kind of [NEWS_DIGEST_KIND, NEWS_DIGEST_V2_KIND, PORTFOLIO_DIGEST_KIND, HTML_VIEW_KIND]) {
      expect(SECRET_INDEX_ALLOWLIST.has(kind)).toBe(true)
    }
    for (const name of ['offtangent', 'axiom', '@axiom/core', '@axiom/web-backend']) {
      expect(SECRET_INDEX_ALLOWLIST.has(name)).toBe(true)
    }
  })

  it('keeps the fence word in a system prompt excerpt even when it is a stored value', () => {
    // The October incident: the fence language was replaced by a handle in
    // the interactive-block instructions. Sealing the word as a value is the
    // worst case — the index must still leave it alone.
    sealSecret('offtangent', 'password', 'form')
    invalidateKnownValues()
    const excerpt = buildInteractiveQuestionsPrompt()
    expect(excerpt).toContain('```offtangent')
    expect(redactKnown(excerpt)).toBe(excerpt)
    const prose = 'Open the block with ```offtangent and close it with ```. offtangent renders it as a card.'
    expect(redactKnown(prose)).toBe(prose)
  })

  it('still resolves an allowlisted stored value through its handle', () => {
    const slug = sealSecret('offtangent', 'password', 'form')
    invalidateKnownValues()
    expect(resolveHandles(`pw ${secretHandle(slug)}`).text).toBe('pw offtangent')
  })

  it('never indexes the shell placeholders', () => {
    for (const text of HARNESS_PLACEHOLDER_TEXTS) sealSecret(text, 'vault-cli', 'tool:shell')
    invalidateKnownValues()
    for (const text of HARNESS_PLACEHOLDER_TEXTS) expect(redactKnown(text)).toBe(text)
  })

  it('treats configured host names as allowlisted', () => {
    process.env.PUBLIC_BASE_URL = 'https://box-example.internal.test:8443/app'
    expect(configuredHostTerms()).toEqual(['box-example.internal.test', 'box-example'])
    expect(indexSkipReason('box-example.internal.test', 8)).toBe('allowlisted')
    sealSecret('box-example.internal.test', 'password', 'form')
    invalidateKnownValues()
    expect(redactKnown('open https://box-example.internal.test/x')).toBe('open https://box-example.internal.test/x')
  })
})

/**
 * Review S0-A / A1: regression table of the eight breakage patterns of the
 * October analysis (UX report § 6.3, innen-bruchanalyse.json). The analysis
 * counted 33 of 64 fence breakages as `fence_variant:fence_mid_line` (the
 * fence word in the middle of a line, inside inline code), so (b) carries that
 * variant too. Worst case for every row: the project word itself was stored as
 * a secret value (the fence spelling, as in the incident).
 *
 * (f) checks that the stored lowercase word never hits the capitalised
 * spelling in prose (no case-folding in the index). A case variant that was
 * itself stored as a secret file value stays redacted on purpose; that is an
 * existing decision pinned in secret-files.test.ts ("redacts credentials
 * containing the reserved token", "masks an uppercase fence label").
 */
describe('A1: regression table of the eight breakage patterns', () => {
  function sealProjectWord(): void {
    sealSecret('offtangent', 'password', 'form')
    invalidateKnownValues()
  }

  /** "offtangent-" + 32 random base62 characters, generated per run (no literal in the repo). */
  function randomProjectSecret(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const bytes = randomBytes(32)
    return 'offtangent-' + Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
  }

  /**
   * Each row seals the reserved word `offtangent` (the incident's worst case)
   * AND at least one value that only the A1 admission rule keeps out of the
   * global index: an allowlisted protocol term, a configured host, or an
   * automatically harvested low-entropy run. `offtangent` alone was already
   * reserved before A1 (`RESERVED_OUTPUT_VALUES`), so a table on that word
   * alone stayed green with A1 reverted (REVIEW-S0-A-2, Kriterium 4). The
   * rows go through the real path: the secret store files the values, the
   * known-value index is rebuilt, `redactKnown` runs on the text.
   */
  interface UntouchedRow {
    label: string
    text: () => string
    /** Values filed in the store besides `offtangent`, each with its source. */
    a1Values: () => Array<[value: string, source: string]>
    env?: Record<string, string>
  }

  const untouched: UntouchedRow[] = [
    {
      label: '(a) fence instructions of the system prompt',
      text: () => buildInteractiveQuestionsPrompt(),
      // Interaction-block kinds that the prompt names (6+ characters, so the
      // length floor alone would admit them).
      a1Values: () => INTERACTION_BLOCK_KINDS
        .filter(kind => kind.length >= 6 && buildInteractiveQuestionsPrompt().includes(kind))
        .map(kind => [kind, 'form'] as [string, string]),
    },
    {
      label: '(b) markdown code fence',
      text: () => 'Here is the card:\n```offtangent\n{"block":"confirm","id":"c1","question":"Go?"}\n```\n',
      a1Values: () => [['confirm', 'form']],
    },
    {
      label: '(b) fence word mid-line in inline code (fence_mid_line)',
      text: () => 'Use ```` ```offtangent ```` to open a block of kind "handover", then JSON, then ```.',
      a1Values: () => [['handover', 'form']],
    },
    {
      label: '(c) file path',
      text: () => 'edited /workspace/offtangent/packages/core/src/task-runner.ts and ~/offtangent/README.md, ' +
        'rendered by /data/board-renderers/portfolio_digest.v1.html, migration db/00000000_init.sql',
      a1Values: () => [['portfolio_digest.v1', 'form'], ['00000000', 'tool:shell']],
    },
    {
      label: '(d) host name',
      text: () => 'ssh alice@offtangent.local && curl http://offtangent.local:3000/health',
      a1Values: () => [['offtangent.local', 'form']],
      env: { PUBLIC_BASE_URL: 'http://offtangent.local:3000' },
    },
    {
      label: '(e) package name',
      text: () => 'import { x } from "@offtangent/x"; npm i @offtangent/x@1.2.3; import { y } from "@axiom/core"',
      a1Values: () => [['@axiom/core', 'form']],
    },
    {
      label: '(f) capitalised word',
      text: () => 'Offtangent is the app, its keys live in vaultwarden. OFFTANGENT and Offtangent stay as they are.',
      a1Values: () => [['vaultwarden', 'form']],
    },
  ]

  for (const row of untouched) {
    it(`${row.label}: unchanged`, () => {
      for (const [k, v] of Object.entries(row.env ?? {})) process.env[k] = v
      const a1Values = row.a1Values()
      expect(a1Values.length).toBeGreaterThan(0)
      sealSecret('offtangent', 'password', 'form')
      for (const [value, source] of a1Values) sealSecret(value, 'password', source)
      invalidateKnownValues()
      const input = row.text()
      expect(input.toLowerCase()).toContain('offtangent')
      for (const [value] of a1Values) expect(input).toContain(value)
      expect(redactKnown(input)).toBe(input)
      // The values were really offered to the index and turned away there.
      const skipped = knownIndexStats().skipped
      expect(skipped.allowlisted + skipped['low-entropy']).toBeGreaterThanOrEqual(a1Values.length + 1)
    })
  }

  it('(g) a high-entropy secret that starts with the project word stays sealed, as a whole', () => {
    sealProjectWord()
    const secret = randomProjectSecret()
    const slug = sealSecret(secret, 'password', 'form')
    invalidateKnownValues()
    const out = redactKnown(`export OT_TOKEN=${secret} # offtangent`)
    expect(out).toBe(`export OT_TOKEN=${secretHandle(slug)} # offtangent`)
    expect(out).not.toContain(secret.slice('offtangent-'.length))
  })

  it('(h) a multi-line grep output: only the value in the one secret line is replaced', () => {
    sealProjectWord()
    const secret = randomProjectSecret()
    const slug = sealSecret(secret, 'password', 'form')
    invalidateKnownValues()
    const lines = [
      'packages/core/src/a.ts:3:// offtangent fence: ```offtangent',
      `packages/core/src/b.ts:9:const key = "${secret}" // Offtangent`,
      'packages/core/src/c.ts:1:import "@offtangent/x"',
      'docs/hosts.md:4:offtangent.local',
    ]
    const out = redactKnown(lines.join('\n')).split('\n')
    expect(out).toHaveLength(4)
    expect(out[0]).toBe(lines[0])
    expect(out[1]).toBe(lines[1].replace(secret, secretHandle(slug)))
    expect(out[2]).toBe(lines[2])
    expect(out[3]).toBe(lines[3])
  })
})

describe('A1: entropy and length floor', () => {
  it('computes Shannon entropy per character', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0)
    expect(shannonEntropy('abababab')).toBeCloseTo(1, 5)
    expect(shannonEntropy('abcdefgh')).toBeCloseTo(3, 5)
  })

  it('skips runs, separators and two-letter patterns', () => {
    expect(indexSkipReason('00000000', 8)).toBe('low-entropy')
    expect(indexSkipReason('--------', 8)).toBe('low-entropy')
    expect(indexSkipReason('abababab', 8)).toBe('low-entropy')
    expect(indexSkipReason('aaaaaaab', 8)).toBe('low-entropy')
    expect(indexSkipReason('short', 8)).toBe('too-short')
    expect(indexSkipReason('Synthetic-Value-42!', 8)).toBeNull()
  })

  it('does not rewrite a zero run that a tool output sealed automatically', () => {
    sealSecret('00000000', 'vault-cli', 'tool:shell')
    invalidateKnownValues()
    const text = 'commit 0000000000000000 at 00000000'
    expect(redactKnown(text)).toBe(text)
    expect(knownIndexStats().skipped['low-entropy']).toBeGreaterThanOrEqual(1)
  })
})

describe('A1: only the hit is replaced', () => {
  it('a multi-line grep output with one real secret loses only that value', () => {
    const secret = 'Synthetic-Grep-Secret-9f3K!'
    const slug = sealSecret(secret, 'password', 'form')
    invalidateKnownValues()
    const grepOutput = [
      'src/config.ts:12:  const fence = "offtangent"',
      `src/config.ts:13:  const token = "${secret}"`,
      'src/config.ts:14:  // bw unlock --raw is documented in docs/vault.md',
      'src/other.ts:7:export const KIND = "news_digest.v2"',
      'src/other.ts:8:const zero = "00000000"',
    ].join('\n')
    const out = redactKnown(grepOutput)
    const expected = grepOutput.replace(secret, secretHandle(slug))
    expect(out).toBe(expected)
    expect(out.split('\n')).toHaveLength(5)
    expect(out).not.toContain(secret)
    expect(out).toContain('offtangent')
  })
})

describe('A2: sealing telemetry', () => {
  it('counts replacements per index entry, keyed by handle, never by value', () => {
    const secret = 'Synthetic-Counted-Value-7Q!'
    const slug = sealSecret(secret, 'password', 'form')
    invalidateKnownValues()
    redactKnown(`a ${secret} b ${secret}`)
    redactKnown(`c ${secret}`)
    const snapshot = sealingStatsSnapshot()
    expect(snapshot.total).toBe(3)
    expect(snapshot.entries).toEqual([{ entry: secretHandle(slug), count: 3 }])
    expect(JSON.stringify(snapshot)).not.toContain(secret)
  })

  it('keys an opaque env value by source and hash prefix', () => {
    const name = 'S0A_TEST_API_TOKEN'
    const value = 'Synthetic-Env-Token-5m2P'
    const before = process.env[name]
    process.env[name] = value
    try {
      invalidateKnownValues()
      redactKnown(`token=${value}`)
      const [entry] = sealingStatsSnapshot().entries
      expect(entry?.entry).toMatch(/^redacted:env:[0-9a-f]{8}$/)
      expect(entry?.count).toBe(1)
      // Review S0-A / A2: salted (HMAC under a per-process key), so the
      // plain SHA-256 prefix of the value, which a word-list check would
      // compute offline, is not the key.
      const unsalted = createHash('sha256').update(value).digest('hex').slice(0, 8)
      expect(entry?.entry).not.toBe(`redacted:env:${unsalted}`)
      // Stable within the process: counts of the same value add up.
      redactKnown(`again ${value}`)
      expect(sealingStatsSnapshot().entries).toEqual([{ entry: entry!.entry, count: 2 }])
    } finally {
      if (before === undefined) delete process.env[name]
      else process.env[name] = before
      invalidateKnownValues()
    }
  })
})
