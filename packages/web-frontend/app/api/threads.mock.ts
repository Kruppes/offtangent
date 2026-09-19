import type {
  CreateThreadPayload,
  Thread,
  ThreadListQuery,
  ThreadsApi,
  UpdateThreadPayload,
} from '~/api/threads'
import type { SessionActivity } from '~/composables/useChat'

/**
 * In-memory threads backend for demoing and screenshotting the inbox without a
 * running web-backend. Enabled only when `NUXT_PUBLIC_THREADS_MOCK=1` is set at
 * build/dev time (see `nuxt.config.ts`), so a normal production build never
 * reaches this module's data.
 */

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function thread(overrides: Partial<Thread> & Pick<Thread, 'id' | 'agentId'>): Thread {
  return {
    title: null,
    pinned: false,
    archived: false,
    startedAt: minutesAgo(600),
    lastActivity: minutesAgo(60),
    endedAt: null,
    messageCount: 12,
    lastMessage: null,
    active: false,
    ...overrides,
  }
}

function seedThreads(): Thread[] {
  return [
    thread({
      id: 'sess-roof-offer',
      agentId: 'bob',
      title: 'Roof offer comparison',
      pinned: true,
      startedAt: minutesAgo(2880),
      lastActivity: minutesAgo(3),
      messageCount: 64,
      active: true,
      lastMessage: {
        role: 'assistant',
        content: 'Emig-Strauss is 2.5k cheaper but the scaffolding line item is missing. I pulled both PDFs into a table so you can compare row by row.',
        timestamp: minutesAgo(3),
      },
    }),
    thread({
      id: 'sess-offtangent-stufe1',
      agentId: 'bob',
      title: 'Offtangent Stufe 1',
      pinned: true,
      startedAt: minutesAgo(420),
      lastActivity: minutesAgo(11),
      messageCount: 128,
      lastMessage: {
        role: 'user',
        content: 'Split the work into two waves so backend and frontend can run in parallel.',
        timestamp: minutesAgo(11),
      },
    }),
    thread({
      id: 'sess-portfolio-review',
      agentId: 'warren',
      title: 'Portfolio review September',
      startedAt: minutesAgo(1500),
      lastActivity: minutesAgo(26),
      messageCount: 41,
      lastMessage: {
        role: 'assistant',
        content: 'Cash position is at 8.4%. Two of the five semis names carry the whole drawdown, the rest is noise.',
        timestamp: minutesAgo(26),
      },
    }),
    thread({
      id: 'sess-earnings-scan',
      agentId: 'gekko',
      title: null,
      startedAt: minutesAgo(180),
      lastActivity: minutesAgo(48),
      messageCount: 9,
      lastMessage: {
        role: 'user',
        content: 'Scan the pre-market movers and tell me which ones are actually liquid.',
        timestamp: minutesAgo(48),
      },
    }),
    thread({
      id: 'sess-bike-season',
      agentId: 'main',
      title: 'Bike season 2026 stats',
      startedAt: minutesAgo(3200),
      lastActivity: minutesAgo(95),
      messageCount: 33,
      lastMessage: {
        role: 'assistant',
        content: 'You are 41 rides ahead of last year at the same date, and the elevation gain per ride went up by 12%.',
        timestamp: minutesAgo(95),
      },
    }),
    thread({
      id: 'sess-garden-wall',
      agentId: 'main',
      title: 'Garden wall quotes',
      startedAt: minutesAgo(5000),
      lastActivity: minutesAgo(240),
      messageCount: 18,
      lastMessage: {
        role: 'assistant',
        content: 'Three quotes in, the middle one has the only realistic drainage plan. I saved the comparison to memory.',
        timestamp: minutesAgo(240),
      },
    }),
    thread({
      id: 'sess-mailcow-upgrade',
      agentId: 'bob',
      title: 'Mailcow upgrade window',
      startedAt: minutesAgo(7000),
      lastActivity: minutesAgo(400),
      endedAt: minutesAgo(380),
      messageCount: 52,
      lastMessage: {
        role: 'assistant',
        content: 'Backup verified, upgrade path is 2026-05 to 2026-08 in one step. Needs a 20 minute window.',
        timestamp: minutesAgo(400),
      },
    }),
    thread({
      id: 'sess-dividend-calendar',
      agentId: 'warren',
      title: null,
      startedAt: minutesAgo(9000),
      lastActivity: minutesAgo(1450),
      endedAt: minutesAgo(1400),
      messageCount: 7,
      lastMessage: {
        role: 'user',
        content: 'Which of my positions pay out before the end of the quarter?',
        timestamp: minutesAgo(1450),
      },
    }),
    thread({
      id: 'sess-options-experiment',
      agentId: 'gekko',
      title: 'Options experiment (paper)',
      startedAt: minutesAgo(12_000),
      lastActivity: minutesAgo(2900),
      endedAt: minutesAgo(2880),
      messageCount: 22,
      lastMessage: {
        role: 'assistant',
        content: 'Paper run closed at +3.1% over six weeks, which is inside the noise band. Not worth real money yet.',
        timestamp: minutesAgo(2900),
      },
    }),
    thread({
      id: 'sess-old-invoices',
      agentId: 'main',
      title: 'Old invoices cleanup',
      archived: true,
      startedAt: minutesAgo(20_000),
      lastActivity: minutesAgo(8000),
      endedAt: minutesAgo(7990),
      messageCount: 15,
      lastMessage: {
        role: 'assistant',
        content: 'Everything before 2024 is tagged and filed in Paperless. Nothing left to do here.',
        timestamp: minutesAgo(8000),
      },
    }),
  ]
}

let store: Thread[] | null = null

function getStore(): Thread[] {
  if (!store) store = seedThreads()
  return store
}

/**
 * Turn state the mock pretends the backend is broadcasting over the WebSocket:
 * one thread streaming, one waiting behind it in the global message queue.
 */
export const MOCK_SESSION_ACTIVITY: Record<string, SessionActivity> = {
  'sess-roof-offer': { state: 'running' },
  'sess-offtangent-stufe1': { state: 'queued', position: 1 },
}

/** Fake transcript so the thread view is demoable without a backend. */
export const MOCK_THREAD_MESSAGES: Record<string, Array<{ role: 'user' | 'assistant'; content: string; minutesAgo: number }>> = {
  'sess-roof-offer': [
    { role: 'user', content: 'Compare the two roof offers again, I only care about what is actually in scope.', minutesAgo: 22 },
    { role: 'assistant', content: 'Both offers cover tear-off, insulation and tiles. Only Emig-Strauss prices the scaffolding separately, which is where the 2.5k difference comes from.', minutesAgo: 20 },
    { role: 'user', content: 'So the cheaper one is not actually cheaper?', minutesAgo: 6 },
    { role: 'assistant', content: 'Correct once you add scaffolding at market rate. Net difference drops to about 300 euro, and the more expensive offer includes the gutter work.', minutesAgo: 3 },
  ],
}

function matches(entry: Thread, query: ThreadListQuery): boolean {
  if (query.agentId && entry.agentId !== query.agentId) return false
  if (!query.includeArchived && entry.archived) return false
  return true
}

function delay<T>(value: T, ms = 180): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), ms))
}

export function useThreadsMock(): ThreadsApi {
  return {
    async listThreads(query: ThreadListQuery = {}) {
      const rows = getStore()
        .filter(entry => matches(entry, query))
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
        .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50))
      return delay(rows.map(entry => ({ ...entry })))
    },

    async createThread(payload: CreateThreadPayload) {
      const created = thread({
        id: `sess-mock-${Math.random().toString(36).slice(2, 8)}`,
        agentId: payload.agentId,
        title: payload.title?.trim() || null,
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        messageCount: 0,
        lastMessage: null,
      })
      getStore().unshift(created)
      return delay({ ...created })
    },

    async updateThread(id: string, patch: UpdateThreadPayload) {
      const entry = getStore().find(row => row.id === id)
      if (!entry) throw new Error(`Thread ${id} not found`)
      if (patch.title !== undefined) entry.title = patch.title
      if (patch.pinned !== undefined) entry.pinned = patch.pinned
      if (patch.archived !== undefined) entry.archived = patch.archived
      return delay({ ...entry })
    },
  }
}
