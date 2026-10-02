<script setup lang="ts">
/*
 * `/ask/news?board=&story=&rev=&date=` — the landing spot of the "ask a
 * question about this story" link inside a news board document.
 *
 * The board document is a sandboxed page with no network and no session; it
 * can only hand over IDENTIFIERS. This page is the authenticated half: it
 * loads that board revision through the normal API (so the reader's own
 * session decides what they may read), rebuilds the article snapshot from the
 * payload it just fetched, and puts it into the composer of a NEW capture.
 *
 * Three properties matter and are why the article text is not in the URL:
 *  - data thrift: a URL is logged, shared and truncated; only ids travel,
 *  - authorisation: the snapshot is built after the API said this board
 *    belongs to this user, not from whatever the link claimed,
 *  - stability: `rev=` pins the revision the reader saw, so a board that was
 *    republished in the meantime does not silently change the context.
 *
 * Nothing is ever sent: the composer opens with the snapshot and the cursor
 * below it, the question and the send stay the reader's.
 */
import { onMounted, ref } from 'vue'
import { useBoardsApi } from '~/api/boards'
import { setComposerHandoff } from '~/composables/useComposerHandoff'
import { buildNewsAskHandoff, parseRevision } from '~/utils/newsAskHandoff'

const route = useRoute()
const router = useRouter()
const boards = useBoardsApi()
const error = ref<string | null>(null)

function query(name: string): string {
  const value = route.query[name]
  return typeof value === 'string' ? value : ''
}

onMounted(async () => {
  const key = query('board')
  const storyId = query('story')
  if (!key || !storyId) {
    error.value = 'ask.missing'
    return
  }
  const revision = parseRevision(query('rev'))
  try {
    const board = revision === null ? await boards.get(key) : await boards.revision(key, revision)
    const result = buildNewsAskHandoff(board, key, storyId)
    if (!result.ok) {
      error.value = result.error
      return
    }
    // A new strand, always: the reader asked about an article, not about the
    // conversation that happens to resemble it most. Nothing is sent.
    setComposerHandoff(result.handoff.text, { newStrand: true, title: result.handoff.title })
    // `replace`, not `push`: the link is a one-way handoff, going back should
    // not re-run it and refill the composer with the same snapshot.
    await router.replace('/')
  } catch {
    error.value = 'ask.failed'
  }
})
</script>

<template>
  <div class="ask">
    <p v-if="error === null">{{ $t('ask.loading') }}</p>
    <template v-else>
      <h1 class="text-lg font-semibold">{{ $t('ask.title') }}</h1>
      <p>{{ $t(error) }}</p>
      <NuxtLink to="/" class="inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ $t('ask.home') }}</NuxtLink>
    </template>
  </div>
</template>

<style scoped>
.ask { padding: 2rem; display: grid; gap: 0.75rem; justify-items: start; }
</style>
