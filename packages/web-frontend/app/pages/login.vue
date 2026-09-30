<template>
  <div class="w-full max-w-sm px-5">
    <Card class="shadow-lg">
      <CardHeader class="items-center gap-2 pb-6 text-center">
        <AppLogo size="lg" />
        <CardTitle class="mt-2 text-2xl font-bold">{{ $t('app.title') }}</CardTitle>
      </CardHeader>

      <CardContent>
        <form class="flex flex-col gap-5" @submit.prevent="handleLogin">
          <!-- Username -->
          <div class="flex flex-col gap-1.5">
            <Label for="username">{{ $t('auth.username') }}</Label>
            <Input
              class="min-h-11"
              id="username"
              v-model="username"
              type="text"
              :placeholder="$t('auth.username')"
              autocomplete="username"
              required
              autofocus
            />
          </div>

          <!-- Password -->
          <div class="flex flex-col gap-1.5">
            <Label for="password">{{ $t('auth.password') }}</Label>
            <Input
              class="min-h-11"
              id="password"
              v-model="password"
              type="password"
              :placeholder="$t('auth.password')"
              autocomplete="current-password"
              required
            />
          </div>

          <!-- Error -->
          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>

          <!-- Submit -->
          <Button
            type="submit"
            class="min-h-11 w-full gap-2"
            :disabled="loading"
          >
            <span
              v-if="loading"
              class="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
              aria-hidden="true"
            />
            {{ loading ? '…' : $t('auth.loginButton') }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>

<script setup lang="ts">
definePageMeta({
  layout: 'blank',
})

const { t } = useI18n()
const { login } = useAuth()

const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function handleLogin() {
  error.value = ''
  loading.value = true

  try {
    const result = await login(username.value, password.value)
    if (result.success) {
      await navigateTo('/')
    } else {
      error.value = result.error || t('auth.loginError')
    }
  } catch {
    error.value = t('auth.loginError')
  } finally {
    loading.value = false
  }
}
</script>
