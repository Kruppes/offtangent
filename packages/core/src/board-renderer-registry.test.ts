/**
 * The renderer lookup is the one place where a model chosen string (`kind`)
 * becomes a file path, so the traversal cases are tested first, and the data
 * injection is tested with a payload that tries to close the script element.
 *
 * Fixtures are synthetic and live in a temp directory, never under DATA_DIR.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BOARD_DATA_SCRIPT_ID,
  BOARD_RENDERER_MAX_BYTES,
  boardRendererPath,
  boardRenderersDir,
  encodeBoardDataJson,
  hasBoardRenderer,
  injectBoardData,
  readBoardRenderer,
  type BoardRendererData,
} from './board-renderer-registry.js'

let dir: string
let previousDataDir: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-renderers-'))
  previousDataDir = process.env.DATA_DIR
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
})

const data: BoardRendererData = {
  key: 'demo',
  kind: 'demo_list.v1',
  title: 'Demo list',
  revision: 3,
  as_of: '2026-09-28T06:00:00Z',
  summary: 'Two entries.',
  payload: { items: ['Alice', 'Bob'] },
}

describe('boardRenderersDir', () => {
  it('sits under DATA_DIR', () => {
    process.env.DATA_DIR = '/tmp/example-data'
    expect(boardRenderersDir()).toBe('/tmp/example-data/board-renderers')
  })

  it('falls back to /data like every other store', () => {
    delete process.env.DATA_DIR
    expect(boardRenderersDir()).toBe('/data/board-renderers')
  })
})

describe('boardRendererPath', () => {
  it('maps a valid kind to one file in the directory', () => {
    expect(boardRendererPath('demo_list.v1', dir)).toBe(path.join(dir, 'demo_list.v1.html'))
  })

  it.each([
    '../secrets.v1',
    '../../etc/passwd',
    'demo/../../escape.v1',
    'sub/demo.v1',
    'sub\\demo.v1',
    '/etc/passwd',
    'demo.v1/../../../root.v1',
    'demo',
    'demo.v',
    'Demo.v1',
    'demo.v1 ',
    '.',
    '..',
    '',
  ])('refuses %j', kind => {
    expect(boardRendererPath(kind, dir)).toBeNull()
    expect(hasBoardRenderer(kind, dir)).toBe(false)
    expect(readBoardRenderer(kind, dir)).toBeNull()
  })

  it('refuses a non-string and an absurdly long kind', () => {
    expect(boardRendererPath(undefined, dir)).toBeNull()
    expect(boardRendererPath(42, dir)).toBeNull()
    expect(boardRendererPath(`${'a'.repeat(200)}.v1`, dir)).toBeNull()
  })
})

describe('readBoardRenderer', () => {
  it('returns null when no renderer exists for the kind', () => {
    expect(readBoardRenderer('demo_list.v1', dir)).toBeNull()
    expect(hasBoardRenderer('demo_list.v1', dir)).toBe(false)
  })

  it('reads the file of a kind that has one', () => {
    fs.writeFileSync(path.join(dir, 'demo_list.v1.html'), '<!doctype html><html><head></head><body></body></html>')
    expect(hasBoardRenderer('demo_list.v1', dir)).toBe(true)
    expect(readBoardRenderer('demo_list.v1', dir)?.html).toContain('<body>')
  })

  it('picks up a file written after the first miss, without any cache to clear', () => {
    expect(readBoardRenderer('demo_list.v1', dir)).toBeNull()
    fs.writeFileSync(path.join(dir, 'demo_list.v1.html'), '<p>first</p>')
    expect(readBoardRenderer('demo_list.v1', dir)?.html).toBe('<p>first</p>')
    fs.writeFileSync(path.join(dir, 'demo_list.v1.html'), '<p>second</p>')
    expect(readBoardRenderer('demo_list.v1', dir)?.html).toBe('<p>second</p>')
  })

  it('never follows a symlink out of the directory', () => {
    const secret = path.join(dir, 'secret.txt')
    fs.writeFileSync(secret, 'TOP SECRET')
    fs.symlinkSync(secret, path.join(dir, 'demo_list.v1.html'))
    expect(hasBoardRenderer('demo_list.v1', dir)).toBe(false)
    expect(readBoardRenderer('demo_list.v1', dir)).toBeNull()
  })

  it('ignores a directory that carries the renderer name', () => {
    fs.mkdirSync(path.join(dir, 'demo_list.v1.html'))
    expect(readBoardRenderer('demo_list.v1', dir)).toBeNull()
  })

  it('ignores a renderer above the size limit', () => {
    fs.writeFileSync(path.join(dir, 'demo_list.v1.html'), 'x'.repeat(BOARD_RENDERER_MAX_BYTES + 1))
    expect(hasBoardRenderer('demo_list.v1', dir)).toBe(false)
    expect(readBoardRenderer('demo_list.v1', dir)).toBeNull()
  })

  it('accepts a renderer at exactly the size limit', () => {
    fs.writeFileSync(path.join(dir, 'demo_list.v1.html'), 'x'.repeat(BOARD_RENDERER_MAX_BYTES))
    expect(readBoardRenderer('demo_list.v1', dir)?.html.length).toBe(BOARD_RENDERER_MAX_BYTES)
  })

  it('defaults to <DATA_DIR>/board-renderers', () => {
    process.env.DATA_DIR = dir
    fs.mkdirSync(path.join(dir, 'board-renderers'))
    fs.writeFileSync(path.join(dir, 'board-renderers', 'demo_list.v1.html'), '<p>from data dir</p>')
    expect(readBoardRenderer('demo_list.v1')?.html).toBe('<p>from data dir</p>')
  })
})

describe('encodeBoardDataJson', () => {
  it('escapes every character that could leave the script element', () => {
    const encoded = encodeBoardDataJson({ text: '</script><script>alert(1)</script>', amp: '&' })
    expect(encoded).not.toContain('<')
    expect(encoded).not.toContain('>')
    expect(encoded).not.toContain('&')
    expect(encoded).toContain('\\u003c')
    expect(JSON.parse(encoded)).toEqual({ text: '</script><script>alert(1)</script>', amp: '&' })
  })

  it('escapes U+2028 and U+2029', () => {
    const encoded = encodeBoardDataJson({ text: 'a\u2028b\u2029c' })
    expect(encoded).not.toContain('\u2028')
    expect(encoded).not.toContain('\u2029')
    expect(JSON.parse(encoded)).toEqual({ text: 'a\u2028b\u2029c' })
  })
})

describe('injectBoardData', () => {
  it('inserts the data island before </head>', () => {
    const html = '<!doctype html><html><head><title>T</title></head><body>x</body></html>'
    const rendered = injectBoardData(html, data)
    expect(rendered).toContain(`<script type="application/json" id="${BOARD_DATA_SCRIPT_ID}">`)
    expect(rendered.indexOf('id="board-data"')).toBeLessThan(rendered.indexOf('</head>'))
    expect(rendered.indexOf('<title>')).toBeLessThan(rendered.indexOf('id="board-data"'))
  })

  it('keeps the rest of the document byte identical', () => {
    const html = '<!doctype html><html><head></head><body><p>unchanged</p></body></html>'
    const rendered = injectBoardData(html, data)
    const island = /<script type="application\/json" id="board-data">.*?<\/script>/s.exec(rendered)
    expect(island).not.toBeNull()
    expect(rendered.replace(island![0], '')).toBe(html)
  })

  it('round trips the board state a renderer reads', () => {
    const rendered = injectBoardData('<html><head></head><body></body></html>', data)
    const json = /id="board-data">(.*?)<\/script>/s.exec(rendered)![1]
    expect(JSON.parse(json)).toEqual({
      key: 'demo',
      kind: 'demo_list.v1',
      title: 'Demo list',
      revision: 3,
      as_of: '2026-09-28T06:00:00Z',
      summary: 'Two entries.',
      payload: { items: ['Alice', 'Bob'] },
    })
  })

  it('cannot be broken out of by a payload that closes the script element', () => {
    const hostile: BoardRendererData = {
      ...data,
      summary: '</script><script>alert(1)</script>',
      payload: { note: '</ScRiPt ><img src=x onerror=alert(2)>', sep: 'a\u2028b' },
    }
    const rendered = injectBoardData('<html><head></head><body></body></html>', hostile)
    // Exactly one script element, and it is the data island: the payload text
    // survives as data (`alert(1)` as characters), but no `<` of it is raw, so
    // it can never become markup.
    expect(rendered.match(/<script/gi)?.length).toBe(1)
    expect(rendered.match(/<\/script/gi)?.length).toBe(1)
    expect(rendered).not.toContain('<script>alert(1)')
    expect(rendered).not.toContain('<img src=x onerror=alert(2)>')
    const json = /id="board-data">(.*?)<\/script>/s.exec(rendered)![1]
    expect(JSON.parse(json).summary).toBe('</script><script>alert(1)</script>')
    expect(JSON.parse(json).payload.sep).toBe('a\u2028b')
  })

  it('places the island after the doctype when there is no head', () => {
    const rendered = injectBoardData('<!doctype html><body>x</body>', data)
    expect(rendered.startsWith('<!doctype html><script type="application/json"')).toBe(true)
  })

  it('places the island after <html> when there is no head', () => {
    const rendered = injectBoardData('<!doctype html><html><body>x</body></html>', data)
    expect(rendered.startsWith('<!doctype html><html><script type="application/json"')).toBe(true)
  })

  it('places the island at the start of a fragment', () => {
    const rendered = injectBoardData('<p>fragment</p>', data)
    expect(rendered.startsWith('<script type="application/json"')).toBe(true)
    expect(rendered.endsWith('<p>fragment</p>')).toBe(true)
  })
})
