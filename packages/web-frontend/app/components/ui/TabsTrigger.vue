<script setup lang="ts">
import { type HTMLAttributes, computed, ref, useAttrs, useId } from 'vue'
import { TabsTrigger, type TabsTriggerProps } from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends TabsTriggerProps {
  class?: HTMLAttributes['class']
  /** Why the tab is locked; announced as description and shown on tap/hover. */
  disabledReason?: string
}

defineOptions({ inheritAttrs: false })
const props = defineProps<Props>()
const attrs = useAttrs()

// A locked tab stays focusable (aria-disabled, not the native disabled
// attribute), so keyboard and screen-reader users reach it and hear why it is
// locked. reka-ui therefore never sees `disabled`; activation is blocked here.
const delegatedProps = computed(() => {
  const { class: _, disabledReason: __, disabled: ___, ...delegated } = props
  return delegated
})
const locked = computed(() => !!props.disabled)
const reasonId = useId()
const reason = computed(() => (props.disabled && props.disabledReason) || undefined)
const reasonOpen = ref(false)
// Escape hides the note shown on keyboard focus without moving the focus (1.4.13).
const reasonDismissed = ref(false)
const reasonStyle = ref<Record<string, string>>({})

function block(event: Event) {
  if (!locked.value) return
  event.preventDefault()
  event.stopImmediatePropagation()
}
function blockKeys(event: KeyboardEvent) {
  if (locked.value && (event.key === 'Enter' || event.key === ' ')) {
    block(event)
    toggleReason(event)
  }
  else if (event.key === 'Escape') {
    reasonOpen.value = false
    reasonDismissed.value = true
  }
}
function blockFocus(event: FocusEvent) {
  // reka-ui activates a tab on focus (automatic activation); a locked tab
  // takes the focus but never becomes the active tab.
  if (!locked.value) return
  event.stopImmediatePropagation()
  // The note shows by CSS while the tab has keyboard focus; place it under the tab.
  placeReason(event.currentTarget as HTMLElement | null)
}
function placeReason(el: HTMLElement | null) {
  if (el) reasonStyle.value = { left: `${el.offsetLeft}px`, top: `${el.offsetTop + el.offsetHeight + 4}px` }
}
function onBlur() {
  reasonOpen.value = false
  reasonDismissed.value = false
}
function toggleReason(event: Event) {
  if (!reason.value) return
  placeReason(event.currentTarget as HTMLElement | null)
  reasonOpen.value = !reasonOpen.value
  reasonDismissed.value = !reasonOpen.value
}
function onClick(event: MouseEvent) {
  if (!locked.value) return
  block(event)
  toggleReason(event)
}
</script>

<template>
  <!--
    A locked tab is marked by the secondary-text step N4 plus a lock icon
    (no strike-through, which reads as "deleted"). aria-disabled carries the
    state; the reason, when known, is the accessible description and appears
    as a visible note on tap or Enter (touch has no hover), while the tab has
    keyboard focus (:focus-visible, see `.tab-lock-reason`), plus the title on
    mouse hover. The note sits outside the tab as its next sibling, so it is
    not part of the tab's name; it never takes the focus itself, Escape hides
    it and it goes away on blur.
  -->
  <TabsTrigger
    v-bind="{ ...attrs, ...delegatedProps }"
    :aria-disabled="locked ? 'true' : undefined"
    :data-locked="locked ? '' : undefined"
    :title="reason"
    :aria-describedby="reason ? reasonId : undefined"
    :class="cn(
      'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-2 max-md:min-h-11 text-sm font-medium ring-offset-background transition-all',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground',
      'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:selected-marker-bottom',
      props.class
    )"
    @mousedown.capture="block"
    @keydown.capture="blockKeys"
    @focus.capture="blockFocus"
    @click.capture="onClick"
    @blur="onBlur"
  >
    <AppIcon v-if="locked" name="lock" class="h-3.5 w-3.5" data-testid="tab-lock" />
    <slot />
  </TabsTrigger>
  <span
    v-if="reason"
    :id="reasonId"
    role="note"
    data-testid="tab-lock-reason"
    class="tab-lock-reason absolute z-50 max-w-64 whitespace-normal rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
    :data-open="reasonOpen ? '' : undefined"
    :data-dismissed="reasonDismissed ? '' : undefined"
    :style="reasonStyle"
  >{{ reason }}</span>
</template>
