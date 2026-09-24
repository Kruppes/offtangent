# Models and Providers

Offtangent does not ship a model. It talks to whatever inference endpoint you configure, and everything about that configuration lives on your instance: keys are encrypted at rest with `ENCRYPTION_KEY`, the model catalog is per provider, and the active model can be switched at runtime.

This page answers three questions:

1. Which providers does the code know about?
2. What must a model be able to do before it can drive the agent?
3. Which parts of the system can run on a *different*, usually smaller, model?

For the click-by-click UI (Add Provider, Test Connection, Add Model, quota display) see [Web UI → Providers](../web-ui/providers). For the bootstrap variables see [Environment Variables](../reference/env-vars).

## Supported provider types

The source of truth is the `ProviderType` union in `packages/core/src/provider-config.ts` and its presets in `PROVIDER_TYPE_PRESETS`. The union has three groups:

- **16 API-key provider types** — the table below.
- **3 OAuth / subscription types** — `anthropic-oauth`, `openai-codex`, `github-copilot`. They do not take a key at all and are covered in [Subscription and OAuth paths](#subscription-and-oauth-paths).
- **2 legacy aliases** — `ollama-local` and `ollama-cloud`, kept only so older `providers.json` files keep loading. Both resolve to the `ollama` preset. Do not use them for new entries.

"Dynamic catalog" means the Add Model dialog fetches the model list live from the provider's own `/models` endpoint instead of the bundled `@earendil-works/pi-ai` catalog (`isDynamicCatalogProvider`).

| # | Type id | Label | Auth | Default base URL | Wire API | Dynamic catalog |
|---|---|---|---|---|---|---|
| 1 | `openai` | OpenAI | API key | `https://api.openai.com/v1` | `openai-completions` | no |
| 2 | `anthropic` | Anthropic | API key | `https://api.anthropic.com` | `anthropic-messages` | no |
| 3 | `mistral` | Mistral | API key | `https://api.mistral.ai` | `mistral-conversations` | no |
| 4 | `ollama` | Ollama | none | `http://localhost:11434/v1` | `openai-completions` | no |
| 5 | `openrouter` | OpenRouter | API key | `https://openrouter.ai/api/v1` | `openai-completions` | **yes** |
| 6 | `deepseek` | DeepSeek | API key | `https://api.deepseek.com` | `openai-completions` | no |
| 7 | `kimi` | Kimi / Moonshot | API key | `https://api.moonshot.ai/v1` | `openai-completions` | no |
| 8 | `kimi-coding` | Kimi Coding (Subscription) | plan API key | `https://api.kimi.com/coding` | `anthropic-messages` | no |
| 9 | `minimax` | MiniMax | API key | `https://api.minimax.io/anthropic` | `anthropic-messages` | no |
| 10 | `zai` | z.ai | API key | `https://api.z.ai/api/paas/v4` | `openai-completions` | no |
| 11 | `zai-coding` | z.ai (GLM Coding Plan) | plan API key | `https://api.z.ai/api/coding/paas/v4` | `openai-completions` | no |
| 12 | `xai` | xAI (Grok) | API key | `https://api.x.ai/v1` | `openai-completions` | no |
| 13 | `opencode-go` | OpenCode Go | plan API key | `https://opencode.ai/zen/go/v1` | per-model, from catalog | no |
| 14 | `opencode-zen` | OpenCode Zen | API key | `https://opencode.ai/zen/v1` | per-model, from catalog | no |
| 15 | `openai-compatible` | OpenAI-compatible (custom) | optional API key | *(you set it)* | `openai-completions` | no |
| 16 | `google` | Google Gemini | API key | `https://generativelanguage.googleapis.com/v1beta` | `google-generative-ai` | no |

Notes on the table:

- **Base URL editable** only for `ollama` and `openai-compatible`. For every other type the URL is pinned by the preset so a typo cannot silently redirect your key to a third party.
- `opencode-zen` and `opencode-go` are gateways whose models span several wire APIs. They set `resolveModelsFromCatalog`, so each model keeps its own `api`, `baseUrl`, cost and limits instead of being pinned to one API type. `kimi` and `kimi-coding` use the same mechanism to inherit the maintained upstream catalog.
- `openai-compatible` is the escape hatch for anything speaking the OpenAI completions protocol: LM Studio, vLLM, NVIDIA NIM, a Cloudflare AI Gateway, a self-hosted router. You supply base URL and (optionally) key.

## The bundled catalog and new model ids

For every provider type without a dynamic catalog the list of selectable
models is the one bundled with `@earendil-works/pi-ai`, pinned by version in
`packages/core/package.json` (0.87.1 as of 2026-09-24, which added
`claude-opus-5-5`, `gpt-6-sol` and `gpt-6-luna`). Two things follow from that:

- **A model id the catalog does not know does not work by being typed in.**
  The Add Model dialog offers to add an unmatched id as a custom model, and
  for `ollama` and `openai-compatible` that is the normal way to name a model.
  For a catalog provider such an entry falls back to the generic
  `buildModel()` path: OAuth providers have no base URL there, the Anthropic
  client version stays at whatever the old SDK pinned, and the first turn fails
  with a provider error (seen as a 400 `claude_code_version_too_old` when
  `claude-fable-5-1` was added ahead of its catalog). The catalog and the pinned
  Claude Code client version are checked against each other by a test
  (`provider-config.claude-version.test.ts`), so a mismatch fails the test run
  rather than the first turn.
- **A new model therefore arrives with a dependency bump**, not with a config
  change: raise `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`
  together (the agent core pins its own `pi-ai` range, a mismatch drags a second
  copy into the tree and breaks the shared types), run the tests, deploy, and
  the new ids show up in the Add Model dialog.

Only `openrouter` has a dynamic catalog (see the table above) and is not
affected: it lists whatever the endpoint reports.

## Subscription and OAuth paths

Three further provider types authenticate with an OAuth login instead of an API key. They are deliberately kept out of the table above, because there is no key to enter and no base URL to set — the preset manages both. What you are buying here is a **consumer subscription**, not metered API credit:

| Type id | Label | Subscription | Wire API |
|---|---|---|---|
| `anthropic-oauth` | Anthropic (Claude Pro/Max) | Claude Pro / Max | `anthropic-messages` |
| `openai-codex` | ChatGPT Plus/Pro (Codex) | ChatGPT Plus / Pro | `openai-codex-responses` |
| `github-copilot` | GitHub Copilot | GitHub Copilot | `openai-completions` |

Practical consequences:

- **No API key exists.** You click *Login & Connect*, complete the provider's login in a browser tab, and the instance stores the returned OAuth credentials (encrypted, like every other secret). If your instance runs on a remote box that cannot receive the OAuth callback, the dialog offers a paste field for the redirect URL — see [Providers → OAuth providers](../web-ui/providers#oauth-providers).
- **You pay a flat fee, not per token.** Cost columns stay meaningless for these rows; the limit you hit is the subscription's usage window, not a bill.
- **Quotas are visible.** For quota-capable subscription providers the instance polls the usage endpoint in the background and shows the remaining allowance per window (e.g. rolling 5h and 7d) directly on the provider row and, for the active provider, in the top bar. The exact windows per provider are listed in [Providers → Subscriber usage quota](../web-ui/providers#subscriber-usage-quota).
- **Refresh tokens expire.** When they do, the model status flips to `Error`; the edit dialog has a *Renew Token* button that re-runs the flow on the existing record.

Two further types are flat-fee subscriptions that nevertheless authenticate with a plan-scoped API key, and are therefore grouped with the subscription entries in the UI (`subscription: true`) without using OAuth: `kimi-coding` and `zai-coding`. `opencode-go` is also a flat-fee plan with an API key; its quota is read from the dashboard rather than an official API and needs two extra fields (workspace id, dashboard cookie).

## Local models with Ollama

Pick the `ollama` type, set the base URL of your Ollama server (default `http://localhost:11434/v1` — from inside a container that is usually *not* localhost), and the provider form swaps the model dropdown for an Ollama panel: refresh the installed model list, tick the models you want enabled, or pull a new one with a live progress bar. No API key is required.

What the code does differently for local providers:

- **Request timeout.** `LOCAL_REQUEST_TIMEOUT_MS` raises the per-request HTTP timeout to one hour for `ollama` providers, because the SDK default of ten minutes covers prompt evaluation *plus* the whole streaming duration and a large local model on a long context routinely exceeds it. `AXIOM_LLM_REQUEST_TIMEOUT_MS` overrides this globally (`resolveRequestTimeoutMs`).
- **Health check timeout.** New local providers get `LOCAL_HEALTH_CHECK_TIMEOUT_MS` (60 s) instead of the default 15 s, so a cold model load is not reported as a broken provider.
- **Slim prompt profile.** A provider can be set to `promptProfile: "slim"`. Slim keeps the core knowledge (SOUL, AGENTS, MEMORY, user profile, tools overview) but injects one recent daily file instead of the configured `heuristics.recentMemory.days`, and drops the wiki page listing and the docs discovery block. It exists for exactly this case: a server whose prompt evaluation runs at a few hundred tokens per second, where the system prompt alone costs real wall-clock time. Absent field means `full`, the unchanged prompt.
- **No prompt caching.** The Anthropic cache-control machinery is a no-op for non-Anthropic APIs, so an Ollama server receives plain requests.

### What actually works locally

Be realistic about the split:

- **Small models as helpers** (router decisions, project assignment, short summaries) are the least demanding job in the system: one short prompt, a structured answer, no tool loop. This is where a local model earns its keep. The shipped defaults illustrate the size class rather than endorse a specific model: `modelPolicy.roles.router` ends its chain on a 14B-class local entry, and the [projects documentation](../reference/projects-api) shows a 27B-class local model as the example for `modelPolicy.roles.projectAssignment`.
- **A local model as the main agent** is possible but constrained by two hard requirements below (tool calling and context window) and by throughput. The one-hour timeout and the slim profile exist because that path was hit in practice; they are mitigations, not a promise of a good experience.
- Quantization, context length and the `num_ctx` your Ollama build actually serves matter more than the parameter count. Verify with *Test Connection* on the model row, then with a real turn that uses tools.

No benchmark numbers are published here. Measure on your own hardware.

## What a model must be able to do

Offtangent is an agent, not a chat completion wrapper. A model that cannot do the following cannot drive it:

### 1. Tool calling / function calling — mandatory

**This is the single most common disappointment.** Every turn hands the model a tool registry (`shell`, `read_file`, `write_file`, `web_search`, `create_task`, memory tools, …). The agent loop is: model emits a tool call → the backend executes it → the result goes back into the conversation → repeat until the model answers. A model without native tool/function-call support will produce prose *describing* what it would do, and nothing will happen. It cannot run a task, cannot read a file, cannot write memory.

Before you invest time in a model, check that the provider exposes it with tool support on the wire API in the table above. "It works in a chat UI" is not evidence.

### 2. Streaming

The backend streams every turn (`streamSimple`) and forwards tokens over the WebSocket to the web UI and the companion app. SSE is the default transport for every provider; only the `openai-codex-responses` API additionally accepts a non-SSE `transport` value (`presetSupportsTransport`), and the same API is the only one that consumes `textVerbosity` (`presetSupportsTextVerbosity`). Everywhere else those fields are dropped on save rather than stored as a no-op.

### 3. A context window that fits the prompt

The system prompt is layered (see [System Prompt](../concepts/system-prompt)) and the strand window is configurable, but a turn routinely carries: system prompt + memory blocks + the verbatim recency window of the strand (`heuristics.strand.windowTokens`, default 24 000 tokens) + tool results (`heuristics.toolOutput.*` caps a single `read_file` result at 20 000 characters and a `shell` result at 30 000). Background tasks are larger still: `heuristics.taskHistory.windowTokens` defaults to 60 000.

A model with a small window will not fail cleanly — it will start dropping the parts of the context that make the agent useful. If you must run a small window, lower the heuristics deliberately ([settings reference](../reference/settings#heuristics)) instead of hoping.

### 4. Nice to have, not required

Reasoning / thinking modes, prompt caching and cost metadata are used when the provider offers them (the catalog carries `reasoning`, cost and limit fields per model) and simply absent otherwise.

## Model roles: one big model, several small ones

Offtangent does not have to run everything on the main model. Several subsystems accept their own provider/model, and pointing them at something small and cheap is the normal configuration, not an optimization.

| Role | Where it is configured | What it does |
|---|---|---|
| Main agent (chat) | active provider/model in [Providers](../web-ui/providers) | Drives the tool loop. This is the big one. |
| Per persona | `IDENTITY.md` → `- **Model:**` ([personas API](../reference/personas-api)) | Overrides the global default for one persona; empty means global default. |
| Per strand | `PATCH /api/strands/:id/model` ([strands API](../reference/strands-api#model-selection)) | A persistent pin on a single strand. Resolution order is turn → strand → persona → global → fallback. |
| Router | `modelPolicy.roles.router` | Decides where a capture belongs. An ordered chain: `modelId`, `providerId:modelId` or a provider name, each optionally with a trailing `:<confidence>` threshold that hands over to the next entry on a weak decision. Missing entries are skipped with a warning. |
| Project assignment | `modelPolicy.roles.projectAssignment` | Suggests which project a strand belongs to; same chain notation. |
| Speech summary | `modelPolicy.roles.speechSummary` | The "summarize aloud" call of the companion app: turns one written message into a few spoken sentences. Fast, cheap, 20 s hard timeout. |
| Background tasks | `modelPolicy.roles["task:default"]`, `task:user`, `task:agent`, `task:cronjob`, `task:heartbeat`, `task:consolidation`, plus `tasks.defaultProvider` | One model per kind of background work. Full precedence chain in the [settings reference](../reference/settings#modelpolicy). |
| Fact extraction | `modelPolicy.roles.factExtraction`, legacy `factExtraction.providerId` | Pulls atomic facts out of an ended session. `""` = active provider. |
| Session summaries | `modelPolicy.roles.summary`, legacy `sessionSummaryProviderId` | Summarizes ended sessions. `""` = active provider. |
| Memory consolidation | `modelPolicy.roles.consolidation`, legacy `memoryConsolidation.providerId` | The nightly consolidation run. `""` = active provider. |
| Speech-to-text rewrite | `modelPolicy.roles.sttRewrite`, legacy `stt.rewrite.providerId` | Cleans up a raw transcript ([Speech-to-Text](../settings/speech-to-text)). |

All of these live in `settings.json` under one block, `modelPolicy.roles`. Read and write it with the admin API [`/api/model-policy`](../reference/model-policy-api), which validates every reference against `providers.json` and can explain a resolution step by step (`GET /api/model-policy/resolve?role=…`); see the [settings reference](../reference/settings#modelpolicy) for types, defaults and validation. The four roles with a legacy field are read-through: the old field keeps working until the role is set. An entry naming an unknown provider, or a provider with no enabled models, is ignored with a warning rather than failing the request.

A reasonable starting shape: one capable model as the active provider, and the router plus the extraction/summary roles pointed at something small. The helper roles are single-shot calls with a short prompt — they do not need the tool loop, so they do not need a tool-capable model.

### A guardrail worth knowing

The same list is enforced by `PUT /api/model-policy`: a blocked provider type is rejected with `400 unresolvable_reference` rather than quietly accepted as a role target.

Some provider types are excluded from *automatic* selection paths that would send private message content to them: `model-resolution.ts` refuses them as a silent fallback target, and the speech-summary path keeps its own copy of that list. It is a policy decision in code, not a quality statement. If you deliberately pick such a provider as your active model, that is your choice and it is honoured.

## Honest status

Provider types are not equally well trodden. The split below is drawn from what the code itself shows, not from a survey:

**Run against real traffic — the code carries scar tissue from it.** Anthropic (API key and Claude Pro/Max OAuth): the prompt-cache breakpoint handling, the pinned Claude Code client version with its drift test, and a hand-maintained catalog override exist because the live API forced them. OpenAI (API key and Codex OAuth): the Codex path has its own api type and is the only one that consumes the `textVerbosity` stream option, and OpenAI is one of the three speech-to-text backends the transcription route knows about. Ollama: the one-hour request timeout, the 60 s health-check timeout and the slim prompt profile are all documented in code as responses to observed local-inference behaviour. Kimi/Moonshot: the catalog override records per-model pricing and a `temperature: 1` constraint that was learned from upstream error responses. OpenCode Go: the dashboard-scraping quota path only exists because someone needed the number.

**Implemented through the same preset and catalog machinery, but without that kind of evidence in the repository:** Google Gemini, Mistral, DeepSeek, xAI, MiniMax, GitHub Copilot, OpenRouter, OpenCode Zen, z.ai, and arbitrary `openai-compatible` endpoints. They use the identical build path, so they should work — but treat a first run as a test, not a guarantee. Use *Test Connection* on the model row, then a real turn that actually calls a tool.

**Deliberately not claimed here:** benchmark results, latency numbers, and a ranked list of recommended model versions. Model lineups change faster than this page, and any table of "best model for X" would be stale before it is useful. The model catalog in the UI is the current list; this page describes the mechanism.

If a provider type behaves differently from what is written above, that is a documentation bug — please open an issue.

## See also

- [Web UI → Providers](../web-ui/providers) — the configuration surface, quota display, statuses.
- [Environment Variables](../reference/env-vars) — `ENCRYPTION_KEY` and the rest of the bootstrap.
- [`settings.json` schema](../reference/settings) — `modelPolicy`, `heuristics`, `factExtraction`, `tasks`.
- [Configuration](./configuration) — how the three config layers relate.
