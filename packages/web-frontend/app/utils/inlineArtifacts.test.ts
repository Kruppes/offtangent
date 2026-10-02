import { describe, expect, it } from 'vitest'
import { parseFencedBlocks } from '@axiom/core'
import { inlineArtifactCount, nextFrameState, splitArtifactFences, visibleArtifacts } from './inlineArtifacts'

const FENCE = '```'

describe('splitArtifactFences', () => {
  const content = [
    'Here is the chart:',
    '',
    `${FENCE}html Sample chart`,
    '<p>one</p>',
    FENCE,
    '',
    'And a code sample:',
    `${FENCE}ts`,
    'const x = 1',
    FENCE,
    '',
    `${FENCE}svg`,
    '<svg><circle r="4"/></svg>',
    FENCE,
    'Done.',
  ].join('\n')

  it('cuts exactly the html/svg fences that became artifacts and keeps everything else', () => {
    const split = splitArtifactFences(content, 2)
    expect(split.fences).toEqual([
      { language: 'html', body: '<p>one</p>' },
      { language: 'svg', body: '<svg><circle r="4"/></svg>' },
    ])
    expect(split.text).not.toContain('<p>one</p>')
    expect(split.text).not.toContain('<svg>')
    expect(split.text).toContain('const x = 1')
    expect(split.text).toContain('Here is the chart:')
    expect(split.text).toContain('Done.')
    expect(split.text).not.toMatch(/\n{3,}/)
  })

  it('cuts nothing when the counts disagree (a block was skipped server side)', () => {
    expect(splitArtifactFences(content, 1)).toEqual({ text: content, fences: [] })
    expect(splitArtifactFences(content, 3)).toEqual({ text: content, fences: [] })
  })

  it('cuts nothing without inline artifacts', () => {
    expect(splitArtifactFences(content, 0)).toEqual({ text: content, fences: [] })
    expect(splitArtifactFences('', 2)).toEqual({ text: '', fences: [] })
  })

  it('ignores empty, unterminated and nested fences like the server does', () => {
    const tricky = [
      `${FENCE}html`, '   ', FENCE,
      '````md', `${FENCE}html`, '<b>demo</b>', FENCE, '````',
      `${FENCE}html`, '<i>real</i>', FENCE,
      `${FENCE}svg`, '<svg/>',
    ].join('\n')
    const split = splitArtifactFences(tricky, 1)
    expect(split.fences).toEqual([{ language: 'html', body: '<i>real</i>' }])
    expect(split.text).toContain('<b>demo</b>')
    expect(split.text).toContain('<svg/>')
  })

  it('agrees with the server parser on which fences are eligible', () => {
    const fixtures = [content, '~~~svg\n<svg/>\n~~~', '```html\n<a>\n```\n```HTML x\n<b>\n```', '``` html\n<x>\n```']
    for (const fixture of fixtures) {
      const server = parseFencedBlocks(fixture).filter(b => (b.language === 'html' || b.language === 'svg') && b.body.trim())
      const client = splitArtifactFences(fixture, server.length).fences
      expect(client.map(f => f.body)).toEqual(server.map(b => b.body))
    }
  })
})

describe('inlineArtifactCount', () => {
  it('counts only inline fences', () => {
    expect(inlineArtifactCount([{ kind: 'html', title: 'a', source: 'inline_fence' }, { kind: 'png', title: 'b', source: 'upload' }])).toBe(1)
    expect(inlineArtifactCount(undefined)).toBe(0)
  })
})

describe('visibleArtifacts', () => {
  const image = { kind: 'png', title: 'photo 1.png', source: 'upload' }
  it('drops an uploaded image that is already an image attachment', () => {
    expect(visibleArtifacts([image], [{ kind: 'image', originalName: 'Photo  1.png' }])).toEqual([])
  })
  it('keeps the image when it is not attached, is a living view, or the attachment is a file', () => {
    expect(visibleArtifacts([image], [])).toEqual([image])
    expect(visibleArtifacts([image], [{ kind: 'file', originalName: 'photo 1.png' }])).toEqual([image])
    const view = { ...image, viewKey: 'chart' }
    expect(visibleArtifacts([view], [{ kind: 'image', originalName: 'photo 1.png' }])).toEqual([view])
  })
  it('never drops html or svg', () => {
    const html = { kind: 'html', title: 'photo 1.png', source: 'upload' }
    expect(visibleArtifacts([html], [{ kind: 'image', originalName: 'photo 1.png' }])).toEqual([html])
  })
})

describe('nextFrameState (lazy window)', () => {
  it('mounts when near, stays mounted inside the keep zone, parks when far, remounts when near again', () => {
    expect(nextFrameState('idle', false, false)).toBe('idle')
    expect(nextFrameState('idle', false, true)).toBe('idle')
    expect(nextFrameState('idle', true, true)).toBe('active')
    expect(nextFrameState('active', false, true)).toBe('active')
    expect(nextFrameState('active', false, false)).toBe('parked')
    expect(nextFrameState('parked', false, true)).toBe('parked')
    expect(nextFrameState('parked', true, true)).toBe('active')
  })
})
