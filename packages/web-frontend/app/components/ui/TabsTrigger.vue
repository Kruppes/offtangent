<script setup lang="ts">
import { type HTMLAttributes, computed, useId } from 'vue'
import { TabsTrigger, type TabsTriggerProps } from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends TabsTriggerProps {
  class?: HTMLAttributes['class']
  /** Why the tab is locked; shown as tooltip and announced as description. */
  disabledReason?: string
}

const props = defineProps<Props>()

const delegatedProps = computed(() => {
  const { class: _, disabledReason: __, ...delegated } = props
  return delegated
})
const reasonId = useId()
const reason = computed(() => (props.disabled && props.disabledReason) || undefined)
</script>

<template>
  <!--
    A locked tab is marked by the secondary-text step N4 plus a lock icon
    (no strike-through, which reads as "deleted"). The native disabled
    attribute set by reka-ui carries the state for assistive technology; the
    reason, when known, is a tooltip and the accessible description.
  -->
  <TabsTrigger
    v-bind="delegatedProps"
    :title="reason"
    :aria-describedby="reason ? reasonId : undefined"
    :class="cn(
      'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2 max-md:min-h-11 text-sm font-medium ring-offset-background transition-all',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:text-muted-foreground',
      'data-[state=active]:bg-background data-[state=active]:text-foreground',
      props.class
    )"
  >
    <AppIcon v-if="disabled" name="lock" class="h-3.5 w-3.5" data-testid="tab-lock" />
    <slot />
    <span v-if="reason" :id="reasonId" class="sr-only">{{ reason }}</span>
  </TabsTrigger>
</template>
