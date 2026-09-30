# Secrets API

Reference for `/api/secrets/handles` — the metadata API for **sealed secrets**
(see the guide page [Secrets](/guide/secrets)). It manages the handles
(<code v-pre>{{secret:&lt;slug&gt;}}</code>) the agent uses instead of real values.

All endpoints are **admin only** (JWT, `role: "admin"`), like `/api/settings`.
A logged-in non-admin gets `403 {"error":"Admin access required"}`, an anonymous
caller `401`. Bodies are JSON, errors are
`{ "error": "<message>", "code": "<machine code>" }`.

::: danger The value is never returned
There is no endpoint that returns a stored value — not in full, not truncated,
not masked with real characters. The only information about the value is its
`length` and its `kind`. A value also never appears in an error message or a log
line.
:::

## `GET /api/secrets/handles`

Metadata of every sealed secret, newest first.

```json
{
  "handles": [
    {
      "slug": "router-password-1",
      "kind": "password",
      "source": "user-message",
      "createdAt": "2026-09-26T10:12:03.421Z",
      "length": 24
    }
  ],
  "kinds": ["password", "token", "api-key", "github-token", "jwt", "private-key",
            "card-number", "pin", "url-credentials", "secret"]
}
```

| Field | Meaning |
|---|---|
| `slug` | the name in the handle, `[a-z0-9][a-z0-9-]{0,63}` |
| `kind` | classification, one of `kinds` |
| `source` | where it came from, e.g. `user-message`, `settings-ui`, `tool-output` |
| `createdAt` | ISO timestamp of sealing |
| `lastSeenAt` | ISO timestamp of the last time the same value was detected again (omitted if never) |
| `length` | character count of the value |

## `POST /api/secrets/handles`

Seals a value that the caller pasted into the settings form.

```json
{ "value": "<the secret>", "kind": "password", "slug": "router-password" }
```

| Field | Required | Rules |
|---|---|---|
| `value` | yes | non-empty after trimming control characters, at most **8192** characters |
| `kind` | yes | one of the `kinds` whitelist |
| `slug` | no | `[a-z0-9][a-z0-9-]{0,63}`; derived from `kind` when omitted |

Answer `201`:

```json
{ "slug": "router-password", "handle": "{{secret:router-password}}",
  "kind": "password" }
```

The answer is the same shape whether the value was new or already sealed. The
store is value-addressed, so an identical value reuses its existing handle and
the requested `slug` is ignored — but the response deliberately does **not**
report that, because a `deduplicated` flag let a caller test a candidate value
against the store without decrypting anything (a guessing oracle for low-entropy
values). A caller that wants to know whether a slug existed before has to look
at `GET /api/secrets/handles` first.

| Status | Cause |
|---|---|
| `400` | empty value, value shorter than 6 characters (`code: "value_too_short"`), value longer than 8192, unknown `kind`, malformed `slug` |
| `409` | `slug` already taken by a different value (`code: "slug_taken"`) |
| `429` | more than 30 creations per minute per user (`code: "rate_limited"`) |
| `500` | `ENCRYPTION_KEY` missing — nothing is stored (`code: "seal_failed"`) |

## `PATCH /api/secrets/handles/:slug`

Renames a handle.

```json
{ "slug": "router-password-old" }
```

Answer `200`: <code v-pre>{ "slug": "router-password-old", "handle": "{{secret:router-password-old}}" }</code>

A rename does **not** rewrite stored text. The endpoint therefore refuses as
soon as the current handle appears anywhere in `chat_messages`, `tool_calls`,
`captures` or `router_decisions`:

```json
{
  "error": "This handle is referenced in stored messages (1) and cannot be renamed. Create a new secret instead.",
  "code": "handle_in_use",
  "usage": { "chat_messages": 1 }
}
```

| Status | Cause |
|---|---|
| `400` | malformed new slug |
| `404` | unknown slug |
| `409` | new slug taken (`slug_taken`) or current handle in use (`handle_in_use`) |

## `DELETE /api/secrets/handles/:slug`

Removes the handle and its encrypted value.

```json
{ "slug": "router-password", "removed": true, "usage": { "chat_messages": 2 } }
```

`usage` lists the tables that still contain the handle after the deletion — a
hint that older text now carries a handle which no longer resolves. Deleting is
allowed regardless: an unresolvable handle fails a command, it does not leak a
value.

| Status | Cause |
|---|---|
| `404` | unknown slug |

## Sealed secrets elsewhere in the API

The same store shows up read-only in the chat surfaces, so a client can tell the
user that something was sealed:

- `GET /api/threads/:id/messages` and `GET /api/chat/history` — a user message
  carries `sealed: [{ "slug": "…", "kind": "…" }]` when the boundary sealed
  something out of it.
- WebSocket frame `message_ack` — `{ "clientMessageId": "…", "sealed": [...],
  "sealedContent": "…" }` right after a message was accepted, so the bubble can
  swap the typed text for the stored text.
- `GET /api/captures/:id` — same `sealed` array for a captured message.

`sealed` contains slugs and kinds only, like everything else in this API.
