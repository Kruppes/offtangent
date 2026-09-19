<script setup lang="ts">
import { computed } from 'vue'
import { SelectRoot, type SelectRootEmits, type SelectRootProps, useForwardPropsEmits } from 'reka-ui'
import { EMPTY_SENTINEL } from '~/lib/selectUtils'

const props = defineProps<SelectRootProps>()
const emits = defineEmits<SelectRootEmits>()

// Map "" ↔ sentinel in both props and emits so reka-ui never sees value="".
// We keep useForwardPropsEmits (which relies on getCurrentInstance()) intact
// for correct controlled-vs-uncontrolled prop detection.
const mappedProps = computed(() => ({
  ...props,
  modelValue: props.modelValue === '' ? EMPTY_SENTINEL : props.modelValue,
  defaultValue: props.defaultValue === '' ? EMPTY_SENTINEL : props.defaultValue,
}))

const wrappedEmit = ((name: string, ...args: any[]) => {
  if (name === 'update:modelValue') {
    emits('update:modelValue', args[0] === EMPTY_SENTINEL ? '' : args[0])
  } else {
    (emits as any)(name, ...args)
  }
}) as typeof emits

const forwarded = useForwardPropsEmits(mappedProps, wrappedEmit)
</script>

<template>
  <SelectRoot v-bind="forwarded">
    <slot />
  </SelectRoot>
</template>
