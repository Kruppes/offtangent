<script setup lang="ts">
interface Route { id: string; label: string; backend: string; model: string; status: string; cost: Record<string, unknown> }
interface Result { default_route: string; routes: Route[]; errors: string[] }
const { apiFetch } = useApi()
const data = ref<Result | null>(null)
const error = ref('')
async function refresh() {
  try { data.value = await apiFetch<Result>('/api/settings/generators'); error.value = '' }
  catch (e) { error.value = e instanceof Error ? e.message : 'Failed to load routes' }
}
onMounted(refresh)
</script>

<template>
  <section
    aria-labelledby="generators-heading"
    class="space-y-4"
  >
    <h2
      id="generators-heading"
      class="text-xl font-semibold"
    >
      {{ $t('settings.sections.generators') }}
    </h2>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }} <button
        type="button"
        @click="refresh()"
      >
        Retry
      </button>
    </p>
    <template v-if="data">
      <p>Default route: {{ data.default_route || '—' }}</p>
      <ul
        v-if="data.errors.length"
        class="list-disc pl-6"
        role="alert"
      >
        <li
          v-for="message in data.errors"
          :key="message"
        >
          {{ message }}
        </li>
      </ul>
      <ul class="divide-y divide-border rounded-lg border border-border">
        <li
          v-for="route in data.routes"
          :key="route.id"
          class="p-4"
        >
          <strong>{{ route.label }}</strong> ({{ route.id }})
          <p>{{ route.backend }} · {{ route.model }} · {{ route.status }} · {{ route.cost.eur_per_image ?? route.cost.usd_per_megapixel ?? 0 }} {{ route.cost.usd_per_megapixel !== undefined ? 'USD/MP' : 'EUR/image' }}</p>
        </li>
      </ul>
    </template>
  </section>
</template>
