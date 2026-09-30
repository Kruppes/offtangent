import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import { useBoardDetail, useBoardList, useBoardSignal } from './useBoards'
import type { Board, BoardSummary } from '~/api/boards'

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), revisions: vi.fn(), revision: vi.fn(), series: vi.fn() }))
vi.mock('~/api/boards', () => ({ useBoardsApi: () => api }))

const summary: BoardSummary = {
  key: 'depot', kind: 'portfolio_digest.v1', title: 'Portfolio', icon: '📈', agentId: 'analyst',
  revision: 3, summary: 'Up 1 %', asOf: '2026-09-25T20:00:00Z', updatedAt: '2026-09-25T20:00:01Z',
}
const board = (revision = 3): Board => ({ ...summary, revision, payload: { digest: `r${revision}` } })

beforeEach(() => {
  vi.resetAllMocks()
  const states = new Map<string, Ref>()
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  })
  api.list.mockResolvedValue([summary])
  api.get.mockResolvedValue(board())
  api.revisions.mockResolvedValue([{ revision: 3, asOf: summary.asOf, createdAt: summary.updatedAt, summary: 'Up 1 %' }])
  api.revision.mockResolvedValue(board(2))
  api.series.mockResolvedValue({ total_eur: [{ day: '2026-09-24', value: 1 }, { day: '2026-09-25', value: 2 }] })
})
afterEach(() => vi.unstubAllGlobals())

describe('board list state', () => {
  it('loads the boards and keeps an error retryable', async () => {
    const list = useBoardList()
    await list.load()
    expect(list.boards.value).toHaveLength(1)
    api.list.mockRejectedValueOnce(new Error('offline'))
    await list.load()
    expect(list.error.value).toBe('boards.loadError')
    await list.load()
    expect(list.error.value).toBeNull()
  })

  it('refetches the list when a board_updated frame arrives', async () => {
    const list = useBoardList()
    await list.load()
    useBoardSignal().receive({ key: 'depot', revision: 4, asOf: '2026-09-26T06:30:00Z' })
    await nextTick()
    await Promise.resolve()
    expect(api.list).toHaveBeenCalledTimes(2)
  })
})

describe('board detail state', () => {
  it('loads board, revisions and the 90-day total series', async () => {
    const detail = useBoardDetail(() => 'depot')
    await detail.load()
    await Promise.resolve()
    expect(detail.board.value?.revision).toBe(3)
    expect(api.series).toHaveBeenCalledWith('depot', ['total_eur'], 90)
    expect(detail.series.value).toHaveLength(2)
    expect(detail.revisions.value).toHaveLength(1)
    expect(detail.isHistoric.value).toBe(false)
  })

  it('survives a missing series without breaking the board', async () => {
    api.series.mockRejectedValueOnce(new Error('no series'))
    const detail = useBoardDetail(() => 'depot')
    await detail.load()
    await Promise.resolve()
    await Promise.resolve()
    expect(detail.series.value).toEqual([])
    expect(detail.board.value).not.toBeNull()
    expect(detail.error.value).toBeNull()
  })

  it('shows a historic revision read-only and returns to the current one', async () => {
    const detail = useBoardDetail(() => 'depot')
    await detail.load()
    await detail.openRevision(2)
    expect(detail.board.value?.revision).toBe(2)
    expect(detail.isHistoric.value).toBe(true)
    detail.backToCurrent()
    expect(detail.board.value?.revision).toBe(3)
    expect(detail.isHistoric.value).toBe(false)
  })

  it('refetches on a matching live frame but not while a revision is pinned', async () => {
    const detail = useBoardDetail(() => 'depot')
    await detail.load()
    useBoardSignal().receive({ key: 'other', revision: 9, asOf: '2026-09-26T06:30:00Z' })
    await nextTick()
    expect(api.get).toHaveBeenCalledTimes(1)

    useBoardSignal().receive({ key: 'depot', revision: 4, asOf: '2026-09-26T06:30:00Z' })
    await nextTick()
    expect(api.get).toHaveBeenCalledTimes(2)

    await detail.openRevision(2)
    useBoardSignal().receive({ key: 'depot', revision: 5, asOf: '2026-09-26T12:00:00Z' })
    await nextTick()
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it('replays a missed live update when returning to the current revision', async () => {
    const detail = useBoardDetail(() => 'depot')
    await detail.load()
    await detail.openRevision(2)

    useBoardSignal().receive({ key: 'depot', revision: 5, asOf: '2026-09-26T12:00:00Z' })
    await nextTick()
    expect(api.get).toHaveBeenCalledTimes(1)

    api.get.mockResolvedValueOnce(board(5))
    detail.backToCurrent()
    await nextTick()
    await Promise.resolve()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(detail.board.value?.revision).toBe(5)
    expect(detail.isHistoric.value).toBe(false)
  })

  it('does not refetch on backToCurrent when no live update was missed', async () => {
    const detail = useBoardDetail(() => 'depot')
    await detail.load()
    await detail.openRevision(2)
    detail.backToCurrent()
    await nextTick()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(detail.board.value?.revision).toBe(3)
  })

  it('keeps the renderer identity when the revision response omits kind and title', async () => {
    api.revision.mockResolvedValueOnce({
      key: 'depot',
      revision: 2,
      summary: 'Older',
      payload: { digest: 'r2' },
      asOf: '2026-09-24T20:00:00Z',
      createdAt: '2026-09-24T20:00:02Z',
    })
    const detail = useBoardDetail(() => 'depot')
    await detail.load()
    await detail.openRevision(2)

    expect(detail.board.value?.kind).toBe('portfolio_digest.v1')
    expect(detail.board.value?.title).toBe('Portfolio')
    expect(detail.board.value?.icon).toBe('📈')
    expect(detail.board.value?.agentId).toBe('analyst')
    expect(detail.board.value?.revision).toBe(2)
    expect(detail.board.value?.summary).toBe('Older')
    expect(detail.board.value?.payload).toEqual({ digest: 'r2' })
    expect(detail.board.value?.asOf).toBe('2026-09-24T20:00:00Z')
  })
})
