# Uploads API

`/api/uploads` stores files and serves them back. It knows nothing about chats,
captures or personas: it turns bytes into **upload descriptors**, and the
descriptors are what the rest of the API accepts as already stored attachments.

That split is what lets a client upload once and decide afterwards what the
bytes become — a capture from the home screen, a chat message, or nothing at
all — instead of having to create a chat message just to get a file onto the
server.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/uploads` | `Authorization: Bearer` **only** | Store files, return descriptors |
| `GET /api/uploads/<path>` | Bearer header **or** `?token=` | Serve a stored file |

## `POST /api/uploads`

`multipart/form-data`, repeatable field `files`. No other fields are read.

```
POST /api/uploads
Authorization: Bearer <access token>
Content-Type: multipart/form-data

files=<IMG_2031.jpg>
files=<roof.png>
files=<angebot.pdf>
```

**201**

```json
{
  "uploads": [
    {
      "kind": "image",
      "originalName": "IMG_2031.jpg",
      "storedName": "517e951d2062a02fe297f8c3-IMG_2031.jpg",
      "relativePath": "2026/09/14/517e951d2062a02fe297f8c3-IMG_2031.jpg",
      "urlPath": "/api/uploads/2026/09/14/517e951d2062a02fe297f8c3-IMG_2031.jpg",
      "mimeType": "image/jpeg",
      "size": 2418223
    },
    {
      "kind": "image",
      "originalName": "roof.png",
      "storedName": "1808b7bfe8539e1f81d0d5d7-roof.png",
      "relativePath": "2026/09/14/1808b7bfe8539e1f81d0d5d7-roof.png",
      "urlPath": "/api/uploads/2026/09/14/1808b7bfe8539e1f81d0d5d7-roof.png",
      "mimeType": "image/png",
      "size": 184002,
      "width": 1280,
      "height": 960,
      "previewUrl": "/api/uploads/2026/09/14/1808b7bfe8539e1f81d0d5d7-roof.png?preview=1&w=640&h=480"
    },
    {
      "kind": "file",
      "originalName": "angebot.pdf",
      "storedName": "a6a1c710b25b6e1b4085c977-angebot.pdf",
      "relativePath": "2026/09/14/a6a1c710b25b6e1b4085c977-angebot.pdf",
      "urlPath": "/api/uploads/2026/09/14/a6a1c710b25b6e1b4085c977-angebot.pdf",
      "mimeType": "application/pdf",
      "size": 4096
    }
  ]
}
```

Order matches the order of the `files` parts. `width`, `height` and
`previewUrl` only appear for images the server could measure (PNG and JPEG
headers); every other field is always present.

| Field | Notes |
|---|---|
| `kind` | `image` when the mime type starts with `image/`, else `file` |
| `originalName` | the client name, sanitized (path separators removed, capped at 120 characters + extension) — metadata only, never a filesystem path |
| `storedName` | generated: 12 random bytes + the sanitized name |
| `relativePath` | `YYYY/MM/DD/<storedName>` (UTC), the only load bearing field when the descriptor is handed back in |
| `urlPath` | `/api/uploads/<relativePath>` |
| `size` | bytes on disk, measured by the server |

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `no_files` | no `files` part in the body |
| 400 | `too_many_files` | more parts than `UPLOAD_MAX_FILES`, or a file under a different field name |
| 400 | `malformed_multipart` / `upload_rejected` | the body is not parseable multipart |
| 401 | — | no Bearer header, expired/forged token, or a refresh token |
| 413 | `upload_too_large` | a file above `UPLOAD_MAX_FILE_SIZE_MB` |
| 507 | `insufficient_storage` | storing the request would push free disk below `UPLOAD_MIN_FREE_DISK_MB` |

All limits come from the environment
([Upload limits](../settings/agent#upload-limits)). Refused requests leave no
part files behind, and the 507 is decided from `Content-Length` **before** the
first byte is written.

### Why `?token=` does not work here

`GET /api/uploads/*` accepts an access token in the query string because
`<img src>` and `<a href>` cannot send headers. The write path does not: a
token in a URL ends up in browser history, referrers and proxy logs, which is a
bounded risk for reading a file the holder may read anyway and a bad trade for
a request that consumes disk. `POST /api/uploads` therefore requires the
`Authorization: Bearer` header, and rejects a query-token-only request with
`401` before multer streams anything.

## Using the descriptors

Both attachment consumers take the objects from `uploads` **verbatim**. Only
`relativePath` is trusted; everything else is re-derived server side
(`size` from `stat`, `urlPath`/`previewUrl` from the resolved path, `kind` from
the sanitized mime type), so a client can at worst mislabel a file it already
has access to.

`POST /api/captures` — JSON body, `attachments` is a real array:

```json
{
  "text": "roof photo from the site",
  "kind": "image",
  "attachments": [ { "kind": "image", "originalName": "roof.png", "storedName": "…", "relativePath": "2026/09/14/…-roof.png", "urlPath": "/api/uploads/2026/09/14/…-roof.png", "mimeType": "image/png", "size": 184002 } ]
}
```

`POST /api/chat/message` — multipart, `attachments` is the same array
**JSON encoded into one field**:

```
content=see attachment
attachments=[{"kind":"image","originalName":"roof.png","storedName":"…","relativePath":"2026/09/14/…-roof.png","urlPath":"/api/uploads/2026/09/14/…-roof.png","mimeType":"image/png","size":184002}]
```

The two parsers are not identical — captures requires `storedName`, `urlPath`
and `relativePath` to be strings, chat requires the file behind `relativePath`
to exist — but a full descriptor as returned above satisfies both, which is why
the endpoint always returns the complete object instead of a bare path.

A descriptor that cannot be resolved answers `400`, it is never silently
dropped.

## `GET /api/uploads/<path>`

Unchanged: see [Auth API → Protected uploads](./auth-api#protected-uploads) for
the token rules and [Chat](../web-ui/chat) for the content-type policy
(anything not on the inline allow list is served as
`application/octet-stream`).

## Lifecycle

A stored file that never ends up on a capture or a message is referenced by
nothing. The retention sweep walks messages, not the upload tree, so such an
orphan is not collected — the same known gap that `keepAudio=1` has
([Voice API → Retention](./voice-api#retention)). Clients should upload at the
moment the user submits, not speculatively.
