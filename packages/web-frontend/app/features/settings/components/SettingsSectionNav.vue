<script setup lang="ts">
import { groupSections, sectionPath } from '../settingsSections'

/**
 * Grouped area navigation next to an open settings area (desktop). Everyday
 * areas first, system areas below; link areas open their own page.
 */
defineProps<{ active: string | null }>()

const groups = groupSections()
</script>

<template>
  <nav
    :aria-label="$t('settings.sectionNav')"
    data-testid="settings-section-nav"
    class="w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border px-3 py-4"
  >
    <NuxtLink
      to="/settings"
      class="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AppIcon name="search" size="sm" />
      {{ $t('settings.overview.title') }}
    </NuxtLink>
    <div v-for="group in groups" :key="group.id" class="flex flex-col gap-1">
      <h2 :id="`settings-nav-${group.id}`" class="px-3 pb-1 text-xs font-semibold uppercase tracking-label text-muted-foreground">
        {{ $t(group.labelKey) }}
      </h2>
      <ul :aria-labelledby="`settings-nav-${group.id}`" class="flex flex-col gap-1">
        <li v-for="section in group.sections" :key="section.id">
          <NuxtLink
            :to="sectionPath(section)"
            :data-section-link="section.id"
            :aria-current="active === section.id ? 'page' : undefined"
            :class="[
              'flex min-h-11 items-center gap-2 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active === section.id
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            ]"
          >
            <AppIcon :name="section.icon" size="sm" />
            <span class="min-w-0 flex-1 truncate">{{ $t(section.labelKey) }}</span>
            <template v-if="section.save === 'link'">
              <AppIcon name="externalLink" size="sm" class="shrink-0" />
              <span class="sr-only">({{ $t('settings.sections.opensPage') }})</span>
            </template>
          </NuxtLink>
        </li>
      </ul>
    </div>
  </nav>
</template>
