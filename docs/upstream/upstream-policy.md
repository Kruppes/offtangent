# External change policy

Decided on 2026-11-16.

## Decision

The source repository `meteyou/axiom` is a reference for potential improvements,
not a source of merge commits. The last full merge was `48102fe6` (v0.27.0).

## Reasons

- A trial merge of `8d8fd175` (after v0.35.0) into this fork produced
  conflicts in 174 files.
- The source project made three breaking rebuilds after v0.27.0 that this fork does not
  follow: the system prompt layout (`12a60d30`), the tool renaming
  (`7fb43d9c`) and the action tool toolkit (`6e0aac06`).
- This fork runs its own context architecture, which external changes would
  have to be rebuilt against piece by piece anyway.

## How external fixes are evaluated

1. Read the source change and check the problem against this fork's code.
   Line numbers and file layout differ; the fork's code decides whether the
   problem exists here.
2. Rebuild the fix in this fork's code. No cherry-pick, no merge of external
   code.
3. Name the source commit SHA in an internal review record so that its behavior can
   be independently checked before implementation. Keep public commit messages
   focused on the resulting change.
4. Each rebuild is tested on its own branch and reviewed before it is deployed.
