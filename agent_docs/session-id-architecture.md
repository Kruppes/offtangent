# Session ID Architecture

> Status: **Analysis document** — describes the current state and proposes a simplification.

## Problem Statement

Session IDs are generated in **many different places** with **different naming conventions** depending on the source (web, telegram, task, heartbeat, etc.). This makes it extremely difficult to:

1. Query all messages for a given session
2. Filter sessions by type (e.g. "only interactive sessions")
3. Generate summaries that include all relevant messages
4. Reason about what a "session" actually is

## Current Session ID Formats

### 1. SessionManager (core — interactive sessions)

**File:** `packages/core/src/session-manager.ts` → `getOrCreateSession()`

```
session-{userId}-{timestamp}-{random6}
```

**Example:** `session-3-1713345600000-a1b2c3`

- Used when a user message arrives via `AgentCore.processUserMessage()` or `processTaskInjection()`
- The SessionManager is the **single owner** of interactive sessions
- Stored in the `sessions` table with `source` column (`web`, `telegram`, `task`)

### 2. WebSocket (web-backend — temporary session IDs)

**File:** `packages/web-backend/src/ws-chat.ts`

```
web-{userId}-{timestamp}-{random8hex}
```

**Example:** `web-3-1713345600000-a1b2c3d4`

- Generated on WebSocket connect as a **temporary** session ID
- **Overwritten** on first message when `SessionManager.getOrCreateSession()` returns the real session ID
- Also generated on `/new` command and on `session_end` events

### 3. REST upload endpoint (web-backend)

**File:** `packages/web-backend/src/routes/chat.ts`

```
web-{userId}-{timestamp}
```

**Example:** `web-3-1713345600000`

- Generated for the `POST /api/chat/message` upload endpoint
- **Never** goes through SessionManager — this is a standalone ID
- Messages saved with this ID are **orphaned** from the SessionManager's tracking

### 4. Task sessions

**File:** `packages/core/src/task-runner.ts`

```
task-{taskId}           (fallback when task has no sessionId)
```

**Example:** `task-a1b2c3d4-e5f6-7890-abcd-ef1234567890`

- Used in `token_usage` and `tool_calls` tables
- The task's `sessionId` field can also be set explicitly at creation time (see heartbeat, consolidation below)

### 5. Heartbeat sessions

**File:** `packages/core/src/agent-heartbeat.ts`

```
agent-heartbeat-{timestamp}
```

**Example:** `agent-heartbeat-1713345600000`

- Set as `sessionId` on the task when creating a heartbeat task
- Used by `usage-stats.ts` to filter heartbeat costs via `LIKE 'agent-heartbeat-%'`

### 6. Loop detection sessions

**File:** `packages/core/src/task-runner.ts`

```
loop-detection-{taskId}
```

**Example:** `loop-detection-a1b2c3d4-e5f6-7890-abcd-ef1234567890`

- Internal session ID for the loop-detection LLM call within a running task
- Logged to `token_usage` for cost tracking

### 7. Task result notification sessions

**File:** `packages/core/src/task-notification.ts`

```
task-result-{taskId}
```

**Example:** `task-result-a1b2c3d4-e5f6-7890-abcd-ef1234567890`

- Used when logging a `tool_call` for the task notification delivery
- Only appears in `tool_calls` table

### 8. Nightly consolidation sessions

**File:** `packages/web-backend/src/memory-consolidation-scheduler.ts`

```
nightly-consolidation-{timestamp}
```

**Example:** `nightly-consolidation-1713345600000`

- Used for the memory consolidation background task
- Logged to `tool_calls` via `logToolCall()`

### 9. System task injection sessions

**File:** `packages/core/src/agent.ts` → `processTaskInjection()`

```
session-system-{timestamp}-{random6}
```

- Created via `SessionManager.getOrCreateSession('system', 'task')`
- Used when a background task result is injected into the main agent

## Where Session IDs Appear in the Database

| Table | Column | Contains |
|-------|--------|----------|
| `sessions` | `id` | `session-{userId}-{ts}-{rand}` (from SessionManager) |
| `sessions` | `source` | `web`, `telegram`, `task` |
| `chat_messages` | `session_id` | All formats above (whoever writes the message) |
| `token_usage` | `session_id` | All formats above (nullable) |
| `tool_calls` | `session_id` | All formats above (nullable) |
| `tasks` | `session_id` | `task-{id}`, `agent-heartbeat-{ts}`, or explicitly set |
| `memories` | `session_id` | Inherited from the session that created the memory |

## How `usage-stats.ts` Differentiates Session Types

The `buildWhereClause()` function in `usage-stats.ts` uses **string prefix matching** to filter by session type:

```typescript
if (sessionType === 'task') {
  clauses.push("session_id LIKE 'task-%' AND session_id NOT LIKE 'agent-heartbeat-%'")
} else if (sessionType === 'heartbeat') {
  clauses.push("session_id LIKE 'agent-heartbeat-%'")
} else if (sessionType === 'main') {
  clauses.push("(session_id IS NULL OR (session_id NOT LIKE 'task-%' AND session_id NOT LIKE 'agent-heartbeat-%'))")
}
```

Similarly, `chat-history-tools.ts` uses prefix matching for source filtering:

```typescript
// Task sessions
"(cm.session_id LIKE 'task-%' OR cm.session_id LIKE 'agent-heartbeat-%' OR cm.session_id LIKE 'task-injection-%')"
// Telegram sessions
"cm.session_id LIKE 'telegram-%'"
// Web sessions
"(cm.session_id LIKE 'web-%' OR cm.session_id LIKE 'session-%')"
```

## Problems with the Current Design

### 1. Session IDs encode semantics via string prefixes
Session type (web/telegram/task/heartbeat) is baked into the ID string. This forces all downstream code to parse prefixes with `LIKE` patterns — fragile and error-prone.

### 2. Multiple generators, no single source of truth
At least **9 different locations** generate session IDs. The `sessions` table only tracks SessionManager-created sessions — task, heartbeat, consolidation, and notification sessions are **never inserted** into the `sessions` table.

### 3. `chat_messages` records are split across different session IDs
When a user chats via web and telegram in the same logical timeframe, they get **two different session IDs** (both managed by SessionManager, but with different `session-{userId}-{ts}` values if the session timed out between them). Building a summary requires joining across multiple session IDs.

### 4. REST upload endpoint creates orphaned session IDs
`POST /api/chat/message` creates `web-{userId}-{ts}` IDs that never appear in the `sessions` table and are never tracked by SessionManager.

### 5. Prefix collisions
`task-result-{uuid}` starts with `task-` so it gets caught by `LIKE 'task-%'` even though it's a notification log, not an actual task execution session.

## Proposed Simplification: UUID-Based Sessions

### Core Idea

Every session gets a **single UUID** (e.g. `crypto.randomUUID()`). The session **type** becomes a column in the `sessions` table, not encoded in the ID.

### Schema Changes

```sql
-- Add a 'type' column to distinguish session kinds
ALTER TABLE sessions ADD COLUMN type TEXT NOT NULL DEFAULT 'interactive';
-- Possible values: 'interactive', 'task', 'heartbeat', 'consolidation',
--                  'loop_detection', 'notification', 'system'
```

### Session ID Generation

**Single function** in `session-manager.ts`:

```typescript
function generateSessionId(): string {
  return crypto.randomUUID()
}
```

### Migration Path

1. **Add `type` column** to `sessions` table (with default `'interactive'` for existing rows)
2. **Backfill type** from existing prefix patterns:
   - `session-*` → `interactive`
   - `task-*` (but not `task-result-*`) → `task`
   - `agent-heartbeat-*` → `heartbeat`
   - `nightly-consolidation-*` → `consolidation`
   - `loop-detection-*` → `loop_detection`
   - `task-result-*` → `notification`
3. **Update all session ID generators** to use UUID + insert into `sessions` table
4. **Update queries** in `usage-stats.ts`, `chat-history-tools.ts`, etc. to filter by `type` column instead of `LIKE` patterns
5. **Ensure all session-creating code** inserts into the `sessions` table (tasks, heartbeats, etc. currently skip this)

### What Changes for Each Generator

| Current Generator | Current Format | New Approach |
|---|---|---|
| `SessionManager.getOrCreateSession()` | `session-{userId}-{ts}-{rand}` | UUID, type=`interactive`, source column already exists |
| `ws-chat.ts` temp IDs | `web-{userId}-{ts}-{rand}` | No temp IDs needed — use SessionManager immediately |
| `routes/chat.ts` REST | `web-{userId}-{ts}` | Use SessionManager or at least store in `sessions` table |
| `task-runner.ts` | `task-{taskId}` | UUID, type=`task`, stored in `sessions` table |
| `agent-heartbeat.ts` | `agent-heartbeat-{ts}` | UUID, type=`heartbeat`, stored in `sessions` table |
| `task-runner.ts` loop | `loop-detection-{taskId}` | UUID, type=`loop_detection`, linked to parent task |
| `task-notification.ts` | `task-result-{taskId}` | UUID, type=`notification`, linked to parent task |
| `consolidation-scheduler.ts` | `nightly-consolidation-{ts}` | UUID, type=`consolidation`, stored in `sessions` table |
| `agent.ts` system injection | `session-system-{ts}-{rand}` | UUID, type=`system` |

### Benefits

1. **Single query** to get all sessions for a user, filterable by type
2. **No prefix parsing** — `WHERE type = 'task'` instead of `LIKE 'task-%'`
3. **All sessions tracked** in the `sessions` table (currently only interactive ones are)
4. **Easier summaries** — can join on user + time range without worrying about ID formats
5. **No accidental collisions** — `task-result-*` won't match a `task-*` filter
6. **Future-proof** — adding a new session type = adding a new enum value, not inventing a new prefix

### Risks / Considerations

- **Breaking change** for any external tooling that parses session ID prefixes
- **Migration** needed for existing data (backfill `type` column, optionally remap IDs)
- **Log readability** — UUIDs are less human-readable than `session-bob-1713345600000`; consider adding a `label` column for display purposes
- **Backward compatibility** — old `LIKE` queries would break until migrated
