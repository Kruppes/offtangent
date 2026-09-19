<template>
  <div
    role="button"
    tabindex="0"
    class="flex w-full cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/50"
    @click="$emit('edit')"
    @keydown.enter.self="$emit('edit')"
  >
    <div class="flex items-start gap-2">
      <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ cronjob.name }}</span>
      <Badge :variant="cronjob.actionType === 'injection' ? 'warning' : 'default'" class="shrink-0">
        {{ cronjob.actionType === 'injection' ? $t('cronjobs.actionTypeInjection') : $t('cronjobs.actionTypeTask') }}
      </Badge>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="sm" class="-my-1 -mr-2 h-7 w-7 shrink-0 p-0" @click.stop>
            <AppIcon name="moreVertical" size="sm" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" @click.stop>
          <DropdownMenuItem @click="$emit('edit')">
            <AppIcon name="edit" size="sm" class="mr-2" />
            {{ $t('common.edit') }}
          </DropdownMenuItem>
          <DropdownMenuItem @click="$emit('trigger')">
            <AppIcon name="send" size="sm" class="mr-2" />
            {{ $t('cronjobs.runNow') }}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive @click="$emit('delete')">
            <AppIcon name="trash" size="sm" class="mr-2" />
            {{ $t('common.delete') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div v-if="hasBadges" class="flex flex-wrap items-center gap-1.5">
      <Badge v-if="cronjob.toolsOverride" variant="outline" class="text-xs">
        {{ $t('cronjobs.badges.customTools') }}
      </Badge>
      <Badge v-if="cronjob.skillsOverride" variant="outline" class="text-xs">
        {{ $t('cronjobs.badges.customSkills') }}
      </Badge>
      <Badge v-if="cronjob.systemPromptOverride" variant="outline" class="text-xs">
        {{ $t('cronjobs.badges.customPrompt') }}
      </Badge>
      <Badge
        v-for="skill in cronjob.attachedSkills || []"
        :key="`attached-${skill}`"
        variant="secondary"
        class="text-xs font-normal"
        :title="$t('cronjobs.badges.attachedSkillTooltip', { name: skill })"
      >
        📎 {{ skill }}
      </Badge>
    </div>

    <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      <div class="flex min-w-0 flex-col">
        <span class="text-foreground">{{ cronjob.scheduleHuman }}</span>
        <span class="font-mono text-muted-foreground">{{ cronjob.schedule }}</span>
      </div>
      <div class="min-w-0">
        <dt class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {{ $t('cronjobs.columns.lastRun') }}
        </dt>
        <dd v-if="cronjob.lastRunAt" class="flex min-w-0 flex-col items-start gap-0.5">
          <Badge :variant="cronjobLastRunVariant(cronjob.lastRunStatus)" class="px-1.5 py-0 text-[10px]">
            {{ cronjob.lastRunStatus ?? '—' }}
          </Badge>
          <span class="truncate text-muted-foreground">{{ formatTimestamp(cronjob.lastRunAt) }}</span>
        </dd>
        <dd v-else class="text-muted-foreground">—</dd>
      </div>
    </dl>

    <div class="flex items-end justify-between gap-3 text-xs">
      <div v-if="cronjob.actionType === 'task'" class="min-w-0 flex-1">
        <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {{ $t('cronjobs.columns.provider') }}
        </div>
        <div class="truncate text-foreground">{{ providerLabel }}</div>
      </div>
      <div class="ml-auto shrink-0" @click.stop>
        <Switch
          :checked="cronjob.enabled"
          :aria-label="$t('cronjobs.columns.enabled')"
          @update:checked="(val: boolean) => $emit('toggle', val)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Cronjob } from '~/composables/useCronjobs'
import { cronjobLastRunVariant } from '~/features/cronjobs/utils/cronjobFormat'

const props = defineProps<{
  cronjob: Cronjob
  providerLabel: string
}>()

defineEmits<{
  edit: []
  trigger: []
  delete: []
  toggle: [enabled: boolean]
}>()

const { formatTimestamp } = useFormat()

const hasBadges = computed(() => [
  props.cronjob.toolsOverride,
  props.cronjob.skillsOverride,
  props.cronjob.systemPromptOverride,
  props.cronjob.attachedSkills?.length,
].some(Boolean))
</script>
