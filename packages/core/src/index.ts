export { AgentHeartbeatService, DEFAULT_AGENT_HEARTBEAT_SETTINGS } from './agent-heartbeat.js'
export type { AgentHeartbeatSettings, AgentHeartbeatNightMode, AgentHeartbeatServiceOptions } from './agent-heartbeat.js'
export { initDatabase, getDatabase, isValidUsername, validateUsername } from './database.js'
export { getOAuthAuth, oauthLogin } from './pi-oauth.js'
export type { Database } from './database.js'
export {
  getDataDir,
  getUploadsDir,
  getUploadsTempDir,
  ensureUploadsTempDir,
  getFreeDiskBytes,
  saveUpload,
  saveUploadFromFile,
  resolveStoredUpload,
  serializeUploadsMetadata,
  parseUploadsMetadata,
  getUploadRetentionDays,
  cleanupExpiredUploads,
  cleanupStaleTempUploads,
  getImageDimensions,
} from './uploads.js'
export type { UploadDescriptor, SaveUploadInput, SaveUploadFromFileInput, UploadSettings } from './uploads.js'
export { buildAttachmentContext } from './attachment-context.js'
export type { AttachmentContext } from './attachment-context.js'
export { loadConfig, warnConfigReadFailed, getConfigDir, ensureConfigTemplates, getDefaultTimezone, getProjectRootDir, getReadmePath, getDocsPath, getAgentDocsPath, loadMultiPersonaSettings, loadCaptureModeSettings } from './config.js'
export type { MultiPersonaSettings } from './config.js'
export { loadPersona, clearPersonaCache, invalidatePersonaCache, seedPersonaFiles, getPersonaDir, listPersonaIds } from './persona-loader.js'
export type { PersonaContext } from './persona-loader.js'
// Offtangent (SPEC 13.2, 13.3, 13.5): the persona record, the structured view
// of its markdown files and the delete cascade preview.
export {
  ensurePersonaTable,
  getDefaultPersonaId,
  getPersonaRecord,
  listPersonaRecords,
  ensurePersonaRecord,
  updatePersonaRecord,
  deletePersonaRecord,
  hasLiveTaskForPersona,
  previewPersonaDelete,
  LEGACY_DEFAULT_PERSONA_ID,
} from './persona-store.js'
export type { PersonaRecord, PersonaRecordPatch, PersonaDeletePreview } from './persona-store.js'
export {
  parsePersonaFields,
  applyPersonaFields,
  EMPTY_PERSONA_FIELDS,
  PERSONA_COLOR_PATTERN,
  PERSONA_NAME_MAX,
  PERSONA_BADGE_MAX,
  PERSONA_ROLE_MAX,
  PERSONA_TONE_MAX,
  PERSONA_MODEL_MAX,
  PERSONA_SUBJECT_MAX,
  PERSONA_SUBJECTS_MAX_COUNT,
  PERSONA_TOOL_MAX,
  PERSONA_TOOLS_MAX_COUNT,
} from './persona-fields.js'
export type { PersonaFields, PersonaFieldsPatch, PersonaFieldFiles } from './persona-fields.js'
export * from './contracts/index.js'
export {
  normalizeThinkingLevel,
  toPiAiReasoning,
  readChatThinkingLevelFromConfig,
  readBackgroundThinkingLevelFromConfig,
  resolveBackgroundReasoning,
  resolveChatReasoning,
} from './thinking-level.js'
export { assertLlmResponseOk } from './llm-response.js'
export {
  ensureMemoryStructure,
  ensureConfigStructure,
  getMemoryDir,
  readSoulFile,
  readMemoryFile,
  writeMemoryFile,
  readAgentsFile,
  writeAgentsFile,
  readAgentsRulesFile,
  writeAgentsRulesFile,
  getDefaultAgentsRulesContent,
  readHeartbeatFile,
  writeHeartbeatFile,
  getDefaultHeartbeatContent,
  readConsolidationFile,
  writeConsolidationFile,
  getDefaultConsolidationContent,
  readTasksGuidelinesFile,
  writeTasksGuidelinesFile,
  getDefaultTasksGuidelinesContent,
  getDailyFilePath,
  ensureDailyFile,
  readDailyFile,
  appendToDailyFile,
  readRecentDailyFiles,
  readRecentDailyEntries,
  assembleSystemPrompt,
  formatRuntimeInstanceBlock,
} from './memory.js'
export { budgetRecentMemory, DAILY_SEPARATOR } from './recent-memory.js'
export type { DailyMemoryEntry, RecentMemoryBudgetOptions, RecentMemoryBudgetResult } from './recent-memory.js'
export {
  SYSTEM_PROMPT_CACHE_MARKER,
  DEFAULT_PROMPT_CACHE_SETTINGS,
  loadPromptCacheSettings,
  resolvePromptCacheSettings,
  splitSystemPromptAtCacheMarker,
  applySystemPromptCacheBreakpoint,
  isAnthropicMessagesApi,
} from './prompt-cache.js'
export type { PromptCacheSettings, PromptCacheRetention } from './prompt-cache.js'
export { getUserProfileDir, ensureUserProfile, readUserProfile, ensureWikiDir, ensureProjectsDir, parseProjectAliases, listWikiPages, listProjectNotes } from './memory.js'
export { isScopedAgentMemoryEnabled, getAgentMemoryDir, resolveAgentMemoryDir, ensurePersonaMemoryRoots } from './memory.js'
export type { ResolveAgentMemoryDirOptions } from './memory.js'
export type { SkillPromptEntry, RuntimeInstanceIdentity } from './memory.js'
// RC5: readDailyFilesForConsolidation stays exported — unlike upstream, our fork
// uses it live in listPersonaConsolidationTargets() to decide which personas have
// daily content worth consolidating. Upstream's removed single-call path
// (consolidateMemory, buildConsolidationPrompt) is dropped as intended.
export { readDailyFilesForConsolidation } from './memory-consolidation.js'
export type { ConsolidationResult } from './memory-consolidation.js'
export { SessionManager, generateSessionId } from './session-manager.js'
export type {
  SessionInfo,
  SessionManagerOptions,
  SessionEndCallbackOptions,
  SessionType,
  CreateSessionOptions,
  Thread,
  ListThreadsOptions,
  UpdateThreadPatch,
} from './session-manager.js'
export {
  loadProviders,
  loadProvidersDecrypted,
  loadProvidersMasked,
  saveProviders,
  addProvider,
  updateProvider,
  updateProviderModel,
  ProviderNotFoundError,
  deleteProvider,
  setActiveProvider,
  setActiveModel,
  getActiveModelId,
  updateProviderStatus,
  getActiveProvider,
  getFallbackProvider,
  getFallbackModelId,
  setFallbackProvider,
  clearFallbackProvider,
  getApiKeyForProvider,
  getPiOAuthAuth,
  getAvailableModels,
  syncNewCatalogModels,
  isDynamicCatalogProvider,
  addOAuthProvider,
  updateOAuthCredentials,
  encryptOAuthCredentials,
  storedToOAuthCredentials,
  buildModel,
  getProviderDefaultModel,
  estimateCost,
  parseProviderModelId,
  resolveProviderModelId,
  resolveProviderModelInput,
  resolveModelTemperature,
  DEFAULT_PRICE_TABLE,
  getConfiguredPriceTable,
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  LOCAL_HEALTH_CHECK_TIMEOUT_MS,
  getDefaultHealthCheckTimeoutMs,
  PROVIDER_TYPE_PRESETS,
  PROVIDER_TYPE_MODEL_OVERRIDES,
  CLAUDE_CODE_VERSION,
  getProviderExtraFieldDefs,
  maskProviderExtraFields,
  resolvePromptProfileOptions,
} from './provider-config.js'
export type { StreamCacheOptions } from './provider-config.js'
export type { ProviderConfig, MaskedProviderConfig, MaskedProvidersFile, ProviderModelConfig, ProvidersFile, ProviderType, ProviderTypePreset, ProviderExtraFieldDef, AuthMethod, TextVerbosity, ProviderTransport, PromptProfile, PromptProfileOptions, AvailableModel, OAuthCredentialsStored, TokenPriceTable } from './provider-config.js'
// Replacements for the deprecated @earendil-works/pi-ai/compat free functions.
// Re-exported so packages outside core (web-backend) can reach them, since
// core is only consumable through this index.
export { streamSimple, completeSimple } from './pi-models.js'
// Spoken output for the companion app: "summarize aloud" (POST /api/speech/summary).
export {
  SPEECH_SOURCE_CAP,
  SPEECH_DIRECT_MAX_CHARS,
  SPEECH_MAX_CHARS,
  SPEECH_MAX_SENTENCES,
  cleanSpokenText,
  detectSpeechLanguage,
  limitSpokenSentences,
  sanitizeSpeechSource,
  sanitizeSpeechSourceDetailed,
} from './speech-text.js'
export type { SpeechLanguage, SanitizedSpeechSource } from './speech-text.js'
export {
  SPEECH_SUMMARY_PREFERRED_MODELS,
  SPEECH_SUMMARY_TIMEOUT_MS,
  SpeechSummaryEmptyError,
  SpeechSummaryUpstreamError,
  buildSpeechSummaryPrompt,
  resolveSpeechSummaryModel,
  summarizeForSpeech,
} from './speech-summary.js'
export type { SpeechSummaryResult, SummarizeForSpeechOptions } from './speech-summary.js'
export {
  fetchAnthropicQuota,
  getAnthropicQuotaForProvider,
  isAnthropicOAuthProvider,
  anthropicQuotaAdapter,
} from './anthropic-quota.js'
export {
  fetchOpenAiCodexQuota,
  getOpenAiCodexQuotaForProvider,
  isOpenAiCodexOAuthProvider,
  extractCodexAccountId,
  openaiCodexQuotaAdapter,
} from './openai-codex-quota.js'
export {
  fetchOpenCodeGoQuota,
  getOpenCodeGoQuotaForProvider,
  isOpenCodeGoQuotaProvider,
  parseOpenCodeGoQuotaHtml,
  resolveOpenCodeGoQuotaCredentials,
  opencodeGoQuotaAdapter,
} from './opencode-go-quota.js'
export {
  fetchZaiQuota,
  getZaiQuotaForProvider,
  isZaiQuotaProvider,
  zaiQuotaAdapter,
} from './zai-quota.js'
export {
  getQuotaAdapter,
  isQuotaProvider,
} from './quota-registry.js'
export { createProviderQuotaTool } from './quota-tool.js'
export type { QuotaServiceLike, ProviderQuotaToolOptions } from './quota-tool.js'
export {
  parseRetryAfterMs,
  normalizeUtilization,
  limitWindowLabel,
} from './provider-quota.js'
export type { ProviderQuotaFetchResult, QuotaProviderAdapter } from './provider-quota.js'
export { encrypt, decrypt, isEncrypted, maskApiKey } from './encryption.js'
export {
  logTokenUsage,
  logToolCall,
  getTokenUsage,
  getToolCalls,
  queryToolCalls,
  getToolCallById,
  getDistinctToolNames,
  getMemoryUsageStats,
  INTERNAL_METRIC_TOOL_NAMES,
} from './token-logger.js'
export type { TokenUsageRecord, ToolCallRecord, ToolCallQueryOptions, ToolCallQueryResult, MemoryFileReadStat, MemorySearchStat, MemoryUsageStats } from './token-logger.js'
export { queryUsageStats, getUsageSummary } from './usage-stats.js'
export type { UsageGroupBy, UsageStatsQueryOptions, UsageTotals, UsageStatsRow, UsageStatsResult, UsageSummary } from './usage-stats.js'
export {
  performProviderHealthCheck,
  logHealthCheck,
  getLatestHealthCheck,
  queryHealthCheckHistory,
  getActivitySummary,
} from './provider-health.js'
export type {
  ProviderHealthStatus,
  ProviderHealthCheckOptions,
  ProviderHealthCheckResult,
  HealthCheckLogInput,
  HealthCheckHistoryRecord,
  HealthCheckHistoryResult,
  ActivitySummary,
} from './provider-health.js'
export {
  parseSkillMd,
  extractFrontmatter,
  isValidSkillName,
  slugifySkillName,
} from './skill-parser.js'
export type { ParsedSkill } from './skill-parser.js'
export {
  parseSkillSource,
  downloadSkillDirectory,
  installSkill,
  installSkillFromZip,
} from './skill-installer.js'
export type { SkillSource, SkillInstallResult, SkillUploadResult, FetchFn } from './skill-installer.js'
export {
  loadSkills,
  saveSkills,
  addSkill,
  updateSkill,
  deleteSkill,
  getSkill,
  getSkillDecrypted,
  loadSkillsDecrypted,
} from './skill-config.js'
export type { SkillConfig, SkillsFile } from './skill-config.js'
export {
  loadSecrets,
  saveSecrets,
  loadSecretsDecrypted,
  loadSecretsMasked,
  setSecret,
  setSecrets,
  deleteSecret,
  injectSecretsIntoEnv,
} from './secrets-config.js'
export type { SecretsFile } from './secrets-config.js'
export {
  createWebSearchTool,
  createWebFetchTool,
  createBuiltinWebTools,
  extractTextFromHtml,
  searchDuckDuckGo,
  parseDuckDuckGoLiteHtml,
  searchBrave,
  searchSearXNG,
  searchTavily,
  resolveSearchProvider,
  encryptBraveApiKey,
  decryptBraveApiKey,
  encryptTavilyApiKey,
  decryptTavilyApiKey,
  stripInlineHtml,
  withRetry,
  BraveSearchError,
  TavilySearchError,
} from './web-tools.js'
export type { WebSearchResult, WebSearchConfig, WebSearchConfigSource, WebFetchConfig, BuiltinToolsConfig, BuiltinToolsConfigSource, SearchProvider, ResolvedSearchProvider, BraveErrorCategory, TavilyErrorCategory, RetryOptions } from './web-tools.js'
export {
  listAgentSkills,
  trackAgentSkillUsage,
  getRecentAgentSkills,
  getAgentSkillsForPrompt,
  getAgentSkillsCount,
  getAgentSkillsDir,
  createAgentSkillTools,
  filterAndAnnotateAgentSkills,
  currentPlatform,
} from './agent-skills.js'
export type { AgentSkillEntry, AgentSkillUsage, SkillPromptContext } from './agent-skills.js'
export { AgentCore, createYoloTools, getWorkspaceDir, isRetryablePreStreamError } from './agent.js'
export type { ResponseChunk, AgentCoreOptions } from './agent.js'
export { TurnRunner } from './turn-runner.js'
export { AUTO_FORBIDDEN_PROVIDER_TYPES, resolveEffectiveModel } from './model-resolution.js'
export type { EffectiveModel, ModelResolutionInput, ModelResolutionSource, ModelSelection } from './model-resolution.js'
export {
  isBlockedProviderType,
  isChainRole,
  loadModelPolicyRoles,
  MODEL_POLICY_CHAIN_ROLES,
  MODEL_POLICY_LEGACY_FIELDS,
  MODEL_POLICY_READ_ONLY_ROLE,
  MODEL_POLICY_ROLES,
  MODEL_POLICY_SINGLE_ROLES,
  resolveDefaultRole,
  resolveModelPolicySpec,
  resolveRoleProvider,
  resolveRoleSpec,
} from './model-policy.js'
export type {
  ModelPolicyChainRole,
  ModelPolicyRoleSource,
  ResolvedRoleModel,
  RoleProviderHit,
  SpecResolution,
} from './model-policy.js'
export type {
  TurnAgentLike,
  TurnEvent,
  TurnInfo,
  TurnRunnerOptions,
  TurnSubscriber,
  StartTurnInput,
  TurnPreambleToolCall,
} from './turn-runner.js'
export { hasTurnRuntimeOverrides } from './turn-overrides.js'
export type { TurnRuntimeOverrides } from './turn-overrides.js'
export { createAgentRuntime, createBaseAgentTools } from './agent-runtime.js'
export type { AgentRuntimeBoundary, AgentRuntimeOptions, AgentRuntimePiAgentAccess, BaseAgentToolsOptions } from './agent-runtime.js'
export type {
  AbortScope,
  AgentRuntimeStateSnapshot,
  QueueSignalChunk,
  RetryInfo,
  StallInfo,
  StallOutcome,
  TurnErrorCause,
  TurnErrorInfo,
  TurnStreamChunk,
} from './agent-runtime-types.js'
export { STALL_OUTCOMES, TURN_ERROR_CAUSES } from './agent-runtime-types.js'
export {
  TURN_ERROR_KIND,
  buildTurnErrorMetadata,
  parseTurnErrorMetadata,
  formatTurnErrorContent,
} from './turn-error.js'
export type { TurnErrorMetadata } from './turn-error.js'
export {
  TURN_RETRY_ACTION_KIND,
  TURN_RETRY_ACTION_ID,
  TURN_RETRY_RESOLUTIONS,
  createTurnRetryService,
  newTurnRetryActionId,
} from './turn-retry-action.js'
export type {
  TurnRetryOutcome,
  TurnRetryRunnerLike,
  TurnRetryService,
  TurnRetryServiceDeps,
} from './turn-retry-action.js'
export {
  registerTurnRetryNotifier,
  clearTurnRetryNotifiers,
  notifyTurnRetryResolved,
} from './turn-retry-notifier.js'
export type { TurnRetryNotifier, TurnRetryResolution } from './turn-retry-notifier.js'
export {
  DEFAULT_RETRY_POLICY,
  DEFAULT_RETRY_ENABLED,
  DEFAULT_RETRY_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  formatRetryScheduledContent,
  isAbortError,
  isRetryableTurnError,
  loadRetryPolicy,
  retryDelayMs,
} from './turn-retry.js'
export type { RetryPolicy } from './turn-retry.js'
export {
  PROVIDER_STALL_KIND,
  DEFAULT_STALL_WARN_MS,
  DEFAULT_STALL_ABORT_MS,
  buildProviderStallMetadata,
  parseProviderStallMetadata,
  formatProviderStallContent,
  loadStallThresholds,
  queryStallStats,
} from './provider-stall.js'
export type { ProviderStallMetadata, StallStats, StallStatsQueryOptions, StallThresholds } from './provider-stall.js'
export { ProviderManager } from './provider-manager.js'
export type { OperatingMode, ProviderManagerEvents } from './provider-manager.js'
export { TaskStore, initTasksTable, buildTaskFilterClause } from './task-store.js'
export type {
  Task,
  TaskStatus,
  TaskTriggerType,
  TaskResultStatus,
  TaskContextMode,
  CreateTaskInput,
  UpdateTaskInput,
  TaskListFilters,
  TaskFilterClause,
  TaskFilterClauseOptions,
} from './task-store.js'
export { TaskRunner, formatTaskInjection } from './task-runner.js'
export type { TaskRunnerOptions, TaskOverrides } from './task-runner.js'
export { createTaskRuntime } from './task-runtime.js'
export type {
  TaskRuntimeBoundary,
  TaskRuntimeTaskBoundary,
  TaskRuntimeScheduleBoundary,
  TaskRuntimeOptions,
} from './task-runtime.js'
export { TaskEventBus } from './task-event-bus.js'
export type { TaskEvent, TaskEventType } from './task-event-bus.js'
export {
  ToolCallTracker,
  buildSmartDetectionPrompt,
  parseSmartDetectionResponse,
  resolveDetectionMethod,
  formatPeriodicStatusUpdate,
} from './loop-detection.js'
export type { TrackedToolCall, LoopDetectionConfig, LoopDetectionResult } from './loop-detection.js'
export { createTaskTool, createResumeTaskTool, listTasksTool } from './task-tools.js'
export {
  runWithTaskExecutionContext,
  getCurrentTaskExecutionContext,
  getCurrentTaskProvider,
  getCurrentTaskAgentId,
  getCurrentTaskOrigin,
} from './task-execution-context.js'
export type { TaskExecutionContext, TaskOrigin } from './task-execution-context.js'
export { resolveTaskDefaultProvider } from './task-provider-resolution.js'
export type { TaskDefaultProviderChainOptions } from './task-provider-resolution.js'
export type { TaskToolsOptions } from './task-tools.js'
export { createReadChatHistoryTool } from './chat-history-tools.js'
export { createRecallMessageTool } from './recall-message-tool.js'
export { formatMessageDigest, parseMessageDigestId, maskTranscript, stripRecalledLines, RECALLED_MARKER, DEFAULT_MASK_OPTIONS } from './message-digest.js'
export type { DigestableMessage, MaskTranscriptOptions, MaskResult } from './message-digest.js'
export { parseSummaryDelta, mergeSummaryDelta, renderSummaryMarkdown, emptySummary, isEmptySummary, buildSummaryDeltaSystemPrompt, EMPTY_SUMMARY_TEXT } from './session-summary-schema.js'
export type { SessionSummary, SessionSummaryDelta } from './session-summary-schema.js'
export { getLatestSessionSummary, insertSessionSummary, listSessionSummaries, ensureSessionSummariesTable } from './session-summary-store.js'
export type { SessionSummaryRow } from './session-summary-store.js'
export { loadHeuristics, resolveHeuristics, DEFAULT_HEURISTICS, setHeuristicsOverrideForTests } from './heuristics.js'
export { toIsoUtc, toIsoUtcOrNull, timestampSortKey } from './timestamps.js'
export { detectTopicShift, toSessionMessages, resolveTopicShiftThresholds, extractTopicTags, topicOverlap, queryMemoriesFts, buildFactInjection } from './session-store.js'
export type { TopicShiftThresholds, TopicShiftResult, SessionMessage } from './session-store.js'
export type { Heuristics } from './heuristics.js'
export { getSessionCacheStats, getPersonaCacheStats, cacheReadRatio } from './cache-stats.js'
export { planWrapUp, buildWrapUpMessage } from './task-wrap-up.js'
export type { WrapUpSchedule, WrapUpScheduleInput } from './task-wrap-up.js'
export {
  buildTaskHandoff,
  extractHandoffSection,
  formatContinuationContext,
  MAX_HANDOFF_CHARS,
  MAX_CONTINUATION_CHARS,
} from './task-handoff.js'
export type { HandoffReason, BuildHandoffInput } from './task-handoff.js'
export {
  listPendingTaskNotices,
  markTaskNoticesDelivered,
  expireStaleTaskNotices,
  formatPendingTaskNoticeBlock,
  consumePendingTaskNotices,
} from './task-agent-notice.js'
export type { PendingTaskNotice, PendingNoticeQuery } from './task-agent-notice.js'
export { TaskProgressGuard, stableArgsSignature } from './task-progress-guard.js'
export type { ProgressGuardKind, ProgressGuardLimits, ProgressGuardTrip, ProgressGuardState } from './task-progress-guard.js'
export { getTaskCostSummary, getSubtreeCostForTasks, findTasksWithSubTasks, totalTokens, MAX_TASK_COST_DEPTH } from './task-cost.js'
export type { TaskCostSummary, TaskUsageTotals } from './task-cost.js'
export {
  resolveTaskModelRole,
  resolveTaskModelRoleFrom,
  loadTaskModelRoles,
  taskModelRoleKeys,
  isTaskModelRoleKind,
  TASK_MODEL_ROLE_KINDS,
} from './task-model-policy.js'
export type { TaskModelRoleKind, TaskModelPolicyHit } from './task-model-policy.js'
export {
  initTaskInjectionQueueTable,
  enqueueTaskInjection,
  getTaskInjection,
  markTaskInjectionAttempt,
  markTaskInjectionDelivered,
  markTaskInjectionFailed,
  abandonTaskInjection,
  listPendingTaskInjections,
  countPendingTaskInjections,
  selectInjectionsForRedelivery,
  formatRedeliveryPayload,
  injectionTimestampMs,
} from './task-injection-queue.js'
export type {
  TaskInjectionRow,
  TaskInjectionKind,
  TaskInjectionStatus,
  EnqueueTaskInjectionInput,
  RedeliverySelection,
  RedeliverySelectionOptions,
} from './task-injection-queue.js'
export {
  TaskInjectionSweeper,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_RETRY_AFTER_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_BATCH_LIMIT,
} from './task-injection-sweeper.js'
export type { TaskInjectionSweeperOptions, SweepResult } from './task-injection-sweeper.js'
export { planBootResume, formatResumeNotice } from './task-resume-plan.js'
export type {
  BootResumePlan,
  BootResumePlanInput,
  BootResumeNotice,
  PendingInjectionSummary,
  RunningTaskSummary,
} from './task-resume-plan.js'
export { parseOutputSchema, checkOutputAgainstSchema, extractJsonObject, buildSchemaCorrectionPrompt, buildOutputSchemaInstruction } from './task-output-schema.js'
export { buildDelegationContext, briefTooThin, MAX_SELECTED_MESSAGES, DEFAULT_DELEGATION_BUDGET_TOKENS } from './delegation-context.js'
export type { DelegationContextSelection, DelegationContextResult } from './delegation-context.js'
export type { SessionCacheStats, PersonaCacheStats } from './cache-stats.js'
export { assembleStrandContext, buildStrandContextBlock, trimMessagesToBudget, retrieveOlderRows, loadStrandRows, splitRowsOutsideMemory, stripStrandContextFromLastUserMessage } from './strand-context.js'
export type { ChatHistoryToolsOptions } from './chat-history-tools.js'
export { createSendFileTool, extractUploadsFromToolResult } from './send-file-tool.js'
export type { SendFileToolOptions, SendFileToolDetails, SendFileDelivery } from './send-file-tool.js'
export {
  searchMemories,
  listMemories,
  getMemoryById,
  createMemory,
  supersedeMemory,
  INJECTABLE_PROVENANCE,
  updateMemory,
  deleteMemory,
} from './memories-store.js'
export type { MemoryFact, SearchMemoriesOptions, ListMemoriesOptions, MemoryProvenance, MemoryStatus, CreateMemoryProvenance } from './memories-store.js'
export {
  buildMemoryViewIndex,
  buildMemoryTree,
  buildMemoryGraph,
  listNodeFacts,
  getFactDetail,
  memoryViewSignature,
  scanWikiPages,
  encodeFactCursor,
  normalizeForMatch,
  UnknownMemoryNodeError,
  InvalidMemoryCursorError,
  UNASSIGNED_NODE_ID,
  HUB_MIN_OUTGOING_LINKS,
  WIKI_MAX_PAGES,
  GRAPH_DEFAULT_NODES,
  GRAPH_MAX_NODES,
  FACTS_DEFAULT_LIMIT,
  FACTS_MAX_LIMIT,
} from './memory-view.js'
export type {
  MemoryViewScope,
  MemoryViewIndex,
  MemoryViewFact,
  MemoryTreeNode,
  MemoryTreeResponse,
  MemoryNodeType,
  BuildTreeOptions,
  NodeFactsOptions,
  NodeFactsResult,
  GraphOptions,
  MemoryGraphResult,
  MemoryGraphNode,
  MemoryGraphEdge,
  MemoryGraphNodeType,
  MemoryGraphEdgeType,
  FactDetail,
  FactOrigin,
  FactHistoryEntry,
  WikiPageEntry,
} from './memory-view.js'
export { detectFactConflicts, normalizeForConflicts, CONFLICT_SCAN_MAX } from './memory-conflicts.js'
export type { ConflictLink, ConflictReason, ConflictCandidate, DetectConflictsOptions } from './memory-conflicts.js'
export {
  loadMemoryEmbeddingSettings,
  embedTexts,
  searchMemoriesByEmbedding,
  backfillMemoryEmbeddings,
  EMBEDDING_ASSIGN_MIN_SCORE,
} from './memory-embeddings.js'
export type { MemoryEmbeddingSettings, EmbeddingSearchHit } from './memory-embeddings.js'
export {
  ensureMemoryPageEmbeddingTables,
  refreshMemoryPageIndex,
  refreshWikiPageEmbeddings,
  refreshFactPageMatches,
  memoryPageIndexState,
  loadFactPageMatches,
  loadStrandPageMatches,
  loadWikiPageVectors,
  wikiPageFingerprints,
  wikiPageChunkTexts,
  pagesSignature,
  PAGE_CHUNK_CHARS,
  PAGE_CHUNK_OVERLAP,
  PAGE_MAX_CHUNKS,
  EMBEDDING_FACT_SCORE_MARGIN,
} from './memory-page-embeddings.js'
export type {
  FactPageMatch,
  MemoryPageIndexState,
  MemoryPageIndexRefreshResult,
  PageEmbeddingRefreshResult,
  FactMatchRefreshResult,
  WikiPageFingerprint,
  WikiPageVectors,
} from './memory-page-embeddings.js'
export { withTimeout } from './promise-utils.js'
export {
  parseFactLines,
  parseFacts,
  isDuplicateFact,
  storeFact,
  extractAndStoreFacts,
  sessionKindProducesFacts,
  normalizeSupersessionKey,
  computeFactOverlap,
  FACT_PRODUCING_SESSION_KINDS,
} from './fact-extraction.js'
export type { ParsedFact, FactScope } from './fact-extraction.js'
export { createSearchMemoriesTool } from './memories-tool.js'
export type { SearchMemoriesToolOptions } from './memories-tool.js'
export { normalizeFtsQuery, normalizePlainFtsQuery } from './fts-utils.js'
export { NotFoundError, InvalidInputError } from './errors.js'
export { ProjectNotFoundError, isProjectNotFoundError } from './errors.js'
export { ProjectManager, resolveAssignableProjectId, PROJECT_NAME_MAX_LENGTH } from './project-manager.js'
export type { Project, ListProjectsOptions, CreateProjectInput, UpdateProjectPatch } from './project-manager.js'
export { ensureProjectAssignmentTables } from './project-assignment-schema.js'
export {
  PROJECT_ASSIGN_MIN_CONFIDENCE,
  PROJECT_SUGGEST_MIN_CONFIDENCE,
  PROJECT_ASSIGNMENT_MAX_DISMISSALS,
  assignProjectIfUnset,
  clearStrandProjectSuggestion,
  countStrandMessages,
  dismissStrandProject,
  getProjectAssignmentRun,
  getStrandForAssignment,
  getStrandProjectSuggestion,
  isProjectDismissedForStrand,
  listDismissedProjectsForStrand,
  putStrandProjectSuggestion,
  recordProjectAssignmentRun,
} from './project-assignment-store.js'
export type {
  StrandProjectSuggestion,
  StrandAssignmentRow,
  ProjectAssignmentOutcome,
  ProjectAssignmentRun,
} from './project-assignment-store.js'
export {
  PROJECT_ASSIGNMENT_MIN_MESSAGES,
  PROJECT_ASSIGNMENT_MESSAGE_INTERVAL,
  PROJECT_ASSIGNMENT_PROJECT_CAP,
  PROJECT_ASSIGNMENT_SYSTEM_PROMPT,
  buildProjectAssignmentInput,
  buildProjectAssignmentPrompt,
  evaluateStrandProject,
  listAssignmentProjects,
  loadProjectAssignmentChain,
  parseProjectAssignmentOutput,
  planProjectAssignment,
  runProjectAssignment,
} from './project-assignment.js'
export type {
  AssignmentProject,
  EvaluateStrandProjectResult,
  ProjectAssignmentInput,
  ProjectAssignmentPlan,
  ProjectAssignmentProposal,
  ProjectAssignmentSkipReason,
  ProjectAssignmentTrigger,
  RunProjectAssignmentOptions,
} from './project-assignment.js'
export {
  SessionAccessError,
  SessionNotFoundError,
  SessionAgentMismatchError,
  SessionForbiddenError,
  isSessionAccessError,
} from './errors.js'
export type { SessionAccessErrorCode } from './errors.js'
export { MessageQueue, TurnSemaphore } from './message-queue.js'
export type { ActiveTurnInfo, QueuedMessage, QueueSnapshot } from './message-queue.js'
export {
  parseCronExpression,
  validateCronExpression,
  getNextRunTime,
  cronToHumanReadable,
} from './cron-parser.js'
export type { CronFields } from './cron-parser.js'
export {
  loadEmailAccounts,
  saveEmailAccounts,
  listEmailAccounts,
  getEmailAccount,
  getEmailAccountDecrypted,
  createEmailAccount,
  updateEmailAccount,
  deleteEmailAccount,
  toSafeEmailAccount,
  DEFAULT_ATTACHMENT_DOWNLOAD_PATH,
} from './email-account-store.js'
export type {
  EmailAccount,
  EmailAccountsFile,
  EmailAllowlist,
  EmailFolderMode,
  SafeEmailAccount,
  CreateEmailAccountInput,
  UpdateEmailAccountInput,
} from './email-account-store.js'
export {
  createEmailClient,
  htmlToText,
  normalizeAddress,
  addressDomain,
  formatAddress,
  mapAddresses,
  parseReferences,
  collectAttachmentParts,
  decodeHtmlEntities,
  describeConnectionError,
} from './email-client.js'
export type {
  EmailClient,
  EmailClientAccount,
  EmailAddress,
  EmailFolder,
  EmailAttachmentInfo,
  EmailAttachmentDownload,
  EmailMessage,
  EmailMessageSummary,
  EmailListOptions,
  EmailOutgoingAttachment,
  EmailSendInput,
  EmailSendResult,
  EmailConnectionCheck,
  EmailConnectionTestResult,
  EmailSecurity,
  EmailProtocol,
} from './email-client.js'
export {
  evaluateEmailSendPolicy,
  isRecipientAllowed,
} from './email-send-policy.js'
export type {
  EmailSendDecision,
  EmailRecipientField,
  EmailRecipientViolation,
  EmailSendPolicyAccount,
  EmailSendPolicyRecipients,
  EmailSendPolicyResult,
} from './email-send-policy.js'
export {
  initEmailSendLogTable,
  createEmailSendLogEntry,
  getEmailSendLogEntry,
  updateEmailSendLogEntry,
  listEmailSendLog,
  countEmailSendLog,
  EMAIL_SEND_LOG_STATUSES,
} from './email-send-log.js'
export type {
  EmailSendLogEntry,
  EmailSendLogStatus,
  EmailSendLogAttachment,
  CreateEmailSendLogInput,
  UpdateEmailSendLogInput,
  ListEmailSendLogOptions,
} from './email-send-log.js'
export {
  createEmailTools,
  createEmailListTool,
  createEmailFoldersTool,
  createEmailReadTool,
  createEmailMarkReadTool,
  createEmailMarkUnreadTool,
  createEmailMoveTool,
  createEmailDeleteTool,
  createEmailDownloadAttachmentTool,
  createEmailSendTool,
  appendSignature,
  appendHtmlSignature,
  resolveWorkspaceFile,
  isFolderAllowed,
  toClientAccount,
  attachmentTargetDir,
  safeAttachmentFilename,
  DEFAULT_EMAIL_FOLDER,
  DEFAULT_EMAIL_LIST_LIMIT,
  MAX_EMAIL_LIST_LIMIT,
  MAX_EMAIL_BULK_UIDS,
} from './email-tools.js'
export type { EmailToolsDeps } from './email-tools.js'
export { createEmailApprovalService, recoverStuckApprovedEmails } from './email-approval.js'
export {
  registerEmailApprovalNotifier,
  clearEmailApprovalNotifiers,
  notifyEmailApprovalRequested,
  notifyEmailApprovalResolved,
} from './email-approval-notifier.js'
export type {
  EmailApprovalService,
  EmailApprovalDeps,
  EmailApprovalDecider,
  EmailApprovalResult,
  EmailApprovalErrorCode,
} from './email-approval.js'
export type { EmailApprovalNotifier } from './email-approval-notifier.js'
export { ScheduledTaskStore, initScheduledTasksTable } from './scheduled-task-store.js'
export type { ScheduledTask, ScheduledTaskActionType, CreateScheduledTaskInput, UpdateScheduledTaskInput } from './scheduled-task-store.js'
export { TaskScheduler } from './task-scheduler.js'
export type { TaskSchedulerOptions } from './task-scheduler.js'
export { createCronjobTool, editCronjobTool, removeCronjobTool, listCronjobsTool, getCronjobTool, createReminderTool } from './cronjob-tools.js'
export type { CronjobToolsOptions } from './cronjob-tools.js'
export {
  formatTaskTelegramMessage,
  formatTaskStatusUpdateContent,
  formatTaskStatusUpdateTelegramHtml,
  persistTaskResultMessage,
  persistTaskStatusUpdateMessage,
  resolveTaskNotificationSessionId,
  deliverTaskNotification,
  deliverTaskStatusUpdate,
} from './task-notification.js'
export type {
  TelegramDeliveryMode,
  TaskNotificationOptions,
  TaskNotificationEvent,
  TaskStatusUpdateOptions,
  TaskStatusUpdateEvent,
  TaskStatusUpdateDetails,
} from './task-notification.js'
export {
  loadSttSettings,
  loadDeepgramApiKey,
  transcribeAudio,
  transcribeWhisperUrl,
  transcribeOpenAi,
  transcribeOllama,
  rewriteTranscript,
} from './stt.js'
export type {
  SttSettings,
  SttRewriteSettings,
  TranscribeOptions,
  TranscribeResult,
} from './stt.js'
export { createTranscribeAudioTool } from './stt-tool.js'
export {
  loadTtsSettings,
  loadTtsDeepgramApiKey,
  synthesizeOpenAi,
  synthesizeOpenAiStream,
  synthesizeMistral,
  synthesizeGemini,
  synthesizeTts,
  synthesizeTtsStream,
  shouldStreamTts,
  formatFromAccept,
  isOfficialOpenAiBaseUrl,
  chunkTextForTts,
  composeGeminiPrompt,
  resolveTtsFormat,
  TtsFormatError,
  TtsUpstreamError,
  TTS_PROVIDER_FORMATS,
  TTS_STREAMABLE_FORMATS,
  TTS_FALLBACK_MODEL,
  TTS_FIRST_BYTE_TIMEOUT_MS,
  TTS_BLOCK_TIMEOUT_MS,
  ttsHeaderTimeoutMs,
} from './tts.js'
export type {
  TtsSettings,
  SynthesizeOptions,
  SynthesizeResult,
  TtsStreamResult,
} from './tts.js'
export {
  resamplePcm,
  isSupportedSampleRate,
  PCM_MIN_SAMPLE_RATE,
  PCM_MAX_SAMPLE_RATE,
} from './pcm-resample.js'
export { synthesizeGeminiPcm, parseGeminiAudioFormat } from './gemini-tts.js'
export type { GeminiTtsRequest } from './gemini-tts.js'
export { encodeOggOpus, normalizePcm, wrapPcmInWav } from './ogg-opus.js'
export type { PcmAudio } from './ogg-opus.js'
export { loadVoiceTelegramSettings } from './tts-utils.js'
export type { VoiceTelegramSettings } from './tts-utils.js'
export {
  transcribeDeepgram,
  synthesizeDeepgram,
  listDeepgramModels,
  encryptDeepgramApiKey,
  decryptDeepgramApiKey,
  extractDeepgramTranscript,
  DEEPGRAM_DEFAULT_BASE_URL,
  DEEPGRAM_DEFAULT_STT_MODEL,
  DEEPGRAM_DEFAULT_TTS_MODEL,
  DEEPGRAM_TTS_PRESET_MODELS,
  DEEPGRAM_TTS_ENCODINGS,
} from './deepgram.js'
export type {
  DeepgramTranscribeOptions,
  DeepgramSynthesizeOptions,
  DeepgramListModelsOptions,
  DeepgramModel,
  DeepgramModelsList,
  DeepgramTtsEncoding,
  DeepgramTtsPresetModel,
} from './deepgram.js'
export {
  parseSlashCommand,
  SlashCommandRegistry,
  registerBuiltInSlashCommands,
  MODEL_TASK_COMMANDS,
  renderHelp,
  formatTasksReply,
  formatCronjobsReply,
  isSlashCommandPicker,
  isSlashCommandAgentTurn,
  listLoadableSkills,
} from './slash-commands.js'
export type {
  SlashCommandSurface,
  SlashCommandMetadata,
  SlashCommandDefinition,
  SlashCommandContext,
  StartModelTaskInput,
  StartModelTaskResult,
  ParsedSlashCommand,
  SlashCommandDispatchResult,
  SlashCommandPicker,
  SlashCommandPickerOption,
  SlashCommandReply,
  SlashCommandAgentTurn,
  LoadableSkill,
} from './slash-commands.js'

// Offtangent (SPEC 7.4b): canvas artifacts, extraction and persistence.
export {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS_PER_MESSAGE,
  ARTIFACT_TITLE_MAX,
  parseFencedBlocks,
  sanitizeArtifactTitle,
  titleFromMarkup,
  extractInlineArtifacts,
  extractUploadArtifacts,
  extractArtifactCandidates,
  artifactMimeType,
  artifactFileExtension,
} from './artifact-extract.js'
export type {
  ArtifactKind,
  ArtifactSource,
  FencedBlock,
  ArtifactCandidate,
  InlineArtifactCandidate,
  UploadArtifactCandidate,
} from './artifact-extract.js'
export {
  ensureArtifactTables,
  getArtifactsDir,
  insertArtifact,
  getArtifactForUser,
  listArtifacts,
  listArtifactsForMessages,
  readArtifactContent,
  deleteArtifactsForMessages,
  recordMessageArtifacts,
} from './artifact-store.js'
export type {
  Artifact,
  InsertArtifactInput,
  ListArtifactsOptions,
  RecordMessageArtifactsInput,
  RecordMessageArtifactsResult,
} from './artifact-store.js'

// Offtangent (SPEC 3, 4, 6): captures, router, tags, now set, resurface.
export { ensureOfftangentTables } from './offtangent-schema.js'
export {
  NOW_SET_MAX,
  NOW_SET_RANKING_WINDOW_DAYS,
  NOW_SET_RANKING_HALF_LIFE_DAYS,
  rankStrandsByActivity,
  TAG_NAME_MAX_LENGTH,
  NowSetTooLargeError,
  isNowSetTooLargeError,
  normalizeTagName,
  listTags,
  getTag,
  getTagByName,
  createTag,
  updateTag,
  ensureTags,
  getStrandTags,
  setStrandTags,
  addStrandTags,
  strandIdsWithTag,
  getNowSet,
  getNowRank,
  setNowSet,
  addToNowSetIfRoom,
  removeFromNowSet,
  createStrandLink,
  countStrandLinks,
  insertCapture,
  getCapture,
  getCaptureByClientKey,
  listCaptures,
  updateCapture,
  insertDecision,
  getDecision,
  getCurrentDecision,
  getCurrentDecisionForPart,
  listCurrentDecisions,
  listAllCurrentDecisions,
  capturePartCount,
  listDecisionsForCaptures,
  updateDecision,
  snoozeStrand,
  snoozedStrandIds,
} from './strand-store.js'
export {
  getStrandReadState,
  getStrandReadStates,
  markStrandRead,
  EMPTY_STRAND_READ_STATE,
} from './strand-read-state.js'
export type { StrandReadState } from './strand-read-state.js'
export {
  previewStrandDelete,
  deleteStrand,
  listStrandFacts,
  removeUploadFiles,
  hasLiveTaskForStrand,
} from './strand-delete.js'
export type {
  StrandDeletePreview,
  StrandDeleteResult,
  StrandFactRef,
  DeleteStrandOptions,
} from './strand-delete.js'
export type {
  RankStrandsByActivityOptions,
  Tag,
  StrandLinkKind,
  CaptureKind,
  CaptureStatus,
  RouterAction,
  RouterIntent,
  DecisionState,
  Capture,
  Decision,
  DecisionAlternative,
  ProjectSuggestion,
  InsertCaptureInput,
  InsertDecisionInput,
  ListCapturesOptions,
} from './strand-store.js'
export {
  DEFAULT_ROUTER_CHAIN,
  parseRouterChain,
  loadRouterChain,
  resolveRouterChain,
  resetRouterModelWarnings,
  buildRouterModel,
} from './router-model.js'
export type { RouterChainEntry, ResolvedRouterModel, RouterModelHandle } from './router-model.js'
export {
  ROUTER_CANDIDATE_CAP,
  ROUTER_TITLE_MAX,
  ROUTER_PROJECT_CAP,
  ROUTER_LAST_MESSAGE_CHARS,
  LOW_CONFIDENCE_APPEND_MARKER,
  PROJECT_SUGGESTION_MIN_CONFIDENCE,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  ROUTER_SYSTEM_PROMPT,
  confidenceBand,
  captureKeywords,
  selectCandidates,
  listRouterProjects,
  buildRouterInput,
  buildRouterUserPrompt,
  buildRepairPrompt,
  parseRouterOutput,
  syntheticProposal,
  guardLowConfidenceAppend,
  addressStrength,
  declaresSelfNote,
  captureLanguage,
  runRouter,
} from './capture-router.js'
export {
  SPLIT_MIN,
  DEFAULT_SPLIT_MIN_CHARS,
  SPLIT_MIN_SENTENCES_PER_TOPIC,
  SPLIT_REPAIR_ATTEMPTS,
  SPLIT_TITLE_MAX,
  STAGE1_SYSTEM_PROMPT,
  STAGE2_SYSTEM_PROMPT,
  loadCaptureSplitSettings,
  isSplitEligible,
  segmentSentences,
  parseStage1Answer,
  buildStage1UserPrompt,
  buildStage1RepairPrompt,
  splitCapture,
  mergeTinyTopics,
  buildStage2UserPrompt,
  consolidatePart,
  singlePartSplit,
  runCaptureSplit,
  capturePartContextLine,
  withCapturePartPrefix,
  parseCapturePartRef,
} from './capture-split.js'
export type {
  CaptureSplitSettings,
  CaptureSplitOptions,
  CaptureSplit,
  CapturePart,
  CapturePartRef,
  SplitCompletion,
  SplitTopic,
  SplitUncertainty,
  Stage1Answer,
  Stage1Outcome,
  ParseStage1Result,
} from './capture-split.js'
export { deriveStrandTitle, DERIVED_TITLE_MAX } from './strand-title.js'
export { isSilenceTranscript, SILENCE_GUARD_MARKER } from './silence-guard.js'
export {
  USER_SURFACE_SOURCES,
  EXPLICIT_TARGET_FORBIDDEN,
  CLIENT_TARGET_RATIONALE,
  CLIENT_TARGET_MODEL,
  FILLER_GUARD_MARKER,
  isUserSurfaceSource,
  clientCreatedStrand,
  explicitTargetVerdict,
  findDeviceAffinity,
  isFillerCapture,
} from './capture-guards.js'
export type { ExplicitTargetVerdict, DeviceAffinityHint } from './capture-guards.js'
export type {
  ConfidenceBand,
  AddressStrength,
  CaptureLanguage,
  RouterCandidate,
  RouterProject,
  RouterCaptureInput,
  RouterInput,
  RouterDeviceHint,
  RouterProposal,
  RouterResult,
  RouterCompletion,
  RunRouterOptions,
  ParseRouterResult,
} from './capture-router.js'
export { listResurfaceItems } from './resurface.js'
export type { ResurfaceItem, ResurfaceReason, ResurfaceOptions } from './resurface.js'

// Offtangent (SPEC 2.9, 6.4): the feed — everything unsolicited, out of the
// strand dialogue.
export {
  FEED_ITEM_KINDS,
  FEED_TITLE_MAX,
  UnknownFeedCursorError,
  isUnknownFeedCursorError,
  isFeedItemKind,
  insertFeedItem,
  getFeedItem,
  listFeedItems,
  markFeedItemRead,
  markAllFeedItemsRead,
  countUnreadFeedItems,
} from './feed-store.js'
export type { FeedItem, FeedItemKind, InsertFeedItemInput, ListFeedOptions } from './feed-store.js'
export {
  resolveTaskStrandOrigin,
  feedKindForTask,
  feedTitleForTask,
  buildTaskFeedItem,
} from './task-feed.js'
export type { TaskFeedItemOptions } from './task-feed.js'
export { resolveTaskOwnerUserId, resolveTaskOwnerUserIdForTask, parseStrictUserId } from './task-ownership.js'
export type { TaskOwnershipLineage } from './task-ownership.js'
export {
  buildStrandTaskTree,
  buildTaskActivityFrame,
  resolveTaskStrandId,
  MAX_TASK_TREE_DEPTH,
  MAX_TASK_TREE_NODES,
} from './task-tree.js'
export type {
  StrandTaskInclude,
  StrandTaskNode,
  StrandTaskTree,
  StrandTaskTreeOptions,
  TaskActivityFrame,
  TaskActivityPhase,
} from './task-tree.js'
