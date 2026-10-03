<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '~/lib/utils'

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class']
  type?: string
  placeholder?: string
  disabled?: boolean
  readonly?: boolean
  modelValue?: string | number
  id?: string
  name?: string
  autocomplete?: string
  autofocus?: boolean
  required?: boolean
}>(), {
  type: 'text',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'input', event: Event): void
  (e: 'change', event: Event): void
  (e: 'blur', event: FocusEvent): void
  (e: 'focus', event: FocusEvent): void
}>()

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', target.value)
  emit('input', event)
}
</script>

<template>
  <input
    :id="id"
    :name="name"
    :type="type"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :value="modelValue"
    :autocomplete="autocomplete"
    :autofocus="autofocus"
    :required="required"
    :class="cn(
      'flex h-10 max-md:h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
      'file:border-0 file:bg-transparent file:text-sm file:font-medium',
      'placeholder:text-muted-foreground',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      // On touch devices Chrome moves focus into the inner fields of a date/time input, so
      // neither :focus nor :focus-visible matches the host; :focus-within does.
      /^(date|time|datetime-local|month|week)$/.test(type) && 'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
      'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
      'transition-colors',
      props.class
    )"
    v-bind="$attrs"
    @input="handleInput"
    @change="$emit('change', $event)"
    @blur="$emit('blur', $event)"
    @focus="$emit('focus', $event)"
  />
</template>
