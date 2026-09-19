import { describe, it, expect } from 'vitest'
import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS_PER_MESSAGE,
  extractArtifactCandidates,
  extractInlineArtifacts,
  extractUploadArtifacts,
  parseFencedBlocks,
  sanitizeArtifactTitle,
  titleFromMarkup,
} from './artifact-extract.js'
import type { UploadDescriptor } from './uploads.js'

const fence = '```'
const wideFence = '````'

function upload(overrides: Partial<UploadDescriptor>): UploadDescriptor {
  return {
    kind: 'file',
    originalName: 'file.html',
    storedName: 'abc-file.html',
    relativePath: '2026/09/14/abc-file.html',
    urlPath: '/api/uploads/2026/09/14/abc-file.html',
    mimeType: 'text/html',
    size: 10,
    ...overrides,
  }
}

describe('parseFencedBlocks', () => {
  it('reads a plain fence with its info string', () => {
    const blocks = parseFencedBlocks(`before\n${fence}html Rendite\n<p>hi</p>\n${fence}\nafter`)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.language).toBe('html')
    expect(blocks[0]!.infoRest).toBe('Rendite')
    expect(blocks[0]!.body).toBe('<p>hi</p>')
  })

  it('treats a shorter fence inside a longer one as body, not as a nested block', () => {
    const text = `${wideFence}markdown\nHere is how you write it:\n${fence}html\n<p>example</p>\n${fence}\n${wideFence}`
    const blocks = parseFencedBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.language).toBe('markdown')
    expect(blocks[0]!.body).toContain('```html')
  })

  it('drops an unterminated fence instead of guessing where it ends', () => {
    expect(parseFencedBlocks(`${fence}html\n<p>truncated`)).toEqual([])
  })

  it('keeps the blocks that closed before a later fence was left open', () => {
    const blocks = parseFencedBlocks(`${fence}html\n<b>one</b>\n${fence}\ntext\n${fence}html\n<b>two`)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.body).toBe('<b>one</b>')
  })

  it('does not close a backtick fence with a tilde fence', () => {
    expect(parseFencedBlocks(`${fence}html\n<p>x</p>\n~~~`)).toEqual([])
  })

  it('accepts a longer closing fence than the opening one', () => {
    const blocks = parseFencedBlocks(`${fence}html\n<p>x</p>\n${wideFence}`)
    expect(blocks).toHaveLength(1)
  })

  it('ignores a backtick fence whose info string contains a backtick', () => {
    expect(parseFencedBlocks('```html `x`\nbody\n```')).toEqual([])
  })

  it('reads several independent blocks', () => {
    const blocks = parseFencedBlocks(`${fence}html\na\n${fence}\n${fence}svg\nb\n${fence}`)
    expect(blocks.map(b => b.language)).toEqual(['html', 'svg'])
  })
})

describe('extractInlineArtifacts', () => {
  it('turns an html fence into a candidate and keeps the raw body', () => {
    const [artifact] = extractInlineArtifacts(`Kurz gesagt: hier ist der Chart.\n\n${fence}html\n<h1>Chart</h1>\n${fence}`)
    expect(artifact).toMatchObject({
      source: 'inline_fence',
      kind: 'html',
      mimeType: 'text/html',
      body: '<h1>Chart</h1>',
    })
    expect(artifact!.size).toBe(Buffer.byteLength('<h1>Chart</h1>', 'utf8'))
  })

  it('prefers the info-string title, then <title>, then the kind', () => {
    const withInfo = extractInlineArtifacts(`${fence}html Mein Rechner\n<title>Ignoriert</title>\n${fence}`)
    expect(withInfo[0]!.title).toBe('Mein Rechner')

    const withMarkup = extractInlineArtifacts(`${fence}html\n<title>Aus dem Markup</title>\n${fence}`)
    expect(withMarkup[0]!.title).toBe('Aus dem Markup')

    const bare = extractInlineArtifacts(`${fence}html\n<p>ohne Titel</p>\n${fence}`)
    expect(bare[0]!.title).toBe('HTML artifact')
  })

  it('handles svg fences', () => {
    const [artifact] = extractInlineArtifacts(`${fence}svg Diagramm\n<svg></svg>\n${fence}`)
    expect(artifact).toMatchObject({ kind: 'svg', mimeType: 'image/svg+xml', title: 'Diagramm' })
  })

  it('ignores other languages and empty bodies', () => {
    expect(extractInlineArtifacts(`${fence}ts\nconst a = 1\n${fence}`)).toEqual([])
    expect(extractInlineArtifacts(`${fence}html\n\n${fence}`)).toEqual([])
  })

  it('finds nothing in a message without a fence', () => {
    expect(extractInlineArtifacts('Plain prose with <html> mentioned inline.')).toEqual([])
  })
})

describe('extractUploadArtifacts', () => {
  it('takes renderable uploads from the message descriptors', () => {
    const found = extractUploadArtifacts('see attachment', [
      upload({ originalName: 'report.html' }),
      upload({ relativePath: '2026/09/14/x.pdf', mimeType: 'application/pdf', originalName: 'x.pdf' }),
    ])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ source: 'upload', kind: 'html', title: 'report.html' })
  })

  it('finds /api/uploads links in the text', () => {
    const found = extractUploadArtifacts('Chart: /api/uploads/2026/09/14/plot.svg done')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'svg', relativePath: '2026/09/14/plot.svg' })
  })

  it('does not list the same upload twice', () => {
    const found = extractUploadArtifacts(
      'here /api/uploads/2026/09/14/abc-file.html',
      [upload({})],
    )
    expect(found).toHaveLength(1)
  })

  it('refuses a traversal path', () => {
    expect(extractUploadArtifacts('/api/uploads/../../etc/passwd.html')).toEqual([])
  })
})

describe('extractArtifactCandidates', () => {
  it('lists uploads before inline fences (SPEC order of preference)', () => {
    const candidates = extractArtifactCandidates(
      `Summary.\n/api/uploads/2026/09/14/a.html\n${fence}html\n<p>inline</p>\n${fence}`,
    )
    expect(candidates.map(c => c.source)).toEqual(['upload', 'inline_fence'])
  })

  it('caps the number of artifacts per message', () => {
    const many = Array.from({ length: 9 }, (_, i) => `${fence}html\n<p>${i}</p>\n${fence}`).join('\n')
    expect(extractArtifactCandidates(many)).toHaveLength(MAX_ARTIFACTS_PER_MESSAGE)
  })

  it('reports the size of an oversized block instead of hiding it', () => {
    const big = 'x'.repeat(MAX_ARTIFACT_BYTES + 1)
    const [candidate] = extractArtifactCandidates(`${fence}html\n${big}\n${fence}`)
    expect(candidate!.source).toBe('inline_fence')
    expect((candidate as { size: number }).size).toBeGreaterThan(MAX_ARTIFACT_BYTES)
  })
})

describe('title helpers', () => {
  it('collapses whitespace, strips control characters and cuts long titles', () => {
    expect(sanitizeArtifactTitle('  a\n\tb  ', 'fallback')).toBe('a b')
    expect(sanitizeArtifactTitle('', 'fallback')).toBe('fallback')
    expect(sanitizeArtifactTitle('x'.repeat(500), 'fallback')).toHaveLength(120)
  })

  it('reads <title> and falls back to <h1>', () => {
    expect(titleFromMarkup('<title>A</title>')).toBe('A')
    expect(titleFromMarkup('<h1>B</h1>')).toBe('B')
    expect(titleFromMarkup('<p>none</p>')).toBeNull()
  })
})
