# Push API

Reference for `/api/push/devices` and the FCM sender behind it (Offtangent
PROTOCOL chapter 7, slices 1 and 2). The companion app registers its FCM
token here; the backend rings that device when something proactive happens.

All endpoints are JWT protected (`Authorization: Bearer <access token>`).
Errors are `{ "error": "<message>", "code": "<machine code>" }`.

## The payload rule

A doorbell never carries message content. The `data` map holds routing
information and short labels only, and the app fetches the actual line through
the tunnel afterwards. Google sees that something happened, not what.

That is the default and the ADR's position. `PUSH_PREVIEW_CHARS` lets an
operator trade it away deliberately: with a positive value a finished turn
carries the strand title and a shortened excerpt of the answer. Nothing else
ever does, not even a failed turn or a task result.

## `POST /api/push/devices`

```json
{ "token": "<FCM registration token>", "platform": "android", "appVersion": "0.7.3" }
```

`platform` is one of `android`, `ios`, `web` (default `android`), `appVersion`
is free text up to 64 characters. Upsert on the token: registering the same
token twice updates the row instead of creating a second one, clears the
failure counter and revives a device that had been disabled.

A token addresses exactly one device, so it belongs to exactly one user. If a
token that is already registered arrives under a different account, the row is
re-pointed to the new user and the previous owner stops receiving doorbells
for it. That is a device change, not a conflict.

**200** `{ "device": Device }` · **400** `token_required`, `token_too_long`,
`invalid_platform`, `invalid_app_version` · **401** without a token.

## `DELETE /api/push/devices/:token`

Removes the row. Only the owner can delete; the token has to be URL encoded.
Called on logout.

**204** on success · **404** `device_not_found` when the token is unknown or
belongs to another user.

## `GET /api/push/devices`

**200** `{ "devices": Device[] }`, newest contact first, own devices only.

## `Device`

```json
{
  "id": "0f3c...",
  "platform": "android",
  "appVersion": "0.7.3",
  "createdAt": "2026-09-13T21:00:00.000Z",
  "lastSeenAt": "2026-09-13T21:00:00.000Z",
  "lastSuccessAt": "2026-09-13T21:04:12.000Z",
  "failureCount": 0,
  "disabled": false
}
```

The registration token itself is never echoed back: the client already knows
its own address and nothing good comes from sending it over the wire again.

## What the backend sends

FCM HTTP v1, `POST https://fcm.googleapis.com/v1/projects/<project>/messages:send`,
authenticated with an OAuth2 access token minted from the service account
(JWT bearer grant, RS256, cached for its lifetime minus a minute).

```json
{
  "message": {
    "token": "<device token>",
    "android": { "priority": "NORMAL", "ttl": "600s", "collapse_key": "<strandId>" },
    "data": {
      "kind": "turn_done",
      "strandId": "<strand id>",
      "sessionId": "<strand id>",
      "agentId": "bob",
      "persona": "bob",
      "title": "bob",
      "body": "There is a new answer",
      "messageId": "4711",
      "sentAt": "2026-09-13T21:04:12.000Z"
    }
  }
}
```

* **Data only, no `notification` block.** With a `notification` block Android
  renders the message itself and `onMessageReceived` does not run in the
  background, which is where the app needs it.
* `persona` repeats `agentId` so the slice 0 app (0.5.0 to 0.7.2) keeps
  working; new clients read `agentId`. `sessionId` repeats `strandId` for the
  same reason: a strand is a session row and clients address it under both
  names. `strandId` plus `messageId` is everything a deep link
  (`offtangent://chat/<strandId>`) needs.
* There is no text excerpt in the payload by default, deliberately. The app
  renders the labels immediately and then fetches the strand head through the
  tunnel, so an excerpt adds nothing on screen while handing message content
  to Google. Set `PUSH_PREVIEW_CHARS` to a positive number and a `turn_done`
  gains `"preview": "<shortened answer>"` while `title` becomes the strand's
  own title:

  ```json
  { "kind": "turn_done", "strandId": "<strand id>", "sessionId": "<strand id>",
    "agentId": "bob", "persona": "bob", "title": "Roof quotes",
    "body": "There is a new answer", "preview": "Emig is 25 520 EUR and the\u2026",
    "messageId": "4711", "sentAt": "2026-09-13T21:04:12.000Z" }
  ```

  The excerpt is whitespace collapsed, cut on a word boundary with an
  ellipsis, and capped at 300 characters whatever the variable says. The
  companion app up to 0.8.0 parses `kind`, `persona`/`agentId`, `strandId`,
  `title`, `body`, `messageId` and `sentAt` and ignores anything else, so
  `preview` is for clients that come later; the shipped app shows the fetched
  strand head instead.
* `title` and `body` are labels derived from the event, never message text. A
  task name is not included either.
* `messageId` is the newest assistant row of the strand, a cursor for the
  app's fetch.

| `kind` | When | Android priority |
|---|---|---|
| `turn_done` | a turn finished for the strand | normal |
| `task_done` | a background task completed | normal |
| `question` | a background task is waiting for an answer | high |
| `error` | a turn died, or a background task failed | high |

## Triggers and what stays silent

A doorbell is sent when a turn ends, when a background task completes, fails
or asks a question. Heartbeats, consolidation runs and loop detection never
ring: the guard is the session's `type`, only `interactive` sessions qualify.

**An open WebSocket is not a reason to stay silent, by default.** The backend
sends and the app decides: a socket that is open is not a socket that is
watched, a second device may be the one in front of the user, and the app
already posts nothing while that strand is open and resumed on screen.

An instance that wants the backend side gate as well sets
`PUSH_SUPPRESS_WHEN_CLIENT_ONLINE`:

| Value | Effect while that user has a live `/ws/chat` connection |
|---|---|
| `off` (default) | nothing is suppressed |
| `turn` | `turn_done` is dropped, `task_done`, `question` and `error` still ring |
| `all` | every doorbell is dropped |

Presence is evaluated per user and before the coalescing window is stamped, so
a suppressed doorbell never silences the next one. An unrecognised value falls
back to `off`, and a presence lookup that throws sends rather than swallows.
The trade-off is asymmetric on purpose: a doorbell that never arrives is
invisible, a redundant one is merely noisy.

**Coalescing, not queueing.** At most one doorbell per strand per 10 seconds.
A doorbell suppressed by the window is dropped, not deferred: it would arrive
stale and the app re-fetches the strand head anyway.

## Failure handling

| FCM answer | What happens |
|---|---|
| `UNREGISTERED`, `INVALID_ARGUMENT`, `NOT_FOUND` | `disabled_at` is set, the device drops out of the active set, no retry |
| `UNAVAILABLE`, `INTERNAL`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, 5xx, 429, transport error | exactly one retry after 500 ms, then the failure counter is raised |
| 200 | `last_success_at` is set and the failure counter is cleared |

A disabled row is kept rather than deleted, so the next registration of the
same token can revive it and the failure history stays readable.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `FCM_SERVICE_ACCOUNT_FILE` | `/data/secrets/firebase/service-account.json` | Firebase service account JSON with `project_id`, `client_email` and `private_key`. Mount it from outside the image; it must never be in the repository. |
| `PUSH_SUPPRESS_WHEN_CLIENT_ONLINE` | `off` | `off`, `turn` or `all`, see the table above. |
| `PUSH_PREVIEW_CHARS` | `0` | Characters of the answer a `turn_done` may carry. `0` means none, which is the payload rule. Capped at 300. |

Both are enumerated in `docker-compose.yml`. That file lists every variable
the container gets explicitly, so a variable that is not in the list does not
reach the process no matter what the host exports.

The service account path is resolved **inside** the container. Two ways to get
the file there:

```bash
# a) drop it on the data volume, which is where the default path points
docker cp service-account.json <container>:/data/secrets/firebase/service-account.json

# b) bind mount it read only and point the variable at the mount
#    (docker-compose.override.yml, which is gitignored)
#   services:
#     axiom:
#       volumes:
#         - /srv/secrets/firebase/service-account.json:/run/secrets/fcm.json:ro
#       environment:
#         - FCM_SERVICE_ACCOUNT_FILE=/run/secrets/fcm.json
```

Without a readable service account the sender logs one line at startup
(`[push] No FCM service account found, push notifications are off`), warns
once on the first doorbell and then stays quiet. Every doorbell is a no-op,
nothing else changes, so an instance without Firebase behaves exactly as it
did before this feature.

## Verifying the migration on a real database

```bash
npm run build
node scripts/push/check-live-migration.mjs /path/to/a/COPY/of/axiom.db
```

It runs the migration twice on the copy and prints the row counts before and
after, the resulting `push_devices` shape, `PRAGMA integrity_check` and the
file size. Measured against a copy of the owner's live database (1.35 GB,
85 572 chat messages, 6 096 sessions): 64 ms, integrity `ok`, no row moved,
file size unchanged, second run a no-op. Never point it at a live file, it
opens the database read write.

## Sending one by hand

```bash
npm run build
node scripts/push/send-doorbell.mjs --token-file /path/to/token.env --kind question --persona bob
```

The script imports the same sender the backend uses, so what goes out is what
the backend would send. It prints the HTTP status and the FCM message name.
