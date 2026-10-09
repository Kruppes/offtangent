# HA inference adapter — experimental, off by default

**Do not merge/deploy before independent review. Technical legacy-provider prototype,
not evidence of an officially authorized subscription-sharing deployment.**

This is NOT the interview.v1 endpoint, NOT an agent, and NOT mounted on the main
Offtangent router. Nothing starts unless the separate CLI is launched explicitly.
No main prompt, SOUL, memory, conversation DB, tool execution, or request logging.
Existing provider-config OAuth renewal and pi-models streaming are reused; no
credential store, copied provider keys, API-billing fallback, or replacement model.

## Blocking subscription-route finding (2026-10-09)

The existing `openai-codex` / OAuth / `openai-codex-responses` provider reaches the
legacy Codex backend. Live wire confirmed `gpt-6-luna`, `gpt-5.6-luna`, and
`gpt-6.1-sol`. `gpt-6.1-luna` returned HTTP 400: “The 'gpt-6.1-luna' model is not
supported when using Codex with a ChatGPT account.”

Current official Sign in with ChatGPT sharing documentation requires the public
Responses endpoint and explicitly says not to use ChatGPT backend-api endpoints.
The current account token failed public Models with HTTP 403 / `api.model.read`
and public Responses with HTTP 401 / `api.responses.write`. No scopes were changed,
protection bypassed, or API key substituted. **Production requires a newly approved
sharing authorization AND matching existing-provider infrastructure support.**
This adapter intentionally refuses non-Codex/non-OAuth/non-enabled/non-policy-approved
providers, custom URLs, redirects, different response model names, and incomplete
responses. It does not pretend the legacy route is the official sharing route.

Primary sources opened 2026-10-09:
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md
- https://developers.openai.com/codex/auth.md

The OpenAI terms page returned HTTP 403 to the fetcher; no legal/ToS approval is
claimed from unread text. Supported-route status alone does not settle all terms.

## Protocol and security

- Authenticated `GET /v1/models`: configured pin only; NOT a live account catalog.
- `POST /v1/chat/completions`: exact pinned model, text messages, initial system/
  developer messages, assistant function calls and matching tool results.
- Dedicated high-entropy HA bearer secret; store only its SHA256 in adapter config.
  Never reuse an Offtangent user, interview, or provider OAuth token as this secret.
- Administrator pins each tool name/schema/description. Names are limited to
  `GetLiveContext` or `Hass[A-Z]…` names, but the administrator must still verify
  these are genuine restricted HA tools. Client schemas must match exactly;
  client tool descriptions cannot override trusted descriptions. No arbitrary
  `execute_services`, bash, shell, file, email, or skill defaults.
- Complete upstream response and arguments are validated BEFORE any JSON or SSE
  body is returned. SSE is OpenAI chat-chunk compatible but **buffered**, not live
  token streaming. Reasoning/signatures are removed. This cannot certify that an
  otherwise valid HA action is semantically correct; HA retains execution scope.
- `tool_choice`: `auto` or `none` only. `none` omits new tools, retaining history.
- Neutral client `temperature=1`, `top_p=1`, `service_tier=auto`, and
  `reasoning_effort=minimal` accepted. Sampling is unavailable on subscription;
  other values fail, never silently ignored. Reasoning is pinned minimal.
- `max_tokens` OR `max_completion_tokens` (1–4096) is an **output acceptance fence**
  after completion, not an upstream generation/token-cost budget. A too-large
  completed response is rejected before emitting actions. No upstream cap is
  claimed. Never supply both. Client should normally use 4096 here.
- 64-message history, 32 pinned tools, 16 output calls, bounded bodies/messages/
  arguments/output, one concurrent call, hourly allowance, timeout and cancellation.
  No automatic retry. Clients must also set `max_retries=0` to avoid duplicate HA
  actions after errors. Generic redacted errors; 429/504/503/502 remain visible.
- Loopback-only transport; no public bind flag. Main application remains untouched.

## Review-only local start

Create `/absolute/private/path/ha-inference.json`, mode **0600**, never in Git:

```json
{
  "enabled": true,
  "tokenSha256": "<sha256-of-NEW-random-HA-secret>",
  "providerId": "<existing-openai-codex-OAuth-provider-id>",
  "model": "gpt-6-luna",
  "tools": [
    {"name":"HassTurnOff","description":"Turn off one named HA device",
     "parameters":{"type":"object","properties":{"name":{"type":"string"}},
                   "required":["name"],"additionalProperties":false}}
  ],
  "timeoutMs": 100000,
  "maxBodyBytes": 262144,
  "maxCallsPerHour": 100
}
```

The example schema is a MOCK, not an export of live HA schemas. Replace it with the
EXACT approved schemas of the selected HA API; do not copy benchmark household data
or broad integration defaults. Generate a new HA secret with crypto.randomBytes(32),
provision it only to the intended HA client, and hash it in config. The existing
Offtangent service environment must provide provider configuration/encryption access;
never export/copy OAuth access or refresh credentials.

```sh
DATA_DIR=/data pnpm exec tsx scripts/ha-inference.mts /absolute/private/path/ha-inference.json 3107
```

Remove/disable the service to turn it off. `enabled:false` or a malformed config
fails closed. No startup/service unit is installed by this branch. Binding an
additional listener or a reverse proxy is deployment and requires later approval.

## HA integration seam (not installed or executed against HA)

The current built-in Ollama conversation integration uses `/api/chat`, NOT this
endpoint; changing its URL is not a drop-in solution. A chat-completions integration
with configurable base URL is required. Current Extended OpenAI Conversation master
was source-read, including `entity.py`, `helpers.py`, `const.py`: it uses streamed
chat chunks, tools/history, `/models` for setup, and max_tokens/top_p/temperature for
the gpt-6 default profile. Defaults are NOT safe to accept unchanged: temperature
is 0.5, and its custom function defaults can include shell/file/execute_services.

After route authorization, independent review, and explicit deployment approval:
1. Add a SEPARATE test conversation agent; leave the preferred production pipeline
   unchanged. No real actions during initial integration verification.
2. Base URL: approved HTTPS proxy of this dedicated listener ending `/v1`; use only
   the new HA bearer secret. Pin `gpt-6-luna`, temperature **1**, top_p **1**, max
   tokens **4096**, empty extra_body, no structured output/skills/general agent tools.
3. Explicitly configure restricted genuine HA tools and copy their exact schemas to
   the adapter allowlist. Do not enable the integration's wide default tool list.
   Tool-count cutoff's `tool_choice:none` is supported; call-ID shortening should
   remain off. Built-in OpenAI integration's Responses route is NOT implemented.
   **Client retry prerequisite:** current Extended helper constructs AsyncOpenAI
   without `max_retries`; upstream Python SDK defaults to **2 retries**. The helper
   must be separately reviewed/patched to set `max_retries=0` (not an extra_body
   option). Unmodified Extended is NOT presented as a deployment-ready client.
4. Proxy only the two paths, preserve Authorization, add network allowlisting/TLS
   and matching body/time limits. Never forward Offtangent login cookies/tokens.
5. Integration versions differ. The live system was Core 2026.9.4 with builtin
   Ollama; Extended OpenAI was NOT installed or production-tested. Its exact installed
   version and the explicit no-retry client patch still require review. A real OpenAI JS SDK made
   successful HTTP model-list + buffered SSE toolcall/mock-result/final roundtrip
   through this adapter against gpt-6-luna; this proves the wire seam, not HA rollout.

## Checks

```sh
flock /workspace/.heavy-build.lock pnpm exec vitest run --config scripts/vitest-ha.config.mts --configLoader runner --cache false
flock /workspace/.heavy-build.lock pnpm exec tsc -p packages/core/tsconfig.json --noEmit
```

The bounded config includes ALL new HA tests plus existing isolated/interview tests
and faults, using repository test setup with fresh private test DATA_DIRs. It avoids
modifying the root Vitest config or writing Vite caches to shared node_modules.
No production build, full-repository test suite, merge or deploy is claimed.
