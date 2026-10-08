/**
 * Stall row rendering (plan 2026-10-09-provider-silence), synthetic values.
 * Historical rows keep their stored text (e.g. "Provider recovered after 45s
 * of silence"); the row must show the neutral i18n label derived from
 * stallInfo instead, without a DB migration.
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ChatStatusRow from './ChatStatusRow.vue'
import type { ChatMessage, ChatStallInfo } from '~/composables/useChat'

async function render(stallInfo: ChatStallInfo, content: string): Promise<string> {
  const msg = { id: 1, role: 'system', content, timestamp: '2026-01-01T00:00:45.000Z', stallInfo } as unknown as ChatMessage
  const app = createSSRApp({ render: () => h(ChatStatusRow, { msg }) })
  app.config.globalProperties.$t = (key: string) => `[${key}]`
  app.component('AppIcon', { props: ['name'], render(this: { name: string }) { return h('i', { 'data-icon': this.name }) } })
  return renderToString(app)
}

const base: ChatStallInfo = { messageId: 1, startedAt: '2026-01-01T00:00:00.000Z', durationMs: 45_000 }

describe('ChatStatusRow stall notice', () => {
  it('relabels a stored "recovered" row neutrally instead of showing the outage text', async () => {
    const html = await render({ ...base, outcome: 'recovered', resolvedAt: '2026-01-01T00:00:45.000Z' }, '\u2705 Provider recovered after 45s of silence')
    expect(html).toContain('[chat.stall.recovered]')
    expect(html).not.toContain('Provider recovered')
    expect(html).not.toContain('border-destructive')
    expect(html).not.toContain('border-success')
    expect(html).toContain('data-icon="play"')
    expect(html).toContain('45s')
  })

  it('keeps the failure styling for an explicit watchdog abort', async () => {
    const html = await render({ ...base, durationMs: 90_000, outcome: 'aborted' }, 'stored text')
    expect(html).toContain('[chat.stall.aborted]')
    expect(html).toContain('border-destructive')
    expect(html).toContain('data-icon="warning"')
  })

  it('shows the backend text for a native first-token wait', async () => {
    const html = await render({ ...base, phase: 'first_token' }, 'Local model is still processing the prompt')
    expect(html).toContain('Local model is still processing the prompt')
    expect(html).not.toContain('[chat.stall.')
  })
})
