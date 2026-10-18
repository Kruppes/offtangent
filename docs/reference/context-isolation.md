# Context isolation and migration

## Contract

The automatic context default is project-isolated, not an optional clean-room
mode. An authenticated, owned session is the authority for user, active persona
and project; a detached strand receives only its own strand memory. `strand-only`
may narrow that choice further. A project id from a caller is not sufficient: the
project must belong to the session user. Invalid ownership fails closed.

Always-required global agent rules, runtime/tool safety and the active persona's
identity remain. Persona-wide MEMORY.md, daily notes, heuristics, wiki indexes,
other projects' notes and historical failure notices are not automatically
loaded. Never modify the trusted global safety layer to classify project data. Project instructions/history supplied explicitly inside a strand remain
part of that strand. This is application data isolation, not provider-policy
avoidance and not a filesystem sandbox against a malicious tool caller.

### Storage

New memory is written below the active persona memory root:

```
scoped-v1/<user-id>/<sha256(persona-id)>/<sha256(scope-key)>/MEMORY.md
scoped-v1/<user-id>/<sha256(persona-id)>/<sha256(scope-key)>/YYYY-MM-DD.md
```

Scope keys are `project:<project-id>`, `strand:<origin-session-id>`. The user id is an authenticated positive integer; persona and
scope keys are hashed, never raw caller-controlled path segments. A reserved `approved-global` directory is NOT automatically loaded. This release provides no implicit global data approval; keep cross-project preferences in explicit retrieval or reviewed trusted configuration. Existing AGENTS/global safety instructions
are independent and always retained. Ordinary turn outcomes, failure notices,
fact extraction and consolidation never promote into approved-global.

Facts have nullable `memories.context_scope`. Automatic FTS retrieval requires
matching user, persona and project/strand,
active status and owner/agent provenance. Unclassified NULL rows are retained but
not automatically injected. Extracted `[SHARED]` model suggestions cannot confer
global approval. Dedupe occurs within the classified scope. If a strand's project,
policy, persona or owner changes, its retained transcript may mix scopes. Facts
extracted from that strand are preserved as unclassified (also when assignment
changes back during extraction), never relabelled into the new project. Start a
fresh strand for new automatically classified facts. This conservative quarantine
does not erase existing facts or stop the strand from reading its selected scope.
Summaries of such strands remain in the database without a scoped daily-file write;
consolidation does not select their mixed transcript as its source. A fresh strand's initial project is stored in its INSERT and is not a reassignment. Automatic NULL-to-project assignment is exempt only while there is no retained chat, tool, fact, summary, task or child-session history and no prior scope-change marker. Existing markers are never silently cleared.

**Project-switch warning:** interactive history is retained, not isolated into historical project segments. A moved strand can send old A messages alongside B memory on its next turn. Use a NEW strand when that mixture is unwanted. The sticky marker protects derived facts/summaries/consolidation, not the interactive transcript; a change back to A does not restore automatic fact or consolidation writes. A dedicated UI warning/history-partition migration is still open.

New task context inherits from an owned origin strand (including nested tasks), with user/scope identity pinned at task-session creation in `sessions.context_origin_scope`. A later parent project, policy or owner change fails closed for automatic task reads/writes and resume; it cannot relabel the existing task transcript into the new scope. Existing legacy task sessions are marked unclassified at startup, retaining transcript/results but receiving no automatic memory until a fresh task is created.
Cross-persona work uses the target persona's isolated root. Unknown-origin work
has no implicit project/persona memory fallback. Consolidation enumerates only
classified owned scope roots, runs one scope at a time with only scope-bound file tools and exact-session history. Shell, codemode, delegation, arbitrary connectors and cross-project search are absent from its capabilities. Only MEMORY.md, wiki/*.md and users/*.md are writable; daily/sources are read-only. Symlink and traversal paths are rejected. This is a capability boundary for consolidation, not just a prompt instruction. Legacy files remain
available for deliberate retrieval; `search_memories(cross_project=true)` is an
explicit archive read limited to the authenticated user's facts. An explicit
persona parameter further controls persona selection. Retrieved data then belongs
to the current strand history; changing policy does not erase that history.

## Additive migration (no automatic global classification)

1. Finish active workers and choose an external, safe deployment window. Do not
   restart the instance from an agent running inside it. Use the established
   pre-deploy SQLite backup/integrity hook; do not create unbounded ad-hoc dumps.
2. Preserve the whole existing persistent memory volume, including persona roots,
   using the operator's normal versioned snapshot procedure. This migration
   neither moves nor rewrites nor deletes legacy markdown or fact rows.
3. On first start, idempotent schema setup adds `sessions.context_policy` with
   default `project-isolated`, nullable `sessions.context_origin_scope` for pinned task origins, nullable `memories.context_scope`, and the metadata-
   only `context_manifests` table. Existing facts remain NULL/unclassified. Check
   row counts and byte hashes of representative legacy files against the backup.
4. Do NOT bulk-copy legacy MEMORY.md/dailies into approved-global. First review
   each item for owner, active persona, project and provenance. Leave uncertain
   items archived. Copy only reviewed items to their owned scoped directory (keep
   the original archive); explicitly classified fact rows may be assigned their
   canonical scope after review. Record each old/new value in an operator audit
   outside the public repository. No such mass reassignment is performed by the
   application.
5. Start a new strand in project A, project B and no project. Verify only their
   own synthetic sentinel is present and global safety remains. Repeat for a
   second user/persona and a nested task. Do not use real sensitive prompts as
   tests. Check writes stay in the scope displayed for the originating session.
6. Inspect the Web and Companion context panels. Older servers produce an
   explicit unsupported state, not a fabricated zero. The Companion update is
   additive and may be tested before backend rollout, but Play promotion follows
   the backend compatibility/smoke gate.

## Context provenance

`GET /api/strands/:id/context` is protected by the existing authenticated strand
ownership and allowed-persona checks, and the manifest query repeats user/persona
checks. It reports fixed source labels, scope/reason, HMAC-SHA-256 and character counts
only. There are no text previews, tool arguments, filesystem paths or prompt dumps.
The manifest is recorded at the app-side, redacted pre-provider boundary; provider
serialization may add envelopes. The HMAC key is random, database-local and never returned through the API. It is retained in the protected database backup, not in telemetry; public hashes cannot be dictionary-matched offline without this key.
System/message envelope rows overlap their
individual source rows, so their sizes must not be summed as a token budget.
Retention is bounded to 20 manifests per session and 30 days. Global pruning runs on every manifest write; deletion of a session cascades to its metadata rows. Changing project, context policy or ownership clears stale manifests via a database trigger. The next provider turn rebuilds the runtime system context against the current authenticated scope. The
panel without a recorded request shows selected policy/scope and no invented
outgoing-request measurement. Generic counts and hashes are still sensitive
metadata: do not export them to public issue reports.

### Legacy notice delivery

The `legacy-cron-notices-v2` boot migration runs ONCE, in an immediate database transaction. Only terminal, non-silent, unmarked **cronjob** rows in that first-run snapshot are eligible. User/agent/subtask, heartbeat and consolidation outcomes are not an old cron notice queue. Existing feed rows must match both task and verified owner. Feed insertion and `agent_notified_at` marking are atomic; nested savepoints isolate damaged rows. The migration-completion marker commits with the batch, so a crash rolls back the entire uncommitted batch. Subsequent boots are no-ops, including for tasks created after migration.

Unknown/ambiguous-owner or failed rows remain intact in `tasks` plus a durable `context_notice_quarantine` disposition. There is NO automatic retry on boot; classification/recovery is an explicit operator action. Admins receive one generic deduplicated metadata-only alert (no foreign title/result). No personal outcome is broadcast to admins or a default user. Current outcome routing commits a private-feed row and notice receipt together; live-parent delivery also records a receipt. Do not delete quarantined rows, completion markers or original task results during deployment or rollback.

## Rollback

The schema changes are additive; old columns and data are not renamed or removed.
Keep the scoped directories and NULL legacy fact rows intact. Reverting to an old
binary would re-enable its persona-wide auto-injection and is therefore a privacy
regression, not a safe isolation fallback. Prefer a forward fix or temporarily
stop new turns through the external orchestrator. If an operator knowingly rolls
back, preserve new scoped files separately, use the tested database backup only
with a reconciled write window, and document the lost post-backup writes. Do not
drop new columns/tables or delete scopes merely to make an older binary run. A
re-upgrade is idempotent and can reuse the preserved scope data.

## Release gates

Run the synthetic context-isolation and runtime assembly suites, owner/persona
API tests, memory/FTS/fact/task/consolidation regressions, Web contract tests, lint,
CI type/build/prebuilt gates and independent fresh-context read-only review.
Compile and test native on the remote Android build host; run an emulator smoke
on a synthetic server, verify old/new-server behavior and stop the emulator and
Gradle daemons afterwards. No build/review assertion alone means a deployment or
Play internal release happened. Report implemented, tested and live separately.

## Known boundaries retained after the blocker fixes

- Consolidation pins owner/scope at session INSERT, including the scheduler fallback without SessionManager. Missing legacy pins fail closed. Every allowed capability rechecks lineage and sticky owner/persona/policy/project changes (including A→B→A); reads crossing a change are discarded. Production filesystem writes execute synchronously after the check. This guards application event-loop changes, not a malicious concurrent local filesystem/database writer.
- Skills remain global/persona-wide: an agent-created skill's name/description can appear in another project's prompt. This is an explicit agent-controlled cross-project side channel, NOT a solved isolation guarantee. Scoping/approval of skills is separate work.
- Provenance tags are regex-derived display metadata, not trusted attribution. User text can forge tags (only HMAC/length are retained); category labeling follows the current resolved scope.
- Filesystem containment checks still have an lstat/access symlink TOCTOU window for a concurrent local writer. No OS sandbox is claimed.
- Task lineage resolution is bounded to ten ancestors and fails closed beyond that limit. Without an admin account no quarantine feed notification can be emitted; durable dispositions and original task results still exist.
- Companion parsing tests do not prove UI rendering. The companion implementation is unchanged by this blocker round; fresh native/UI verification and independent review remain release gates.
