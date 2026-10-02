<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { groupSections, searchSettings, sectionPath } from '../settingsSections'

/**
 * Settings overview (/settings): search over area and setting names, then the
 * areas grouped into everyday and system. On phones this is the list the
 * user drills down from.
 */
const props = defineProps<{ initialQuery?: string }>()
const { t } = useI18n()
const query = ref(props.initialQuery ?? '')
const groups = groupSections()
const hits = computed(() => searchSettings(query.value, key => t(key)))
const searching = computed(() => query.value.trim().length > 0)
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-8" data-testid="settings-overview">
    <h2 class="mb-4 text-lg font-semibold tracking-tight text-foreground md:sr-only">
      {{ $t('settings.overview.title') }}
    </h2>
    <form role="search" class="relative mb-6" @submit.prevent>
      <label for="settings-search" class="sr-only">{{ $t('settings.overview.searchLabel') }}</label>
      <AppIcon name="search" size="sm" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input
        id="settings-search"
        v-model="query"
        name="settings-search"
        type="search"
        autocomplete="off"
        :placeholder="$t('settings.overview.searchPlaceholder')"
        class="min-h-11 w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
        @keydown.esc="query = ''"
      >
    </form>

    <!-- Search results -->
    <template v-if="searching">
      <p class="sr-only" role="status" aria-live="polite">{{ $t('settings.overview.resultCount', { count: hits.length }) }}</p>
      <div v-if="hits.length === 0" class="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground" data-testid="settings-search-empty">
        <p class="break-words">{{ $t('settings.overview.noResults', { query: query.trim() }) }}</p>
        <button
          type="button"
          class="mt-3 inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm text-foreground hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @click="query = ''"
        >
          {{ $t('settings.overview.clearSearch') }}
        </button>
      </div>
      <ul v-else class="flex flex-col gap-2" data-testid="settings-search-results">
        <li v-for="hit in hits" :key="hit.section.id">
          <NuxtLink
            :to="sectionPath(hit.section)"
            :data-section-link="hit.section.id"
            class="flex min-h-11 items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AppIcon :name="hit.section.icon" size="sm" class="mt-0.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium text-foreground">{{ hit.label }}</span>
              <span v-if="hit.matches.length" class="mt-0.5 block break-words text-sm text-muted-foreground">
                <span class="sr-only">{{ $t('settings.overview.matchesIn') }}: </span>{{ hit.matches.join(' · ') }}
              </span>
              <span v-else class="mt-0.5 block break-words text-sm text-muted-foreground">{{ $t(hit.section.descriptionKey) }}</span>
            </span>
            <AppIcon :name="hit.section.save === 'link' ? 'externalLink' : 'chevronRight'" size="sm" class="mt-0.5 shrink-0 text-muted-foreground" />
          </NuxtLink>
        </li>
      </ul>
    </template>

    <!-- Grouped list -->
    <div v-else class="flex flex-col gap-8">
      <section v-for="group in groups" :key="group.id" :aria-labelledby="`settings-group-${group.id}`">
        <h3 :id="`settings-group-${group.id}`" class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {{ $t(group.labelKey) }}
        </h3>
        <p class="mb-3 mt-1 text-sm text-muted-foreground">{{ $t(group.descriptionKey) }}</p>
        <ul class="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          <li v-for="section in group.sections" :key="section.id">
            <NuxtLink
              :to="sectionPath(section)"
              :data-section-link="section.id"
              class="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <AppIcon :name="section.icon" size="sm" class="shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-foreground">{{ $t(section.labelKey) }}</span>
                <span class="block break-words text-sm text-muted-foreground">{{ $t(section.descriptionKey) }}</span>
              </span>
              <AppIcon
                :name="section.save === 'link' ? 'externalLink' : 'chevronRight'"
                size="sm"
                class="shrink-0 text-muted-foreground"
              />
              <span v-if="section.save === 'link'" class="sr-only">({{ $t('settings.sections.opensPage') }})</span>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
