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
loaded. Project instructions/history supplied explicitly inside a strand remain
part of that strand. This is application data isolation, not provider-policy
avoidance and not a filesystem sandbox against a malicious tool caller.

### Storage

New memory is written below the active persona memory root:

```
scoped-v1/<user-id>/<sha256(persona-id)>/<sha256(scope-key)>/MEMORY.md
scoped-v1/<user-id>/<sha256(persona-id)>/<sha256(scope-key)>/YYYY-MM-DD.md
```

Scope keys are `project:<project-id>`, `strand:<origin-session-id>` and
`approved-global`. The user id is an authenticated positive integer; persona and
scope keys are hashed, never raw caller-controlled path segments. Approved-global is
an explicit, operator-reviewed classification, per user and persona; it is NOT a
fallback location for legacy material. Existing AGENTS/global safety instructions
are independent and always retained. Ordinary turn outcomes, failure notices,
fact extraction and consolidation never promote into approved-global.

Facts have nullable `memories.context_scope`. Automatic FTS retrieval requires
matching user, persona and project/strand,
active status and owner/agent provenance. Unclassified NULL rows are retained but
not automatically injected. Extracted `[SHARED]` model suggestions cannot confer
global approval. Dedupe occurs within the classified scope.

Task context inherits from an owned origin strand (including nested tasks).
Cross-persona work uses the target persona's isolated root. Unknown-origin work
has no implicit project/persona memory fallback. Consolidation enumerates only
classified owned scope roots, runs one scope at a time, and is forbidden to read
legacy archives or promote content into global context. Legacy files remain
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
   default `project-isolated`, nullable `memories.context_scope`, and the metadata-
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
checks. It reports fixed source labels, scope/reason, SHA-256 and character counts
only. There are no text previews, tool arguments, filesystem paths or prompt dumps.
The manifest is recorded at the app-side, redacted pre-provider boundary; provider
serialization may add envelopes. System/message envelope rows overlap their
individual source rows, so their sizes must not be summed as a token budget.
Retention is bounded to 20 manifests per session and 30 days. Changing project or
context policy clears stale manifests and recreates live session context. The
panel without a recorded request shows selected policy/scope and no invented
outgoing-request measurement. Generic counts and hashes are still sensitive
metadata: do not export them to public issue reports.

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
