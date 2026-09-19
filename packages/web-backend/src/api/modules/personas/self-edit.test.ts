/**
 * SPEC 13.7, the invariant that is not negotiable: **a persona may propose a
 * change to a persona, it never applies one.**
 *
 * Persona files are prompt injection surface and they carry tool access. A
 * system in which an agent can widen its own permissions after reading a web
 * page is not a system, it is an incident waiting for a date. So the write
 * path must be reachable from an authenticated admin HTTP request and from
 * nowhere else — in particular not from anything the agent runtime can call.
 *
 * Two tests, because the invariant has two halves:
 *  1. structural — the agent runtime package does not, and must not, import
 *     the persona write path or reach it over HTTP;
 *  2. behavioural — the routes themselves reject anything that is not an
 *     authenticated admin (covered in depth in route.test.ts, asserted here
 *     for the write verbs so this file fails on its own if the gate is ever
 *     loosened).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../../../../..')
const CORE_SRC = path.join(REPO_ROOT, 'packages/core/src')
const TELEGRAM_SRC = path.join(REPO_ROOT, 'packages/telegram/src')

/** Every .ts file of a package, tests included — a test tool is still a tool. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(full)
      } else if (entry.name.endsWith('.ts')) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out
}

/**
 * The write surface of the persona module. Reading is fine — the runtime has
 * to load a persona to be one — so only the functions that CHANGE a persona
 * are listed here.
 */
const WRITE_SYMBOLS = [
  'createPersonasService',
  'createPersonasRouter',
  'updatePersonaRecord',
  'deletePersonaRecord',
  'applyPersonaFields',
]

describe('a persona cannot edit a persona (SPEC 13.7)', () => {
  it('keeps the persona write path out of the agent runtime', () => {
    const offenders: string[] = []

    for (const file of [...sourceFiles(CORE_SRC), ...sourceFiles(TELEGRAM_SRC)]) {
      const content = fs.readFileSync(file, 'utf-8')
      const relative = path.relative(REPO_ROOT, file)

      // The module itself is defined in core (persona-store, persona-fields),
      // and the package barrel re-exports it for the web backend. Both are the
      // package boundary, not a path an agent can call: a tool is reachable
      // only if some tool definition invokes the function, and neither of
      // these does.
      const isOwnModule = /persona-(store|fields)(\.test)?\.ts$/.test(file)
        || /packages\/core\/src\/index\.ts$/.test(relative)

      if (content.includes('api/modules/personas')) {
        offenders.push(`${relative}: imports the persona API module`)
      }
      if (/['"`]\/api\/personas/.test(content)) {
        offenders.push(`${relative}: calls the persona API over HTTP`)
      }
      if (!isOwnModule) {
        for (const symbol of WRITE_SYMBOLS) {
          // A tool definition is what makes a function reachable for an agent,
          // so the symbol appearing anywhere in the runtime package is enough
          // to fail: there is no legitimate reason for it to be there.
          if (new RegExp(`\\b${symbol}\\b`).test(content)) {
            offenders.push(`${relative}: references ${symbol}`)
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('registers no agent tool whose name suggests persona editing', () => {
    // Tool names are declared as `name: 'x'` in the tool factories. A tool
    // called anything like `edit_persona` would be the obvious way to break
    // this invariant by accident.
    const forbidden = /name:\s*['"`]([a-z][a-z0-9_]*persona[a-z0-9_]*)['"`]/g
    const found: string[] = []

    for (const file of sourceFiles(CORE_SRC)) {
      // Tool names are declared in the factories, never in a test fixture.
      if (file.endsWith('.test.ts')) continue
      const content = fs.readFileSync(file, 'utf-8')
      for (const match of content.matchAll(forbidden)) {
        const toolName = match[1] as string
        if (/persona/i.test(toolName)) found.push(`${path.relative(REPO_ROOT, file)}: ${toolName}`)
      }
    }

    expect(found).toEqual([])
  })

  it('serves the persona write path behind an admin gate only', () => {
    // Read the route module as source: the gate must be visible and
    // unconditional, not a runtime detail that a refactor can drop silently.
    const routeSource = fs.readFileSync(path.join(HERE, 'route.ts'), 'utf-8')
    expect(routeSource).toContain('router.use(jwtMiddleware)')
    expect(routeSource).toContain("req.user?.role !== 'admin'")
    // The gate is installed before any handler is mounted.
    expect(routeSource.indexOf('router.use(jwtMiddleware)')).toBeLessThan(routeSource.indexOf("router.get('/'"))
    expect(routeSource.indexOf("req.user?.role !== 'admin'")).toBeLessThan(routeSource.indexOf("router.post('/'"))
  })
})
