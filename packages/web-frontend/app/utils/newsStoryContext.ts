/**
 * Turns a parsed news story (`utils/newsDigest.ts`) into the plain text
 * article context that goes into a conversation — the board's side of
 * `@axiom/core/contracts`' `formatNewsStoryContext`.
 *
 * Only fields the payload actually carries are passed on: no full article
 * text, no invented date, no rewritten summary. The critique and the
 * relevance paragraphs stay out on purpose — they are the digest's opinion,
 * and the point of "Use in question" is to ask about the story, not to hand
 * the agent its own earlier verdict as if it were a fact.
 */
import { formatNewsStoryContext } from '@axiom/core/contracts'
import type { NewsStory } from '~/utils/newsDigest'

export interface NewsStoryContextOptions {
  boardKey: string
  boardTitle?: string | null
  /** Revision of the board the reader is looking at. */
  revision?: number | null
  /** `date` of the digest revision on screen. */
  date?: string | null
  /** Base path of the board page, e.g. `/boards/ki-news`. */
  basePath?: string | null
}

/** The `?date=…&story=…` deep link of the story, relative to the app. */
export function newsStoryLink(story: NewsStory, options: NewsStoryContextOptions): string {
  const base = (options.basePath ?? '').trim()
  if (!base.startsWith('/')) return ''
  const params = new URLSearchParams()
  if (options.date) params.set('date', options.date)
  params.set('story', story.storyId)
  return `${base}?${params.toString()}`
}

export function buildNewsStoryContext(story: NewsStory, options: NewsStoryContextOptions): string {
  return formatNewsStoryContext({
    boardKey: options.boardKey,
    boardTitle: options.boardTitle ?? null,
    revision: options.revision ?? null,
    date: options.date ?? null,
    storyId: story.storyId,
    title: story.title,
    take: story.take ?? null,
    summary: story.summary ?? null,
    delta: story.status === 'update' ? story.delta ?? null : null,
    verdict: story.verdict ?? null,
    category: story.categoryLabel ?? story.category ?? null,
    sources: story.sources.map(source => ({
      name: source.name,
      url: source.url ?? null,
      type: source.type ?? null,
      publishedAt: source.publishedAt ?? null,
    })),
    boardLink: newsStoryLink(story, options),
  })
}

/**
 * What the composer is prefilled with: the snapshot, a blank line, and the
 * reader's own question. The trailing newline is where the cursor lands — the
 * agent is asked nothing until the reader has typed it.
 */
export function newsStoryComposerDraft(story: NewsStory, options: NewsStoryContextOptions): string {
  return `${buildNewsStoryContext(story, options)}\n\n`
}
