# Effective memory scope and skills

Project assignment organizes a strand; it does not authorize importing its history into project memory. A new empty project strand uses project memory. Once a nonempty strand is assigned/reassigned (or an existing assignment changes), its effective data scope remains its own strand, even when the assignment changes back. Its daily summaries, extracted facts, consolidation, skill creation and ordinary memory writes agree on that scope. New child tasks inherit it; a monotonic revision invalidates older task pins. Owner/persona changes fail closed rather than transferring memory ownership.

Web and Android show **effective** policy/data scope, separately from the stored project policy. A retained-history notice explains that a new project strand is needed for project memory. Missing server fields are unknown, not a claim of project isolation.

## Skills: no automatic classification

Both installed-skill metadata and agent-created skill metadata (including names and paths) are filtered before prompt assembly. Agent-created skills belong in the creation directory supplied by the current prompt:

`<skills_agent>/scoped-v1/<owner>/<sha256(persona)>/<sha256(scope-key)>/<skill>/SKILL.md`

Do not infer the directory from the UI's project assignment. Discovery defaults to approved generics plus this effective scope. Explicit `list_agent_skills(cross_project=true)` reads the same owner's/persona's other scopes and labels the result; it grants no publication/write permission. Named task attachments are deliberate reads, preferring current-scope skills and falling back to legacy names. Legacy files are preserved; explicit `list_files`/`read_file` also remain available. They are not automatically inventoried in prompts.

Five reviewed shipped generics (`email`, `wiki`, `skill-creator`, `tasks-and-cronjobs`, `voice-message`) are approved by exact SHA-256 in `approved-builtin-skills.ts`. Changed copies are not trusted by name. Their instructions use the effective scoped directories, not legacy global memory paths.

Operator-only publication:

- For an existing generic agent-created skill, add its **relative legacy directory name** and exact SHA-256 of `SKILL.md` to `<skills_agent>/.global-approvals.json` (JSON object). Review the complete skill, including metadata, before granting. Changing content revokes approval automatically. Never approve by keywords.
- Installed skills in `skills.json` require explicit `contextAccess: "global"` for generics, or `contextAccess: { "userId": 123, "agentId": "main", "key": "project:..." }` (or `strand:...`) for an exact scope. `enabled: true` alone is not global approval.
- These are operator configuration steps, not automatic migrations or project-agent writes. This change does not modify existing production files or grants.

## Boundaries and upgrade

Ordinary `write_file` and `edit_file` reject old/new foreign project memory, legacy memory, global/foreign skills and skill-grant configuration; existing path ancestors are resolved before checking symlinks. Explicit reads do not authorize copying a retained transcript into another project's memory. Shell remains a general-purpose tool, **not an OS sandbox**; policy explicitly prohibits bypassing the write rules with shell. Consolidation has a narrower allowlist, no shell/delegation, and revalidates its origin for each operation.

Schema additions are additive: `context_scope_revision` and `context_identity_changed`; the previous empty-first-assignment test and notice migration are retained. Existing history/files are never heuristically reclassified, moved, deleted or promoted. This cannot detect or undo material copied into project memory *before* the fix; any historical repair requires an explicit reviewed data audit. Existing `scope-changed` rows gain their independent strand scope; the new identity-change marker only records identity changes after this schema is installed (the old marker did not retain the reason). This is not a reconstruction of past ownership.

Do not treat an old-binary rollback as safe: earlier binaries may again select the UI project's memory for mixed history. Production rollout/rollback needs a reviewed DB/files backup and the independent release process. No deployment is part of this change.
