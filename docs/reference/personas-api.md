# Personas API

A persona is a directory `/data/agents/<id>/` with six markdown files, plus a
row in the `personas` table holding what a client needs to *render* it (display
name, colour, badge, `is_default`, `archived`). The files are the behaviour of
the agent; the record is the identity a client can show without parsing
markdown.

Two surfaces:

| Surface | Auth | Purpose |
|---|---|---|
| `GET /api/personas/client` | any logged-in user | the picker list: id, name, badge, colour |
| everything under `/api/personas` | `role: "admin"` | management: create, read, edit, archive, delete |

**The write path is user-only.** There is no agent tool that edits a persona,
and there must never be one: persona files carry tool access, so an agent that
can rewrite them can widen its own permissions (SPEC 13.7). A persona may
*propose* a change in chat; a user applies it.

## Common shapes

### `PersonaFields` — the structured editor (SPEC 13.3)

Parsed out of, and written back into, the markdown files. Every field is
nullable.

| Field | Type | Written to | Notes |
|---|---|---|---|
| `name` | `string \| null` | `IDENTITY.md` `- **Name:**` | max 80 chars |
| `badge` | `string \| null` | `IDENTITY.md` `- **Emoji:**` | max 8 chars, one character or emoji |
| `color` | `string \| null` | `IDENTITY.md` `- **Color:**` | `#rrggbb`, lowercased on write |
| `role` | `string \| null` | `IDENTITY.md` `- **Role:**` | role in one sentence, max 280 |
| `tone` | `string \| null` | `IDENTITY.md` `- **Tone:**` | max 280 |
| `model` | `string \| null` | `IDENTITY.md` `- **Model:**` | empty = global default |
| `subjects` | `string[]` | fenced block in `IDENTITY.md` | max 30 × 80 chars |
| `tools` | `string[]` | fenced block in `TOOLS.md` | max 60 × 80 chars |

Writing rules that matter for a client:

- A scalar replaces **one line** and keeps the label the file already used, so
  the personas that use `- **Creature:**` / `- **Vibe:**` keep those labels and
  only the value changes. Aliases understood on read: `Name|Nickname`,
  `Emoji|Badge`, `Color|Colour|Farbe`, `Role|Creature|Rolle|Wesen`,
  `Tone|Vibe|Ton|Stil`, `Model|Modell`.
- A list owns an HTML-comment fence (`<!-- offtangent:subjects:start -->` …
  `:end`). Everything outside it is preserved byte for byte. An empty list
  removes the block.
- `null` clears a field (the line is dropped). A key that is **absent** from
  the request leaves the field untouched. The difference is load bearing.
- Parse → write is byte identical: sending back the `fields` you just read
  changes nothing on disk.
- `name`, `color` and `badge` are mirrored into the record; `GET` reports the
  record's value with the markdown as fallback.

### `PersonaFiles` — raw mode

`{ identity, soul, user, tools, agents, heartbeat }`, all `string`, each at most
262 144 bytes (256 KB), mapping to `IDENTITY.md`, `SOUL.md`, `USER.md`,
`TOOLS.md`, `AGENTS.md`, `HEARTBEAT.md`.

### Persona id

`^[a-z][a-z0-9-]{0,48}[a-z0-9]$` (2–50 chars), plus `main`. Path separators,
dots and null bytes are rejected explicitly — the id becomes a directory name.
**The id is immutable.** Renaming changes `name`, never `id`: the id appears in
sessions, facts, tasks and file paths.

### Errors

All failures answer `{ "error": "<human readable>", "code": "<stable code>" }`.
Branch on `code`, show `error`. Messages never contain filesystem paths or
stack traces.

| Code | Status | Meaning |
|---|---|---|
| `invalid_id` | 400 | the `:id` segment is not a persona id |
| `invalid_body` | 400 | body or a field failed validation |
| `confirm_required` | 400 | `DELETE` without `confirm=1` |
| `default_required` | 400 | tried to clear `isDefault` without naming a successor |
| `forbidden` | 403 | authenticated but not an admin |
| `persona_is_default` | 403 | tried to delete the default persona |
| `persona_not_found` | 404 | no directory and no record for this id |
| `persona_exists` | 409 | create with an id that is taken |
| `persona_busy` | 409 | a turn or a delegated task of this persona is running |
| `telegram_bound` | 409 | a Telegram bot is bound to this persona |
| `internal_error` | 500 | unexpected failure |

`401` without a valid access token (no body contract).

---

## `GET /api/personas`

Admin. Lists every persona: directories on disk **and** records in the
database, merged.

**200** — an array (not an envelope):

```json
[
  {
    "id": "main",
    "displayName": "main",
    "color": null,
    "badge": null,
    "role": null,
    "isDefault": true,
    "archived": false,
    "hasTelegramBinding": false,
    "fileCount": 0
  },
  {
    "id": "bob",
    "displayName": "Bob",
    "color": null,
    "badge": "🔨",
    "role": "Senior Software Engineer Agent — strukturell, tief, qualitätsorientiert",
    "isDefault": false,
    "archived": false,
    "hasTelegramBinding": false,
    "fileCount": 6
  }
]
```

Sorting: the default persona first, then unarchived before archived, then by
`id`. **Archived personas are included and flagged**, not hidden — the client
needs them to offer "restore".

## `POST /api/personas`

Admin. Creates the directory with the template files, then applies `files` and
`fields` (in that order, so `fields` wins).

```json
{
  "id": "scout",
  "fields": { "name": "Scout", "badge": "🧭", "color": "#4f8ef7", "role": "Finds things out before anybody asks." },
  "files": { "soul": "# SOUL.md\n…" }
}
```

`fields` and `files` are optional. **201** with the same body as
`GET /api/personas/:id`. `409 persona_exists`, `400 invalid_body`.

## `GET /api/personas/:id`

Admin. **200**:

```json
{
  "id": "scout",
  "displayName": "Scout",
  "color": "#4f8ef7",
  "badge": "🧭",
  "isDefault": false,
  "archived": false,
  "hasTelegramBinding": false,
  "fields": {
    "name": "Scout", "badge": "🧭", "color": "#4f8ef7",
    "role": "Finds things out before anybody asks.",
    "tone": "short, no small talk", "model": null,
    "subjects": ["research"], "tools": ["web_search"]
  },
  "files": { "identity": "# IDENTITY.md\n…", "soul": "…", "user": "…", "tools": "…", "agents": "…", "heartbeat": "…" }
}
```

## `PUT /api/personas/:id`

Admin. The single write endpoint. At least one key required; an empty body is
`400 invalid_body`.

```json
{
  "files":  { "soul": "…" },
  "fields": { "name": "Scout", "subjects": ["research"] },
  "archived": false,
  "isDefault": false
}
```

- `files` is applied **first**, `fields` on top — a client that edits both a raw
  file and a field in one save gets the field.
- Send only the files the user actually changed; a full write clobbers
  concurrent edits for no reason.
- `archived: true` → **archive** (SPEC 13.5): hidden from
  `/api/personas/client`, every file and row kept. Refused with
  `409 persona_busy` while a turn or delegated task of that persona runs.
  `archived: false` restores and is never blocked.
- `isDefault: true` moves the flag atomically (the previous default loses it)
  and un-archives this persona. `isDefault: false` is refused with
  `400 default_required` — promote another persona instead.

**200** with the full detail body. `404 persona_not_found`.

## `GET /api/personas/:id/delete-preview`

Admin. What a hard delete would remove. Read only.

```json
{ "personaId": "scout", "strands": 12, "messages": 340, "tasks": 3, "cronjobs": 1, "facts": 88, "captures": 5 }
```

Show this before asking for confirmation.

## `DELETE /api/personas/:id?confirm=1`

Admin. Hard delete: the directory and the record. **`confirm=1` (or
`confirm=true`) is mandatory** — without it, `400 confirm_required`.

Refused with `403 persona_is_default`, `409 persona_busy` (running turn or
running/paused task), `409 telegram_bound`, `404 persona_not_found`.

**Rows keyed by `agent_id` are NOT cascaded.** Strands, messages, facts, tasks
and captures survive and keep the old id — knowledge lives above personas, the
same way facts survive a deleted strand. The preview says what those counts are
so the user can decide; reassigning them to another persona is not implemented
yet.

**200** `{ "message": "Persona \"scout\" deleted" }`

---

## `GET /api/personas/client`

Any authenticated user, **no** admin role. The picker projection.

```json
{
  "personas": [
    { "id": "main",   "displayName": "main",   "emoji": null, "color": null,      "isDefault": true },
    { "id": "bob",    "displayName": "Bob",    "emoji": "🔨", "color": null,      "isDefault": false },
    { "id": "warren", "displayName": "Warren", "emoji": "📈", "color": "#4f46e5", "isDefault": false }
  ]
}
```

| Field | Notes |
|---|---|
| `id` | the `agentId` used everywhere else (`/api/threads`, chat frames) |
| `displayName` | record first, `- **Name:**` from `IDENTITY.md` as fallback, max 80 chars, finally the `id` |
| `emoji` | record `badge` first, `- **Emoji:**` as fallback (max 8 chars), else `null` |
| `color` | record first, `- **Color:** #rrggbb` as fallback (lowercased), else `null` |
| `isDefault` | the persona that catches everything. **Do not hardcode `main`.** |

- The default persona is first, every other persona follows sorted by `id`.
- **Archived personas are omitted** — that is what archiving is for.
- Parsing is defensive: a missing file, a placeholder (`—`, `-`, `n/a`, …) or
  junk yields the fallbacks above, never an error.
- The projection contains nothing operational: no Telegram bindings, no file
  counts, no file contents.

**401** without a valid access token.

::: tip Routing
`/api/personas/client` is mounted **before** the admin router, whose `GET /:id`
route would otherwise swallow the path. As a consequence a persona whose id is
literally `client` is not reachable through the admin detail endpoint — an
acceptable trade-off for a reserved word.
:::

::: warning For client authors
Colour and badge come from the API now. A client that ships a hardcoded palette
keyed by persona id (`main`, `bob`, `warren`, `gekko`) renders every persona a
second user creates as grey and nameless — use `color`, `emoji` and
`displayName`, and fall back to a generated colour from the id only when
`color` is `null`.
:::
