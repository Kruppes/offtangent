# Isolated inference gateway (`isolated-inference.v1`)

Status: implemented on branch `feat/isolated-inference-gateway`, **off by default**, not deployed.

One narrow HTTP endpoint that lets a *registered external service* run a profile bound
completion on the models this instance already has. It exists so such a service does not need
its own provider key and does not get an agent: no loop, no persona, no memory, no chat, no
strand, no connector, no tool.

## Endpoint

```http
POST /v1/isolated/infer
Authorization: Bearer <service token>
Idempotency-Key: <optional, 8..128 chars of [A-Za-z0-9._:-]>
Content-Type: application/json

{ "profile": "interview.v1", "input": "<text>", "maxOutputTokens": 2400 }
```

- Request keys are **exactly** `profile`, `input`, `maxOutputTokens`. Anything else →
  `400 unknown_field`. No `system`, `model`, `tools`, `temperature`, `thinking`, `messages`,
  `provider`, `baseUrl`.
- `system` is deliberately **not** a client field (security review 2026-09-30): a client
  supplied system prompt turns a service credential into free steering of a foreign model and
  into a way to pay for arbitrary work. The interview instructions of the calling service
  therefore travel as the leading section of `input`; on this side they are data like any other
  input, and the profile prompt above them cannot be overwritten.
- `GET`/`PUT`/… → `405`. Body limit **512 KiB** (the profile allows 80.000 characters, which is
  up to ~320 kB in UTF-8, so the byte cap has to sit above the character cap — a German or CJK
  input must not die in the parser), `Cache-Control: no-store`, no CORS credentials, no cookie is
  read — the endpoint is for server side callers only. The path is matched **case sensitively and
  without a trailing slash** (`/V1/ISOLATED/INFER` → `404`), so a proxy rule pinned to the exact
  path cannot be evaded. A body above the limit or malformed JSON is answered in the contract
  shape (`input_too_large` / `invalid_request`), never as an HTML page.

### Response

```json
{ "contract": "isolated-inference.v1",
  "json": { "…": "the object the model returned" },
  "usage": { "inputTokens": 11, "outputTokens": 22 } }
```

Errors are `{ "contract": "isolated-inference.v1", "error": { "code": …, "message": … } }` with
codes `unauthorized` (401), `unknown_field` / `invalid_request` (400), `profile_not_allowed` (403),
`input_too_large` (413), `busy` / `budget_exhausted` (429), `model_not_available` /
`model_blocked_by_policy` (503), `upstream_failed` / `output_truncated` / `bad_model_output` (502),
`method_not_allowed` (405). No provider message, URL, key or stack ever reaches the client.

## Profile `interview.v1` (server side, not caller controllable)

| what | value |
|---|---|
| model | `claude-sonnet-5-5` (resolved through the configured providers) |
| system prompt | fixed in `packages/core/src/isolated-inference.ts` |
| output ceiling | 3000 tokens (a larger `maxOutputTokens` is clamped). Derived from the live run of 30.09.2026: a valid interview state JSON cost 474-993 output tokens, the bounded delta contract of the client worst cases at ~2200, the client asks for 2400. |
| input cap | 80 000 chars |
| tools | none, ever |
| temperature | never sent (Sonnet 5.5 rejects it) |
| thinking | never sent as `disabled` (Sonnet 5.5 rejects that) |
| output | must be one JSON object; anything else → `bad_model_output`. A run that stopped at the token budget (`stopReason: length`) is never parsed and never returned: it is `output_truncated`, so the caller can enlarge the budget or shrink its contract instead of guessing. |

The model still goes through the normal **data-policy gate** (`resolveRoleModel` →
`checkAutomaticModelFor`): region, training and gate mode decide, and a blocked provider means
the call never leaves the process (`model_blocked_by_policy`).

## Configuration (no secrets in git)

`<DATA_DIR>/config/isolated-inference.json`, absent by default:

```json
{
  "enabled": true,
  "services": [
    { "id": "interview-service",
      "tokenSha256": "<sha256 hex of the bearer token>",
      "profiles": ["interview.v1"],
      "maxConcurrent": 2,
      "dailyCallBudget": 200,
      "expiresAt": "2026-12-31T00:00:00Z",
      "revoked": false }
  ]
}
```

- Only the **sha256 hash** of the token is stored; a 64 hex char entry is required, so a plain
  token in that field is rejected (the service would simply not authenticate).
- `enabled: false` or a missing file → the endpoint answers `401` for every request.
- `maxConcurrent` 1..8, `dailyCallBudget` 1..100 000 per service and UTC day.
- **Per service identity, individually revocable** (maintainer requirement 2026-09-30): one
  entry per caller, `revoked: true` kills it immediately, `expiresAt` expires it. An expiry
  that cannot be parsed counts as *expired*, never as unlimited. Rotation = add the new entry,
  set the old one to `revoked: true`.
- Revocation is re-checked with a freshly read config **immediately before the provider call**,
  so a revoke that lands while a request waits for a concurrency slot still prevents the spend
  (`401 unauthorized`, provider never contacted). A request already handed to the provider
  cannot be un-spent — that is the documented limit.
- Generate a token outside the repo, e.g. `openssl rand -base64 32`, hash it with
  `printf %s "<token>" | sha256sum`. The token itself goes only into the *caller's* environment
  (the inference token setting on the interview service side).

## Audit

One JSONL line per request in `<DATA_DIR>/logs/isolated-inference.audit.jsonl`:

```json
{"at":"2026-09-30T12:00:00.000Z","requestId":"<uuid>","serviceId":"interview-service",
 "profile":"interview.v1","model":"anth/claude-sonnet-5-5","status":"ok","code":"ok",
 "inputChars":812,"inputTokens":11,"outputTokens":22,"durationMs":1840}
```

Token id (= `serviceId`), request id, profile, model, time, status and spend — **never** the
prompt, the answer, the token or its hash (proven by tests on both the unit and the HTTP level).
Failures are audited with their error code (`unauthorized`, `budget_exhausted`,
`upstream_failed`, …).

## Limits

Per service: `maxConcurrent` parallel calls (`busy`), `dailyCallBudget` calls per UTC day
(`budget_exhausted`), one entry per `Idempotency-Key` + body hash (200 newest kept, 10 min TTL) so
a retry of the same turn does not pay twice, while the same key with a *different* body is a new
call instead of the wrong answer. A failed call is not cached, so it can be retried.

Both counters are reserved **synchronously** before the first `await`, so parallel requests cannot
all pass a budget of 1. The daily counter is persisted to
`<DATA_DIR>/logs/isolated-inference.usage.json` (`{version, services:{<id>:{day, calls}}}`, no
prompt, no token) and re-read after a restart: a deploy or a crash loop does not hand out a fresh
budget. A call that never reached the provider (`model_not_available`, `model_blocked_by_policy`,
`unauthorized` at the revoke re-check) gives its budget unit back.

The parsed service registry is cached for at most 1 s, keyed on inode, size and mtime of
`isolated-inference.json`, so the unauthenticated path does not read and parse the file per packet
while a revoke still takes effect immediately (rewriting the file changes the key).

## What this endpoint cannot do

- reach any `/api/*` router: it is mounted before them, gets no `Database` handle and its
  module imports only `config`, `data-policy`, `pi-models` and `provider-config` (a test pins
  that import list),
- accept a web session JWT (a user account is not a service credential),
- run more than one route: `/v1/isolated/*` is only `POST /infer`, everything else is `404`,
- write anything: no database, no memory, no chat, no strand, no board, no file.

## Tests

| file | what |
|---|---|
| `packages/core/src/isolated-inference.test.ts` | config/auth/validation/limits/idempotency, import allowlist (32) |
| `packages/core/src/isolated-inference.wire.test.ts` | real `completeSimple` + faked Anthropic stream: system prompt, `max_tokens`, no `temperature`, no `thinking`, policy refusal (4) |
| `packages/web-backend/src/routes/isolated-inference.test.ts` | HTTP contract, 401 for JWT/wrong token, unknown fields, 405, body cap, 16 other API paths closed for the service token (27) |
