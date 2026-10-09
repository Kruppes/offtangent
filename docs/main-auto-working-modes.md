# Strand persona and working mode

A strand's `agentId` is its conversational owner. `workingMode` is a separate persisted policy: `main` (inline-first) or `auto` (delegation-first). Auto is not another persona: it uses Main's existing base prompt plus a mode-specific supplement. Specialist direct chats retain their own persona prompts.

## Creation and transitions

Unpinned/Auto capture routing creates new strands as `agentId: main, workingMode: auto`, regardless of a router model's topic-based specialist suggestion. An explicit persona selection remains authoritative and creates a direct strand in `main` mode. Appending to an existing strand preserves that strand's stored identity; existing historical specialist strands are not silently converted.

`PATCH /api/strands/:id` accepts `agentId` and/or `workingMode`:

| Request | Result |
| --- | --- |
| Main mode → Auto | Main persona, Auto mode |
| Auto → Main mode | Main persona, Main mode |
| Auto → specialist persona | Specialist persona, Main mode |
| Specialist → Auto | Main persona, Auto mode |
| Specialist → Main persona | Main persona, Main mode |
| Specialist → another specialist | Selected specialist, Main mode |
| Same values | No boundary and no prompt eviction |
| Explicit specialist + Auto together | Rejected (400) |

Unknown/archived personas and invalid modes are rejected. An active or queued turn blocks an identity change (409); background workers do not block changes and are not rewritten. A successful identity change evicts the cached strand prompt/transcript, writes a context-change boundary into that same conversation and retains previous rows. Owner-checked strand history returns messages across its earlier personas.

## Persistence and compatibility

The additive `sessions.working_mode` column defaults to `main`; all historical `agent_id` values remain unchanged. Modes survive reload and strand forks. The execution layer re-reads the strand policy when preparing Main's prompt, instead of treating a client label or persona alias as policy.

Auto prefers scoped specialist tasks for substantial execution. It still answers trivial questions and asks clarifications inline. Main retains context, chooses the worker and checks the result. Existing task identity and `delegatedBy` stay independent of later strand settings; specialist task outcomes are attributed to the actual receiving strand persona when delivered after a switch.

## Verification and rollout

Tests cover migration/reopen, transition validation, busy turns, unchanged workers, routing (including samplebot), shared-base prompt differences, cross-persona history, forks and Web rendering. The Android Companion has matching API/domain/reload tests and selector behavior.

Deployment and independent review are separate gates. This change does not migrate historical personas or require a restart during implementation. A previous binary ignores the additive mode column; do not manually drop it or rewrite historical strand/task identities for rollback.
