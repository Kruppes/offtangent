<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Settings page -->
  <div v-else class="flex h-full flex-col overflow-hidden">
    <!-- Header with save action (hidden on secrets tab which has its own save flow) -->
    <PageHeader :title="$t('settings.title')" :subtitle="$t('settings.subtitle')">
      <template v-if="activeTab !== 'secrets' && activeTab !== 'email' && activeTab !== 'models'" #actions>
        <Button class="h-8 px-3 text-xs md:h-10 md:px-4 md:py-2 md:text-sm" :disabled="saving || !form" @click="handleSave">
          <span
            v-if="saving"
            class="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
            aria-hidden="true"
          />
          {{ $t('settings.save') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Feedback alerts — only for non-secrets tabs (secrets tab handles its own feedback) -->
    <div v-if="activeTab !== 'secrets' && activeTab !== 'email' && activeTab !== 'models' && (error || successMessage)" class="shrink-0 border-b border-border px-6 py-3">
      <Alert v-if="error" variant="destructive">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearMessages()"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>
      <Alert v-if="successMessage" variant="success" :class="error ? 'mt-2' : ''">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ $t('settings.saveSuccess') }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearMessages()"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>
    </div>

    <!-- Settings layout: sidebar nav + content -->
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">

      <!-- Tab navigation — horizontal on mobile, vertical sidebar on desktop -->
      <nav
        role="tablist"
        :aria-label="$t('settings.title')"
        class="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-3 py-2
               md:w-52 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-4"
      >
        <button
          v-for="tab in tabs"
          :key="tab.id"
          role="tab"
          type="button"
          :aria-selected="activeTab === tab.id"
          :class="[
            'flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors',
            'md:w-full',
            activeTab === tab.id
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
          ]"
          @click="activeTab = tab.id"
        >
          <AppIcon :name="tab.icon" size="sm" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <!-- Content area -->
      <div class="flex-1 overflow-y-auto" role="tabpanel">
        <div :class="['mx-auto px-6 py-6 md:px-8 md:py-8', activeTab === 'email' ? 'max-w-5xl' : 'max-w-xl']">

          <!-- Loading skeletons -->
          <div v-if="loading" class="flex flex-col gap-6">
            <div>
              <Skeleton class="mb-2 h-5 w-28" />
              <Skeleton class="h-4 w-72" />
            </div>
            <div>
              <Skeleton class="mb-1.5 h-4 w-24" />
              <Skeleton class="h-10 w-44" />
              <Skeleton class="mt-1.5 h-3 w-56" />
            </div>
            <div>
              <Skeleton class="mb-1.5 h-4 w-20" />
              <Skeleton class="h-10 w-56" />
              <Skeleton class="mt-1.5 h-3 w-48" />
            </div>
          </div>

          <!-- Tab content -->
          <template v-else-if="form">

            <!-- ═══ Agent ═══ -->
            <div v-if="activeTab === 'agent'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.agent') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.agentDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Agent Rules -->
                <div class="rounded-xl border border-border bg-card px-4 py-4">
                  <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <AppIcon name="file" size="sm" class="text-muted-foreground" />
                        <h3 class="text-sm font-semibold text-foreground">
                          {{ $t('settings.agentRulesTitle') }}
                        </h3>
                      </div>
                      <p class="mt-1 text-sm text-muted-foreground">
                        {{ $t('settings.agentRulesDescription') }}
                      </p>
                      <div class="mt-3 inline-flex max-w-full items-center rounded-md border border-border bg-muted/50 px-2.5 py-1">
                        <span class="truncate font-mono text-xs text-muted-foreground">/data/config/AGENTS.md</span>
                      </div>
                    </div>

                    <Button as-child variant="outline" class="shrink-0">
                      <NuxtLink to="/instructions?file=agents">
                        {{ $t('settings.openEditor') }}
                        <AppIcon name="externalLink" size="sm" />
                      </NuxtLink>
                    </Button>
                  </div>
                </div>

                <Separator />

                <!-- Multi-Persona -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.multiPersonaTitle') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.multiPersonaDescription') }}
                  </p>
                </div>

                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="multi-persona-enabled" class="cursor-pointer">
                      {{ $t('settings.multiPersonaEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.multiPersonaEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="multi-persona-enabled"
                    v-model:checked="form.multiPersona.enabled"
                  />
                </div>

                <template v-if="form.multiPersona.enabled">
                  <div class="flex flex-col gap-2">
                    <Label for="multi-persona-default-agent">{{ $t('settings.multiPersonaDefaultAgentId') }}</Label>
                    <Input
                      id="multi-persona-default-agent"
                      :model-value="form.multiPersona.defaultAgentId"
                      disabled
                      class="font-mono"
                    />
                    <p class="text-xs text-muted-foreground">{{ $t('settings.multiPersonaDefaultAgentIdHint') }}</p>
                  </div>

                  <div class="rounded-xl border border-border bg-card px-4 py-4">
                    <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div class="min-w-0">
                        <div class="flex items-center gap-2">
                          <AppIcon name="bot" size="sm" class="text-muted-foreground" />
                          <h3 class="text-sm font-semibold text-foreground">
                            {{ $t('settings.multiPersonaManageLink') }}
                          </h3>
                        </div>
                      </div>
                      <Button as-child variant="outline" class="shrink-0">
                        <NuxtLink to="/personas">
                          {{ $t('settings.multiPersonaManageLink') }}
                          <AppIcon name="externalLink" size="sm" />
                        </NuxtLink>
                      </Button>
                    </div>
                  </div>
                </template>

                <!-- Language -->
                <div class="flex flex-col gap-2">
                  <Label for="language-select">{{ $t('settings.language') }}</Label>
                  <Select v-model="form.language">
                    <SelectTrigger id="language-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="match">{{ $t('settings.languageMatch') }}</SelectItem>
                      <SelectItem value="English">{{ $t('settings.languages.english') }}</SelectItem>
                      <SelectItem value="German">{{ $t('settings.languages.german') }}</SelectItem>
                      <SelectItem value="French">{{ $t('settings.languages.french') }}</SelectItem>
                      <SelectItem value="Spanish">{{ $t('settings.languages.spanish') }}</SelectItem>
                      <SelectItem value="Italian">{{ $t('settings.languages.italian') }}</SelectItem>
                      <SelectItem value="Portuguese">{{ $t('settings.languages.portuguese') }}</SelectItem>
                      <SelectItem value="Dutch">{{ $t('settings.languages.dutch') }}</SelectItem>
                      <SelectItem value="Russian">{{ $t('settings.languages.russian') }}</SelectItem>
                      <SelectItem value="Chinese">{{ $t('settings.languages.chinese') }}</SelectItem>
                      <SelectItem value="Japanese">{{ $t('settings.languages.japanese') }}</SelectItem>
                      <SelectItem value="Korean">{{ $t('settings.languages.korean') }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.languageHint') }}</p>
                </div>

                <!-- Timezone -->
                <div class="flex flex-col gap-2">
                  <Label for="timezone-select">{{ $t('settings.timezone') }}</Label>
                  <Select v-model="form.timezone">
                    <SelectTrigger id="timezone-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="tz in timezones" :key="tz" :value="tz">{{ tz }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.timezoneHint') }}</p>
                </div>

                <!-- Active Provider -->
                <div class="flex flex-col gap-2">
                  <Label for="active-provider">{{ $t('settings.activeProvider') }}</Label>
                  <Select :model-value="activeProviderModelValue" @update:model-value="(v) => handleActivateProvider(v as string)">
                    <SelectTrigger id="active-provider">
                      <SelectValue :placeholder="$t('settings.activeProviderPlaceholder')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="opt in providerModelOptions" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.activeProviderHint') }}</p>
                </div>

                <!-- Thinking level (main chat agent) -->
                <div class="flex flex-col gap-2">
                  <Label for="thinking-level">{{ $t('settings.thinkingLevel') }}</Label>
                  <Select v-model="form.thinkingLevel">
                    <SelectTrigger id="thinking-level">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="lvl in thinkingLevelOptions" :key="lvl.value" :value="lvl.value">
                        {{ lvl.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.thinkingLevelHint') }}</p>
                </div>

                <!-- ─── Storage ─── -->
                <Separator />

                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.storageSection') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.storageSectionDescription') }}
                  </p>
                </div>

                <!-- Upload retention -->
                <div class="flex flex-col gap-2">
                  <Label for="upload-retention">{{ $t('settings.uploadRetention') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="upload-retention"
                      v-model.number="form.uploads.retentionDays"
                      type="number"
                      min="0"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.days') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.uploadRetentionHint') }}</p>
                </div>

                <!-- ─── Now set ─── -->
                <Separator />

                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.nowSetSection') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.nowSetSectionDescription') }}
                  </p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="now-set-max">{{ $t('settings.nowSetMax') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="now-set-max"
                      v-model.number="form.offtangent.nowSetMax"
                      type="number"
                      :min="NOW_SET_MAX_RANGE.min"
                      :max="NOW_SET_MAX_RANGE.max"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.nowSetMaxUnit') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">
                    {{ $t('settings.nowSetMaxHint', { min: NOW_SET_MAX_RANGE.min, max: NOW_SET_MAX_RANGE.max }) }}
                  </p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="now-set-mode">{{ $t('settings.nowSetMode') }}</Label>
                  <Select v-model="form.offtangent.nowSetMode">
                    <SelectTrigger id="now-set-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="opt in nowSetModeOptions" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">
                    {{ $t('settings.nowSetModeHint') }}
                  </p>
                </div>

                <!-- ─── Capture mode: quick question ─── -->
                <Separator />

                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.quickModeSection') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.quickModeSectionDescription') }}
                  </p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="quick-mode-model">{{ $t('settings.quickModeModel') }}</Label>
                  <Select :model-value="quickModeModelValue" @update:model-value="(v) => setQuickModeModel(v as string)">
                    <SelectTrigger id="quick-mode-model">
                      <SelectValue :placeholder="$t('settings.quickModeModelInherit')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{{ $t('settings.quickModeModelInherit') }}</SelectItem>
                      <SelectItem v-for="opt in providerModelOptions" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.quickModeModelHint') }}</p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="quick-mode-thinking">{{ $t('settings.quickModeThinkingLevel') }}</Label>
                  <Select v-model="form.captureModes.quick.thinkingLevel">
                    <SelectTrigger id="quick-mode-thinking">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="opt in thinkingLevelOptions" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.quickModeThinkingLevelHint') }}</p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="quick-mode-style">{{ $t('settings.quickModeStyleHint') }}</Label>
                  <textarea id="quick-mode-style" v-model="form.captureModes.quick.styleHint" rows="3" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.quickModeStyleHintHint') }}</p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="quick-mode-strand">{{ $t('settings.quickModeStrandTitle') }}</Label>
                  <Input id="quick-mode-strand" v-model="form.captureModes.quick.strandTitle" class="w-full" />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.quickModeStrandTitleHint') }}</p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="capture-source-puck">{{ $t('settings.puckStyleHint') }}</Label>
                  <textarea id="capture-source-puck" v-model="form.captureSources.puck.styleHint" rows="2" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.puckStyleHintHint') }}</p>
                </div>

                <!-- ─── Resilience (retry + watchdog) ─── -->
                <Separator />

                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.resilienceSection') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.resilienceSectionDescription') }}
                  </p>
                </div>

                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="retry-enabled" class="cursor-pointer">
                      {{ $t('settings.retryEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.retryEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="retry-enabled"
                    v-model:checked="form.retry.enabled"
                  />
                </div>

                <template v-if="form.retry.enabled">
                  <div class="flex flex-col gap-8">
                    <div class="flex flex-col gap-2">
                      <Label for="retry-max-retries">{{ $t('settings.retryMaxRetries') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="retry-max-retries"
                          v-model.number="form.retry.maxRetries"
                          type="number"
                          min="0"
                          max="10"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.attemptsUnit') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.retryMaxRetriesHint') }}</p>
                    </div>

                    <div class="flex flex-col gap-2">
                      <Label for="retry-base-delay">{{ $t('settings.retryBaseDelay') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="retry-base-delay"
                          v-model.number="form.retry.baseDelayMs"
                          type="number"
                          min="100"
                          max="60000"
                          step="100"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">ms</span>
                      </div>
                      <p class="text-xs text-muted-foreground">
                        {{ $t('settings.retryBaseDelayHint', { schedule: retryBackoffSchedule }) }}
                      </p>
                    </div>
                  </div>
                </template>

                <div class="flex flex-col gap-2">
                  <Label for="watchdog-warn">{{ $t('settings.watchdogStallWarn') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="watchdog-warn"
                      v-model.number="form.watchdog.stallWarnMs"
                      type="number"
                      min="1000"
                      max="600000"
                      step="1000"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">ms</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.watchdogStallWarnHint') }}</p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="watchdog-abort">{{ $t('settings.watchdogStallAbort') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="watchdog-abort"
                      v-model.number="form.watchdog.stallAbortMs"
                      type="number"
                      min="1000"
                      max="3600000"
                      step="1000"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">ms</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.watchdogStallAbortHint') }}</p>
                  <p v-if="watchdogThresholdInvalid" class="text-xs text-destructive">
                    {{ $t('settings.watchdogStallAbortInvalid') }}
                  </p>
                </div>

              </div>
            </div>

            <!-- ═══ Memory ═══ -->
            <div v-else-if="activeTab === 'memory'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.memory') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.memoryDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- ─── Sessions ─── -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.sessionSection') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.sessionSectionDescription') }}
                  </p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="session-timeout">{{ $t('settings.sessionTimeout') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="session-timeout"
                      v-model.number="form.sessionTimeoutMinutes"
                      type="number"
                      min="0"
                      max="1440"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.sessionTimeoutHint') }}</p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="session-summary-provider">{{ $t('settings.sessionSummaryProvider') }}</Label>
                  <Select v-model="form.sessionSummaryProviderId">
                    <SelectTrigger id="session-summary-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{{ $t('settings.sessionSummaryProviderDefault') }}</SelectItem>
                      <SelectItem v-for="opt in providerModelOptions" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.sessionSummaryProviderHint') }}</p>
                </div>

                <!-- ─── Fact Extraction ─── -->
                <Separator />

                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.factExtractionSection') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.factExtractionSectionDescription') }}
                  </p>
                </div>

                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="fact-extraction-enabled" class="cursor-pointer">
                      {{ $t('settings.factExtractionEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.factExtractionEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="fact-extraction-enabled"
                    v-model:checked="form.factExtraction.enabled"
                  />
                </div>

                <template v-if="form.factExtraction.enabled">
                  <div class="flex flex-col gap-8">
                    <div class="flex flex-col gap-2">
                      <Label for="fact-extraction-provider">{{ $t('settings.factExtractionProvider') }}</Label>
                      <Select v-model="form.factExtraction.providerId">
                        <SelectTrigger id="fact-extraction-provider">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">{{ $t('settings.factExtractionProviderDefault') }}</SelectItem>
                          <SelectItem v-for="opt in providerModelOptions" :key="opt.value" :value="opt.value">
                            {{ opt.label }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.factExtractionProviderHint') }}</p>
                    </div>

                    <div class="flex flex-col gap-2">
                      <Label for="fact-extraction-min-messages">{{ $t('settings.factExtractionMinSessionMessages') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="fact-extraction-min-messages"
                          v-model.number="form.factExtraction.minSessionMessages"
                          type="number"
                          min="1"
                          max="100"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.messagesUnit') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.factExtractionMinSessionMessagesHint') }}</p>
                    </div>
                  </div>
                </template>

                <!-- ─── Memory Consolidation ─── -->
                <Separator />

                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.consolidationSection') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.consolidationSectionDescription') }}
                  </p>
                </div>

                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="consolidation-enabled" class="cursor-pointer">
                      {{ $t('settings.consolidationEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.consolidationEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="consolidation-enabled"
                    v-model:checked="form.memoryConsolidation.enabled"
                  />
                </div>

                <template v-if="form.memoryConsolidation.enabled">
                  <div class="flex flex-col gap-8">
                    <div class="flex flex-col gap-2">
                      <Label for="consolidation-hour">{{ $t('settings.consolidationRunAtHour') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="consolidation-hour"
                          v-model.number="form.memoryConsolidation.runAtHour"
                          type="number"
                          min="0"
                          max="23"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.oClock') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.consolidationRunAtHourHint') }}</p>
                    </div>

                    <div class="flex flex-col gap-2">
                      <Label for="consolidation-days">{{ $t('settings.consolidationLookbackDays') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="consolidation-days"
                          v-model.number="form.memoryConsolidation.lookbackDays"
                          type="number"
                          min="1"
                          max="30"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.days') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.consolidationLookbackDaysHint') }}</p>
                    </div>

                    <div class="flex flex-col gap-2">
                      <Label for="consolidation-provider">{{ $t('settings.consolidationProvider') }}</Label>
                      <Select v-model="form.memoryConsolidation.providerId">
                        <SelectTrigger id="consolidation-provider">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">{{ $t('settings.consolidationProviderDefault') }}</SelectItem>
                          <SelectItem v-for="opt in providerModelOptions" :key="opt.value" :value="opt.value">
                            {{ opt.label }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.consolidationProviderHint') }}</p>
                    </div>

                    <!-- Manual run + status -->
                    <div class="flex flex-col gap-3 rounded-lg bg-muted/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div v-if="consolidationStatus" class="text-xs text-muted-foreground">
                        <span class="font-medium">{{ $t('settings.consolidationLastRun') }}:</span>
                        {{ consolidationStatus.lastRun ? formatDateTime(consolidationStatus.lastRun) : $t('settings.consolidationNeverRun') }}
                        <template v-if="consolidationStatus.lastResult">
                          · <span :class="consolidationStatus.lastResult.updated ? 'text-green-600 dark:text-green-400' : ''">
                            {{ consolidationStatus.lastResult.updated ? $t('settings.consolidationResultUpdated') : $t('settings.consolidationResultNoChange') }}
                          </span>
                        </template>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        class="shrink-0"
                        :disabled="consolidationRunning"
                        @click="handleRunConsolidation"
                      >
                        <span
                          v-if="consolidationRunning"
                          class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground"
                          aria-hidden="true"
                        />
                        {{ consolidationRunning ? $t('settings.consolidationRunning') : $t('settings.consolidationRunNow') }}
                      </Button>
                    </div>
                  </div>
                </template>

                <!-- CONSOLIDATION.md rules card — belongs to the consolidation section -->
                <div class="rounded-xl border border-border bg-card px-4 py-4">
                  <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <AppIcon name="file" size="sm" class="text-muted-foreground" />
                        <h3 class="text-sm font-semibold text-foreground">
                          {{ $t('settings.consolidationRulesTitle') }}
                        </h3>
                      </div>
                      <p class="mt-1 text-sm text-muted-foreground">
                        {{ $t('settings.consolidationRulesDescription') }}
                      </p>
                      <div class="mt-3 inline-flex max-w-full items-center rounded-md border border-border bg-muted/50 px-2.5 py-1">
                        <span class="truncate font-mono text-xs text-muted-foreground">/data/config/CONSOLIDATION.md</span>
                      </div>
                    </div>

                    <Button as-child variant="outline" class="shrink-0">
                      <NuxtLink to="/instructions?file=consolidation">
                        {{ $t('settings.openEditor') }}
                        <AppIcon name="externalLink" size="sm" />
                      </NuxtLink>
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <!-- ═══ Agent Heartbeat ═══ -->
            <div v-else-if="activeTab === 'agentHeartbeat'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.agentHeartbeat') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.agentHeartbeatDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="heartbeat-enabled" class="cursor-pointer">
                      {{ $t('settings.agentHeartbeatEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.agentHeartbeatEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="heartbeat-enabled"
                    v-model:checked="form.agentHeartbeat.enabled"
                  />
                </div>

                <!-- Configuration — progressive disclosure -->
                <template v-if="form.agentHeartbeat.enabled">
                  <!-- Heartbeat tasks -->
                  <div class="rounded-xl border border-border bg-card px-4 py-4">
                    <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div class="min-w-0">
                        <div class="flex items-center gap-2">
                          <AppIcon name="file" size="sm" class="text-muted-foreground" />
                          <h3 class="text-sm font-semibold text-foreground">
                            {{ $t('settings.heartbeatTasksTitle') }}
                          </h3>
                        </div>
                        <p class="mt-1 text-sm text-muted-foreground">
                          {{ $t('settings.heartbeatTasksDescription') }}
                        </p>
                        <div class="mt-3 inline-flex max-w-full items-center rounded-md border border-border bg-muted/50 px-2.5 py-1">
                          <span class="truncate font-mono text-xs text-muted-foreground">/data/config/HEARTBEAT.md</span>
                        </div>
                      </div>

                      <Button as-child variant="outline" class="shrink-0">
                        <NuxtLink to="/instructions?file=heartbeat">
                          {{ $t('settings.openEditor') }}
                          <AppIcon name="externalLink" size="sm" />
                        </NuxtLink>
                      </Button>
                    </div>
                  </div>

                  <!-- Interval -->
                  <div class="flex flex-col gap-2">
                    <Label for="heartbeat-interval">{{ $t('settings.agentHeartbeatInterval') }}</Label>
                    <div class="flex items-center gap-2">
                      <Input
                        id="heartbeat-interval"
                        v-model.number="form.agentHeartbeat.intervalMinutes"
                        type="number"
                        min="1"
                        max="1440"
                        class="w-full"
                      />
                      <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                    </div>
                    <p class="text-xs text-muted-foreground">{{ $t('settings.agentHeartbeatIntervalHint') }}</p>
                  </div>

                  <Separator />

                  <!-- Night mode section -->
                  <div>
                    <h3 class="text-base font-semibold tracking-tight text-foreground">
                      {{ $t('settings.agentHeartbeatNightMode') }}
                    </h3>
                    <p class="mt-1 text-sm text-muted-foreground">
                      {{ $t('settings.agentHeartbeatNightModeDescription') }}
                    </p>
                  </div>

                  <!-- Night mode enable -->
                  <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                    <div class="flex flex-col gap-0.5 pr-4">
                      <Label for="heartbeat-night-enabled" class="cursor-pointer">
                        {{ $t('settings.agentHeartbeatNightModeEnabled') }}
                      </Label>
                      <p class="text-xs text-muted-foreground">
                        {{ $t('settings.agentHeartbeatNightModeEnabledHint') }}
                      </p>
                    </div>
                    <Switch
                      id="heartbeat-night-enabled"
                      v-model:checked="form.agentHeartbeat.nightMode.enabled"
                    />
                  </div>

                  <template v-if="form.agentHeartbeat.nightMode.enabled">
                    <!-- Night start hour -->
                    <div class="flex flex-col gap-2">
                      <Label for="heartbeat-night-start">{{ $t('settings.agentHeartbeatNightModeStart') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="heartbeat-night-start"
                          v-model.number="form.agentHeartbeat.nightMode.startHour"
                          type="number"
                          min="0"
                          max="23"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.oClock') }}</span>
                      </div>
                    </div>

                    <!-- Night end hour -->
                    <div class="flex flex-col gap-2">
                      <Label for="heartbeat-night-end">{{ $t('settings.agentHeartbeatNightModeEnd') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="heartbeat-night-end"
                          v-model.number="form.agentHeartbeat.nightMode.endHour"
                          type="number"
                          min="0"
                          max="23"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.oClock') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.agentHeartbeatNightModeHoursHint') }}</p>
                    </div>
                  </template>

                </template>
              </div>
            </div>

            <!-- ═══ Health Monitor ═══ -->
            <div v-else-if="activeTab === 'healthMonitor'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.healthMonitor') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.healthMonitorDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="health-monitor-enabled" class="cursor-pointer">
                      {{ $t('settings.healthMonitorEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.healthMonitorEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="health-monitor-enabled"
                    v-model:checked="form.healthMonitor.enabled"
                  />
                </div>

                <!-- Configuration — progressive disclosure -->
                <template v-if="form.healthMonitor.enabled">
                <!-- Health check interval -->
                <div class="flex flex-col gap-2">
                  <Label for="health-monitor-interval">{{ $t('settings.healthMonitorInterval') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="health-monitor-interval"
                      v-model.number="form.healthMonitorIntervalMinutes"
                      type="number"
                      min="1"
                      max="60"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorHint') }}</p>
                </div>

                <!-- Fallback trigger -->
                <div class="flex flex-col gap-2">
                  <Label for="fallback-trigger">{{ $t('settings.healthMonitorFallbackTrigger') }}</Label>
                  <Select v-model="form.healthMonitor.fallbackTrigger">
                    <SelectTrigger id="fallback-trigger">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="down">{{ $t('settings.healthMonitorFallbackTriggerDown') }}</SelectItem>
                      <SelectItem value="degraded">{{ $t('settings.healthMonitorFallbackTriggerDegraded') }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorFallbackTriggerHint') }}</p>
                </div>

                <!-- Failures before fallback -->
                <div class="flex flex-col gap-2">
                  <Label for="failures-before-fallback">{{ $t('settings.healthMonitorFailuresBeforeFallback') }}</Label>
                  <Input
                    id="failures-before-fallback"
                    v-model.number="form.healthMonitor.failuresBeforeFallback"
                    type="number"
                    min="1"
                    class="w-full"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorFailuresBeforeFallbackHint') }}</p>
                </div>

                <!-- Recovery check interval -->
                <div class="flex flex-col gap-2">
                  <Label for="recovery-check-interval">{{ $t('settings.healthMonitorRecoveryCheckInterval') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="recovery-check-interval"
                      v-model.number="form.healthMonitor.recoveryCheckIntervalMinutes"
                      type="number"
                      min="1"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorRecoveryCheckIntervalHint') }}</p>
                </div>

                <!-- Successes before recovery -->
                <div class="flex flex-col gap-2">
                  <Label for="successes-before-recovery">{{ $t('settings.healthMonitorSuccessesBeforeRecovery') }}</Label>
                  <Input
                    id="successes-before-recovery"
                    v-model.number="form.healthMonitor.successesBeforeRecovery"
                    type="number"
                    min="1"
                    class="w-full"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.healthMonitorSuccessesBeforeRecoveryHint') }}</p>
                </div>

                <Separator />

                <!-- Notification toggles -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.healthMonitorNotifications') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.healthMonitorNotificationsDescription') }}
                  </p>
                </div>

                <div class="flex flex-col gap-3">
                  <div
                    v-for="toggle in notificationToggles"
                    :key="toggle.key"
                    class="flex items-center justify-between rounded-lg border border-border px-4 py-3"
                  >
                    <div class="flex flex-col gap-0.5 pr-4">
                      <Label :for="`notify-${toggle.key}`" class="cursor-pointer">
                        {{ toggle.label }}
                      </Label>
                    </div>
                    <Switch
                      :id="`notify-${toggle.key}`"
                      v-model:checked="form.healthMonitor.notifications[toggle.key]"
                    />
                  </div>
                </div>
                </template>
              </div>
            </div>

            <!-- ═══ Telegram ═══ -->
            <div v-else-if="activeTab === 'telegram'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.telegram') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.telegramDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="telegram-enabled" class="cursor-pointer">
                      {{ $t('settings.telegramEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.telegramEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="telegram-enabled"
                    v-model:checked="form.telegram.enabled"
                  />
                </div>

                <!-- Configuration — progressive disclosure -->
                <template v-if="form.telegram.enabled">
                <!-- Bot token -->
                <div class="flex flex-col gap-2">
                  <Label for="telegram-token">{{ $t('settings.telegramBotToken') }}</Label>
                  <Input
                    id="telegram-token"
                    v-model="form.telegram.botToken"
                    type="password"
                    autocomplete="off"
                    :placeholder="$t('settings.telegramBotTokenPlaceholder')"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.telegramBotTokenHint') }}</p>
                </div>

                <!-- Batching delay -->
                <div class="flex flex-col gap-2">
                  <Label for="batching-delay">{{ $t('settings.batchingDelay') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="batching-delay"
                      v-model.number="form.telegram.batchingDelayMs"
                      type="number"
                      min="0"
                      max="10000"
                      step="100"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">ms</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.batchingDelayHint') }}</p>
                </div>

                <!-- Voice replies -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="telegram-send-voice-reply" class="cursor-pointer">
                      {{ $t('settings.telegramSendVoiceReply') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.telegramSendVoiceReplyHint') }}
                    </p>
                  </div>
                  <Switch
                    id="telegram-send-voice-reply"
                    v-model:checked="form.telegram.sendVoiceReply"
                  />
                </div>

                <!-- Stall warnings -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="telegram-send-stall-warnings" class="cursor-pointer">
                      {{ $t('settings.telegramSendStallWarnings') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.telegramSendStallWarningsHint') }}
                    </p>
                  </div>
                  <Switch
                    id="telegram-send-stall-warnings"
                    v-model:checked="form.telegram.sendStallWarnings"
                  />
                </div>

                <!-- Telegram users section -->
                <Separator />

                <div class="flex items-start justify-between gap-4">
                  <div>
                    <h3 class="text-base font-semibold tracking-tight text-foreground">
                      {{ $t('settings.telegramUsers') }}
                    </h3>
                    <p class="mt-1 text-sm text-muted-foreground">
                      {{ $t('settings.telegramUsersDescription') }}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    :disabled="telegramUsersLoading"
                    :aria-label="$t('settings.telegramUsersRefresh')"
                    @click="fetchTelegramUsers"
                  >
                    <AppIcon
                      name="refresh"
                      class="h-4 w-4"
                      :class="telegramUsersLoading ? 'animate-spin' : ''"
                    />
                  </Button>
                </div>

                <!-- Loading -->
                <div v-if="telegramUsersLoading" class="flex flex-col gap-2">
                  <Skeleton class="h-[72px] w-full rounded-lg" />
                  <Skeleton class="h-[72px] w-full rounded-lg" />
                </div>

                <!-- Empty state -->
                <div v-else-if="telegramUsers.length === 0" class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                  <AppIcon name="send" size="lg" class="text-muted-foreground/40" />
                  <p class="text-sm text-muted-foreground">{{ $t('settings.telegramUsersEmpty') }}</p>
                </div>

                <!-- User list -->
                <div v-else class="overflow-hidden rounded-lg border border-border">
                  <div
                    v-for="(tgUser, index) in telegramUsers"
                    :key="tgUser.id"
                    :class="[
                      'flex items-center gap-3 px-4 py-3 transition-colors',
                      index > 0 ? 'border-t border-border' : '',
                    ]"
                  >
                    <!-- Avatar -->
                    <img
                      v-if="tgUser.hasAvatar"
                      :src="getTelegramAvatarUrl(tgUser.id)"
                      :alt="tgUser.telegramDisplayName || tgUser.telegramUsername || ''"
                      class="h-9 w-9 shrink-0 rounded-full object-cover"
                      @error="($event.target as HTMLImageElement).style.display = 'none'; ($event.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden')"
                    >
                    <span
                      :class="[
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                        tgUser.hasAvatar ? 'hidden' : '',
                        tgUser.status === 'approved'
                          ? 'bg-success/10 text-success'
                          : tgUser.status === 'pending'
                            ? 'bg-warning/10 text-warning'
                            : 'bg-muted text-muted-foreground',
                      ]"
                    >
                      {{ (tgUser.telegramDisplayName || tgUser.telegramUsername || '?').slice(0, 1).toUpperCase() }}
                    </span>

                    <!-- Info -->
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="truncate font-medium text-foreground">
                          {{ tgUser.telegramDisplayName || tgUser.telegramUsername || tgUser.telegramId }}
                        </span>
                        <Badge
                          :variant="tgUser.status === 'approved' ? 'success' : tgUser.status === 'pending' ? 'warning' : 'destructive'"
                          class="shrink-0"
                        >
                          {{ $t(`settings.telegramUsers${tgUser.status.charAt(0).toUpperCase() + tgUser.status.slice(1)}`) }}
                        </Badge>
                      </div>
                      <div class="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span v-if="tgUser.telegramUsername">@{{ tgUser.telegramUsername }}</span>
                        <span v-else>{{ $t('settings.telegramUsersNoUsername') }}</span>
                        <span class="text-border">·</span>
                        <span class="font-mono">{{ tgUser.telegramId }}</span>
                        <template v-if="tgUser.linkedUsername">
                          <span class="text-border">·</span>
                          <span class="inline-flex items-center gap-1">
                            <AppIcon name="user" size="sm" />
                            {{ tgUser.linkedUsername }}
                          </span>
                        </template>
                      </div>
                    </div>

                    <!-- Primary action: Approve for pending users -->
                    <Button
                      v-if="tgUser.status === 'pending'"
                      size="sm"
                      @click="handleApproveTelegramUser(tgUser.id)"
                    >
                      <AppIcon name="check" size="sm" class="mr-1" />
                      {{ $t('settings.telegramUsersApprove') }}
                    </Button>

                    <!-- Row actions dropdown -->
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="ghost" size="icon-sm" :aria-label="$t('aria.userMenu')">
                          <AppIcon name="moreVertical" class="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem v-if="tgUser.status !== 'approved'" @click="handleApproveTelegramUser(tgUser.id)">
                          <AppIcon name="check" class="h-4 w-4" />
                          {{ $t('settings.telegramUsersApprove') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem v-if="tgUser.status !== 'rejected'" @click="handleRejectTelegramUser(tgUser.id)">
                          <AppIcon name="close" class="h-4 w-4" />
                          {{ $t('settings.telegramUsersReject') }}
                        </DropdownMenuItem>

                        <!-- User assignment submenu -->
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{{ $t('settings.telegramUsersAssignUser') }}</DropdownMenuLabel>
                        <DropdownMenuItem
                          :class="tgUser.userId === null ? 'font-medium' : ''"
                          @click="handleAssignUser(tgUser.id, '')"
                        >
                          {{ $t('settings.telegramUsersUnassigned') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-for="u in users"
                          :key="u.id"
                          :class="tgUser.userId === u.id ? 'font-medium' : ''"
                          @click="handleAssignUser(tgUser.id, String(u.id))"
                        >
                          <AppIcon name="user" class="h-4 w-4" />
                          {{ u.username }}
                          <AppIcon v-if="tgUser.userId === u.id" name="check" class="ml-auto h-4 w-4" />
                        </DropdownMenuItem>

                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive @click="handleDeleteTelegramUser(tgUser)">
                          <AppIcon name="trash" class="h-4 w-4" />
                          {{ $t('settings.telegramUsersDelete') }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                </template>
              </div>
            </div>

            <!-- ═══ Tasks ═══ -->
            <div v-else-if="activeTab === 'tasks'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.tasks') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.tasksDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- General Task Settings -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.tasksGeneral') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.tasksGeneralHint') }}
                  </p>
                </div>

                <!-- Default provider -->
                <div class="flex flex-col gap-2">
                  <Label for="tasks-default-provider">{{ $t('settings.tasksDefaultProvider') }}</Label>
                  <Select v-model="form.tasks.defaultProvider">
                    <SelectTrigger id="tasks-default-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{{ $t('settings.tasksDefaultProviderActive') }}</SelectItem>
                      <SelectItem v-for="opt in providerModelOptions" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.tasksDefaultProviderHint') }}</p>
                </div>

                <!-- Max duration -->
                <div class="flex flex-col gap-2">
                  <Label for="tasks-max-duration">{{ $t('settings.tasksMaxDuration') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="tasks-max-duration"
                      v-model.number="form.tasks.maxDurationMinutes"
                      type="number"
                      min="1"
                      max="1440"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.tasksMaxDurationHint') }}</p>
                </div>

                <!-- Telegram delivery mode -->
                <div class="flex flex-col gap-2">
                  <Label for="tasks-telegram-delivery">{{ $t('settings.tasksTelegramDelivery') }}</Label>
                  <Select v-model="form.tasks.telegramDelivery">
                    <SelectTrigger id="tasks-telegram-delivery">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{{ $t('settings.tasksTelegramDeliveryAuto') }}</SelectItem>
                      <SelectItem value="always">{{ $t('settings.tasksTelegramDeliveryAlways') }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.tasksTelegramDeliveryHint') }}</p>
                </div>

                <!-- Background thinking level (task agent + internal background jobs) -->
                <div class="flex flex-col gap-2">
                  <Label for="background-thinking-level">{{ $t('settings.backgroundThinkingLevel') }}</Label>
                  <Select v-model="form.tasks.backgroundThinkingLevel">
                    <SelectTrigger id="background-thinking-level">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="lvl in thinkingLevelOptions" :key="lvl.value" :value="lvl.value">
                        {{ lvl.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.backgroundThinkingLevelHint') }}</p>
                </div>

                <Separator />

                <!-- Loop Detection Section -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.tasksLoopDetection') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.tasksLoopDetectionHint') }}
                  </p>
                </div>

                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="loop-detection-enabled" class="cursor-pointer">
                      {{ $t('settings.tasksLoopDetectionEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.tasksLoopDetectionEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="loop-detection-enabled"
                    v-model:checked="form.tasks.loopDetection.enabled"
                  />
                </div>

                <template v-if="form.tasks.loopDetection.enabled">
                  <!-- Detection method -->
                  <div class="flex flex-col gap-2">
                    <Label for="loop-detection-method">{{ $t('settings.tasksLoopDetectionMethod') }}</Label>
                    <Select v-model="form.tasks.loopDetection.method">
                      <SelectTrigger id="loop-detection-method">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="systematic">{{ $t('settings.tasksLoopDetectionMethodSystematic') }}</SelectItem>
                        <SelectItem value="smart">{{ $t('settings.tasksLoopDetectionMethodSmart') }}</SelectItem>
                        <SelectItem value="auto">{{ $t('settings.tasksLoopDetectionMethodAuto') }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p class="text-xs text-muted-foreground">{{ $t('settings.tasksLoopDetectionMethodHint') }}</p>
                  </div>

                  <!-- Max consecutive failures -->
                  <div class="flex flex-col gap-2">
                    <Label for="loop-max-failures">{{ $t('settings.tasksLoopDetectionMaxFailures') }}</Label>
                    <Input
                      id="loop-max-failures"
                      v-model.number="form.tasks.loopDetection.maxConsecutiveFailures"
                      type="number"
                      min="1"
                      max="20"
                      class="w-full"
                    />
                    <p class="text-xs text-muted-foreground">{{ $t('settings.tasksLoopDetectionMaxFailuresHint') }}</p>
                  </div>

                  <!-- Smart provider (shown when method is smart or auto) -->
                  <template v-if="form.tasks.loopDetection.method !== 'systematic'">
                    <div class="flex flex-col gap-2">
                      <Label for="loop-smart-provider">{{ $t('settings.tasksLoopDetectionSmartProvider') }}</Label>
                      <Select v-model="form.tasks.loopDetection.smartProvider">
                        <SelectTrigger id="loop-smart-provider">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">{{ $t('settings.tasksLoopDetectionSmartProviderDefault') }}</SelectItem>
                          <SelectItem v-for="opt in providerModelOptions" :key="opt.value" :value="opt.value">
                            {{ opt.label }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.tasksLoopDetectionSmartProviderHint') }}</p>
                    </div>

                    <!-- Smart check interval -->
                    <div class="flex flex-col gap-2">
                      <Label for="loop-smart-interval">{{ $t('settings.tasksLoopDetectionSmartInterval') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="loop-smart-interval"
                          v-model.number="form.tasks.loopDetection.smartCheckInterval"
                          type="number"
                          min="1"
                          max="50"
                          class="w-full"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.tasksToolCalls') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.tasksLoopDetectionSmartIntervalHint') }}</p>
                    </div>
                  </template>
                </template>

                <Separator />

                <!-- Status Updates Section -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.tasksStatusUpdates') }}
                  </h3>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ $t('settings.tasksStatusUpdatesHint') }}
                  </p>
                </div>

                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="status-updates-enabled" class="cursor-pointer">
                      {{ $t('settings.tasksStatusUpdatesEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.tasksStatusUpdatesEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="status-updates-enabled"
                    v-model:checked="form.tasks.statusUpdates.enabled"
                  />
                </div>

                <div v-if="form.tasks.statusUpdates.enabled" class="flex flex-col gap-2">
                  <Label for="status-update-interval">{{ $t('settings.tasksStatusUpdateInterval') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="status-update-interval"
                      v-model.number="form.tasks.statusUpdates.intervalMinutes"
                      type="number"
                      min="1"
                      max="120"
                      class="w-full"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.tasksStatusUpdateIntervalHint') }}</p>
                </div>
              </div>
            </div>

            <!-- ═══ Text-to-Speech ═══ -->
            <div v-else-if="activeTab === 'tts'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.ttsTitle') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.ttsSubtitle') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="tts-enabled" class="cursor-pointer">
                      {{ $t('settings.ttsEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.ttsEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="tts-enabled"
                    v-model:checked="form.tts.enabled"
                  />
                </div>

                <!-- Configuration — progressive disclosure -->
                <template v-if="form.tts.enabled">
                  <!-- Provider -->
                  <div class="flex flex-col gap-2">
                    <Label for="tts-provider">{{ $t('settings.ttsProvider') }}</Label>
                    <Select v-model="ttsProviderComposite">
                      <SelectTrigger id="tts-provider">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <template v-for="opt in ttsProviderOptions" :key="opt.value">
                          <SelectItem :value="opt.value" :disabled="opt.disabled">
                            {{ opt.label }}
                          </SelectItem>
                        </template>
                      </SelectContent>
                    </Select>
                    <p class="text-xs text-muted-foreground">{{ $t('settings.ttsProviderHint') }}</p>
                  </div>

                  <Separator />

                  <!-- OpenAI Settings -->
                  <template v-if="form.tts.provider === 'openai'">
                    <div>
                      <h3 class="text-base font-semibold tracking-tight text-foreground">OpenAI</h3>
                    </div>

                    <!-- Model -->
                    <div class="flex flex-col gap-2">
                      <Label for="tts-openai-model">{{ $t('settings.ttsOpenaiModel') }}</Label>
                      <Select v-model="form.tts.openaiModel">
                        <SelectTrigger id="tts-openai-model">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gpt-4o-mini-tts">gpt-4o-mini-tts</SelectItem>
                          <SelectItem value="tts-1">tts-1</SelectItem>
                          <SelectItem value="tts-1-hd">tts-1-hd</SelectItem>
                        </SelectContent>
                      </Select>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.ttsOpenaiModelHint') }}</p>
                    </div>

                    <!-- Voice -->
                    <div class="flex flex-col gap-2">
                      <Label for="tts-openai-voice">{{ $t('settings.ttsOpenaiVoice') }}</Label>
                      <Select v-model="form.tts.openaiVoice">
                        <SelectTrigger id="tts-openai-voice">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="v in openaiVoiceOptions" :key="v.value" :value="v.value">
                            {{ v.label }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.ttsOpenaiVoiceHint') }}</p>
                    </div>

                    <!-- Instructions (only for gpt-4o-mini-tts) -->
                    <div v-if="form.tts.openaiModel === 'gpt-4o-mini-tts'" class="flex flex-col gap-2">
                      <Label for="tts-openai-instructions">{{ $t('settings.ttsOpenaiInstructions') }}</Label>
                      <Input
                        id="tts-openai-instructions"
                        v-model="form.tts.openaiInstructions"
                        :placeholder="$t('settings.ttsOpenaiInstructionsPlaceholder')"
                      />
                      <p class="text-xs text-muted-foreground">{{ $t('settings.ttsOpenaiInstructionsHint') }}</p>
                    </div>
                  </template>

                  <!-- Deepgram Settings -->
                  <template v-if="form.tts.provider === 'deepgram'">
                    <div>
                      <h3 class="text-base font-semibold tracking-tight text-foreground">Deepgram Aura</h3>
                    </div>

                    <!-- TTS Deepgram key (separate from STT). Needed before the model list can be refreshed. -->
                    <div class="flex flex-col gap-2">
                      <Label for="tts-deepgram-api-key">{{ $t('settings.deepgramApiKey') }}</Label>
                      <Input
                        id="tts-deepgram-api-key"
                        v-model="form.tts.deepgramApiKey"
                        type="password"
                        :placeholder="$t('settings.deepgramApiKeyPlaceholder')"
                        autocomplete="off"
                      />
                      <p class="text-xs text-muted-foreground">{{ $t('settings.deepgramApiKeyHint') }}</p>
                    </div>

                    <div class="flex flex-col gap-2">
                      <Label for="tts-deepgram-model">{{ $t('settings.ttsDeepgramModel') }}</Label>
                      <div class="flex items-center gap-2">
                        <Select v-model="form.tts.deepgramModel" class="flex-1">
                          <SelectTrigger id="tts-deepgram-model" class="flex-1">
                            <SelectValue :placeholder="$t('settings.deepgramModelPlaceholder')" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem
                              v-for="opt in ttsDeepgramModelOptions"
                              :key="opt.value"
                              :value="opt.value"
                            >
                              {{ opt.label }}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          :disabled="deepgramModelsLoading"
                          :title="$t('settings.deepgramModelsRefresh')"
                          :aria-label="$t('settings.deepgramModelsRefresh')"
                          @click="handleRefreshTtsDeepgramModels"
                        >
                          <AppIcon name="refresh" class="h-4 w-4" :class="{ 'animate-spin': deepgramModelsLoading }" />
                        </Button>
                      </div>
                      <p v-if="deepgramModelsError" class="text-xs text-destructive">{{ deepgramModelsError }}</p>
                      <p v-else class="text-xs text-muted-foreground">{{ $t('settings.ttsDeepgramModelHint') }}</p>
                    </div>

                  </template>

                  <!-- Mistral Settings -->
                  <template v-if="form.tts.provider === 'mistral'">
                    <div>
                      <h3 class="text-base font-semibold tracking-tight text-foreground">Mistral (Voxtral)</h3>
                    </div>

                    <!-- Voice + Mood (two 50:50 dropdowns) -->
                    <div class="flex flex-col gap-2">
                      <Label>{{ $t('settings.ttsMistralVoice') }}</Label>
                      <div class="grid grid-cols-2 gap-3">
                        <!-- Speaker -->
                        <Select v-model="mistralSpeaker">
                          <SelectTrigger>
                            <SelectValue :placeholder="$t('settings.ttsMistralSpeakerPlaceholder')" />
                          </SelectTrigger>
                          <SelectContent>
                            <template v-if="mistralSpeakerOptions.length > 0">
                              <SelectItem v-for="s in mistralSpeakerOptions" :key="s.name" :value="s.name">
                                {{ s.name }} ({{ s.languageLabel }})
                              </SelectItem>
                            </template>
                            <template v-else>
                              <SelectItem value="" disabled>
                                {{ voicesLoading ? $t('settings.ttsVoicesLoading') : $t('settings.ttsVoicesEmpty') }}
                              </SelectItem>
                            </template>
                          </SelectContent>
                        </Select>
                        <!-- Mood -->
                        <Select v-model="mistralMood">
                          <SelectTrigger>
                            <SelectValue :placeholder="$t('settings.ttsMistralMoodPlaceholder')" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem v-for="m in mistralMoodOptions" :key="m" :value="m">
                              {{ m }}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.ttsMistralVoiceHint') }}</p>
                    </div>
                  </template>

                  <!-- Gemini Settings -->
                  <template v-if="form.tts.provider === 'gemini'">
                    <div>
                      <h3 class="text-base font-semibold tracking-tight text-foreground">Google Gemini TTS</h3>
                      <p class="mt-1 text-xs text-muted-foreground">{{ $t('settings.ttsGeminiIntro') }}</p>
                    </div>

                    <!-- Model -->
                    <div class="flex flex-col gap-2">
                      <Label for="tts-gemini-model">{{ $t('settings.ttsGeminiModel') }}</Label>
                      <Select v-model="form.tts.geminiModel">
                        <SelectTrigger id="tts-gemini-model">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="opt in ttsGeminiModelOptions" :key="opt" :value="opt">
                            {{ opt }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.ttsGeminiModelHint') }}</p>
                    </div>

                    <!-- Voice -->
                    <div class="flex flex-col gap-2">
                      <Label for="tts-gemini-voice">{{ $t('settings.ttsGeminiVoice') }}</Label>
                      <Select v-model="form.tts.geminiVoice">
                        <SelectTrigger id="tts-gemini-voice">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="voice in ttsGeminiVoices" :key="voice.name" :value="voice.name">
                            {{ voice.name }} · {{ voice.style }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.ttsGeminiVoiceHint') }}</p>
                    </div>

                    <!-- Style hint -->
                    <div class="flex flex-col gap-2">
                      <Label for="tts-gemini-style">{{ $t('settings.ttsGeminiStyle') }}</Label>
                      <Input
                        id="tts-gemini-style"
                        v-model="form.tts.geminiStyle"
                        :placeholder="$t('settings.ttsGeminiStylePlaceholder')"
                        maxlength="500"
                      />
                      <p class="text-xs text-muted-foreground">{{ $t('settings.ttsGeminiStyleHint') }}</p>
                    </div>
                  </template>

                  <!-- Voice Preview -->
                  <div class="flex flex-col gap-2">
                    <Label for="tts-preview-text">{{ $t('settings.ttsPreview') }}</Label>
                    <div class="flex items-end gap-2">
                      <Input
                        id="tts-preview-text"
                        v-model="ttsPreviewText"
                        :placeholder="$t('settings.ttsPreviewPlaceholder')"
                        class="flex-1"
                        @keydown.enter.prevent="handleTtsPreview"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        class="shrink-0 gap-2"
                        :disabled="ttsPreviewLoading || !ttsPreviewText.trim()"
                        @click="handleTtsPreview"
                      >
                        <AppIcon
                          v-if="ttsPreviewLoading"
                          name="loader"
                          size="sm"
                          class="animate-spin"
                        />
                        <AppIcon
                          v-else-if="ttsPreviewPlaying"
                          name="square"
                          size="sm"
                        />
                        <AppIcon v-else name="volume" size="sm" />
                        {{ ttsPreviewPlaying ? $t('settings.ttsPreviewStop') : ttsPreviewBlocked ? $t('settings.ttsPreviewPlayNow') : $t('settings.ttsPreviewPlay') }}
                      </Button>
                    </div>
                    <p v-if="ttsPreviewError" class="text-xs text-destructive" role="alert">{{ ttsPreviewError }}</p>
                    <p v-else class="text-xs text-muted-foreground">{{ $t('settings.ttsPreviewHint') }}</p>
                  </div>

                  <!--
                    Single audio format selector across all providers. The
                    core dispatcher maps it to provider-specific knobs (e.g.
                    Deepgram's `wav` becomes raw `linear16` PCM with a WAV
                    header wrapped around it post-synthesis).
                  -->
                  <Separator />

                  <div class="flex flex-col gap-2">
                    <Label for="tts-format">{{ $t('settings.ttsResponseFormat') }}</Label>
                    <Select v-model="form.tts.responseFormat">
                      <SelectTrigger id="tts-format">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="opt in ttsFormatOptions" :key="opt.value" :value="opt.value">
                          {{ opt.label }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p class="text-xs text-muted-foreground">
                      {{ form.tts.provider === 'gemini' ? $t('settings.ttsResponseFormatGeminiHint') : $t('settings.ttsResponseFormatHint') }}
                    </p>
                  </div>
                </template>
              </div>
            </div>

            <!-- ═══ Speech-to-Text ═══ -->
            <div v-else-if="activeTab === 'stt'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.sttTitle') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.sttSubtitle') }}
                </p>
              </div>

              <div class="flex flex-col gap-8">
                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="stt-enabled" class="cursor-pointer">
                      {{ $t('settings.sttEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.sttEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="stt-enabled"
                    v-model:checked="form.stt.enabled"
                  />
                </div>

                <!-- Configuration — progressive disclosure -->
                <template v-if="form.stt.enabled">
                  <!-- Provider -->
                  <div class="flex flex-col gap-2">
                    <Label for="stt-provider">{{ $t('settings.sttProvider') }}</Label>
                    <Select v-model="sttProviderComposite">
                      <SelectTrigger id="stt-provider">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <template v-for="opt in sttProviderOptions" :key="opt.value">
                          <SelectItem :value="opt.value" :disabled="opt.disabled">
                            {{ opt.label }}
                          </SelectItem>
                        </template>
                      </SelectContent>
                    </Select>
                    <p class="text-xs text-muted-foreground">{{ $t('settings.sttProviderHint') }}</p>
                  </div>

                  <!-- Whisper URL field (only visible when provider is whisper-url) -->
                  <div v-if="form.stt.provider === 'whisper-url'" class="flex flex-col gap-2">
                    <Label for="stt-whisper-url">{{ $t('settings.sttWhisperUrl') }}</Label>
                    <Input
                      id="stt-whisper-url"
                      v-model="form.stt.whisperUrl"
                      type="url"
                      :placeholder="$t('settings.sttWhisperUrlPlaceholder')"
                    />
                    <p class="text-xs text-muted-foreground">{{ $t('settings.sttWhisperUrlHint') }}</p>
                  </div>

                  <!-- OpenAI model field (only visible when provider is openai) -->
                  <div v-if="form.stt.provider === 'openai'" class="flex flex-col gap-2">
                    <Label for="stt-openai-model">{{ $t('settings.sttOpenaiModel') }}</Label>
                    <Select v-model="form.stt.openaiModel">
                      <SelectTrigger id="stt-openai-model">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="whisper-1">whisper-1</SelectItem>
                        <SelectItem value="gpt-4o-transcribe">gpt-4o-transcribe</SelectItem>
                        <SelectItem value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</SelectItem>
                      </SelectContent>
                    </Select>
                    <p class="text-xs text-muted-foreground">{{ $t('settings.sttOpenaiModelHint') }}</p>
                  </div>

                  <!-- Ollama model field (only visible when provider is ollama) -->
                  <div v-if="form.stt.provider === 'ollama'" class="flex flex-col gap-2">
                    <Label for="stt-ollama-model">{{ $t('settings.sttOllamaModel') }}</Label>
                    <Input
                      id="stt-ollama-model"
                      v-model="form.stt.ollamaModel"
                      type="text"
                      :placeholder="$t('settings.sttOllamaModelPlaceholder')"
                    />
                    <p class="text-xs text-muted-foreground">{{ $t('settings.sttOllamaModelHint') }}</p>
                  </div>

                  <!-- Deepgram fields (only visible when provider is deepgram) -->
                  <template v-if="form.stt.provider === 'deepgram'">
                    <!-- STT Deepgram key (separate from TTS). Needed before the model list can be refreshed. -->
                    <div class="flex flex-col gap-2">
                      <Label for="stt-deepgram-api-key">{{ $t('settings.deepgramApiKey') }}</Label>
                      <Input
                        id="stt-deepgram-api-key"
                        v-model="form.stt.deepgramApiKey"
                        type="password"
                        :placeholder="$t('settings.deepgramApiKeyPlaceholder')"
                        autocomplete="off"
                      />
                      <p class="text-xs text-muted-foreground">{{ $t('settings.deepgramApiKeyHint') }}</p>
                    </div>
                    <div class="flex flex-col gap-2">
                      <Label for="stt-deepgram-model">{{ $t('settings.sttDeepgramModel') }}</Label>
                      <div class="flex items-center gap-2">
                        <Select v-model="form.stt.deepgramModel" class="flex-1">
                          <SelectTrigger id="stt-deepgram-model" class="flex-1">
                            <SelectValue :placeholder="$t('settings.deepgramModelPlaceholder')" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem
                              v-for="opt in sttDeepgramModelOptions"
                              :key="opt.value"
                              :value="opt.value"
                            >
                              {{ opt.label }}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          :disabled="deepgramModelsLoading"
                          :title="$t('settings.deepgramModelsRefresh')"
                          :aria-label="$t('settings.deepgramModelsRefresh')"
                          @click="handleRefreshSttDeepgramModels"
                        >
                          <AppIcon name="refresh" class="h-4 w-4" :class="{ 'animate-spin': deepgramModelsLoading }" />
                        </Button>
                      </div>
                      <p v-if="deepgramModelsError" class="text-xs text-destructive">{{ deepgramModelsError }}</p>
                      <p v-else class="text-xs text-muted-foreground">{{ $t('settings.sttDeepgramModelHint') }}</p>
                    </div>
                    <div class="flex flex-col gap-2">
                      <Label for="stt-deepgram-language">{{ $t('settings.sttDeepgramLanguage') }}</Label>
                      <Input
                        id="stt-deepgram-language"
                        v-model="form.stt.deepgramLanguage"
                        type="text"
                        :placeholder="$t('settings.sttDeepgramLanguagePlaceholder')"
                      />
                      <p class="text-xs text-muted-foreground">{{ $t('settings.sttDeepgramLanguageHint') }}</p>
                    </div>
                  </template>

                  <!-- Rewrite toggle -->
                  <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                    <div class="flex flex-col gap-0.5 pr-4">
                      <Label for="stt-rewrite-enabled" class="cursor-pointer">
                        {{ $t('settings.sttRewriteEnabled') }}
                      </Label>
                      <p class="text-xs text-muted-foreground">
                        {{ $t('settings.sttRewriteEnabledHint') }}
                      </p>
                    </div>
                    <Switch
                      id="stt-rewrite-enabled"
                      v-model:checked="form.stt.rewrite.enabled"
                    />
                  </div>

                  <!-- Rewrite provider dropdown -->
                  <div v-if="form.stt.rewrite.enabled" class="flex flex-col gap-2">
                    <Label for="stt-rewrite-provider">{{ $t('settings.sttRewriteProvider') }}</Label>
                    <Select v-model="form.stt.rewrite.providerId">
                      <SelectTrigger id="stt-rewrite-provider">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <template v-for="opt in providerModelOptions" :key="opt.value">
                          <SelectItem :value="opt.value">
                            {{ opt.label }}
                          </SelectItem>
                        </template>
                        <SelectItem v-if="providerModelOptions.length === 0" value="" disabled>
                          {{ $t('settings.sttRewriteProviderNone') }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p class="text-xs text-muted-foreground">{{ $t('settings.sttRewriteProviderHint') }}</p>
                  </div>
                </template>
              </div>
            </div>

            <!-- ═══ Secrets ═══ -->
            <div v-else-if="activeTab === 'secrets'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.secretsTitle') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.secretsSubtitle') }}
                </p>
              </div>

              <!-- Secrets feedback alerts -->
              <div v-if="secretsError || secretsSuccess" class="mb-6">
                <Alert v-if="secretsError" variant="destructive">
                  <AlertDescription class="flex items-center justify-between">
                    <span>{{ secretsError }}</span>
                    <button
                      type="button"
                      class="ml-2 opacity-70 transition-opacity hover:opacity-100"
                      :aria-label="$t('aria.closeAlert')"
                      @click="clearSecretsMessages()"
                    >
                      <AppIcon name="close" class="h-4 w-4" />
                    </button>
                  </AlertDescription>
                </Alert>
                <Alert v-if="secretsSuccess" variant="success" :class="secretsError ? 'mt-2' : ''">
                  <AlertDescription class="flex items-center justify-between">
                    <span>{{ secretsSuccess === 'deleted' ? $t('settings.secretsDeleteSuccess') : $t('settings.secretsSaveSuccess') }}</span>
                    <button
                      type="button"
                      class="ml-2 opacity-70 transition-opacity hover:opacity-100"
                      :aria-label="$t('aria.closeAlert')"
                      @click="clearSecretsMessages()"
                    >
                      <AppIcon name="close" class="h-4 w-4" />
                    </button>
                  </AlertDescription>
                </Alert>
              </div>

              <!-- Loading -->
              <div v-if="secretsLoading" class="flex flex-col gap-4">
                <Skeleton class="h-16 w-full rounded-lg" />
                <Skeleton class="h-16 w-full rounded-lg" />
              </div>

              <div v-else class="flex flex-col gap-8">
                <!-- Existing secrets list -->
                <div v-if="secretsList.length > 0" class="overflow-hidden rounded-lg border border-border">
                  <div
                    v-for="(secret, index) in secretsList"
                    :key="secret.key"
                    :class="[
                      'px-4 py-3',
                      index > 0 ? 'border-t border-border' : '',
                    ]"
                  >
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex min-w-0 items-center gap-3">
                        <span class="font-mono text-sm font-medium text-foreground">{{ secret.key }}</span>
                        <span v-if="secret.configured" class="font-mono text-xs text-muted-foreground">
                          {{ secret.maskedValue }}
                        </span>
                        <Badge v-else variant="outline">{{ $t('settings.secretsNotConfigured') }}</Badge>
                      </div>
                      <div class="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          :aria-label="$t('common.edit')"
                          @click="toggleSecretEdit(secret.key)"
                        >
                          <AppIcon name="edit" class="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          :aria-label="$t('settings.secretsDelete')"
                          @click="secretToDelete = secret.key"
                        >
                          <AppIcon name="trash" class="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <!-- Inline update field — shown on edit click -->
                    <div v-if="secretEditOpen.has(secret.key)" class="mt-3 flex flex-col gap-1.5">
                      <Label :for="`secret-edit-${secret.key}`">{{ $t('settings.secretsNewValue') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          :id="`secret-edit-${secret.key}`"
                          v-model="secretEdits[secret.key]"
                          type="password"
                          autocomplete="off"
                          :placeholder="$t('settings.secretsValuePlaceholder')"
                          class="flex-1"
                        />
                        <Button
                          size="sm"
                          :disabled="secretsSaving || !secretEdits[secret.key]"
                          @click="handleSaveSingleSecret(secret.key)"
                        >
                          <span
                            v-if="secretsSaving"
                            class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                            aria-hidden="true"
                          />
                          {{ $t('common.save') }}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          @click="toggleSecretEdit(secret.key)"
                        >
                          {{ $t('common.cancel') }}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Empty state -->
                <div v-else class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                  <AppIcon name="key" size="lg" class="text-muted-foreground/40" />
                  <p class="text-sm text-muted-foreground">{{ $t('settings.secretsEmpty') }}</p>
                </div>

                <Separator />

                <!-- Add new secret -->
                <div>
                  <h3 class="text-base font-semibold tracking-tight text-foreground">
                    {{ $t('settings.secretsAdd') }}
                  </h3>
                </div>

                <div class="flex flex-col gap-4">
                  <div class="flex flex-col gap-2">
                    <Label for="new-secret-key">{{ $t('settings.secretsKey') }}</Label>
                    <Input
                      id="new-secret-key"
                      v-model="newSecretKey"
                      :placeholder="$t('settings.secretsKeyPlaceholder')"
                      class="font-mono"
                      @input="newSecretError = validateNewSecretKey(newSecretKey)"
                    />
                    <p v-if="newSecretError" class="text-xs text-destructive">{{ newSecretError }}</p>
                  </div>

                  <div class="flex flex-col gap-2">
                    <Label for="new-secret-value">{{ $t('settings.secretsValue') }}</Label>
                    <Input
                      id="new-secret-value"
                      v-model="newSecretValue"
                      type="password"
                      autocomplete="off"
                      :placeholder="$t('settings.secretsValuePlaceholder')"
                    />
                  </div>
                </div>

                <!-- Save button -->
                <div class="flex justify-end">
                  <Button :disabled="secretsSaving" @click="handleSaveSecrets">
                    <span
                      v-if="secretsSaving"
                      class="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                      aria-hidden="true"
                    />
                    {{ $t('settings.secretsSave') }}
                  </Button>
                </div>
              </div>

              <!-- Delete confirmation dialog -->
              <ConfirmDialog
                :open="!!secretToDelete"
                :title="$t('settings.secretsDelete')"
                :description="$t('settings.secretsDeleteConfirm', { key: secretToDelete ?? '' })"
                :confirm-label="$t('settings.secretsDelete')"
                destructive
                :loading="secretsSaving"
                @confirm="handleDeleteSecret"
                @cancel="secretToDelete = null"
              />
            </div>

            <!-- ═══ Email ═══ -->
            <div v-else-if="activeTab === 'email'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.email') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.emailDescription') }}
                </p>
              </div>

              <EmailAccountsWorkspace />
            </div>

            <!-- ═══ Models ═══ -->
            <ModelPolicyPanel v-else-if="activeTab === 'models'" />

          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { canonicalizeProviderModelRef, NOW_SET_MAX_RANGE, NOW_SET_MODES, SETTINGS_THINKING_LEVELS, SETTINGS_TTS_GEMINI_MODELS, SETTINGS_TTS_GEMINI_VOICES, type SettingsThinkingLevel } from '@axiom/core/contracts'
import { buildProviderModelOptions } from '~/utils/providerModelOptions'
import { useSettingsApi } from '~/api/settings'
import { browserCanPlayType, classifyPlaybackError, pickPlayableFormat } from '~/utils/ttsPlayback'
import EmailAccountsWorkspace from '~/features/email/components/EmailAccountsWorkspace.vue'
import ModelPolicyPanel from './ModelPolicyPanel.vue'
import type { MemoryConsolidationSettings, FactExtractionSettings, HealthMonitorNotificationToggles, HealthMonitorSettings, AgentHeartbeatSettings, TasksSettings, TtsSettings, SttSettings, UploadsSettings, TelegramSettings, WatchdogSettings, RetrySettings, OfftangentSettings, CaptureModesSettings, CaptureSourcesSettings } from '~/composables/useSettings'
import type { TelegramUser } from '~/composables/useTelegramUsers'

/* ── Auth ── */
const { formatDateTime } = useFormat()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

/* ── Tab routing — persisted in URL query for deep-linking ── */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const timezones = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Warsaw',
  'Europe/Moscow',
  'Europe/Istanbul',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
]

const VALID_TABS = ['agent', 'memory', 'agentHeartbeat', 'healthMonitor', 'models', 'telegram', 'tasks', 'tts', 'stt', 'secrets', 'email'] as const
type TabId = (typeof VALID_TABS)[number]

const activeTab = computed<TabId>({
  get() {
    const raw = route.query.tab as string
    return VALID_TABS.includes(raw as TabId) ? (raw as TabId) : 'agent'
  },
  set(value: TabId) {
    router.replace({ query: { tab: value } })
  },
})

const tabs = computed(() => [
  { id: 'agent' as TabId, icon: 'bot', label: t('settings.tabs.agent') },
  { id: 'agentHeartbeat' as TabId, icon: 'activity', label: t('settings.tabs.agentHeartbeat') },
  { id: 'email' as TabId, icon: 'mail', label: t('settings.tabs.email') },
  { id: 'healthMonitor' as TabId, icon: 'activity', label: t('settings.tabs.healthMonitor') },
  { id: 'memory' as TabId, icon: 'brain', label: t('settings.tabs.memory') },
  { id: 'models' as TabId, icon: 'bot', label: t('settings.tabs.models') },
  { id: 'secrets' as TabId, icon: 'key', label: t('settings.tabs.secrets') },
  { id: 'stt' as TabId, icon: 'mic', label: t('settings.sttTitle') },
  { id: 'tasks' as TabId, icon: 'bot', label: t('settings.tabs.tasks') },
  { id: 'telegram' as TabId, icon: 'send', label: t('settings.tabs.telegram') },
  { id: 'tts' as TabId, icon: 'volume', label: t('settings.ttsTitle') },
])

/* ── Settings state ── */
const {
  settings,
  loading,
  saving,
  error,
  successMessage,
  fetchSettings,
  updateSettings,
  clearMessages,
} = useSettings()

/* ── Providers (consolidation dropdown + active provider) ── */
const { providers, fetchProviders, activateProvider, activeProviderId, activeModelId } = useProviders()

/** Current active provider:model composite value for the select dropdown */
const activeProviderModelValue = computed(() => {
  if (!activeProviderId.value) return ''
  const provider = providers.value.find(p => p.id === activeProviderId.value)
  const model = activeModelId.value ?? provider?.enabledModels?.[0] ?? ''
  return `${activeProviderId.value}:${model}`
})

async function handleActivateProvider(value: string) {
  const parts = value.split(':')
  const providerId = parts[0]
  const modelId = parts.slice(1).join(':') || undefined
  if (!providerId) return
  await activateProvider(providerId, modelId)
  await fetchProviders()
}

/** Flattened list of provider+model combinations for all provider select dropdowns */
const providerModelOptions = computed(() => buildProviderModelOptions(providers.value))

/* ── Users (for telegram user assignment) ── */
const { users, fetchUsers } = useUsers()
const { refreshAvatar } = useUserAvatar()

/* ── Telegram users ── */
const {
  telegramUsers,
  loading: telegramUsersLoading,
  fetchTelegramUsers,
  updateTelegramUser,
  deleteTelegramUser,
} = useTelegramUsers()

/* ── Secrets ── */
const {
  secrets: secretsList,
  loading: secretsLoading,
  saving: secretsSaving,
  error: secretsError,
  successMessage: secretsSuccess,
  fetchSecrets,
  updateSecrets,
  removeSecret,
  clearMessages: clearSecretsMessages,
} = useSecrets()

/** Inline editing state for existing secrets */
const secretEdits = ref<Record<string, string>>({})

/** Which secrets have their edit field expanded */
const secretEditOpen = ref<Set<string>>(new Set())

/** State for adding a new secret */
const newSecretKey = ref('')
const newSecretValue = ref('')
const newSecretError = ref<string | null>(null)

/** Delete confirmation */
const secretToDelete = ref<string | null>(null)

function toggleSecretEdit(key: string) {
  const s = new Set(secretEditOpen.value)
  if (s.has(key)) {
    s.delete(key)
    delete secretEdits.value[key]
  } else {
    s.add(key)
  }
  secretEditOpen.value = s
}

function resetSecretEdits() {
  secretEdits.value = {}
  secretEditOpen.value = new Set()
  newSecretKey.value = ''
  newSecretValue.value = ''
  newSecretError.value = null
}

function validateNewSecretKey(key: string): string | null {
  if (!key) return null
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return t('settings.secretsKeyInvalid')
  if (secretsList.value.some(s => s.key === key)) return t('settings.secretsKeyExists')
  return null
}

async function handleSaveSingleSecret(key: string) {
  const value = secretEdits.value[key]
  if (!value) return

  const ok = await updateSecrets({ [key]: value })
  if (ok) {
    toggleSecretEdit(key)
    setTimeout(() => { secretsSuccess.value = null }, 3000)
  }
}

async function handleSaveSecrets() {
  const updates: Record<string, string> = {}

  // Collect edits for existing secrets
  for (const [key, value] of Object.entries(secretEdits.value)) {
    if (value) updates[key] = value
  }

  // Add new secret if provided
  if (newSecretKey.value) {
    const err = validateNewSecretKey(newSecretKey.value)
    if (err) {
      newSecretError.value = err
      return
    }
    if (newSecretValue.value) {
      updates[newSecretKey.value] = newSecretValue.value
    }
  }

  if (Object.keys(updates).length === 0) return

  const ok = await updateSecrets(updates)
  if (ok) {
    resetSecretEdits()
    setTimeout(() => { secretsSuccess.value = null }, 3000)
  }
}

async function handleDeleteSecret() {
  if (!secretToDelete.value) return
  const ok = await removeSecret(secretToDelete.value)
  secretToDelete.value = null
  if (ok) {
    setTimeout(() => { secretsSuccess.value = null }, 3000)
  }
}

function getTelegramAvatarUrl(telegramUserId: number): string {
  const config = useRuntimeConfig()
  const { getAccessToken } = useAuth()
  const token = getAccessToken()
  return `${config.public.apiBase}/api/telegram-users/${telegramUserId}/avatar${token ? `?token=${token}` : ''}`
}

async function handleApproveTelegramUser(id: number) {
  await updateTelegramUser(id, { status: 'approved' })
}

async function handleRejectTelegramUser(id: number) {
  await updateTelegramUser(id, { status: 'rejected' })
}

async function handleAssignUser(telegramUserId: number, userIdStr: string) {
  const userId = userIdStr ? parseInt(userIdStr, 10) : null
  await updateTelegramUser(telegramUserId, { userId })
  refreshAvatar()
}

async function handleDeleteTelegramUser(tgUser: TelegramUser) {
  const name = tgUser.telegramDisplayName || tgUser.telegramUsername || tgUser.telegramId
  if (!confirm(t('settings.telegramUsersDeleteConfirm', { name }))) return
  await deleteTelegramUser(tgUser.id)
  refreshAvatar()
}

/* ── Consolidation runtime ── */
const settingsApi = useSettingsApi()

interface ConsolidationStatus {
  lastRun: string | null
  lastResult: { updated: boolean; reason?: string } | null
}

const consolidationRunning = ref(false)
const consolidationStatus = ref<ConsolidationStatus | null>(null)

async function fetchConsolidationStatus() {
  try {
    consolidationStatus.value = await settingsApi.getConsolidationStatus()
  } catch {
    // Status display is optional — fail silently
  }
}

async function handleRunConsolidation() {
  consolidationRunning.value = true
  try {
    const result = await settingsApi.runConsolidation()
    consolidationStatus.value = {
      lastRun: new Date().toISOString(),
      lastResult: result,
    }
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    consolidationRunning.value = false
  }
}

/* ── Thinking level options (shared by Agent + Tasks tabs) ── */
const thinkingLevelOptions = computed(() =>
  SETTINGS_THINKING_LEVELS.map(value => ({
    value,
    label: t(`settings.thinkingLevelOptions.${value}`),
  })),
)

/* ── Now set mode (auto = ranked from activity, manual = curated) ── */
const nowSetModeOptions = computed(() =>
  NOW_SET_MODES.map(value => ({
    value,
    label: t(`settings.nowSetModeOptions.${value}`),
  })),
)

/* ── Form state ── */
interface MultiPersonaForm {
  enabled: boolean
  defaultAgentId: string
}

interface SettingsForm {
  sessionTimeoutMinutes: number
  sessionSummaryProviderId: string
  language: string
  timezone: string
  thinkingLevel: SettingsThinkingLevel
  healthMonitorIntervalMinutes: number
  uploads: UploadsSettings
  watchdog: WatchdogSettings
  retry: RetrySettings
  telegram: TelegramSettings
  healthMonitor: HealthMonitorSettings
  memoryConsolidation: MemoryConsolidationSettings
  factExtraction: FactExtractionSettings
  agentHeartbeat: AgentHeartbeatSettings
  tasks: TasksSettings
  tts: TtsSettings
  stt: SttSettings
  multiPersona: MultiPersonaForm
  offtangent: OfftangentSettings
  captureModes: CaptureModesSettings
  captureSources: CaptureSourcesSettings
}

const form = ref<SettingsForm | null>(null)

/**
 * Migrate a legacy provider-only ID to the composite "providerId:modelId" format.
 * If the value already contains ':', it is returned as-is.
 * If it matches a known provider, it is expanded to "providerId:<first enabled model>".
 */
function migrateProviderValue(value: string): string {
  return canonicalizeProviderModelRef(
    value,
    providers.value.map(provider => ({ id: provider.id, enabledModels: provider.enabledModels })),
  )
}

function hydrateForm() {
  if (!settings.value) return
  const s = settings.value
  form.value = {
    sessionTimeoutMinutes: s.sessionTimeoutMinutes,
    sessionSummaryProviderId: migrateProviderValue(s.sessionSummaryProviderId ?? ''),
    language: s.language,
    timezone: s.timezone,
    thinkingLevel: s.thinkingLevel,
    healthMonitorIntervalMinutes: s.healthMonitorIntervalMinutes,
    uploads: { ...s.uploads },
    watchdog: { ...s.watchdog },
    retry: { ...s.retry },
    telegram: { ...s.telegram },
    healthMonitor: {
      enabled: s.healthMonitor.enabled,
      fallbackTrigger: s.healthMonitor.fallbackTrigger,
      failuresBeforeFallback: s.healthMonitor.failuresBeforeFallback,
      recoveryCheckIntervalMinutes: s.healthMonitor.recoveryCheckIntervalMinutes,
      successesBeforeRecovery: s.healthMonitor.successesBeforeRecovery,
      notifications: { ...s.healthMonitor.notifications },
    },
    memoryConsolidation: {
      ...s.memoryConsolidation,
      providerId: migrateProviderValue(s.memoryConsolidation.providerId ?? ''),
    },
    factExtraction: {
      ...s.factExtraction,
      providerId: migrateProviderValue(s.factExtraction.providerId ?? ''),
    },
    agentHeartbeat: { ...s.agentHeartbeat, nightMode: { ...s.agentHeartbeat.nightMode } },
    tasks: {
      ...s.tasks,
      defaultProvider: migrateProviderValue(s.tasks.defaultProvider ?? ''),
      loopDetection: {
        ...s.tasks.loopDetection,
        smartProvider: migrateProviderValue(s.tasks.loopDetection.smartProvider ?? ''),
      },
      statusUpdates: { ...s.tasks.statusUpdates },
    },
    tts: { ...s.tts },
    stt: {
      ...s.stt,
      rewrite: {
        ...s.stt.rewrite,
        providerId: migrateProviderValue(s.stt.rewrite?.providerId ?? ''),
      },
    },
    multiPersona: {
      enabled: s.multiPersona?.enabled ?? false,
      defaultAgentId: s.multiPersona?.defaultAgentId ?? 'main',
    },
    offtangent: { ...s.offtangent },
    captureModes: { quick: { ...s.captureModes.quick } },
    captureSources: { puck: { ...s.captureSources.puck } },
  }
}

/**
 * The quick mode's model as ONE `providerId:modelId` value, because that is how
 * every other model pin in this dialog is chosen. Empty means "inherit the
 * persona's model", and it is stored as two empty strings so the backend's
 * pair check (both or neither) stays satisfied.
 */
const quickModeModelValue = computed(() => {
  const quick = form.value?.captureModes.quick
  if (!quick?.providerId || !quick.modelId) return ''
  return `${quick.providerId}:${quick.modelId}`
})

function setQuickModeModel(value: string): void {
  if (!form.value) return
  const colon = value.indexOf(':')
  if (colon === -1) {
    form.value.captureModes.quick.providerId = ''
    form.value.captureModes.quick.modelId = ''
    return
  }
  form.value.captureModes.quick.providerId = value.slice(0, colon)
  form.value.captureModes.quick.modelId = value.slice(colon + 1)
}

watch(settings, hydrateForm)

/* ── OpenAI voice options (filtered by model) ── */
const OPENAI_VOICES_ALL = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'ash', label: 'Ash' },
  { value: 'ballad', label: 'Ballad', gpt4oOnly: true },
  { value: 'coral', label: 'Coral' },
  { value: 'echo', label: 'Echo' },
  { value: 'fable', label: 'Fable' },
  { value: 'nova', label: 'Nova' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse', label: 'Verse', gpt4oOnly: true },
  { value: 'marin', label: 'Marin', gpt4oOnly: true },
  { value: 'cedar', label: 'Cedar', gpt4oOnly: true },
]

const openaiVoiceOptions = computed(() => {
  const isGpt4o = form.value?.tts.openaiModel === 'gpt-4o-mini-tts'
  return OPENAI_VOICES_ALL.filter(v => isGpt4o || !v.gpt4oOnly)
})

// Reset voice when switching to a model that doesn't support it
watch(() => form.value?.tts.openaiModel, (model) => {
  if (!form.value || model === 'gpt-4o-mini-tts') return
  const current = form.value.tts.openaiVoice
  const available = OPENAI_VOICES_ALL.filter(v => !v.gpt4oOnly)
  if (!available.some(v => v.value === current)) {
    form.value.tts.openaiVoice = 'nova'
  }
})

/* ── TTS voices & preview ── */
const { mistralVoices, voicesLoading, fetchMistralVoices } = useTts()

/* ── Deepgram models (shared between STT + TTS panes) ── */
const {
  sttModels: deepgramSttModels,
  ttsModels: deepgramTtsModels,
  loading: deepgramModelsLoading,
  error: deepgramModelsError,
  loaded: deepgramModelsLoaded,
  fetchModels: fetchDeepgramModels,
} = useDeepgram()

/**
 * Format a list of Deepgram language codes for a model dropdown label.
 *
 * Three transformations are applied so multilingual STT models (Deepgram's
 * `nova-3-general` ships with 100+ language entries) stay scannable:
 *
 * 1. **Collapse locale suffixes once the list gets long.** `zh-Hant`,
 *    `zh-CN`, `zh-TW` all collapse to `zh`. Locale variants matter for
 *    pronunciation, but at 117 languages the user mostly wants to know
 *    "does this support Chinese?" — the locale picker is the language field
 *    below, not the model picker.
 * 2. **English first.** Most installations transcribe English most of the
 *    time, so seeing `en` in the visible prefix is the most useful signal.
 *    Everything else sorts alphabetically for predictable scanning.
 * 3. **Truncate with `+N`** to keep the label width bounded.
 */
function formatDeepgramLanguageList(langs: string[]): string {
  if (langs.length === 0) return ''

  // Strip locale suffixes once the list is long enough that per-locale detail
  // is more noise than signal. Threshold of 6 means small bilingual TTS
  // voices keep their precise codes (`en-US`), while the big STT catalogs
  // collapse cleanly.
  const COLLAPSE_THRESHOLD = 6
  let normalized: string[]
  if (langs.length > COLLAPSE_THRESHOLD) {
    const seen = new Set<string>()
    normalized = []
    for (const lang of langs) {
      const base = lang.split('-')[0] ?? lang
      if (!seen.has(base)) {
        seen.add(base)
        normalized.push(base)
      }
    }
  } else {
    normalized = [...langs]
  }

  // Pull `en` to the front (case-insensitive, locale-tolerant), keep the rest
  // alphabetically sorted. Done after the collapse so an `en-US`-only list
  // also gets the priority treatment.
  const front: string[] = []
  const rest: string[] = []
  for (const lang of normalized) {
    if (lang.toLowerCase().startsWith('en')) front.push(lang)
    else rest.push(lang)
  }
  rest.sort((a, b) => a.localeCompare(b))
  const ordered = [...front, ...rest]

  const MAX_INLINE = 6
  if (ordered.length <= MAX_INLINE) return ordered.join(', ')
  return `${ordered.slice(0, MAX_INLINE).join(', ')}, +${ordered.length - MAX_INLINE}`
}

/**
 * Build the option list for a Deepgram model `<Select>`. Four responsibilities:
 *
 * 1. **Dedup by `canonical_name`** — Deepgram's `/v1/models` returns one entry
 *    per supported language (and per batch/streaming mode and internal
 *    version), but only `canonical_name` ever gets passed back via `?model=`.
 *    For STT the language is set independently via `?language=...` (the
 *    "Deepgram Language" field below the model picker), so collapsing
 *    language variants into one entry is correct — they're the same model.
 *    For TTS the language is already baked into the canonical_name
 *    (`aura-2-thalia-en` vs. `aura-2-ophelia-de`) so each entry survives
 *    dedup naturally.
 * 2. **Aggregate languages per canonical_name** so the user can still tell at
 *    a glance which languages a model supports without seeing duplicate rows.
 * 3. **Sort by primary language first, then canonical_name.** Useful mostly
 *    for TTS voices: groups all `aura-*-de`, `aura-*-en`, `aura-*-es` ...
 *    blocks together so picking a German voice doesn't require scrolling
 *    through interleaved languages. Harmless for STT because the big
 *    multilingual models share the same primary language after aggregation.
 * 4. **Always include the currently-selected value** — even when the API
 *    hasn't been polled yet or the value is no longer in Deepgram's catalog —
 *    so the dropdown never silently drops the user's saved selection.
 */
function deepgramModelOptions(
  apiModels: Array<{ canonical_name: string; languages?: string[] }>,
  currentValue: string,
): Array<{ value: string; label: string }> {
  // Aggregate: canonical_name -> ordered set of distinct languages
  const langsByName = new Map<string, string[]>()
  for (const m of apiModels) {
    if (!m.canonical_name) continue
    let bucket = langsByName.get(m.canonical_name)
    if (!bucket) {
      bucket = []
      langsByName.set(m.canonical_name, bucket)
    }
    for (const lang of m.languages ?? []) {
      if (lang && !bucket.includes(lang)) bucket.push(lang)
    }
  }

  // Primary language used for sorting: the first language of each model with
  // its locale suffix stripped (`de-DE` -> `de`). For TTS each canonical_name
  // has exactly one base language; for STT it's whichever Deepgram lists
  // first — which is fine since the per-model lang set is shown in the label
  // anyway.
  const options = Array.from(langsByName.entries()).map(([name, langs]) => {
    const langPart = formatDeepgramLanguageList(langs)
    const primaryLang = (langs[0] ?? '').split('-')[0] ?? ''
    return {
      value: name,
      label: langPart ? `${name} (${langPart})` : name,
      primaryLang,
    }
  })
  options.sort((a, b) => {
    const langCmp = a.primaryLang.localeCompare(b.primaryLang)
    return langCmp !== 0 ? langCmp : a.value.localeCompare(b.value)
  })

  // Drop the internal `primaryLang` before returning so the option shape
  // stays `{ value, label }` for the `<Select>`.
  const cleaned = options.map(({ value, label }) => ({ value, label }))

  if (currentValue && !langsByName.has(currentValue)) {
    // Surface the saved value so the trigger can render it; flag as `(current)`
    // so the user knows it's not part of the freshly-fetched list.
    cleaned.unshift({ value: currentValue, label: `${currentValue} (current)` })
  }
  return cleaned
}

const sttDeepgramModelOptions = computed(() =>
  deepgramModelOptions(deepgramSttModels.value, form.value?.stt.deepgramModel ?? ''),
)
const ttsDeepgramModelOptions = computed(() =>
  deepgramModelOptions(deepgramTtsModels.value, form.value?.tts.deepgramModel ?? ''),
)

/**
 * Trigger a refresh of the Deepgram model list, scoped to either STT or TTS
 * since the two now have separate Deepgram keys. The currently-typed key
 * from the matching form block is passed along so the user can test a fresh
 * key without having to Save first — the backend falls back to the saved
 * key for the same scope when this is empty or still the masked sentinel.
 *
 * Failures are surfaced inline via `deepgramModelsError` so the click never
 * throws.
 */
async function handleRefreshSttDeepgramModels() {
  const typedKey = form.value?.stt.deepgramApiKey ?? ''
  await fetchDeepgramModels({ scope: 'stt', apiKey: typedKey })
}

async function handleRefreshTtsDeepgramModels() {
  const typedKey = form.value?.tts.deepgramApiKey ?? ''
  await fetchDeepgramModels({ scope: 'tts', apiKey: typedKey })
}
const ttsPreviewText = ref('Hello! This is a preview of the selected voice.')
const ttsPreviewLoading = ref(false)
const ttsPreviewPlaying = ref(false)
/** Audio arrived but the browser wants a fresh click before it plays. */
const ttsPreviewBlocked = ref(false)
const ttsPreviewError = ref<string | null>(null)
let previewAudio: HTMLAudioElement | null = null
let previewBlobUrl: string | null = null
/** Bumped by every start/stop; async continuations of an older click bail. */
let previewGeneration = 0

function stopTtsPreview() {
  previewGeneration++
  if (previewAudio) {
    // Detach first: pause() rejects a pending play() with AbortError and
    // load() on an empty src fires `error`; neither is a user-facing failure.
    previewAudio.onended = null
    previewAudio.onerror = null
    previewAudio.pause()
    previewAudio.removeAttribute('src')
    previewAudio.load()
    previewAudio = null
  }
  if (previewBlobUrl) {
    URL.revokeObjectURL(previewBlobUrl)
    previewBlobUrl = null
  }
  ttsPreviewPlaying.value = false
  ttsPreviewLoading.value = false
  ttsPreviewBlocked.value = false
}

function reportTtsPreviewError(err: unknown) {
  const failure = classifyPlaybackError(err)
  if (failure.kind === 'aborted') return
  if (failure.kind === 'blocked') {
    // Keep the decoded audio: the next click plays it inside the gesture.
    ttsPreviewBlocked.value = true
    ttsPreviewLoading.value = false
    ttsPreviewPlaying.value = false
    ttsPreviewError.value = t('settings.ttsPreviewBlocked')
    return
  }
  ttsPreviewError.value = failure.kind === 'unsupported'
    ? t('settings.ttsPreviewUnsupported')
    : failure.message
  stopTtsPreview()
}

async function handleTtsPreview() {
  if (ttsPreviewBlocked.value && previewAudio) {
    const generation = ++previewGeneration
    ttsPreviewBlocked.value = false
    ttsPreviewError.value = null
    ttsPreviewPlaying.value = true
    previewAudio.play().catch((err) => {
      if (generation === previewGeneration) reportTtsPreviewError(err)
    })
    return
  }
  if (ttsPreviewPlaying.value || ttsPreviewLoading.value) {
    stopTtsPreview()
    return
  }
  if (!form.value || !ttsPreviewText.value.trim()) return

  // Send full unsaved TTS settings so the backend uses them for preview
  const tts = form.value.tts
  const format = pickPlayableFormat(tts.responseFormat, tts.provider, browserCanPlayType())
  const body = {
    text: ttsPreviewText.value,
    ...(format ? { format } : {}),
    settings: {
      provider: tts.provider,
      providerId: tts.providerId,
      openaiModel: tts.openaiModel,
      openaiVoice: tts.openaiVoice,
      openaiInstructions: tts.openaiInstructions,
      mistralVoice: tts.mistralVoice,
      responseFormat: tts.responseFormat,
      geminiModel: tts.geminiModel,
      geminiVoice: tts.geminiVoice,
      geminiStyle: tts.geminiStyle,
    },
  }

  ttsPreviewLoading.value = true
  ttsPreviewError.value = null
  const generation = ++previewGeneration
  try {
    const blob = await settingsApi.previewTts(body)
    if (generation !== previewGeneration) return
    previewBlobUrl = URL.createObjectURL(blob)
    const element = new Audio(previewBlobUrl)
    previewAudio = element
    element.onended = () => {
      if (generation === previewGeneration) stopTtsPreview()
    }
    element.onerror = () => {
      if (generation === previewGeneration) reportTtsPreviewError(element.error ?? new Error('media error'))
    }
    try {
      await element.play()
    } catch (err) {
      if (generation === previewGeneration) reportTtsPreviewError(err)
      return
    }
    if (generation !== previewGeneration) return
    ttsPreviewLoading.value = false
    ttsPreviewPlaying.value = true
  } catch (err) {
    if (generation !== previewGeneration) return
    console.error('TTS preview failed:', err)
    ttsPreviewError.value = err instanceof Error ? err.message : String(err)
    stopTtsPreview()
  }
}

onUnmounted(() => stopTtsPreview())

interface MistralSpeakerOption {
  name: string
  languageLabel: string
  moods: Array<{ mood: string; id: string }>
}

/** Parse voices into grouped speaker options */
const mistralSpeakerOptions = computed<MistralSpeakerOption[]>(() => {
  const langLabels: Record<string, string> = {
    en_us: 'English US',
    en_gb: 'English UK',
    fr_fr: 'Français',
    de_de: 'Deutsch',
    es_es: 'Español',
    it_it: 'Italiano',
    pt_pt: 'Português',
    nl_nl: 'Nederlands',
    hi_in: 'Hindi',
    ar_sa: 'Arabic',
  }
  const speakers = new Map<string, MistralSpeakerOption>()
  for (const v of mistralVoices.value) {
    const parts = v.name.split(' - ')
    const name = parts[0]?.trim() ?? v.name
    const mood = parts[1]?.trim() ?? 'Default'
    if (!speakers.has(name)) {
      const langCode = v.languages[0] ?? ''
      speakers.set(name, {
        name,
        languageLabel: langLabels[langCode] ?? langCode,
        moods: [],
      })
    }
    speakers.get(name)!.moods.push({ mood, id: v.id })
  }
  return Array.from(speakers.values())
})

/** Available moods for the currently selected speaker */
const mistralMoodOptions = computed<string[]>(() => {
  const speaker = mistralSpeakerOptions.value.find(s => s.name === mistralSpeaker.value)
  return speaker?.moods.map(m => m.mood) ?? []
})

/** Resolve current voice UUID to speaker name */
function resolveVoiceToSpeakerMood(voiceId: string): { speaker: string; mood: string } {
  for (const s of mistralSpeakerOptions.value) {
    const found = s.moods.find(m => m.id === voiceId)
    if (found) return { speaker: s.name, mood: found.mood }
  }
  // Fallback: pick first speaker + first mood
  const first = mistralSpeakerOptions.value[0]
  return { speaker: first?.name ?? '', mood: first?.moods[0]?.mood ?? '' }
}

/** Selected speaker name (synced with form.tts.mistralVoice) */
const mistralSpeaker = computed({
  get(): string {
    if (!form.value) return ''
    return resolveVoiceToSpeakerMood(form.value.tts.mistralVoice).speaker
  },
  set(name: string) {
    if (!form.value) return
    const speaker = mistralSpeakerOptions.value.find(s => s.name === name)
    if (!speaker) return
    // Try to keep the same mood, otherwise pick Neutral or first
    const currentMood = resolveVoiceToSpeakerMood(form.value.tts.mistralVoice).mood
    const sameMood = speaker.moods.find(m => m.mood === currentMood)
    const neutral = speaker.moods.find(m => m.mood === 'Neutral')
    const target = sameMood ?? neutral ?? speaker.moods[0]
    if (target) form.value.tts.mistralVoice = target.id
  },
})

/** Selected mood (synced with form.tts.mistralVoice) */
const mistralMood = computed({
  get(): string {
    if (!form.value) return ''
    return resolveVoiceToSpeakerMood(form.value.tts.mistralVoice).mood
  },
  set(mood: string) {
    if (!form.value) return
    const speaker = mistralSpeakerOptions.value.find(s => s.name === mistralSpeaker.value)
    const target = speaker?.moods.find(m => m.mood === mood)
    if (target) form.value.tts.mistralVoice = target.id
  },
})

/* ── TTS provider composite select ── */
const ttsProviderOptions = computed(() => {
  const options: Array<{ value: string; label: string; disabled?: boolean }> = []

  // OpenAI-compatible providers
  const openaiProviders = providers.value.filter(p =>
    p.providerType === 'openai' || p.provider === 'openai' || p.baseUrl?.includes('api.openai.com')
  )
  if (openaiProviders.length > 0) {
    for (const p of openaiProviders) {
      options.push({ value: `openai::${p.id}`, label: `OpenAI (${p.name})` })
    }
  } else {
    options.push({ value: 'openai::', label: t('settings.ttsProviderOpenaiNone'), disabled: true })
  }

  // Mistral-compatible providers
  const mistralProviders = providers.value.filter(p =>
    p.providerType === 'mistral' || p.provider === 'mistral' || p.baseUrl?.includes('api.mistral.ai')
  )
  if (mistralProviders.length > 0) {
    for (const p of mistralProviders) {
      options.push({ value: `mistral::${p.id}`, label: `Mistral Voxtral (${p.name})` })
    }
  } else {
    options.push({ value: 'mistral::', label: t('settings.ttsProviderMistralNone'), disabled: true })
  }

  // Deepgram — standalone, uses the shared `deepgramApiKey` from the STT block
  // (canonical location, since both STT and TTS share one Deepgram account).
  options.push({ value: 'deepgram::', label: t('settings.ttsProviderDeepgram') })

  // Gemini — keyed by a Google provider (Gemini API key), same pattern as
  // OpenAI/Mistral: the key lives in Settings → Providers, not here.
  const googleProviders = providers.value.filter(p =>
    p.providerType === 'google' || p.provider === 'google' || p.baseUrl?.includes('generativelanguage.googleapis.com')
  )
  if (googleProviders.length > 0) {
    for (const p of googleProviders) {
      options.push({ value: `gemini::${p.id}`, label: `Google Gemini TTS (${p.name})` })
    }
  } else {
    options.push({ value: 'gemini::', label: t('settings.ttsProviderGeminiNone'), disabled: true })
  }

  return options
})

/* ── Gemini TTS option lists (from the shared contract) ── */
const ttsGeminiModelOptions = computed(() => {
  const known = [...SETTINGS_TTS_GEMINI_MODELS] as string[]
  // Keep a saved id the list does not know yet, so the select never shows blank.
  const current = form.value?.tts.geminiModel
  if (current && !known.includes(current)) known.unshift(current)
  return known
})
const ttsGeminiVoices = SETTINGS_TTS_GEMINI_VOICES

/**
 * Gemini only ever returns PCM; the backend packages it as Opus or WAV and
 * rejects mp3/flac with an error. Hide those here and move a saved mp3/flac
 * choice to Opus when Gemini is selected, so the form never saves a
 * combination the backend refuses.
 */
const GEMINI_FORMATS = new Set(['opus', 'wav'])
const ttsFormatOptions = computed(() => {
  const all = [
    { value: 'mp3', label: 'MP3' },
    { value: 'wav', label: 'WAV' },
    { value: 'opus', label: 'Opus' },
    { value: 'flac', label: 'FLAC' },
  ]
  return form.value?.tts.provider === 'gemini' ? all.filter(o => GEMINI_FORMATS.has(o.value)) : all
})
watch(() => form.value?.tts.provider, (provider) => {
  if (!form.value || provider !== 'gemini') return
  if (!GEMINI_FORMATS.has(form.value.tts.responseFormat)) {
    form.value.tts.responseFormat = 'opus'
  }
})

const ttsProviderComposite = computed({
  get(): string {
    if (!form.value) return 'openai::'
    const { provider, providerId } = form.value.tts
    return `${provider}::${providerId}`
  },
  set(value: string) {
    if (!form.value) return
    const [type, ...rest] = value.split('::')
    const id = rest.join('::')
    form.value.tts.provider = type as 'openai' | 'mistral' | 'deepgram' | 'gemini'
    form.value.tts.providerId = id
  },
})

/* ── STT provider composite select ── */
const sttProviderOptions = computed(() => {
  const options: Array<{ value: string; label: string; disabled?: boolean }> = []

  // Whisper URL (standalone, no provider needed)
  options.push({ value: 'whisper-url::', label: t('settings.sttProviderWhisperUrl') })

  // OpenAI-compatible providers
  const openaiProviders = providers.value.filter(p =>
    p.providerType === 'openai' || p.provider === 'openai' || p.baseUrl?.includes('api.openai.com')
  )
  if (openaiProviders.length > 0) {
    for (const p of openaiProviders) {
      options.push({ value: `openai::${p.id}`, label: `${t('settings.sttProviderOpenai')} (${p.name})` })
    }
  } else {
    options.push({ value: 'openai::', label: t('settings.sttOpenaiNone'), disabled: true })
  }

  // Ollama providers
  const ollamaProviders = providers.value.filter(p =>
    p.providerType === 'ollama'
  )
  if (ollamaProviders.length > 0) {
    for (const p of ollamaProviders) {
      options.push({ value: `ollama::${p.id}`, label: `${t('settings.sttProviderOllama')} (${p.name})` })
    }
  } else {
    options.push({ value: 'ollama::', label: t('settings.sttOllamaNone'), disabled: true })
  }

  // Deepgram — standalone, uses the shared `deepgramApiKey` stored under STT
  // (also consumed by the Deepgram TTS path).
  options.push({ value: 'deepgram::', label: t('settings.sttProviderDeepgram') })

  return options
})

const sttProviderComposite = computed({
  get(): string {
    if (!form.value) return 'whisper-url::'
    const { provider, providerId } = form.value.stt
    return `${provider}::${providerId}`
  },
  set(value: string) {
    if (!form.value) return
    const [type, ...rest] = value.split('::')
    const id = rest.join('::')
    form.value.stt.provider = type as 'whisper-url' | 'openai' | 'ollama' | 'deepgram'
    form.value.stt.providerId = id
  },
})

/* ── Notification toggles ── */
const notificationToggles = computed(() => [
  { key: 'healthyToDegraded' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyHealthyToDegraded') },
  { key: 'degradedToHealthy' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyDegradedToHealthy') },
  { key: 'degradedToDown' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyDegradedToDown') },
  { key: 'healthyToDown' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyHealthyToDown') },
  { key: 'downToFallback' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyDownToFallback') },
  { key: 'fallbackToHealthy' as keyof HealthMonitorNotificationToggles, label: t('settings.healthMonitorNotifyFallbackToHealthy') },
])

/* ── Resilience helpers ── */
const retryBackoffSchedule = computed(() => {
  const retry = form.value?.retry
  if (!retry || !retry.baseDelayMs || retry.maxRetries < 1) return '—'
  return Array.from({ length: Math.min(retry.maxRetries, 10) }, (_, i) =>
    `${Math.round((retry.baseDelayMs * 2 ** i) / 100) / 10}s`,
  ).join(' · ')
})

const watchdogThresholdInvalid = computed(() => {
  const watchdog = form.value?.watchdog
  if (!watchdog) return false
  return watchdog.stallAbortMs < watchdog.stallWarnMs
})

/* ── Save ── */
async function handleSave() {
  if (!form.value) return
  if (watchdogThresholdInvalid.value) {
    error.value = t('settings.watchdogStallAbortInvalid')
    return
  }
  const success = await updateSettings(form.value)
  if (!success) return

  hydrateForm()
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

/* ── Init ── */
onMounted(async () => {
  if (!isAdmin.value) return
  await Promise.all([
    fetchSettings(),
    fetchProviders(),
    fetchUsers(),
    fetchTelegramUsers(),
    fetchConsolidationStatus(),
    fetchSecrets(),
    fetchMistralVoices(),
  ])
  hydrateForm()
  // Auto-fetch Deepgram models on first load so the dropdown is populated by
  // the time the user opens the STT/TTS pane. STT takes precedence when both
  // providers are set to Deepgram — the user can hit either refresh button to
  // re-fetch with the other key. Skipped silently when no key is present;
  // the refresh buttons still give the user a manual trigger.
  if (!deepgramModelsLoaded.value) {
    if (form.value?.stt.provider === 'deepgram' && form.value.stt.deepgramApiKey) {
      void fetchDeepgramModels({ scope: 'stt' })
    } else if (form.value?.tts.provider === 'deepgram' && form.value.tts.deepgramApiKey) {
      void fetchDeepgramModels({ scope: 'tts' })
    }
  }
})
</script>
