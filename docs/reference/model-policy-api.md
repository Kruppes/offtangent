# Model Policy API

Reference for `/api/model-policy` — the read/write API for the `modelPolicy`
block in `settings.json` (ADR "Modell-Policy für Offtangent", 2026-09-13).
One document, one abstraction: **roles**. A role names a job ("the router",
"cronjob tasks", "the speech summary") and points it at a model; everything
that is not pinned by a role keeps running on the active provider.

All endpoints are **admin only** (JWT, `role: "admin"`), like `/api/settings`.
A logged-in non-admin gets `403 {"error":"Admin access required"}`, an
anonymous caller `401`. Bodies are JSON, errors are
`{ "error": "<message>", "code": "<machine code>" }`.

Provider secrets never appear in a response: the API returns provider **ids,
names and model ids** only, never keys, tokens or base URLs.

## Roles

| Role | Shape | Consumer |
|---|---|---|
| `router` | chain | capture router (`POST /api/captures` without `strandId`) |
| `projectAssignment` | chain | project assignment proposal for a strand |
| `speechSummary` | single | the short spoken summary (20 s budget) |
| `task:default` | single | every background task, only when `tasks.defaultProvider` is empty |
| `task:user`, `task:agent`, `task:cronjob`, `task:heartbeat`, `task:consolidation` | single | tasks of that trigger type |
| `summary` | single | session summary — legacy field `sessionSummaryProviderId` |
| `factExtraction` | single | fact extraction — legacy field `factExtraction.providerId` |
| `consolidation` | single | memory consolidation — legacy field `memoryConsolidation.providerId` |
| `sttRewrite` | single | transcript rewrite — legacy field `stt.rewrite.providerId` |
| `loopDetection` | single | smart loop detection — legacy field `tasks.loopDetection.smartProvider` |
| `default` | **read-only** | the active provider/model from `providers.json` |

A **single** role takes exactly one entry: `providerId:modelId`, a bare model
id, a provider id or a provider name. A **chain** role takes a comma separated
list, entries may carry a trailing confidence threshold (`gpt-5.4-nano:0.9`).
The provider/model split happens at the **first** colon, so model ids with
colons (`qwen3.8:27b-mlx`) work.

The five roles with a *legacy field* are read through: as long as the role is
empty, the old settings field is used unchanged. Nothing is migrated or
rewritten; deleting the role restores the old behaviour exactly.

## `GET /api/model-policy`

```json
{
  "roles": {
    "router": "claude-sonnet-5, gpt-5.4-nano:0.9, ministral-3:14b",
    "task:cronjob": "c9801e41-…:claude-sonnet-5"
  },
  "default": {
    "providerId": "c9801e41-…", "providerName": "Anthropic",
    "modelId": "claude-opus-5", "composite": "c9801e41-…:claude-opus-5"
  },
  "policy": [
    { "role": "task:cronjob", "value": "c9801e41-…:claude-sonnet-5", "source": "role",
      "resolved": { "providerId": "c9801e41-…", "providerName": "Anthropic", "modelId": "claude-sonnet-5" } },
    { "role": "summary", "value": "4ac0eadd-…:qwen3.8:27b-mlx", "source": "legacy",
      "legacyField": "sessionSummaryProviderId",
      "resolved": { "providerId": "4ac0eadd-…", "providerName": "ollama", "modelId": "qwen3.8:27b-mlx" } },
    { "role": "task:heartbeat", "value": "", "source": "active", "resolved": null }
  ]
}
```

- `roles` — the raw block as written in `settings.json`.
- `default` — derived from `providers.json`, **read-only**, `null` when no
  provider is active.
- `policy` — one entry per known role plus every extra role found on disk.
  `source` is `role` (set in the policy), `legacy` (read through to the old
  field) or `active` (nothing configured, the active provider is used).
  `resolved` is the first usable entry of the value, `warning` carries the
  reason when an entry does not resolve (dead pin) — a dead reference is
  reported, never an error.

## `PUT /api/model-policy`

Body `{ "roles": { "<role>": "<spec>" , … } }`. The block is replaced by the
validated payload; a role sent empty (`""`) is removed. Only `modelPolicy` is
written, every other key of `settings.json` is preserved byte-for-byte (the
file is read, one key is replaced and the result is written through a temp
file + rename).

Each entry is validated against `providers.json`: the provider must exist, the
model must be in its `enabledModels`, and the provider type must not be on the
guardrail blocklist (`zai`, `zai-coding`, `zai-coding-plan`, `kimi`,
`kimi-coding`, `moonshot` — these may be chosen by hand for a chat, never as
an automatic policy target).

Errors:

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_body` | body is not `{ roles: { … } }` |
| 400 | `default_is_read_only` | `default` sent as a role (or top level) |
| 400 | `invalid_role_value` | role value is not a string |
| 400 | `chain_not_allowed` | several entries on a single-entry role |
| 400 | `unresolvable_reference` | unknown provider/model, disabled model, or blocked provider type |
| 403 | — | caller is not an admin |

The response is the same payload as `GET`.

## `GET /api/model-policy/resolve`

Debug route. Query: `role` (required), `kind` (task trigger type), `agentId`
(persona). It returns the full chain, which step was taken and why:

```
GET /api/model-policy/resolve?role=task:cronjob&kind=cronjob
```

```json
{
  "role": "task:cronjob", "kind": "cronjob", "agentId": null,
  "steps": [
    { "step": "explicit (create_task provider/model)", "value": null, "taken": false,
      "reason": "a call argument, not configuration — not visible from here" },
    { "step": "parent task provider", "value": null, "taken": false, "reason": "only set while running inside a task" },
    { "step": "persona multiPersona.perAgentProvider[\"\"]", "value": null, "taken": false, "reason": "no agentId given" },
    { "step": "modelPolicy.roles[\"task:cronjob\"]", "value": "c9801e41-…:claude-sonnet-5", "taken": true, "reason": "used" },
    { "step": "tasks.defaultProvider", "value": "c9801e41-…:claude-opus-5", "taken": false, "reason": "a stronger step already decided" },
    { "step": "modelPolicy.roles[\"task:default\"]", "value": null, "taken": false, "reason": "only consulted when tasks.defaultProvider is empty" },
    { "step": "active provider (default role)", "value": "c9801e41-…:claude-opus-5", "taken": false, "reason": "a stronger step already decided" }
  ],
  "resolved": { "providerId": "c9801e41-…", "providerName": "Anthropic", "modelId": "claude-sonnet-5" }
}
```

For a chain role every chain entry is one step; for a role with a legacy field
the legacy step appears after the role step. The last step is always the active
provider, which is what a role without any configuration falls back to.

`400 role_required` when `role` is missing.

## See also

- [Settings → `modelPolicy`](./settings#modelpolicy) — the block on disk
- [Models and Providers](../guide/models) — which model belongs in which role
- [Captures API → router model chain](./captures-api#router-model-chain)
