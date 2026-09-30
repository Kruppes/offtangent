/**
 * Screenshot helper for the /connectors page.
 *
 *   SHOT_DIR=/tmp/shots/html npx vitest run \
 *     packages/web-frontend/app/features/connectors/components/connectorsShots.render.spec.ts
 *   node scripts/connectors-shots.mjs /tmp/shots/png
 *
 * Step one renders the documented page states to static HTML, step two styles
 * them with the app's real Tailwind theme and photographs each state dark and
 * light, at a phone width and at desktop width. `SHOT_VIEWPORTS` overrides the
 * widths as a comma separated `name:width` list, e.g. `phone:390,desktop:1440`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { compile } from '@tailwindcss/node'
import { chromium } from 'playwright'

const repo = path.resolve(import.meta.dirname, '..')
const htmlDir = process.env.SHOT_DIR ?? path.join(repo, '.shots/html')
const outDir = process.argv[2] ?? path.join(repo, '.shots/png')
const cssPath = path.join(repo, 'packages/web-frontend/app/assets/css/tailwind.css')

const fixtures = fs.readdirSync(htmlDir).filter(name => name.endsWith('.html'))
const bodies = Object.fromEntries(fixtures.map(name => [name, fs.readFileSync(path.join(htmlDir, name), 'utf8')]))

// Tailwind 4 needs the candidate list; take every class token of every fixture.
const candidates = new Set()
for (const body of Object.values(bodies)) {
  for (const match of body.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) candidates.add(token)
  }
}
for (const extra of ['dark', 'font-sans', 'antialiased', 'bg-background', 'text-foreground', 'min-h-screen']) candidates.add(extra)

const compiler = await compile(fs.readFileSync(cssPath, 'utf8'), {
  base: path.dirname(cssPath),
  onDependency: () => {},
})
const css = compiler.build([...candidates])
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'connectors.css'), css)

const viewports = process.env.SHOT_VIEWPORTS
  ? process.env.SHOT_VIEWPORTS.split(',').map(entry => {
    const [name, width] = entry.split(':')
    return { name, width: Number(width), height: 900 }
  })
  : [
    { name: 'mobile360', width: 360, height: 900 },
    { name: 'desktop', width: 1280, height: 900 },
  ]
const themes = ['dark', 'light']

const browser = await chromium.launch()
const written = []
for (const [name, body] of Object.entries(bodies)) {
  const base = name.replace(/\.html$/, '')
  for (const theme of themes) {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 2 })
      await page.setContent(`<!doctype html><html lang="de" class="${theme === 'dark' ? 'dark' : ''}"><head><meta charset="utf-8"><style>${css}</style></head><body class="font-sans antialiased bg-background text-foreground"><div style="min-height:100vh">${body}</div></body></html>`, { waitUntil: 'load' })
      const file = path.join(outDir, `${base}.${theme}.${viewport.name}.png`)
      await page.screenshot({ path: file, fullPage: true })
      written.push(file)
      await page.close()
    }
  }
}
await browser.close()
console.log(`${written.length} screenshots written to ${outDir}`)
