# Auth API

Reference for the authentication endpoints under `/api/auth` and for the token
rules every client (web UI, native app, scripts) has to follow.

All request and response bodies are JSON. Errors use `{ "error": "<message>" }`.

## Tokens

| Token | Lifetime | Claims | Use |
|---|---|---|---|
| Access token | 1 hour | `userId`, `username`, `role`, `type: "access"`, `sid` | `Authorization: Bearer <token>` on every protected endpoint, `?token=` for WebSocket and `/api/uploads` |
| Refresh token | 7 days | `userId`, `username`, `role`, `type: "refresh"`, `jti` | Only for `POST /api/auth/refresh` and `POST /api/auth/logout` |

- Both tokens are HS256 JWTs signed with `JWT_SECRET`.
- Every refresh token has a row in the `refresh_tokens` table (only the sha256
  hash of the token is stored). `sid` in an access token is the id of the
  refresh row that issued it — that is what `GET /api/auth/sessions` uses to
  mark the current session.
- **A refresh token is not an access token.** Protected endpoints, the
  WebSocket handshake and `/api/uploads` reject tokens with `type: "refresh"`.
- Tokens issued before this change have no `type` claim; they are still
  accepted as access tokens so existing browser sessions survive a deploy.

## `POST /api/auth/login`

```json
{ "username": "alice", "password": "…", "deviceName": "Pixel 8" }
```

`deviceName` is optional (trimmed, truncated to 80 characters) and is shown in
the session list.

**200**

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<jwt>",
  "user": { "id": 2, "username": "alice", "role": "user" }
}
```

**400** missing username/password · **401** invalid credentials

## `POST /api/auth/refresh`

```json
{ "refreshToken": "<jwt>" }
```

**200** — same shape as login (`accessToken`, `refreshToken`, `user`).

The refresh token is **rotated**: the presented row is revoked and linked to
its successor, and the response contains a brand new refresh token. Clients
must persist the new refresh token immediately and stop using the old one.

**401** if the token is invalid, expired, revoked (logout / session deleted),
unknown to the store, or an access token.

**Reuse detection:** presenting a refresh token that was already rotated away
returns `401` *and* revokes the entire rotation chain of that session (the
server logs `[auth] refresh token reuse detected`). The user has to log in
again. This is the standard defense against stolen refresh tokens.

**Legacy tokens:** a refresh JWT issued before the store existed (no `jti`) is
accepted exactly once and migrated into the store; the old token is recorded as
revoked, so a second use trips reuse detection.

## `POST /api/auth/logout`

Auth: `Authorization: Bearer <access token>` **or** a valid refresh token in
the body.

```json
{ "refreshToken": "<jwt>" }
```

**204** — the refresh row is revoked. Idempotent: unknown, already revoked or
foreign tokens also return `204` (no information leak).

Two accepted ways to authenticate the call:

| Request | Result |
|---|---|
| Valid access token + `refreshToken` | `204`, that refresh row is revoked |
| Valid access token, no `refreshToken` | `400` |
| No / expired access token + correctly signed `refreshToken` | `204`, that refresh row is revoked |
| No access token, no `refreshToken` | `401` |
| No access token + forged, unsigned or `type: "access"` token in the body | `401` |

The body-token path exists for mobile clients: after a long background phase
the access token is usually expired, and without it the app could never end its
server-side session. The body token still has to verify against `JWT_SECRET`
and must not be an access token, so this is authentication — not an open
revoke endpoint. Only the presented session is revoked, other devices of the
same user stay logged in.

## `GET /api/auth/sessions`

Auth: `Authorization: Bearer <access token>`

**200**

```json
{
  "sessions": [
    {
      "id": 42,
      "deviceName": "Pixel 8",
      "createdAt": "2026-09-13T22:15:04.000Z",
      "lastUsedAt": "2026-09-13T23:02:11.000Z",
      "current": true
    }
  ]
}
```

Only active sessions are listed (not revoked, not expired), newest first.
`deviceName` is `null` when the client did not send one. `current` marks the
session that issued the access token used for this request — rotation is
followed, so an access token from before the last refresh still resolves to the
live session row.

## `DELETE /api/auth/sessions/:id`

Auth: `Authorization: Bearer <access token>`

**204** — the session is revoked; its refresh token stops working immediately
(access tokens already issued stay valid until they expire, at most one hour).
**404** if the session does not exist or belongs to another user.
**400** if `:id` is not an integer.

## `GET /api/auth/me`

Auth: `Authorization: Bearer <access token>` → `{ "user": { "id", "username", "role" } }`.
**401** if the token is invalid/expired, is a refresh token, or the user was deleted.

## Protected uploads

`GET /api/uploads/<path>` requires a valid **access** token, passed either as
`Authorization: Bearer <token>` or as `?token=<token>`. The query variant exists
because `<img src>` and `<a href>` cannot send headers; it means access tokens
show up in URLs (browser history, referrer). The exposure is bounded by the
one-hour access token lifetime. Signed, short-lived per-file URLs would remove
it entirely — tracked as a follow-up.

Path traversal is rejected (`400`/`404`); files outside the uploads directory
are never served.

## Client checklist (native apps)

1. `POST /api/auth/login` with a `deviceName`, store both tokens in
   encrypted/private storage.
2. Send `Authorization: Bearer <access token>` on every API call; append
   `?token=<access token>` for `/api/uploads` and the WebSocket handshake.
3. On `401`, call `POST /api/auth/refresh`, **replace the stored refresh
   token** with the returned one, retry once. Serialize refreshes: two parallel
   refreshes with the same token trip reuse detection and kill the session.
4. On logout, call `POST /api/auth/logout` before dropping local state.
