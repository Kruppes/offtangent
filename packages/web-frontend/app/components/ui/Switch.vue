<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { SwitchRoot, SwitchThumb, type SwitchRootProps } from 'reka-ui'
import { cn } from '~/lib/utils'

// Extend SwitchRootProps but replace modelValue with checked
// so the component supports v-model:checked (shadcn convention)
interface Props extends /* @vue-ignore */ Omit<SwitchRootProps, 'modelValue'> {
  class?: HTMLAttributes['class']
  checked?: boolean
}

const props = defineProps<Props>()
const emits = defineEmits<{
  'update:checked': [value: boolean]
}>()

// Bridge: map checked/update:checked → modelValue/update:modelValue
const modelValue = computed({
  get: () => props.checked,
  set: (val) => emits('update:checked', !!val),
})
</script>

<template>
  <SwitchRoot
    v-model="modelValue"
    :disabled="props.disabled"
    :name="props.name"
    :required="props.required"
    :id="props.id"
    :as="props.as"
    :as-child="props.asChild"
    :class="cn(
      'peer relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
      props.class
    )"
  >
    <SwitchThumb
      :class="cn(
        'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
        'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0'
      )"
    />
  </SwitchRoot>
</template>
