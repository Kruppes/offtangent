# Persona Memory Migration (RC5 — scoped per-persona memory roots)

**Status: manual, opt-in. Nothing in this document is executed automatically.**

Since the RC5 fix (multi-persona bleeding, 2026-07-24), each non-main persona
owns a scoped memory root when `multiPersona.enabled` is true and
`multiPersona.scopedMemory` is not set to `false`:

```
/data/agents/<id>/memory/
├── MEMORY.md      ← persona core memory (injected as <core_memory>)
├── daily/         ← persona session summaries / daily notes
├── users/         ← persona-scoped user profiles
├── wiki/          ← persona wiki pages
└── sources/       ← persona source material
```

Main keeps `/data/memory/` unchanged. The empty structure is bootstrapped
idempotently at startup (`ensurePersonaMemoryRoots()`); **no content is ever
migrated automatically** — moving knowledge between agents is a judgment call
that must be made by a human (or a supervised session), not by startup code.

## What to migrate manually (after deploying the fix)

1. **Persona-relevant sections of `/data/memory/MEMORY.md`**
   Move (don't copy) e.g. Warren's portfolio notes into
   `/data/agents/warren/memory/MEMORY.md`, Bob's WerkstattLog context into
   `/data/agents/bob/memory/MEMORY.md`, etc. Delete the moved sections from
   the shared file so main stops reciting persona knowledge.

2. **Old daily files** (`/data/memory/daily/*.md`)
   These are append-only history; usually it is enough to leave them as-is.
   The 3-day prompt window means persona content in old dailies stops being
   injected into main after 3 days. If a recent daily is heavily
   persona-flavored, cut the persona sections over into the persona's own
   `daily/` file of the same date.

3. **Wiki pages** under `/data/memory/wiki/` that are purely persona-domain
   (e.g. portfolio watchlists) can be moved (`git`-style: `mv`, keep the
   filename) into `/data/agents/<id>/memory/wiki/`.

4. **Relabel of the 828 pre-fix facts** (from the RC1 fix, still pending):

   ```sql
   -- Vorsicht: Task-Sessions waren selbst als 'main' mislabeled (RC3),
   -- daher fängt das nur Fakten aus interaktiven Persona-Sessions korrekt.
   UPDATE memories SET agent_id = COALESCE(
     (SELECT s.agent_id FROM sessions s WHERE s.id = memories.session_id), 'main');
   ```

## Verification after migration

- Send a message to a persona bot and check the assembled system prompt
  (or simply ask "what do you know about <main-only topic>?") — the persona
  must not see main's MEMORY.md content.
- Check that a persona session summary lands in
  `/data/agents/<id>/memory/daily/<date>.md` and NOT in `/data/memory/daily/`.
- After the next nightly consolidation, `tool_calls` contains one
  `memory_consolidation` entry per persona with daily content, with the
  session's `agent_id` set to the persona.

## Rollback

Set `"scopedMemory": false` under `multiPersona` in
`/data/config/settings.json` and restart — all reads/writes fall back to the
shared `/data/memory/` (legacy behavior). The persona memory roots stay on
disk and are simply ignored.
