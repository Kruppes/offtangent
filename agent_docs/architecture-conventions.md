# Architecture Conventions & Guardrails

This document is the **permanent reference** for structure rules, boundary constraints, and verification checks in the Offtangent monorepo.

Goals:

1. Clear module boundaries between packages and layers
2. Testable, deep modules instead of shallow distribution
3. Stable behavior parity during refactoring

## 1) Package Boundaries

- `packages/core` is the stable, platform-independent boundary.
- `web-backend`, `web-frontend`, and `telegram` consume Core only via `@axiom/core` (no `@axiom/core/src/*` deep imports).
- `core` does not import any platform packages.
- `web-frontend` does not import `web-backend` or `telegram`.
- `telegram` does not import `web-backend` or `web-frontend`.

## 2) Backend Convention

Mandatory layering for modular API domains under `packages/web-backend/src/api/modules/<domain>/`:

```text
route -> controller -> service -> schema/mapper
```

### Responsibilities

- **route**: HTTP wiring, middleware, route registration
- **controller**: Request/response orchestration, error/status mapping
- **service**: Business logic + coordination of Core/Infra
- **schema/mapper**: Validation, DTO mapping, transport transformation

`app.ts` uses canonical module routes for migrated domains:

- `api/modules/settings/route.ts`
- `api/modules/providers/route.ts`
- `api/modules/memory/route.ts`
- `api/modules/tasks/route.ts`

## 3) Core Deep Modules

- Agent runtime is encapsulated via `createAgentRuntime`/`AgentRuntimeBoundary`.
- Task runtime is encapsulated via `createTaskRuntime`/`TaskRuntimeBoundary`.
- Chat turns are encapsulated via `TurnRunner` (`core/src/turn-runner.ts`). It owns
  the turn lifecycle (streaming, chunk persistence, stall watchdog, abort)
  independently of any connection, buffers the active turn in memory and replays
  it to consumers that attach mid-turn. Channels (`ws-chat`, Telegram) only
  dispatch into it and forward its events — they must not own stream state.
  Turns are never recovered across a process restart.
  There is exactly **one** runner per process, built in
  `web-backend/src/bootstrap/runtime-composition.ts` and handed to both the
  WebSocket chat and the Telegram bot, so a turn started in one channel streams
  into the other and a manual retry cannot race a second, channel-local runner.
  Turns are keyed by `agentUserId` (the identity the agent sees); the numeric
  `userId` is only used for persistence and may be `null` for an approved but
  unlinked Telegram chat, which then streams without persisting.
- Provider stalls are channel-agnostic: the watchdog emits `stall_warning` /
  `stall_resolved` chunks and persists a single `provider_stall` chat row
  (`core/src/provider-stall.ts`) that is updated in place on resolution. Channels
  render that row, they do not invent their own stall messaging. Thresholds come
  from `settings.json → watchdog` and are read at turn start.
- Terminal turn failures are persisted the same way: the runner writes a
  `turn_error` chat row (`core/src/turn-error.ts`) carrying the full provider
  error text plus `cause` / `retryable` / `attempts`, and emits the matching
  `error` chunk with the row id. Channels render that row — a failed turn must
  never end silently.
- Manual retry is a chat action (`core/src/turn-retry-action.ts`): every error row
  carries a `retryActionId` that channels register in the chat-action registry
  (`web-backend/src/turn-retry-chat.ts`). The handler validates freshness against
  the database (session still open, no newer user/assistant/tool row, no running
  turn) and restarts the turn via `TurnRunner.retryTurn`, which continues the
  existing transcript instead of re-sending the user message. The registry is
  in-memory, so buttons minted before a restart answer "no longer available".
  Resolutions cross channel boundaries through `core/src/turn-retry-notifier.ts`
  (same pattern as `email-approval-notifier.ts`): whoever answers first wins, and
  every other channel disables its own button with the same wording. Telegram
  renders the button as an inline keyboard whose `callback_data` carries the
  error row id (`telegram/src/turn-retry.ts`).
- Telegram's provider-stall / auto-retry notices are opt-in
  (`telegram.json → sendStallWarnings`, default off). The terminal error and its
  Retry button are always delivered.
- Integrations (e.g., Heartbeat, Consolidation Scheduler, Task Tools) use boundary contracts instead of low-level wiring.

## 4) Frontend Convention

- `pages/` orchestrates only.
- Feature logic lives in `features/`.
- HTTP/transport logic lives in `api/`.

## 5) Enforceable Rules

Rules are enforced by the default ESLint config (`eslint.config.js`):

- Package boundaries
- Backend layer boundaries (`route/controller/service/schema|mapper`)
- Frontend layer boundaries (`pages/features/api`)
- Prohibition of legacy backend adapter imports (`routes/settings|providers|memory|tasks`)

Lint command:

```bash
npm run lint
```

## 6) Verification Baseline

Mandatory checks for refactoring and major structural changes:

```bash
npm run baseline:unit
npm run baseline:api
npm run verify:critical-flows
```

Full execution locally:

```bash
npm run baseline:parity
```

### Baseline Segments

- `baseline:unit`: Core + Telegram unit/module tests + Frontend utility/composable tests
- `baseline:api`: Backend API/transport test suite
- `verify:critical-flows`: Smoke/critical flows (Health, Auth/Login, Chat History, Memory, Settings, Providers, Tasks, Cronjobs)

## 7) CI Integration

Workflow: `.github/workflows/ci-guardrails.yml`

The workflow runs on `pull_request` (against `main`) and `push` to `main` and executes:

1. `npm run lint`
2. `npm run baseline:unit`
3. `npm run baseline:api`
4. `npm run verify:critical-flows`

## 8) Session Architecture

All sessions in Offtangent share a **single UUID-based model**. Session kind, origin,
and lineage are expressed as columns on the `sessions` table — **never** encoded
into the session ID itself.

### Canonical model

- `sessions.id` is always a UUID (`crypto.randomUUID()`).
- `sessions.type` classifies the session kind:
  - `interactive` — user chat (web, telegram, REST)
  - `task` — background task execution (including cronjob-triggered tasks)
  - `heartbeat` — agent heartbeat
  - `consolidation` — nightly memory consolidation
  - `loop_detection` — loop-detection LLM call within a task
- `sessions.source` tracks the originating channel for interactive sessions:
  `web`, `telegram`, `telegram-group`, `rest`, `task`, `system`.
- `sessions.parent_session_id` links child sessions (task, heartbeat,
  loop_detection) back to the interactive session that triggered them,
  enabling lineage queries without prefix parsing.

System-originated messages (task-injection responses, task-result
notifications) are logged under the **target user's interactive session**.
There is no separate `system` or `notification` session type.

### ID generation

There is exactly one session-ID generator: `generateSessionId()` in
`packages/core/src/session-manager.ts`, which returns `crypto.randomUUID()`.
No code constructs session IDs inline. Legacy prefix forms (`session-*`,
`web-*`, `task-*`, `agent-heartbeat-*`, `nightly-consolidation-*`,
`loop-detection-*`, `task-result-*`, `task-injection-*`, `cronjob-*`) only
survive in migration code, tests, and historical comments.

### Query rule

Consumers (usage stats, token logger, chat-history tools, logs API, frontend
log filters) filter by `sessions.type` / `sessions.source` via JOIN —
**never** via `LIKE 'task-%'` or session-ID prefix inspection. Log/session
filters in the frontend are metadata/type driven and operate on the canonical
`sessionType` parameter.

### Migration

The migration in `packages/core/src/database.ts` backfills `type` from
legacy prefixes, remaps legacy IDs to UUIDs (keeping existing UUIDs
unchanged), rewrites all FK references across `chat_messages`, `token_usage`,
`tool_calls`, `tasks`, and `memories`, and is idempotent + transactional.

## 9) PR Checklist (Definition of Done)

- Structural changes follow the conventions in this document.
- Boundary linting is passing.
- Unit/API/Critical-Flow baseline is passing.
- No unintended functional behavior changes (Behavior Parity).

## 9) Split on Intake

A capture that mixes unrelated matters is cut into topic parts **before** the
router runs (`core/src/capture-split.ts`). The rules that must survive
refactoring:

- The split is a **core** concern (two model calls plus deterministic post
  processing); the captures service only orchestrates. `capture-split.ts` must
  stay free of web-backend imports, like the rest of `packages/core`.
- The model proposes, the **code decides**: the sentence assignment is
  validated (every id exactly once) with up to three repair rounds, topics
  below two sentences are folded into their neighbour, and a split whose
  `splitConfidence` is under `SPLIT_MIN` is discarded. Never move those gates
  into the prompt.
- One part is the identity case: `parts[0].text` is the ORIGINAL capture text,
  no consolidation runs, and nothing about the stored rows or the emitted
  frames changes. `split-single-part.test.ts` pins that against the behaviour
  recorded on `main`.
- Every part gets its OWN `router_decisions` row (`part_index`, `part_count`,
  `part_text`, `part_title`, `sentence_ids`) and its own `chat_messages` row
  (`part_index`, `metadata.capturePart`). `captures.strand_id`/`message_id`
  stay bound to part 0 so the tray and the home screen keep reading one strand
  per capture.
- Clients that know nothing about parts must keep working: `decision` in every
  response and every WebSocket frame is the decision of part 0, `parts` and
  `partCount` are additive.
