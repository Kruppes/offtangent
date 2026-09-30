<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useBoardDetail } from '~/composables/useBoards'
import { relativeTimeKey } from '~/utils/boardFormat'
import GenericBoard from '~/components/board/GenericBoard.vue'
import SandboxedBoard from '~/components/board/SandboxedBoard.vue'
import NewsDigestBoard from '~/components/board/NewsDigestBoard.vue'
import PortfolioDigestBoard from '~/components/board/PortfolioDigestBoard.vue'
import { parseNewsDigest } from '~/utils/newsDigest'
import { setComposerHandoff } from '~/composables/useComposerHandoff'

const route = useRoute()
const router = useRouter()
const boardKey = computed(() => String(route.params.key ?? ''))
const { board, current, revisions, series, loading, error, viewedRevision, isHistoric, historyOpen, load, openRevision, backToCurrent } = useBoardDetail(() => boardKey.value)
/**
 * Which renderer draws this board, in one fixed priority:
 *
 *   1. a BUILT-IN renderer for the kind (portfolio, news digest) — it knows
 *      the app's chrome, day navigation, read state and offline behaviour,
 *      which a sandboxed document cannot have,
 *   2. a SERVER rendered document: any board that came with `content.url`,
 *      whatever its kind. This is what lets a new board type work without a
 *      client update (`html_view.v1` is just the case where the document is
 *      the payload),
 *   3. the GENERIC fallback: summary as Markdown plus the raw payload.
 *
 * A board whose built-in renderer finds nothing renderable falls through to
 * the fallback rather than rendering nothing. Both digest kinds share one
 * renderer: a board keeps older `news_digest.v1` revisions.
 */
const renderer = computed(() => {
  const kind = board.value?.kind
  if (kind === 'portfolio_digest.v1') return 'portfolio_digest.v1'
  if ((kind === 'news_digest.v1' || kind === 'news_digest.v2') && parseNewsDigest(board.value?.payload)) return 'news_digest'
  if (board.value?.content?.url) return 'sandboxed'
  return 'generic'
})

/**
 * A news board brings its own head, day navigation and detail view, so the
 * page chrome around it (header, historic banner, revision list) would only
 * duplicate them. Its state lives in the URL: `?date=` picks the revision of
 * that day, `?story=` opens one story — both shareable, both back-navigable.
 */
const newsDate = computed(() => {
  const value = route.query.date
  return typeof value === 'string' && value ? value : null
})
const newsStory = computed(() => {
  const value = route.query.story
  return typeof value === 'string' && value ? value : null
})
/** The revision published for `?date=`, or null for the current one. */
const newsRevision = computed(() => {
  const date = newsDate.value
  if (!date) return null
  const matching = revisions.value.filter(entry => String(entry.asOf).slice(0, 10) === date)
  if (!matching.length) return null
  return matching.reduce((newest, entry) => (entry.revision > newest.revision ? entry : newest)).revision
})

/**
 * "Use in question" on a story: the snapshot goes to the composer, the reader
 * types the question there. Nothing is sent — but when it is sent, it opens
 * its own conversation, so the question never lands in whatever strand the
 * router finds most similar.
 */
function useInQuestion(draft: { text: string; title: string | null }) {
  setComposerHandoff(draft.text, { newStrand: true, title: draft.title })
  void router.push('/')
}

function onNewsNavigate(target: { date?: string | null; story?: string | null }) {
  const query: Record<string, string> = {}
  if (target.date) query.date = target.date
  if (target.story) query.story = target.story
  void router.push({ query })
}

// Day navigation and the browser's back button both end up here: one query,
// one revision fetch.
watch([newsRevision, () => renderer.value], ([revision]) => {
  if (renderer.value !== 'news_digest') return
  if (revision === null || revision === current.value?.revision) {
    if (isHistoric.value) backToCurrent()
    return
  }
  if (revision !== viewedRevision.value) void openRevision(revision)
})

onMounted(load)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <PageHeader :title="board?.title ?? $t('boards.title')" :subtitle="$t('boards.subtitle')" />
    <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-3 md:px-6 md:pb-8">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <NuxtLink to="/boards" class="inline-flex min-h-[44px] w-fit items-center gap-1 text-sm underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <AppIcon name="arrowLeft" />{{ $t('boards.backToList') }}
        </NuxtLink>

        <header v-if="board && renderer !== 'news_digest'" class="flex flex-wrap items-start gap-3">
          <span v-if="board.icon" class="text-3xl leading-none" aria-hidden="true">{{ board.icon }}</span>
          <div class="min-w-0 flex-1">
            <h1 class="text-xl font-bold tracking-tight [overflow-wrap:anywhere]">{{ board.title }}</h1>
            <p class="text-xs text-muted-foreground">
              {{ $t('boards.asOf', { date: board.asOf }) }} ·
              {{ $t('boards.revision', { revision: board.revision }) }} ·
              {{ $t(relativeTimeKey(board.updatedAt).key, { count: relativeTimeKey(board.updatedAt).count }) }}
            </p>
          </div>
          <Button variant="ghost" class="min-h-[44px]" :disabled="loading" @click="load">{{ $t('common.refresh') }}</Button>
        </header>

        <Alert v-if="isHistoric && renderer !== 'news_digest'" role="status" class="flex flex-wrap items-center gap-3">
          <AlertDescription class="flex-1">{{ $t('boards.historicBanner', { revision: viewedRevision ?? 0, total: current?.revision ?? 0 }) }}</AlertDescription>
          <Button variant="outline" class="min-h-[44px]" @click="backToCurrent">{{ $t('boards.backToCurrent') }}</Button>
        </Alert>

        <Alert v-if="error && renderer !== 'news_digest'" variant="destructive" role="alert" class="flex flex-wrap items-center gap-3">
          <AlertDescription class="flex-1">{{ $t(error) }}</AlertDescription>
          <Button variant="outline" class="min-h-[44px]" :disabled="loading" @click="load">{{ $t('common.retry') }}</Button>
        </Alert>

        <div v-if="loading && !board" role="status" :aria-label="$t('common.loading')" aria-busy="true" class="space-y-3">
          <div v-for="n in 3" :key="n" aria-hidden="true" class="h-24 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        </div>

        <template v-else-if="board">
          <PortfolioDigestBoard v-if="renderer === 'portfolio_digest.v1'" :payload="board.payload" :series="series" />
          <SandboxedBoard v-else-if="renderer === 'sandboxed'" :content="board.content" :title="board.title" :summary="board.summary" />
          <NewsDigestBoard v-else-if="renderer === 'news_digest'" :payload="board.payload" :revisions="revisions"
            :story="newsStory" :date="newsDate" :loading="loading" :failed="Boolean(error)"
            :base-path="`/boards/${boardKey}`" :board-key="boardKey" :board-title="board.title" :revision="board.revision"
            @navigate="onNewsNavigate" @retry="load" @use-in-question="useInQuestion" />
          <GenericBoard v-else :summary="board.summary" :payload="board.payload" :kind="board.kind" />

          <section v-if="revisions.length && renderer !== 'news_digest'" class="rounded-lg border bg-card text-card-foreground">
            <button type="button" class="flex min-h-[44px] w-full items-center gap-2 px-4 text-left text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              :aria-expanded="historyOpen" aria-controls="board-history" @click="historyOpen = !historyOpen">
              <AppIcon :name="historyOpen ? 'chevronDown' : 'chevronRight'" />{{ $t('boards.history') }}
              <span class="text-muted-foreground">({{ revisions.length }})</span>
            </button>
            <ul v-show="historyOpen" id="board-history" class="space-y-1 px-2 pb-2">
              <li v-for="entry in revisions" :key="entry.revision">
                <button type="button" class="flex min-h-[44px] w-full flex-wrap items-center gap-x-3 rounded-lg px-2 text-left text-sm hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  :class="entry.revision === board.revision ? 'bg-accent/60' : ''" @click="openRevision(entry.revision)">
                  <span class="font-medium">{{ $t('boards.revision', { revision: entry.revision }) }}</span>
                  <span class="text-xs text-muted-foreground">{{ entry.asOf }}</span>
                  <span v-if="entry.summary" class="line-clamp-1 w-full text-xs text-muted-foreground">{{ entry.summary }}</span>
                </button>
              </li>
            </ul>
          </section>
        </template>

        <p v-else-if="!error" role="status" class="rounded-lg border p-6 text-center text-muted-foreground">{{ $t('boards.notFound') }}</p>
      </div>
    </div>
  </div>
</template>
