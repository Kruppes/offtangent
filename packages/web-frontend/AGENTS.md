# Web Frontend — Agent Guidelines

## Skills

- **Design decisions** (UI/UX, styling, component look & feel): Load the `nura-design` skill.
- **Architecture decisions** (module structure, refactoring, testability): Load the `improve-codebase-architecture` skill.

## Component Extraction Rules

- **Pages are orchestrators, not containers.** Pages wire up composables and render components — they should not contain inline dialogs, forms, or complex table markup.
- **Extract any dialog/modal that will be reused** (e.g. confirmation dialogs, form dialogs) into its own component under `components/`.
- **Reusable generic components** (like `ConfirmDialog`) go into `components/`. Domain-specific components (like `UserFormDialog`) also go into `components/` but are prefixed with the domain name.

## ConfirmDialog Pattern

Use `<ConfirmDialog>` for any destructive or confirming action. It accepts:
- `open`, `title`, `description`, `confirmLabel`, `cancelLabel`, `destructive`, `loading`
- Events: `@confirm`, `@cancel`

Do **not** inline delete-confirmation dialogs in pages. Always use `<ConfirmDialog>`.

## Table UX Patterns

- **Clickable rows**: Table rows for list/CRUD pages should be clickable (opens edit). Add `class="cursor-pointer"` and `@click="openEdit(entry)"` to `<TableRow>`.
- **No "Actions" column header**: When using a row-action dropdown, the column header should be an empty `<TableHead class="w-12" />` — the hamburger icon is self-explanatory.
- **Dropdown actions**: Use `<DropdownMenu>` with `<DropdownMenuTrigger>` containing a ghost icon button (`moreVertical` icon) instead of inline action buttons. Place edit, delete, and other actions inside `<DropdownMenuItem>`.
- **Stop propagation on dropdown cell**: Add `@click.stop` on the `<TableCell>` containing the dropdown to prevent the row click from firing.
- **Destructive items**: Use the `destructive` prop on `<DropdownMenuItem>` for delete actions. Disable delete for the current user (`entry.id === currentUserId`).

## Form Dialog Pattern

Extract create/edit dialogs into dedicated `*FormDialog.vue` components. They should:
- Accept `open`, `mode` (`'create' | 'edit'`), the entity (optional, for edit), and `loading` as props.
- Emit `@close` and `@submit` with the form payload.
- Sync internal form state via `watch` on `open`/entity props.
- Keep validation and API calls in the **parent page**, not in the dialog.

## Icon Usage

All icons go through `<AppIcon name="..." />`. When a new Lucide icon is needed, add it to the `iconMap` in `components/AppIcon.vue`. Never import Lucide icons directly in pages or feature components.

## i18n

- Every user-visible string must use `$t()` or `t()` from `useI18n()`.
- Both `en.json` and `de.json` must be updated together.
- Use `common.*` keys for shared labels (save, cancel, confirm, etc.).

## Alert Banners

Use `<Alert>` with `variant="destructive"` or `variant="success"` for page-level feedback. Include a dismiss button with `<AppIcon name="close" />`. Auto-hide success messages after 3 seconds via `setTimeout`.
