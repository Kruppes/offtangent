<script setup lang="ts">
/**
 * Keyboard help (W3, `?`): every shortcut of the shell from the one binding
 * table plus the keys handled elsewhere (Enter on a row, dictation, palette).
 */
import { computed, onBeforeUnmount, watch } from 'vue'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { displayKeys, helpSections, isMacPlatform } from '~/utils/shortcuts'
import { useShortcutOverlay } from '~/composables/useShortcuts'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const { t } = useI18n()
const overlay = useShortcutOverlay()
const mac = typeof navigator !== 'undefined' && isMacPlatform(navigator)
const sections = computed(() => helpSections().map(section => ({
  ...section,
  rows: section.rows.map(row => ({ ...row, combos: row.combos.map(combo => displayKeys(combo, mac)) })),
})))

watch(() => props.open, (open, wasOpen) => {
  if (open !== Boolean(wasOpen)) overlay.setOverlayOpen(open)
}, { immediate: true })
onBeforeUnmount(() => { if (props.open) overlay.setOverlayOpen(false) })
</script>

<template>
  <DialogRoot :open="open" @update:open="value => emit('update:open', value)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-fade-in" />
      <DialogContent
        data-testid="shortcut-help"
        class="fixed inset-x-3 top-3 z-50 mx-auto flex max-h-[calc(100dvh-1.5rem)] max-w-[32rem] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-overlay focus:outline-none sm:top-[10vh] sm:max-h-[80vh]"
      >
        <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border py-2 pl-6 pr-2">
          <DialogTitle class="text-lg font-semibold">{{ t('shortcuts.title') }}</DialogTitle>
          <DialogClose class="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="t('common.close')">
            <AppIcon name="x" aria-hidden="true" />
          </DialogClose>
        </div>
        <div class="min-h-0 overflow-y-auto px-6 pb-6">
          <DialogDescription class="pt-3 text-sm text-muted-foreground">{{ t('shortcuts.description') }}</DialogDescription>
          <section v-for="section in sections" :key="section.group" class="mt-4" :aria-labelledby="`shortcut-group-${section.group}`">
            <h3 :id="`shortcut-group-${section.group}`" class="text-xs font-semibold text-muted-foreground">{{ t(`shortcuts.group.${section.group}`) }}</h3>
            <table class="mt-1 w-full text-sm">
              <tbody>
                <tr v-for="row in section.rows" :key="row.id" class="border-b border-border last:border-b-0" :data-shortcut="row.id">
                  <td class="py-2 pr-4">{{ t(`shortcuts.action.${row.id.replace('.', '_')}`) }}</td>
                  <td class="whitespace-nowrap py-2 text-right">
                    <template v-for="(combo, i) in row.combos" :key="i">
                      <span v-if="i > 0" class="px-1 text-muted-foreground">{{ t('shortcuts.or') }}</span>
                      <kbd v-for="key in combo" :key="key" class="ml-1 inline-block min-w-6 rounded-md border border-border bg-muted px-2 text-center font-mono text-xs">{{ key }}</kbd>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
