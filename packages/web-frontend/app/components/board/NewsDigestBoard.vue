<script setup lang="ts">
/**
 * Renderer for news digest boards — `news_digest.v2`, with `news_digest.v1`
 * revisions of the same board read by the same parser
 * (`docs/reference/boards-api.md#news_digestv2`).
 *
 * Layout follows the binding design spec (plan 2026-09-28,
 * "News-Board Gestaltungsspezifikation"): no cards, no filter chips, no
 * disclosure. A divided list with hairlines whose row already carries the
 * verdict sentence (`take`), plus a detail view the reader pages through.
 *
 * Colour comes from exactly eight roles mapped onto the shell theme
 * (bg=surface, raised=surfaceContainer, line=outlineVariant, outline=outline,
 * text-1=onSurface, text-2=onSurfaceVariant, signal=primary,
 * on-signal=onPrimary); there is no hex value in this file. `line` separates,
 * `outline` is used where a line is the only boundary of a control (WCAG
 * 1.4.11, ≥ 3:1). Type is the app system font at 12/14/16/18/22 in rem, weights
 * 400/600 only. Spacing is px on the 4 grid so a text zoom scales type without
 * inflating the layout.
 *
 * No payload text ever reaches `v-html`; every string is interpolated, and a
 * source becomes a link only when the parser kept an `https://` URL for it.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  actionLabelKey, sourceTypeLabelKey, verdictLabelKey, verdictShape,
  type NewsStory,
} from '~/utils/newsDigest'
import {
  formatSourceDate, useNewsDigestView,
  type NewsDigestDay, type NewsRevisionEntry,
} from '~/composables/useNewsDigestView'
import { buildNewsStoryContext, newsStoryComposerDraft } from '~/utils/newsStoryContext'

const props = withDefaults(defineProps<{
  payload: unknown
  /** Revisions of this board; each one is a day the reader can open. */
  revisions?: NewsRevisionEntry[]
  /** `?story=` of the route — the detail view is route state, not local state. */
  story?: string | null
  /** `?date=` of the route. */
  date?: string | null
  loading?: boolean
  /** True when the board (or a revision of it) could not be loaded. */
  failed?: boolean
  /** Path the deep links are built on, e.g. `/boards/ki-news`. */
  basePath?: string
  /** Board key and title, for the article context of "Use in question". */
  boardKey?: string
  boardTitle?: string | null
  /** Revision on screen, so the context names the snapshot it came from. */
  revision?: number | null
}>(), {
  revisions: () => [],
  story: null,
  date: null,
  loading: false,
  failed: false,
  basePath: '',
  boardKey: '',
  boardTitle: null,
  revision: null,
})

const { t } = useI18n()

const emit = defineEmits<{
  /** Route state the page turns into a URL: day and/or story. */
  navigate: [{ date?: string | null; story?: string | null; revision?: number | null }]
  retry: []
  /**
   * The reader wants to ask about this story: the article snapshot as plain
   * text. The page owns the navigation to the composer, this renderer only
   * builds the text — and nothing is sent anywhere until the reader has
   * typed a question.
   */
  useInQuestion: [{ text: string; title: string | null }]
}>()

const view = useNewsDigestView({
  payload: () => props.payload,
  revisions: () => props.revisions,
  story: () => props.story,
  date: () => props.date,
  loading: () => props.loading,
})
const {
  digest, days, newestDay, currentDate, currentDayLabel, olderDay, newerDay,
  isArchive, awaitingToday, items, hotCount, updatedTime, selected,
  selectedPosition, nextStory, previousStory, isRead, showProgress,
  failedOpen, sourcesFailed,
} = view

const dayPickerOpen = ref(false)
/** Feedback for the copy button; reset after a moment, never an error banner. */
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

function contextOptions() {
  return {
    boardKey: props.boardKey,
    boardTitle: props.boardTitle,
    revision: props.revision,
    date: currentDate.value,
    basePath: props.basePath,
  }
}

/** Hand the snapshot of the open story to the composer. */
function useInQuestion() {
  if (!selected.value) return
  emit('useInQuestion', { text: newsStoryComposerDraft(selected.value, contextOptions()), title: selected.value.title })
}

/**
 * The same snapshot on the clipboard, for a question inside a strand that is
 * already open. A denied clipboard is not worth an error state: the button
 * simply does not confirm.
 */
async function copyContext() {
  if (!selected.value) return
  const text = buildNewsStoryContext(selected.value, contextOptions())
  try {
    await navigator.clipboard?.writeText(text)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 2500)
  } catch {
    copied.value = false
  }
}

function storyHref(item: NewsStory): string {
  const params = new URLSearchParams()
  if (currentDate.value) params.set('date', currentDate.value)
  params.set('story', item.storyId)
  return `${props.basePath}?${params.toString()}`
}
function dayHref(day: NewsDigestDay): string {
  return `${props.basePath}?date=${day.date}`
}
function openStory(item: NewsStory | null) {
  copied.value = false
  emit('navigate', { date: currentDate.value, story: item?.storyId ?? null })
}
function openDay(day: NewsDigestDay | null) {
  if (!day) return
  dayPickerOpen.value = false
  emit('navigate', { date: day.date, story: null, revision: day.revision })
}

/** ← / → page through the day, Esc returns to the list. */
function onKeydown(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target as HTMLElement | null
  if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
  if (event.key === 'Escape' && selected.value) { openStory(null); event.preventDefault(); return }
  if (!selected.value) return
  if (event.key === 'ArrowRight' && nextStory.value) { openStory(nextStory.value); event.preventDefault() }
  if (event.key === 'ArrowLeft' && previousStory.value) { openStory(previousStory.value); event.preventDefault() }
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (copiedTimer) clearTimeout(copiedTimer)
})

const verdictClasses: Record<string, string> = {
  'filled-signal': 'nd-signal',
  'filled-raised': 'nd-raised nd-t1',
  'outlined': 'nd-outline-t2 nd-t2',
  'bare': 'nd-t2',
}
function pillClass(verdict: string | undefined): string {
  return verdictClasses[verdictShape(verdict)] ?? 'nd-t2'
}
function verdictText(verdict: string | undefined): string {
  const key = verdictLabelKey(verdict)
  return key ? t(key) : (verdict ?? '')
}
/** A run of text inside one segment; a `nobr` run never breaks inside itself. */
type MetaRun = { text: string, nobr?: boolean }
/** A segment is the unit a `<wbr>` may be offered in front of. */
type MetaSegment = MetaRun[]

/**
 * A host name is an identifier, not language: it breaks at its OWN joints and
 * without a mark (spec "Umbruchregel Bezeichner vs. Sprache", 2026-09-28).
 * Joints in order of rank:
 *  1. before every dot — a dot at a line end reads as the end of a sentence,
 *     one at the start of the next line as a continuation (".net"),
 *  2. before an existing hyphen, and locked AFTER it: the hyphen starts the
 *     following line and never ends one, where it would read as a hyphenation
 *     mark the host does not have. The lock is one inline `nowrap` run holding
 *     the hyphen plus the first following character ("-m" + "itteldeutschland").
 *  3. only then the markless emergency break (`overflow-wrap: anywhere`), and
 *     only inside the one segment that does not fit.
 * No invisible character is put into the text (no U+2060/U+2011/U+200B), so a
 * copy of the line yields the host unchanged.
 */
function hostSegments(host: string): MetaSegment[] {
  return host.split(/(?=[.-])/).map((segment) => {
    if (!segment.startsWith('-') || segment.length < 2) return [{ text: segment }]
    const rest = segment.slice(2)
    return rest ? [{ text: segment.slice(0, 2), nobr: true }, { text: rest }] : [{ text: segment, nobr: true }]
  })
}

/**
 * The meta line of a source as parts, each part as the segments a `<wbr>` may
 * separate. Text only, rendered as text nodes and one `nowrap` span — never
 * `v-html`; `overflow-wrap: anywhere` stays as the net.
 */
function sourceMetaParts(source: NewsStory['sources'][number]): MetaSegment[][] {
  const typeKey = sourceTypeLabelKey(source.type)
  const type = typeKey ? t(typeKey) : source.type
  const date = formatSourceDate(source.publishedAt)
  const parts: MetaSegment[][] = []
  if (type) parts.push([[{ text: type }]])
  if (source.host) parts.push(hostSegments(source.host))
  if (date) parts.push([[{ text: date }]])
  return parts
}

/**
 * The "·" between two parts never starts a line: no-break space in front of it,
 * a normal one behind, so the separator hangs at the end of the line it belongs to.
 */
const metaSeparator = '\u00a0· '

function sourcesText(item: NewsStory): string {
  return item.sourceCount === 1 ? t('boards.news.sourceOne') : t('boards.news.sourceCount', { count: item.sourceCount })
}
function firsthandText(item: NewsStory): string {
  return item.firsthandCount > 0
    ? t('boards.news.firsthandCount', { count: item.firsthandCount })
    : t('boards.news.noFirsthand')
}

/** "9 items · 2 hot · Updated 07:04" — only the parts that exist. */
const counterLine = computed(() => {
  const parts: string[] = [
    items.value.length === 1 ? t('boards.news.itemOne') : t('boards.news.itemCount', { count: items.value.length }),
  ]
  if (hotCount.value > 0) parts.push(t('boards.news.hotCount', { count: hotCount.value }))
  if (updatedTime.value) parts.push(t('boards.news.updatedAt', { time: updatedTime.value }))
  return parts.join(metaSeparator)
})

const footerLine = computed(() => {
  const parts: string[] = []
  if (digest.value?.sourcesChecked !== undefined) parts.push(t('boards.news.checkedSources', { count: digest.value.sourcesChecked }))
  if (digest.value?.candidates !== undefined) parts.push(t('boards.news.candidates', { count: digest.value.candidates }))
  return parts.join(metaSeparator)
})

/** On a narrow screen the detail replaces the list; from 1100 px both show. */
const listHidden = computed(() => selected.value !== null)
</script>

<template>
  <div v-if="digest" class="nd flex min-h-0 w-full flex-col" lang="en">
    <!-- Loading: a 2 px line under the app bar, and only after 300 ms. -->
    <div v-if="showProgress" role="progressbar" :aria-label="$t('common.loading')"
      class="h-[2px] w-full animate-pulse nd-bar motion-reduce:animate-none" />

    <p v-if="failed" role="alert" class="flex flex-wrap items-center gap-[16px] px-[16px] py-[12px] min-[600px]:px-[24px]">
      <span class="nd-body nd-t1">{{ $t('boards.news.loadError') }}</span>
      <button type="button" class="nd-focus nd-body nd-t1 min-h-[48px] min-w-[48px] underline underline-offset-4" @click="emit('retry')">
        {{ $t('boards.news.retry') }}
      </button>
    </p>

    <div class="mx-auto flex w-full max-w-[608px] flex-col min-[1100px]:max-w-none min-[1100px]:flex-row min-[1100px]:gap-[48px]">
      <!-- ── list column ─────────────────────────────────────────────── -->
      <div class="flex min-w-0 flex-col min-[1100px]:h-[calc(100dvh-140px)] min-[1100px]:w-[400px] min-[1100px]:shrink-0 min-[1100px]:overflow-y-auto"
        :class="listHidden ? 'hidden min-[1100px]:flex' : 'flex'">
        <!-- Day line: ‹ date › -->
        <div class="flex h-[48px] items-center px-[16px] min-[600px]:px-[24px]">
          <a v-if="olderDay" :href="dayHref(olderDay)" :aria-label="$t('boards.news.previousDay')"
            class="nd-focus nd-t1 -ml-[12px] flex h-[48px] w-[48px] items-center justify-center"
            @click.prevent="openDay(olderDay)"><span class="nd-icon-glyph" aria-hidden="true">‹</span></a>
          <span v-else aria-hidden="true" class="nd-t2 -ml-[12px] flex h-[48px] w-[48px] items-center justify-center"><span class="nd-icon-glyph">‹</span></span>

          <button type="button" class="nd-focus nd-meta nd-t1 nd-tnum flex min-h-[48px] flex-1 items-center justify-center gap-[8px]"
            :aria-expanded="dayPickerOpen" aria-haspopup="dialog" @click="dayPickerOpen = !dayPickerOpen">
            {{ currentDayLabel ?? $t('boards.news.noDate') }}
          </button>

          <a v-if="newerDay" :href="dayHref(newerDay)" :aria-label="$t('boards.news.nextDay')"
            class="nd-focus nd-t1 -mr-[12px] flex h-[48px] w-[48px] items-center justify-center"
            @click.prevent="openDay(newerDay)"><span class="nd-icon-glyph" aria-hidden="true">›</span></a>
          <span v-else aria-hidden="true" class="nd-t2 -mr-[12px] flex h-[48px] w-[48px] items-center justify-center"><span class="nd-icon-glyph">›</span></span>
        </div>

        <!-- Revision picker: every day with its headline, at most two lines. -->
        <div v-if="dayPickerOpen" role="dialog" :aria-label="$t('boards.news.chooseDay')"
          class="nd-raised nd-outline mx-[16px] border min-[600px]:mx-[24px]">
          <ul>
            <li v-for="day in days" :key="day.revision" class="nd-line border-b last:border-b-0">
              <a :href="dayHref(day)" class="nd-row nd-focus flex min-h-[48px] flex-col justify-center px-[12px] py-[8px]"
                :aria-current="day.date === currentDate ? 'true' : undefined" @click.prevent="openDay(day)">
                <span class="nd-meta nd-t1 nd-tnum">{{ day.label }}</span>
                <span v-if="day.headline" class="nd-meta nd-t2 nd-clamp-2" lang="de">{{ day.headline }}</span>
              </a>
            </li>
          </ul>
        </div>

        <p v-if="isArchive" class="nd-meta nd-t2 flex min-h-[48px] items-center gap-[8px] px-[16px] min-[600px]:px-[24px]">
          {{ $t('boards.news.archive') }}&nbsp;·
          <a v-if="newestDay" :href="dayHref(newestDay)" class="nd-focus nd-t1 inline-flex min-h-[48px] items-center underline underline-offset-4"
            @click.prevent="openDay(newestDay)">{{ $t('boards.news.backToToday') }}</a>
        </p>
        <p v-else-if="awaitingToday" class="nd-meta nd-t2 px-[16px] pt-[8px] min-[600px]:px-[24px]">
          {{ $t('boards.news.awaitingToday') }}
        </p>

        <h2 v-if="digest.headline" class="nd-display nd-t1 nd-de mt-[8px] px-[16px] min-[600px]:px-[24px]" lang="de">
          {{ digest.headline }}
        </h2>
        <p class="nd-meta nd-t2 nd-tnum mt-[8px] px-[16px] min-[600px]:px-[24px]">{{ counterLine }}</p>

        <p v-if="!items.length" role="status" class="nd-body nd-t2 mt-[24px] px-[16px] min-[600px]:px-[24px]">
          {{ $t('boards.news.empty') }}
        </p>

        <!-- ── the list: hairline above the first row, one below each ──── -->
        <ul v-else class="nd-line mt-[24px] border-t">
          <li v-for="item in items" :key="item.storyId" class="nd-line border-b">
            <a :href="storyHref(item)" class="nd-row nd-focus block px-[16px] pb-[20px] pt-[20px] min-[600px]:px-[24px]"
              :class="selected && selected.storyId === item.storyId ? 'nd-raised nd-selected' : ''"
              :aria-current="selected && selected.storyId === item.storyId ? 'true' : undefined"
              @click.prevent="openStory(item)">
              <span class="flex flex-wrap items-center gap-[8px]">
                <span v-if="item.rankLabel" class="nd-meta nd-strong nd-t2 nd-tnum">{{ item.rankLabel }}</span>
                <span v-if="item.verdict" class="nd-label inline-flex min-h-[20px] items-center rounded-sm px-[8px] py-1" :class="pillClass(item.verdict)">
                  {{ verdictText(item.verdict) }}
                </span>
                <span v-if="item.categoryLabel" class="nd-meta nd-t2">{{ item.categoryLabel }}</span>
                <span v-if="item.status === 'update'" class="nd-label nd-t1 ml-auto">{{ $t('boards.news.update') }}</span>
              </span>

              <span class="nd-title nd-de mt-[8px] block" :class="isRead(item) ? 'nd-t2' : 'nd-t1'" lang="de">{{ item.title }}</span>
              <span v-if="item.take" class="nd-body nd-t1 nd-de mt-[4px] block" lang="de">{{ item.take }}</span>

              <span class="mt-[12px] flex flex-wrap items-center gap-[8px]">
                <span v-if="item.sources.length" aria-hidden="true" class="flex items-center gap-[4px]">
                  <span v-for="(source, index) in item.sources.slice(0, 8)" :key="`${item.storyId}-dot-${index}`"
                    class="h-[8px] w-[8px] rounded-full" :class="source.firsthand ? 'nd-dot-1' : 'nd-dot-2'" />
                  <span v-if="item.sources.length > 8" class="nd-meta nd-t2">+{{ item.sources.length - 8 }}</span>
                </span>
                <span class="nd-meta nd-t2">{{ sourcesText(item) }}&nbsp;·
                  <span :class="item.firsthandCount > 0 ? 'nd-t2' : 'nd-t1 nd-strong'">{{ firsthandText(item) }}</span>
                </span>
              </span>
            </a>
          </li>
        </ul>

        <!-- ── quick hits: open externally, no detail view ──────────────── -->
        <section v-if="digest.quickHits.length" class="mt-[48px]">
          <h3 class="nd-label nd-t2 px-[16px] min-[600px]:px-[24px]">{{ $t('boards.news.quickHits') }}</h3>
          <ul class="mt-[8px] nd-line border-t">
            <li v-for="(hit, index) in digest.quickHits" :key="`quick-${index}`" class="nd-line border-b">
              <component :is="hit.url ? 'a' : 'div'" v-bind="hit.url ? { href: hit.url, target: '_blank', rel: 'noopener noreferrer' } : {}"
                class="nd-row nd-focus block px-[16px] py-[12px] min-[600px]:px-[24px]">
                <span class="nd-body nd-t1 nd-de flex items-start gap-[8px]" lang="de">
                  <span class="min-w-0 flex-1">{{ hit.title }}</span>
                  <AppIcon v-if="hit.url" name="externalLink" size="sm" class="nd-t2 mt-[4px] shrink-0" />
                </span>
                <span v-if="hit.note" class="nd-meta nd-t2 nd-de block" lang="de">{{ hit.note }}</span>
                <span v-if="hit.source" class="nd-meta nd-t2 block">{{ hit.source }}</span>
              </component>
            </li>
          </ul>
        </section>

        <!-- ── footer: statistics, failed sources behind a disclosure ──── -->
        <footer class="mt-[48px] px-[16px] pb-[24px] min-[600px]:px-[24px]">
          <p v-if="footerLine" class="nd-meta nd-t2 nd-tnum">{{ footerLine }}</p>
          <template v-if="sourcesFailed.length">
            <button type="button" class="nd-focus nd-meta nd-t1 nd-disclosure flex min-h-[48px] items-center gap-[8px] text-left"
              :aria-expanded="failedOpen" aria-controls="news-sources-failed" @click="failedOpen = !failedOpen">
              <AppIcon name="chevronRight" size="sm" class="nd-chevron" />
              {{ sourcesFailed.length === 1 ? $t('boards.news.sourcesFailedOne') : $t('boards.news.sourcesFailedCount', { count: sourcesFailed.length }) }}
            </button>
            <p v-show="failedOpen" id="news-sources-failed" class="nd-meta nd-t2">{{ sourcesFailed.join(', ') }}</p>
          </template>
        </footer>
      </div>

      <!-- ── detail column ───────────────────────────────────────────── -->
      <article v-if="selected" :key="selected.storyId"
        class="flex min-w-0 flex-col min-[1100px]:h-[calc(100dvh-140px)] min-[1100px]:max-w-[560px] min-[1100px]:flex-1 min-[1100px]:overflow-y-auto">
        <div class="flex h-[64px] items-center gap-[8px] px-[16px] min-[600px]:px-[24px]">
          <a :href="basePath ? `${basePath}?date=${currentDate ?? ''}` : '#'" :aria-label="$t('boards.news.backToList')"
            class="nd-focus nd-t1 -ml-[12px] flex h-[48px] w-[48px] items-center justify-center" @click.prevent="openStory(null)">
            <AppIcon name="arrowLeft" />
          </a>
          <span class="nd-meta nd-t2 nd-tnum">{{ $t('boards.news.position', { index: selectedPosition, total: items.length }) }}</span>
        </div>

        <div class="px-[16px] pb-[48px] min-[600px]:px-[24px]">
          <p class="flex flex-wrap items-center gap-[8px]">
            <span v-if="selected.rankLabel" class="nd-meta nd-strong nd-t2 nd-tnum">{{ selected.rankLabel }}</span>
            <span v-if="selected.verdict" class="nd-label inline-flex min-h-[20px] items-center rounded-sm px-[8px] py-1" :class="pillClass(selected.verdict)">
              {{ verdictText(selected.verdict) }}
            </span>
            <span v-if="selected.categoryLabel" class="nd-meta nd-t2">{{ selected.categoryLabel }}</span>
            <span v-if="selected.status === 'update'" class="nd-label nd-t1 ml-auto">{{ $t('boards.news.update') }}</span>
          </p>

          <h2 class="nd-display nd-t1 nd-de mt-[12px]" lang="de">{{ selected.title }}</h2>
          <p v-if="selected.take" class="nd-lead nd-t1 nd-de mt-[12px]" lang="de">{{ selected.take }}</p>

          <!--
            Take the story into a conversation. The primary button opens the
            composer with the snapshot, the secondary one puts the same text on
            the clipboard for a strand that is already open. Neither one sends
            anything: the question is the reader's.
          -->
          <div v-if="boardKey" class="mt-[20px] flex flex-wrap items-center gap-[8px]">
            <button type="button" data-testid="news-use-in-question"
              class="nd-focus nd-signal nd-label inline-flex min-h-[48px] items-center rounded-md px-[16px]"
              @click="useInQuestion">
              {{ $t('boards.news.useInQuestion') }}
            </button>
            <button type="button" data-testid="news-copy-context"
              class="nd-focus nd-outline-t2 nd-t1 nd-label inline-flex min-h-[48px] items-center rounded-md px-[16px]"
              @click="copyContext">
              {{ $t('boards.news.copyContext') }}
            </button>
          </div>
          <p v-if="boardKey" role="status" class="nd-meta nd-t2 mt-[8px]">
            {{ copied ? $t('boards.news.contextCopied') : $t('boards.news.useInQuestionHint') }}
          </p>

          <template v-if="selected.status === 'update' && selected.delta">
            <h3 class="nd-label nd-t2 mt-[32px]">{{ $t('boards.news.whatsNew') }}</h3>
            <p class="nd-body nd-t1 nd-de mt-[8px]" lang="de">{{ selected.delta }}</p>
          </template>

          <template v-if="selected.summary">
            <h3 class="nd-label nd-t2 mt-[32px]">{{ $t('boards.news.whatHappened') }}</h3>
            <p class="nd-body nd-t1 nd-de mt-[8px]" lang="de">{{ selected.summary }}</p>
          </template>

          <!-- The only tinted surface of the detail view. Never collapsed. -->
          <div v-if="selected.critique" class="nd-raised mt-[24px] rounded-md p-[16px]">
            <h3 class="nd-label nd-t2">{{ $t('boards.news.criticalTake') }}</h3>
            <p class="nd-body nd-t1 nd-de mt-[8px]" lang="de">{{ selected.critique }}</p>
          </div>

          <template v-if="selected.relevance">
            <h3 class="nd-label nd-t2 mt-[24px]">{{ $t('boards.news.forUs') }}</h3>
            <p class="nd-body nd-t1 nd-de mt-[8px]" lang="de">{{ selected.relevance }}</p>
          </template>

          <template v-if="selected.action?.text">
            <h3 class="nd-label nd-t2 mt-[24px]">
              {{ $t('boards.news.nextStep') }}<template v-if="actionLabelKey(selected.action.kind)">{{ metaSeparator }}{{ $t(actionLabelKey(selected.action.kind) as string) }}</template>
            </h3>
            <p class="nd-body nd-t1 nd-de mt-[8px]" lang="de">{{ selected.action.text }}</p>
          </template>

          <template v-if="selected.sources.length">
            <h3 class="nd-label nd-t2 mt-[32px]">{{ $t('boards.news.sources') }}</h3>
            <!--
              No firsthand source: the same sentence the list row carries, as the
              first line inside the section — no icon, no colour, no box, and the
              same distance to the list as between two source lines (8 px here
              plus the 8 px top padding of the row).
            -->
            <p v-if="selected.firsthandCount === 0" class="nd-meta nd-t2 mt-[8px]">{{ sourcesText(selected) }}&nbsp;·
              <span class="nd-t1 nd-strong">{{ firsthandText(selected) }}</span>
            </p>
            <ul class="mt-[8px]">
              <li v-for="(source, index) in selected.sources" :key="`source-${index}`">
                <component :is="source.url ? 'a' : 'div'" v-bind="source.url ? { href: source.url, target: '_blank', rel: 'noopener noreferrer' } : {}"
                  class="nd-row nd-focus flex min-h-[56px] items-start gap-[12px] py-[8px]">
                  <span aria-hidden="true" class="mt-[8px] h-[8px] w-[8px] shrink-0 rounded-full" :class="source.firsthand ? 'nd-dot-1' : 'nd-dot-2'" />
                  <span class="min-w-0 flex-1">
                    <span class="nd-body nd-t1 nd-de block" lang="de">{{ source.name }}</span>
                    <span class="nd-meta nd-t2 nd-tnum nd-wrap nd-id block"><template v-for="(part, p) in sourceMetaParts(source)" :key="`part-${p}`"><template v-if="p > 0">{{ metaSeparator }}</template><template v-for="(segment, s) in part" :key="`seg-${s}`"><template v-for="(run, r) in segment" :key="`run-${r}`"><span v-if="run.nobr" class="nd-nobr">{{ run.text }}</span><template v-else>{{ run.text }}</template></template><wbr v-if="s < part.length - 1" /></template></template></span>
                  </span>
                  <AppIcon v-if="source.url" name="externalLink" size="sm" class="nd-t2 mt-[4px] shrink-0" />
                </component>
              </li>
            </ul>
          </template>

          <a v-if="nextStory" :href="storyHref(nextStory)"
            class="nd-row nd-focus mt-[32px] flex min-h-[64px] flex-col justify-center" @click.prevent="openStory(nextStory)">
            <span class="nd-meta nd-t2">{{ $t('boards.news.nextStoryLabel') }}</span>
            <span class="nd-title nd-t1 nd-de" lang="de">{{ nextStory.title }}</span>
          </a>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
/*
 * The seven roles of the design spec, mapped onto the shell theme. Every
 * colour below is one of these variables — no literal colour in this file.
 */
.nd {
  --nd-bg: hsl(var(--surface));
  --nd-raised: hsl(var(--surface-container));
  --nd-line: hsl(var(--outline-variant));
  --nd-outline: hsl(var(--outline));
  --nd-text-1: hsl(var(--on-surface));
  --nd-text-2: hsl(var(--on-surface-variant));
  --nd-signal: hsl(var(--primary));
  --nd-on-signal: hsl(var(--on-primary));
  background-color: var(--nd-bg);
  color: var(--nd-text-1);
}
.nd-t1 { color: var(--nd-text-1); }
.nd-t2 { color: var(--nd-text-2); }
.nd-raised { background-color: var(--nd-raised); }
/* Separator, no contrast duty of its own (design decision 2026-09-28). */
.nd-line { border-color: var(--nd-line); }
/*
 * A line that is the ONLY boundary of a control (WCAG 1.4.11, ≥ 3:1): the edge
 * of the revision popover, whose raised surface alone does not separate it from
 * the page. Role `outline` of the shell, one step stronger than `line`.
 */
.nd-outline { border-color: var(--nd-outline); }
.nd-signal { background-color: var(--nd-signal); color: var(--nd-on-signal); }
.nd-outline-t2 { border: 1px solid var(--nd-text-2); }
.nd-bar { background-color: var(--nd-text-1); }
.nd-dot-1 { background-color: var(--nd-text-1); }
.nd-dot-2 { border: 1.5px solid var(--nd-text-2); }
/* Selected row in the two column layout: raised plus a 2 dp edge. */
.nd-selected { box-shadow: inset 2px 0 0 0 var(--nd-text-1); }

/*
 * Role `icon-glyph`: the day arrows ‹ › are a glyph, not a text step — 22/22/400.
 * The UI font draws them above the middle of their line box, so the ink would sit
 * high in the 48×48 target; the translate puts the visible centre of the glyph
 * on the centre of the area (measured, see the acceptance report), in em so a
 * text zoom keeps it there. The 48×48 target itself is untouched.
 */
.nd-icon-glyph {
  font-size: 1.375rem;
  line-height: 1.375rem;
  font-weight: 400;
  display: block;
  transform: translateY(-0.045em);
}

/*
 * Chevron of the footer disclosure, on the type of its label (14/20/400):
 *  - size 1 em, so a text zoom scales the glyph with the label (the `size`
 *    prop of the shell icon is a fixed pixel box and would stay behind),
 *  - the ink then covers the x-height of the label, and the stroke of the icon
 *    stays lighter than the stem of the type (measured, see the report),
 *  - the translate moves the middle of the ink from the middle of the line box
 *    onto the middle of the x-height of the label,
 *  - the rotation is driven by `aria-expanded`, so the drawn state cannot drift
 *    from the announced one; closed points right, open points down.
 */
.nd-disclosure :deep(.nd-chevron) {
  width: 1em;
  height: 1em;
  transform: translateY(0.09em);
}
.nd-disclosure[aria-expanded='true'] :deep(.nd-chevron) { transform: translateY(0.09em) rotate(90deg); }

/* Type scale: 12 / 14 / 16 / 18 / 22 in rem, weights 400 and 600 only. */
.nd-display { font-size: 1.375rem; line-height: 1.75rem; font-weight: 600; text-wrap: balance; }
.nd-title { font-size: 1.125rem; line-height: 1.5rem; font-weight: 600; }
.nd-lead { font-size: 1.125rem; line-height: 1.625rem; font-weight: 400; }
.nd-body { font-size: 1rem; line-height: 1.5rem; font-weight: 400; text-wrap: pretty; }
.nd-meta { font-size: 0.875rem; line-height: 1.25rem; font-weight: 400; }
.nd-label { font-size: 0.75rem; line-height: 1rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.nd-strong { font-weight: 600; }
.nd-tnum { font-variant-numeric: tabular-nums; }

/* German content: hyphenation instead of overflow; break as the last resort. */
.nd-de { hyphens: auto; -webkit-hyphens: auto; overflow-wrap: break-word; }
/*
 * Host names are one unbreakable word: "aggregator.example.net" is wider than
 * the 288 px column at 200 % text zoom, so the source line has to be allowed to
 * break inside the word — not hyphenated (it is not prose), just broken.
 */
.nd-wrap { overflow-wrap: anywhere; }
/* Locks the joint AFTER a hyphen of an identifier: "-m" stays together. */
.nd-nobr { white-space: nowrap; }
/* Identifiers (type, host, date): never an automatic hyphen, a hyphen would read as part of the address. */
.nd-id { hyphens: none; -webkit-hyphens: none; }
.nd-clamp-2 { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }

.nd-focus:focus-visible { outline: 2px solid var(--nd-text-1); outline-offset: 2px; }
@media (hover: hover) {
  .nd-row:hover { background-color: var(--nd-raised); }
}
.nd-row:active { background-color: var(--nd-raised); }
</style>
