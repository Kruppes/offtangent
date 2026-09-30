# Personas

The Personas page manages the additional agents that run on this instance. Each persona is a directory of Markdown files under `/data/agents/<id>/` plus a row in the `personas` table; this page is the editor for both.

> **Admin only.** Regular users don't see this page.

> **What is a persona?** This page is about *operating* personas. For the concept — which file lands where in the system prompt, what the Tools field does and does not enforce, how `ask_agent` works — see the [Personas concept](../concepts/personas). For the HTTP shapes, see the [Personas API](../reference/personas-api).

If multi-persona mode is off, the page still works but shows an info banner with a link to **Settings → Agent**. Personas you create while the flag is off are stored, but the runtime ignores their files until you enable it.

## List view

A grid of cards, one per persona — three columns on a wide screen, one on mobile. Each card shows:

| Element | Source |
|---|---|
| Avatar | The persona's badge on its colour; falls back to the first letter of the display name. |
| Display name | Record `display_name`, falling back to the `Name` field in `IDENTITY.md`, falling back to the id. |
| Id | Monospace, below the name. Immutable. |
| Role | The `Role` field, truncated to two lines. Shows a placeholder when unset. |
| Badges | `Default`, `Archived`, and `Telegram` when a bot is bound to this persona. |
| Edit | Opens the editor. |

Archived personas are hidden by default. A **Show archived (n)** button at the bottom toggles them in; they render at reduced opacity.

### Header action

- **New Persona** opens the [create dialog](#create-dialog).

### Row menu

The `⋮` menu on each card:

| Item | Effect |
|---|---|
| **Edit** | Opens the editor. |
| **Make default** | Moves the `is_default` flag to this persona. Hidden for the persona that is already default. Promoting an archived persona also un-archives it. |
| **Archive** | Hides the persona from the default list. Not offered for the default persona. |
| **Restore** | Un-archives. Only on archived personas. |
| **Delete forever** | Opens the [delete dialog](#delete-dialog). Not offered for the default persona. |

Every write shows an explicit success or error message above the grid; errors carry a **Retry** button.

## Create dialog

Creates the directory, writes a template set of all six files, and creates the record. The dialog asks for the minimum:

| Field | Notes |
|---|---|
| **Name** | Display name. Optional. |
| **Id** | Required, immutable afterwards. Lowercase letters, digits and hyphens, 2–50 characters, must start with a letter. A taken id is rejected with a message under the input. |
| **Badge** | One character or emoji, max 8 characters. |
| **Colour** | Colour picker. |
| **Role** | One sentence describing what this persona is for. |

The **Create** button stays disabled until an id is entered. Everything else is edited afterwards in the editor.

The shipped file templates are written in German — open the **Advanced** tab after creating and replace them with your own text.

## Editor

Selecting **Edit** replaces the list with a full-page editor. **Back** returns to the list without saving; **Save** writes and stays. There is no auto-save.

The editor has two tabs over the same persona.

### Fields tab

The structured view. Each field maps to one line or one fenced block inside the Markdown files, so editing here does not disturb prose you wrote by hand.

| Field | Written to | Notes |
|---|---|---|
| **Name** | `IDENTITY.md` | Placeholder is the persona id. |
| **Badge** | `IDENTITY.md` | Max 8 characters. |
| **Colour** | `IDENTITY.md` | Colour picker plus a hex input. An invalid hex shows an inline error; the API only accepts `#rrggbb`. |
| **Role** | `IDENTITY.md` | One sentence. This is what the list card shows. |
| **Tone** | `IDENTITY.md` | Free text, with preset chips you can click to fill the input. |
| **Subjects** | `IDENTITY.md` (fenced block) | Chip list — type, add, remove. What this persona owns. |
| **Tools** | `TOOLS.md` (fenced block) | Chip list. **Writes a hint into the prompt; it does not restrict anything.** See the [concept page](../concepts/personas#tools-a-hint-not-a-boundary). |
| **Model** | `IDENTITY.md` | Model preference as free text. The binding pin is the `multiPersona.perAgentProvider` setting. |

### Advanced tab

Raw textareas for all six files — `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `AGENTS.md`, `HEARTBEAT.md` — each with its file name, a one-line hint and a **Copy** button. A warning banner sits above them: this is the unguarded path.

If you edit both tabs before saving, the structured fields win: the update endpoint applies raw files first and the field patch second.

## Delete dialog

Archiving is the normal removal. **Delete forever** is the irreversible one, so it asks twice over.

The dialog first loads a **cascade preview** (`GET /api/personas/:id/delete-preview`) and lists what is keyed to this persona:

| Counted | Table |
|---|---|
| Strands | `sessions` (interactive) |
| Messages | `chat_messages` |
| Tasks | `tasks` |
| Cronjobs | `scheduled_tasks` |
| Facts | `memories` |
| Captures | `captures` |

These rows are **not** deleted — they outlive the persona, the same way a deleted strand's facts do. What the delete removes is the persona directory and the record. The dialog says so.

To confirm, you type the persona id into the input. The delete is refused by the backend when:

- it is the default persona (`403`) — promote another one first,
- a turn or a delegated task of this persona is running (`409`),
- a Telegram bot is bound to it (`409`) — remove the binding first.

## Default persona

Exactly one persona carries the default flag; the database enforces it with a partial unique index. The default persona is the one that answers when no `agent_id` is given, and it cannot be archived or deleted. To retire it, promote another persona with **Make default** first.

## See also

- [Personas concept](../concepts/personas) — files, prompt layering, `ask_agent`, when to create one.
- [Personas API](../reference/personas-api) — endpoints and payloads.
- [Settings → Agent](../settings/agent) — the multi-persona flag.
