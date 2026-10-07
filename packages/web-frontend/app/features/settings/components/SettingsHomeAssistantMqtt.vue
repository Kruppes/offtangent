<template>
  <div class="flex flex-col gap-5">
    <div>
      <h2 class="text-lg font-semibold">
        {{ $t('settings.mqtt.title') }}
      </h2><p class="text-sm text-muted-foreground">
        {{ $t('settings.mqtt.description') }}
      </p>
    </div>
    <p v-if="form">
      {{ $t(`settings.mqtt.${status}`) }}
    </p>
    <p
      v-if="message"
      role="status"
    >
      {{ message }}
    </p>
    <form
      v-if="form"
      class="flex flex-col gap-4"
      @submit.prevent="save"
    >
      <label class="flex gap-2"><input
        v-model="form.enabled"
        type="checkbox"
      />{{ $t('settings.mqtt.enabled') }}</label>
      <label
        v-for="field in fields"
        :key="field"
        class="flex flex-col gap-1 text-sm"
      >
        {{ $t(`settings.mqtt.${field}`) }}
        <input
          v-model="form[field]"
          class="rounded-md border border-border bg-background px-3 py-2"
          :type="field === 'port' || field === 'intervalSeconds' ? 'number' : 'text'"
          :min="field === 'port' ? 1 : 10"
          :max="field === 'port' ? 65535 : 3600"
          :required="field === 'host' && form.enabled"
          autocomplete="off"
        />
      </label>
      <label class="flex gap-2"><input
        v-model="form.tls"
        type="checkbox"
      />{{ $t('settings.mqtt.tls') }}</label>
      <label class="flex flex-col gap-1 text-sm">{{ $t('settings.mqtt.password') }}
        <input
          v-model="password"
          type="password"
          autocomplete="new-password"
          class="rounded-md border border-border bg-background px-3 py-2"
        />
        <span v-if="form.passwordSet">{{ $t('settings.mqtt.passwordSet') }}</span>
      </label>
      <label class="flex gap-2"><input
        v-model="clearPassword"
        type="checkbox"
      />{{ $t('settings.mqtt.clearPassword') }}</label>
      <fieldset class="flex flex-col gap-2">
        <legend>{{ $t('settings.mqtt.groups') }}</legend>
        <label
          v-for="group in groups"
          :key="group"
          class="flex gap-2"
        ><input
          v-model="form.groups[group]"
          type="checkbox"
        />{{ $t(`settings.mqtt.${group === 'status' ? 'statusGroup' : group}`) }}</label>
      </fieldset>
      <div class="flex gap-2">
        <button
          class="rounded-md border border-border px-4 py-2"
          :disabled="busy"
          type="submit"
        >
          {{ $t('settings.mqtt.save') }}
        </button>
        <button
          class="rounded-md border border-border px-4 py-2"
          :disabled="busy"
          type="button"
          @click="test"
        >
          {{ $t('settings.mqtt.test') }}
        </button>
      </div>
    </form>
  </div>
</template>
<script setup lang="ts">
interface MqttForm {
  enabled: boolean; host: string; port: number; tls: boolean; username: string; clientId: string
  discoveryPrefix: string; baseTopic: string; intervalSeconds: number; passwordSet: boolean
  groups: { limits: boolean; usage: boolean; activity: boolean; status: boolean }
  status: 'off' | 'connecting' | 'connected' | 'error'
}
const { apiFetch } = useApi()
const { t } = useI18n()
const form = ref<MqttForm | null>(null)
const password = ref('')
const clearPassword = ref(false)
const status = ref<MqttForm['status']>('off')
const message = ref('')
const busy = ref(false)
const fields = ['host', 'port', 'username', 'clientId', 'discoveryPrefix', 'baseTopic', 'intervalSeconds'] as const
const groups = ['limits', 'usage', 'activity', 'status'] as const
async function load() {
  try { const data = await apiFetch<MqttForm>('/api/settings/mqtt'); form.value = data; status.value = data.status }
  catch (err) { message.value = String(err) }
}
async function save() {
  if (!form.value) return
  busy.value = true; message.value = ''
  try {
    const { passwordSet: _passwordSet, status: _status, ...settings } = form.value
    const result = await apiFetch<MqttForm>('/api/settings/mqtt', { method: 'PUT', body: JSON.stringify({ ...settings, port: Number(settings.port), intervalSeconds: Number(settings.intervalSeconds), ...(password.value ? { password: password.value } : {}), clearPassword: clearPassword.value }) })
    form.value = result; status.value = result.status; password.value = ''; clearPassword.value = false; message.value = t('settings.mqtt.saved')
  } catch (err) { message.value = String(err) }
  finally { busy.value = false }
}
async function test() {
  busy.value = true; message.value = ''
  try { const result = await apiFetch<{ connected: boolean }>('/api/settings/mqtt/test', { method: 'POST' }); message.value = t(result.connected ? 'settings.mqtt.testSuccess' : 'settings.mqtt.testFailed') }
  catch (err) { message.value = String(err) }
  finally { busy.value = false }
}
onMounted(() => { void load() })
</script>
