# Web strands and projects (W3)

> Build-wave notes for the strands and projects UI. Contributor material, moved here from `docs/`
> because it documents frontend decisions, not user-facing behavior. The REST contracts
> themselves live in `docs/reference/strands-api.md` and `docs/reference/projects-api.md`.

The product owner’s Capture → Strand → optional Project model now uses the
Offtangent strand endpoints rather than the legacy thread inbox.

## Contracts and boundaries

- `StrandList.vue` is shared by `/strands` and `/projects/[id]`. It shows the
  first 100 rows immediately, then loads another server page on scroll or the
  keyboard-accessible Load more button. A short page ends pagination; 30 full
  pages produce an explicit truncation notice. Request generations reject stale
  responses when filters change. Loaded-row counts are explicitly not totals.
- Project, no-project (`project_id=none`), tag, Now and archive filters round-trip
  through the URL. The backend has no free-text strand search parameter, so no
  misleading search field is offered. Pinned/recent grouping is retained.
- Project counts come exclusively from `Project.threadCount` (active strands),
  never from loaded pages. Both active and archived projects are fetched. There
  is no project detail GET route; detail metadata comes from that collection.
  Create and PATCH support name, six-digit metadata color and archive state.
- The strand header loads its ID directly, including deep links beyond the
  first list page. Title, tags, project suggestions and model pins use their
  existing endpoints. Manual project assignment uses the existing thread PATCH
  endpoint; strand PATCH does not accept `projectId`. Suggestions are never
  applied without an explicit action.
- Archive is optimistic, rolls back on errors and offers eight seconds of Undo.
  Backend archiving clears the pin and Now slot. Undo restores visibility, not
  those separate associations. Content is retained. Busy conflicts are localized.
- Delete first loads the server preview, then requires an accessible confirmation
  dialog containing its counts and Now-slot effect. Facts remain unchecked and
  retained by default. Successful deletion has no undo.
- Conversation behavior is unchanged. Legacy conversation hit areas and its
  teleported toolbar received only minimum target dimensions and labels, so the
  required mobile accessibility baseline also holds around the new header.

## Verification

Fresh baseline: 288 frontend tests in 28 files. The W3 suite adds pagination,
cap, URL, rollback, preview/confirmation, explicit suggestion and view-state
coverage. Root lint, frontend tests, typecheck, build and secret scan must all
pass before integration.

Real-backend verification reached **522 / 522** active strands through the UI,
matching both paginated API IDs and read-only SQL. All 25 active-project filters
matched their server counts. Temporary, exclusively test-owned strands and
projects verified archive/undo/delete, project creation/rename/color/archive/
restore, title/project/tag editing, and model pin/reset. They were then deleted.
Existing suggestions were only displayed, not accepted or dismissed against
live data; those actions have component/contract tests. No deployment occurred.

Browser evidence and operational counts live outside the repository. Screenshots
are viewport captures after fully loading the list, not a many-hundred-row tall
image. The cap is unit/render-tested; live data does not reach 3,000 rows. Real
busy-turn rejection and destructive deletion of retained facts were deliberately
not provoked. Offset pagination is not a server snapshot: concurrent changes can
shift pages; refresh reconciles them, and repeated IDs are deduplicated.
