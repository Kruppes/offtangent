import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_CODE_VERSION } from './provider-config.js'

/**
 * Locate the installed pi-ai package directory by walking up from this test
 * file looking for `node_modules/@earendil-works/pi-ai`. `require.resolve`
 * cannot reach the internal dist file because pi-ai's `exports` map only
 * declares `import`-condition subpaths, which the CJS resolver rejects.
 */
function findPiAiDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-ai')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('Could not locate @earendil-works/pi-ai under any node_modules directory')
}

/**
 * Drift guard for Bug A (Fable 5.1 rejected with HTTP 400
 * `claude_code_version_too_old`).
 *
 * pi-ai's anthropic-messages transport hardcodes its own `claudeCodeVersion`
 * and sends it as the `claude-cli/<version>` user-agent for OAuth requests.
 * Our fork overrides that user-agent from `CLAUDE_CODE_VERSION` in
 * provider-config.ts (buildModel + anthropic-quota.ts). If our constant lags
 * behind pi-ai after a dependency bump, Anthropic rejects the request.
 *
 * pi-ai does NOT export `claudeCodeVersion` (it is a module-local const), so
 * we cannot import it. Instead we read the installed package's compiled source
 * and extract the string, failing the build the moment the two drift apart.
 */
describe('CLAUDE_CODE_VERSION sync with pi-ai', () => {
  it('matches the claudeCodeVersion hardcoded in the installed pi-ai package', () => {
    const anthropicMessagesPath = path.join(
      findPiAiDir(),
      'dist',
      'api',
      'anthropic-messages.js',
    )
    const source = fs.readFileSync(anthropicMessagesPath, 'utf-8')

    // Matches: const claudeCodeVersion = "2.1.251";  (single or double quotes)
    const match = source.match(/claudeCodeVersion\s*=\s*['"]([^'"]+)['"]/)
    expect(
      match,
      'Could not find `claudeCodeVersion = "..."` in pi-ai anthropic-messages.js. ' +
        'pi-ai may have renamed/moved it — re-verify the sync manually.',
    ).not.toBeNull()

    const piAiVersion = match![1]
    expect(
      CLAUDE_CODE_VERSION,
      `CLAUDE_CODE_VERSION (${CLAUDE_CODE_VERSION}) drifted from pi-ai claudeCodeVersion (${piAiVersion}). ` +
        'Bump CLAUDE_CODE_VERSION in provider-config.ts to match after a pi-ai upgrade.',
    ).toBe(piAiVersion)
  })
})
