/**
 * What a persisted outgoing file actually renders as.
 *
 * The chain under test is the one a page reload takes: a `chat_messages` row
 * whose `metadata` holds `{"files":[…]}` → `mapHistoryRows` → the same
 * `ChatAttachments` component the incoming (user) side uses. No browser exists
 * in the build sandbox, so the component goes through Vue's SSR renderer: real
 * SFC compilation, real props, real template logic, real HTML.
 *
 * Run: npx vitest run --config packages/web-frontend/vitest.render.config.ts
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h, ref, computed } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ChatAttachments from './ChatAttachments.vue'
import { mapHistoryRows, type ChatHistoryRow } from '~/composables/useChat'

const globals = globalThis as Record<string, unknown>
globals.ref = ref
globals.computed = computed
globals.useRuntimeConfig = () => ({ public: { apiBase: 'https://ot.example' } })
globals.useAuth = () => ({ getAccessToken: () => 'jwt-token' })

const IconStub = defineComponent({
  props: { name: { type: String, default: '' } },
  setup: props => () => h('i', { 'data-icon': props.name }),
})

async function render(attachments: unknown[]): Promise<string> {
  const app = createSSRApp(ChatAttachments, { attachments })
  app.component('AppIcon', IconStub)
  app.config.globalProperties.$t = (key: string) => key
  return await renderToString(app)
}

/** Exactly what `serializeUploadsMetadata` writes for an agent-sent file. */
const APK_ROW: ChatHistoryRow = {
  id: 89648,
  role: 'assistant',
  content: '',
  metadata: JSON.stringify({
    files: [{
      kind: 'file',
      originalName: 'offtangent-0.9.1-cards.apk',
      storedName: '7a0cf020e89c798a8f13a866-offtangent-0.9.1-cards.apk',
      relativePath: '2026/09/15/7a0cf020e89c798a8f13a866-offtangent-0.9.1-cards.apk',
      urlPath: '/api/uploads/2026/09/15/7a0cf020e89c798a8f13a866-offtangent-0.9.1-cards.apk',
      mimeType: 'application/octet-stream',
      size: 5_459_816,
      caption: 'Offtangent 0.9.1',
    }],
  }),
  timestamp: '2026-09-15T08:39:48.000Z',
  session_id: 'strand-1',
}

describe('an outgoing file rendered from history', () => {
  it('becomes a download card with name, size and a tokenised url', async () => {
    const [message] = mapHistoryRows([APK_ROW])
    expect(message!.attachments).toHaveLength(1)

    const html = await render(message!.attachments!)

    expect(html).toContain('offtangent-0.9.1-cards.apk')
    expect(html).toContain('5.2 MB')
    expect(html).toContain(
      'https://ot.example/api/uploads/2026/09/15/7a0cf020e89c798a8f13a866-offtangent-0.9.1-cards.apk?download=1&amp;token=jwt-token',
    )
    expect(html).toContain('data-icon="download"')
  })

  it('renders an agent-sent image the same way an uploaded one renders', async () => {
    const image = {
      kind: 'image',
      originalName: 'shot.png',
      storedName: 'def-shot.png',
      relativePath: '2026/09/15/def-shot.png',
      urlPath: '/api/uploads/2026/09/15/def-shot.png',
      mimeType: 'image/png',
      size: 2048,
    }

    const html = await render([image])

    expect(html).toContain('<img')
    expect(html).toContain('https://ot.example/api/uploads/2026/09/15/def-shot.png?token=jwt-token')
    expect(html).toContain('alt="shot.png"')
  })

  it('renders nothing at all for a message without files', async () => {
    const [message] = mapHistoryRows([{ ...APK_ROW, metadata: undefined }])
    expect(message!.attachments).toEqual([])
    expect(await render(message!.attachments!)).toBe('<!---->')
  })
})
