import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import TranscriptState from './TranscriptState.vue'
import ToolActivityGroup from './ToolActivityGroup.vue'
import type { ChatMessage } from '../../composables/useChat'

async function render(tools: ChatMessage[]) {
  const app = createSSRApp({ render: () => h(ToolActivityGroup, { tools }, { default: ({ msg }: { msg: ChatMessage }) => h('details', [h('summary', msg.toolData!.toolName), h('pre', String(msg.toolData!.toolResult ?? ''))]) }) })
  app.config.globalProperties.$t = (key: string, ...args: unknown[]) => `${key}${args[0] && typeof args[0] === 'object' && 'count' in args[0] ? ` ${args[0].count}` : ''}`
  return renderToString(app)
}
describe('tool group markup', () => {
  it('starts collapsed and exposes expandable results with error and success states', async () => {
    const html = await render([
      { role: 'tool', content: '', toolData: { toolName: 'shell', toolCallId: 'a', toolResult: '<output>' } },
      { role: 'tool', content: '', toolData: { toolName: 'read_file', toolCallId: 'b', toolIsError: true, toolResult: 'denied' } },
    ])
    expect(html).toContain('data-tool-group')
    expect(html).not.toContain(' open')
    expect(html).toContain('w4Content.toolCalls 2')
    expect(html).toContain('w4Content.errors 1')
    expect(html).toContain('data-tool-state="error"')
    expect(html).toContain('data-tool-state="complete"')
    expect(html).toContain('&lt;output&gt;')
  })
  it('does not label a missing historical result as running', async () => {
    const html = await render([{ id: 7, role: 'tool', content: '', toolData: { toolName: 'shell', toolCallId: '' } }])
    expect(html).toContain('w4Content.unknown')
    expect(html).not.toContain('w4Content.running')
  })
  it('shows running status and elapsed seconds on a live call', async () => {
    const html = await render([{ role: 'tool', content: '', timestamp: new Date(Date.now() - 5000).toISOString(), toolData: { toolName: 'shell', toolCallId: 'a' } }])
    expect(html).toContain('w4Content.running 1')
    expect(html).toContain('5s')
  })
})


describe('transcript states', () => {
  it.each(['error', 'loading', 'empty', 'ready'] as const)('renders %s without leaking other states or stale messages', async state => {
    const app = createSSRApp({ render: () => h(TranscriptState, { state }, { default: () => h('p', 'Visible answer') }) })
    app.config.globalProperties.$t = (key: string) => key
    const html = await renderToString(app)
    if (state === 'ready') {
      expect(html).toContain('Visible answer')
      expect(html).not.toContain('data-transcript-state')
    } else {
      expect(html).toContain(`data-transcript-state="${state}"`)
      expect(html).not.toContain('Visible answer')
    }
    if (state === 'error') expect(html).toContain('role="alert"')
    if (state === 'loading') expect(html).toContain('role="status"')
    if (state === 'empty') expect(html).toContain('chat.noMessages')
  })
})
