/**
 * Turn a board revision plus a story id into the composer handoff of the
 * "ask about this story" link (`/ask/news?board=&story=&rev=`).
 *
 * Pure on purpose: the page around it does the fetching and the navigating,
 * this decides WHAT ends up in the composer — which is the part that has to
 * stay checkable. The article text never travels in the URL; it is rebuilt
 * here from the board the API just handed out for this reader.
 */
import type { Board } from '~/api/boards'
import { parseNewsDigest } from './newsDigest'
import { newsStoryComposerDraft } from './newsStoryContext'

export interface NewsAskHandoff {
  text: string
  title: string
}

export type NewsAskResult =
  | { ok: true; handoff: NewsAskHandoff }
  | { ok: false; error: 'ask.missing' | 'ask.storyGone' }

/** `rev=` as a positive integer, or null when it is absent or unusable. */
export function parseRevision(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  return Number.isInteger(value) && value > 0 ? value : null
}

export function buildNewsAskHandoff(board: Board, boardKey: string, storyId: string): NewsAskResult {
  if (!boardKey || !storyId) return { ok: false, error: 'ask.missing' }
  const digest = parseNewsDigest(board.payload)
  const story = digest?.items.find(entry => entry.storyId === storyId)
  if (!story) return { ok: false, error: 'ask.storyGone' }
  return {
    ok: true,
    handoff: {
      text: newsStoryComposerDraft(story, {
        boardKey,
        boardTitle: board.title,
        revision: board.revision,
        date: digest?.date ?? null,
        basePath: `/boards/${encodeURIComponent(boardKey)}`,
      }),
      title: story.title,
    },
  }
}
