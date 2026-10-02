/** W6b: the sidebar version line with the build commit (synthetic values). */
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import AppVersionLabel from './AppVersionLabel.vue'

async function render(props: { version: string; buildSha?: string }): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(AppVersionLabel, props) }))
}

describe('AppVersionLabel', () => {
  it('shows version and the 7-char commit', async () => {
    const html = await render({ version: '0.30.0', buildSha: 'abcdef0123456789abcdef0123456789abcdef01' })
    expect(html).toContain('v0.30.0 · abcdef0')
    expect(html).toContain('data-build-sha="abcdef0"')
    expect(html).toContain('data-testid="app-version"')
  })
  it('shows only the version without a commit', async () => {
    const html = await render({ version: '0.30.0', buildSha: '' })
    expect(html).toMatch(/>\s*v0\.30\.0\s*</)
    expect(html).not.toContain('·')
    expect(html).not.toContain('data-build-sha')
  })
  it('drops an invalid commit instead of printing it', async () => {
    const html = await render({ version: '0.30.0', buildSha: 'unknown' })
    expect(html).toMatch(/>\s*v0\.30\.0\s*</)
    expect(html).not.toContain('unknown')
  })
})
