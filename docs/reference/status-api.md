# Status API and device tokens

One general, device-independent status source for every screen that polls
Offtangent: the Pi dashboard first, any later screen or knob after it. Devices
**pull** (`GET /api/status`, typically every 10 s with `If-None-Match`); the
backend never pushes to them.

The LED clock keeps its own endpoints under `/api/device/clock/*`, byte for
byte as before, but runs on the same token registry, LAN gate and answer path.

Source: `packages/web-backend/src/api/modules/devices/` (`registry.ts`,
`gate.ts`, `status.ts`, `answer.ts`, `note.ts`, `route.ts`).

## Device tokens

A device token is not a user login. It carries a small set of scopes and
nothing else: no chat, no feed, no memory, no message bodies.

| Scope | Allows |
|---|---|
| `status:read` | `GET /api/status` (and the clock's `GET /api/device/clock/state`) |
| `interactions:answer` | `POST /api/status/answer` (and the clock's `POST /api/device/clock/answer`) |

- Only the SHA-256 of a token is stored (`clock_devices.token_hash`, historical
  table name). The plaintext is returned once, at creation.
- Prefix `otd_` for general devices, `otc_` for clocks. Both are verified the
  same way; the prefix only makes a leaked token recognisable.
- Kinds: `clock`, `dashboard`, `generic`. Only `clock` changes behaviour (the
  clock endpoints and the clock wake call accept only clocks).
- Revoking sets `revoked_at`; the next request with that token is a `401`.
- Deleting a user deletes its device rows (trigger), so no token outlives its
  account.
- Unknown scope names in the database are dropped (fail closed).

### Migration of clock tokens

Clocks provisioned before this generalisation keep working without a new
token. The migration is additive: `clock_devices` gets a column
`kind TEXT NOT NULL DEFAULT 'clock'`, so every existing row is a clock. Stored
scope strings are not rewritten; the legacy names are read as aliases:

| Stored (first clock build) | Read as |
|---|---|
| `clock:state` | `status:read` |
| `clock:answer` | `interactions:answer` |

New clocks created through `/api/device/clock/devices` are still stored with
the legacy names, so a rollback to the previous build reads them unchanged.
A clock token may also poll `/api/status`.

### Owner routes (user JWT)

```
GET    /api/devices                                    -> { devices: DeviceView[] }   every kind, clocks included
POST   /api/devices { name?, kind?, scopes?, privacy? } -> 201 { device, token }       token shown ONCE
PATCH  /api/devices/:id { privacy?, scopes? }           -> { device }
DELETE /api/devices/:id                                 -> { revoked: true }
```

Defaults: `kind` = `dashboard`; scopes `status:read interactions:answer` for
`dashboard`/`clock`, `status:read` for `generic`; `privacy` = false. `name`
1 to 40 characters (default `Dashboard`). Errors: `400 invalid_kind |
invalid_name | invalid_scopes | invalid_privacy | invalid_body`,
`404 unknown_device` (also for another user's device), `401` for a device
token or no login.

```json
{
  "device": {
    "id": "dev_3f9a0c1b2d4e", "kind": "dashboard", "name": "Offtangent-PI",
    "scopes": ["status:read", "interactions:answer"], "privacy": false,
    "createdAt": "2026-10-25 08:00:00", "lastSeenAt": null, "revokedAt": null
  },
  "token": "otd_…"
}
```

The clock's owner routes (`/api/device/clock/devices`) stay unchanged and list
only clocks.

## LAN gate

Device-token requests are accepted only when

1. the socket peer lies in `DEVICE_ALLOWED_CIDRS` (alias: the old
   `CLOCK_ALLOWED_CIDRS`; the new name wins when both are set; default
   `10.0.0.0/8,192.168.0.0/16,fc00::/7,fe80::/10`, no loopback, no Docker
   range; the default applies only when neither variable is set: a set but
   empty or entirely invalid value refuses every device, fail closed), and
2. the request carries none of the proxy/tunnel headers (`x-forwarded-*`,
   `forwarded`, `via`, `cf-*`, `x-real-ip`, `true-client-ip`).

Otherwise `403 not_lan`. A user JWT on `GET /api/status` skips the gate: it is
the app's own credential and already valid on every other route behind the
tunnel.

## `GET /api/status`

`Authorization: Bearer <device token with status:read>` (LAN only) or
`Bearer <user JWT>`.

- `200` with the payload below, headers `ETag: "<rev>"`, `Cache-Control: no-store`
- `304` without a body when `If-None-Match` carries the current `rev`
  (quoted, `W/`-prefixed or bare)
- `401 unauthorized` (no/unknown/revoked token, invalid JWT),
  `403 not_lan`, `403 forbidden_scope`

`rev` is a hash over everything except `generated_at`; it changes exactly when
something visible changes.

```json
{
  "v": 2,
  "rev": "9c41d7a03be2f815",
  "generated_at": "2026-10-25T08:00:10.123Z",
  "privacy": false,
  "note": "Deploy läuft, bitte nichts mergen",
  "note_expires_at": "2026-10-25T18:00:00.000Z",
  "waiting": [
    {
      "strand_id": "6d1f…", "title": "Bericht Wochenende", "persona": "main",
      "kind": "interaction", "since": "2026-10-25T07:58:00.000Z",
      "question_id": "m4711:b1"
    },
    {
      "strand_id": "a02c…", "title": "Server aufräumen", "persona": "builder",
      "kind": "interaction", "since": "2026-10-25T07:40:00.000Z",
      "question_id": null
    }
  ],
  "questions": [
    {
      "id": "m4711:b1", "message_id": 4711, "block_id": "b1",
      "strand_id": "6d1f…", "persona": "main", "kind": "choice",
      "text": "Welche Variante soll ich für den Bericht nehmen?",
      "options": [{ "id": "kurz", "label": "Kurzfassung" }, { "id": "lang", "label": "Lange Fassung" }],
      "since": "2026-10-25T07:58:00.000Z", "expires_at": null
    }
  ],
  "running": [
    { "id": "1a2b3c4d", "name": "Dashboard bauen", "persona": "builder", "started_at": "2026-10-25T07:30:00.000Z" }
  ],
  "unread": 1,
  "unread_all": 4,
  "strands_total": 37
}
```

| Field | Meaning |
|---|---|
| `waiting` | Strands that wait on the user, oldest first, max 12 (same source as the attention badge of the app strand list). `kind`: `interaction` (a card) or `task_question` (a paused task asks). `question_id` points into `questions` when the device may answer, else `null` (answer on the phone). |
| `questions` | Open cards a device may answer, max 6: `choice` and `confirm` only, never `multi`, never `destructive`, never a card with a `danger` option. A default confirm (`yes`/`no`) is `kind: "confirm"` with labels `Ja`/`Nein`. |
| `running` | Running tasks of this user, newest first, max 10. |
| `unread` / `unread_all` | Unread strands with activity in the last 7 days / overall. |
| `note` | One line from Main, see below; `""` when none. |

Texts are single lines, Markdown emphasis removed, cut with `…`: titles and
task names 60, questions 160, labels 40 characters. Never prompts, summaries,
results or message bodies.

**Privacy mode** (per device, `PATCH /api/devices/:id { "privacy": true }`):
every text (`title`, `name`, `text`, `label`, `note`) is empty, block and
option ids are opaque positions (`~1`, `~2`, …) that `/answer` maps back.
`Ja`/`Nein` labels of a default confirm stay. A user JWT always gets
`privacy: false`.

## `POST /api/status/answer`

`Authorization: Bearer <device token with interactions:answer>` (LAN only; a
user JWT is refused, the app answers through `/api/interactions`).

```json
{ "message_id": 4711, "block_id": "b1", "value": "kurz", "client_id": "dash-1729843210-7" }
```

Goes through the same `InteractionsService` as a tap in the app or on
Telegram: it records the answer on the message and starts the follow-up turn.
`client_id` makes retries idempotent.

| Status | Body |
|---|---|
| `200` | `{ "applied": true, "idempotent": false }` (`idempotent: true` on a retry with the same `client_id`) |
| `400` | `invalid_body`, `invalid_value` (not an option of this card) |
| `401` | `unauthorized` |
| `403` | `not_lan`, `forbidden_scope`, `not_allowed` (destructive, danger or multi card: answer on the phone) |
| `404` | `unknown_message`, `unknown_block` (also another user's message) |
| `409` | `already_answered`, `closed`, `idempotency_conflict` (no label echo) |
| `410` | `stale` (card expired or strand gone) |
| `502` | `turn_failed` (answer saved, follow-up turn did not start) |

## Note from Main

`note` comes from a file the agent can write with its normal file access, no
credential needed:

```
${DATA_DIR}/status/note-<userId>.json        (directory override: STATUS_NOTE_DIR)
{ "text": "Deploy läuft, bitte nichts mergen", "expires_at": "2026-10-25T18:00:00Z" }
```

One file per user: user `<userId>` (and every device token of that user)
sees only `note-<userId>.json`, never the note of another user. A former
shared `note.json` is not read at all, not even as a fallback; rename it to
`note-<userId>.json` of the intended user.

`expires_at` is optional. Deleting the file, an empty text or a past
`expires_at` clears the note. Unreadable JSON is ignored (warning once per
file content), never a failed status. A file larger than 8 KB is not parsed
(no note, one warning). Each poll reads at most 8 KB and compares a SHA-256
of the content, so an edit with the same mtime and size is still picked up
(and changes `rev`).
