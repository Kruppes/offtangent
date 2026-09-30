<!--
  A labelled list of short phrases (subjects, tools). Chips rather than a
  comma separated line, because the values end up as markdown bullets and a
  comma is a perfectly normal character inside a subject.

  Accessibility: the input carries the visible label, every remove button
  names the entry it removes, and Enter adds — so the whole control is usable
  from the keyboard without touching the mouse.
-->
<template>
  <div class="flex flex-col gap-2">
    <Label :for="id">{{ label }}</Label>
    <p v-if="hint" :id="`${id}-hint`" class="text-xs text-muted-foreground">{{ hint }}</p>

    <div class="flex gap-2">
      <Input
        :id="id"
        v-model="draft"
        class="min-h-11"
        :placeholder="placeholder"
        :aria-describedby="hint ? `${id}-hint` : undefined"
        autocomplete="off"
        @keydown.enter.prevent="add"
      />
      <Button type="button" variant="outline" class="min-h-11 shrink-0" :disabled="!draft.trim()" @click="add">
        {{ addLabel }}
      </Button>
    </div>

    <ul v-if="modelValue.length > 0" class="flex flex-wrap gap-2 pt-1">
      <li
        v-for="(entry, index) in modelValue"
        :key="`${entry}-${index}`"
        class="flex items-center gap-1 rounded-full border border-border bg-muted/50 py-1 pl-3 pr-1 text-sm text-foreground"
      >
        <span class="max-w-[14rem] truncate">{{ entry }}</span>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="`${removeLabel}: ${entry}`"
          @click="remove(index)"
        >
          <AppIcon name="close" class="h-3.5 w-3.5" />
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  id: string
  modelValue: string[]
  label: string
  hint?: string
  placeholder?: string
  addLabel: string
  removeLabel: string
}>()

const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const draft = ref('')

function add(): void {
  const value = draft.value.trim()
  if (!value) return
  if (props.modelValue.includes(value)) {
    draft.value = ''
    return
  }
  emit('update:modelValue', [...props.modelValue, value])
  draft.value = ''
}

function remove(index: number): void {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index))
}
</script>
