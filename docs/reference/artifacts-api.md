# Artifacts API (canvas)

Reference for `/api/artifacts` and the server side artifact extraction behind
it (Offtangent SPEC 7.4b, "Canvas (R2)"). A persona hands over an interactive
artifact — an HTML page, a small tool, a diagram, a preview — and the backend
turns it into a durable resource that any renderer can open.

The backend is the single source of truth here on purpose. Extraction,
persistence, the wire format and the security headers live on the server, so
the Android app (WebView) and the web app (sandboxed `<iframe>`) are two
renderers of the same resource instead of two independent implementations with
two different security models.

List and metadata endpoints are JWT protected (`Authorization: Bearer <access
token>`). The content endpoint is not — see [Reading the
bytes](#reading-the-bytes). Errors are `{ "error": "<message>", "code":
"<machine code>" }`.

## How an artifact comes into existence

Nobody uploads an artifact. It is extracted from the assistant message when
that message is persisted, in `TurnRunner` — the one place every channel (web,
app, Telegram) writes its assistant row.

Two sources, in the order of preference the SPEC gives:

1. an upload the message references (`/api/uploads/…`, `.html`, `.htm`,
   `.svg`, `.png`), either as an attachment descriptor in the message metadata
   or as a plain link in the text,
2. a fenced ` ```html ` or ` ```svg ` block in the message text.

The fence is **never removed** from the message. Telegram and the plain web
view keep rendering the raw block, and a message that lost its only content
would read as empty there. The artifact is an additional representation, not a
replacement.

Rules the extractor follows:

- CommonMark fence semantics. A ` ```` ` wrapper that demonstrates a ` ```html `
  block yields the wrapper, not a nested artifact.
- An unterminated fence yields nothing. Guessing where a truncated block ends
  is how half an HTML page ships as an artifact.
- An optional title comes after the language (` ```html Zins-Rechner `), the
  same convention as the ` ```snippet ` fence from SPEC 7.4b. Without one the
  `<title>`, then the first `<h1>`, then the kind is used.
- At most **4** artifacts per message, at most **2 MiB** per artifact. An
  oversized block is skipped and logged; the message text is unaffected.
- Extraction is idempotent per `(message, content hash)`: running it twice
  never doubles an artifact.

## Persistence model

Metadata lives in the `artifacts` table, bytes live under
`DATA_DIR/artifacts/<yyyy>/<mm>/<dd>/<id>.<ext>`.

| column | meaning |
| --- | --- |
| `id` | UUID, the public artifact id |
| `user_id` | owner (`chat_messages.user_id`), the only ownership check |
| `strand_id` | `sessions.id` the artifact belongs to |
| `message_id` | `chat_messages.id` that produced it |
| `agent_id` | persona that wrote it |
| `kind` | `html`, `svg`, `image` |
| `title` | display title, at most 120 characters |
| `source` | `inline_fence` or `upload` |
| `mime_type`, `size` | for delivery and for the client's size budget |
| `content_path`, `content_hash` | relative byte path, sha256 |
| `created_at` | UTC |

An artifact sourced from an upload **copies** the bytes into the artifact
store. `cleanupExpiredUploads()` deletes upload files after the retention
window (30 days by default); an artifact that lived there would vanish from
the strand, which is the opposite of "the canvas reopens from the strand
later".

## `GET /api/artifacts`

Query: `strandId` (optional), `limit` (1–200, default 100), `offset`.

**200** `{ "artifacts": ArtifactRef[] }`, oldest first, own artifacts only ·
**400** `invalid_strand_id`, `invalid_limit`, `invalid_offset` · **401**
without a token.

## `GET /api/artifacts/:id`

**200**

```json
{
  "artifact": { "...": "ArtifactRef" },
  "contentUrl": "/api/artifacts/8f2c…/content?t=v1.8f2c….1.1789…",
  "contentExpiresAt": "2026-09-14T09:10:00.000Z",
  "embed": {
    "iframeSandbox": "allow-scripts",
    "iframeReferrerPolicy": "no-referrer",
    "separateOrigin": false,
    "denies": ["same-origin", "cookies", "localStorage", "network", "top-navigation"]
  }
}
```

**404** `artifact_not_found` — also when the artifact belongs to another user.
A foreign id must not be distinguishable from a missing one.

`contentUrl` is minted per call and valid for 10 minutes. A client asks for it
right before it opens the canvas, not when it renders the message list.

`embed` is the sandbox contract the backend hands its renderers, so the two
clients cannot drift apart.

## `ArtifactRef`

```json
{
  "id": "8f2c1f4e-…",
  "strandId": "6b1e…",
  "messageId": 4211,
  "agentId": "bob",
  "kind": "html",
  "title": "Dachvergleich",
  "source": "inline_fence",
  "mimeType": "text/html",
  "size": 8134,
  "createdAt": "2026-09-14T08:59:12.000Z"
}
```

The owner is never echoed back.

## Artifacts in the chat history

`GET /api/chat/history` adds `artifacts: ArtifactRef[]` to every message
(empty when it has none), so no client has to parse markdown to find out
whether a message opens a canvas. Same projection as `/api/artifacts`.

## Reading the bytes

`GET /api/artifacts/:id/content?t=<capability token>`

This route serves the only bytes in the system that are written by a language
model and executed by a browser. It therefore authenticates differently from
every other route:

- **`?t=` capability token** (the normal path). An opaque HMAC over (artifact
  id, owner, expiry), minted by `GET /api/artifacts/:id`, valid 10 minutes,
  good for exactly one artifact. This is what an `<iframe>` or a WebView uses,
  because neither can send an `Authorization` header.
- **`Authorization: Bearer`** for programmatic clients and for an app that
  fetches the bytes itself.

`?token=<access token>` — the pattern `/api/uploads` uses for `<img src>` — is
**rejected** here. A rendered document can read its own URL (`location.href`),
so an access token in the URL would hand the account to LLM written code. The
worst an artifact can do with its own capability token is read itself.

**200** raw bytes · **401** `artifact_unauthorized` (no or invalid credential,
token for a different artifact, expired token) · **404** `artifact_not_found`
· **410** `artifact_content_gone` when the row exists but the file does not.

### Response headers

```
Content-Type:                text/html; charset=utf-8   (html)
                             image/svg+xml | image/png  (svg | image)
Content-Security-Policy:     default-src 'none'; script-src 'unsafe-inline';
                             style-src 'unsafe-inline'; img-src data: blob:;
                             font-src data:; media-src data:; connect-src 'none';
                             form-action 'none'; base-uri 'none'; object-src 'none';
                             frame-src 'none'; worker-src 'none';
                             frame-ancestors 'self'; sandbox allow-scripts
X-Content-Type-Options:      nosniff
X-Frame-Options:             SAMEORIGIN   (only while frame-ancestors is the default 'self')
Referrer-Policy:             no-referrer
Permissions-Policy:          accelerometer=(), camera=(), geolocation=(), gyroscope=(),
                             microphone=(), payment=(), usb=()
Cache-Control:               private, no-store, max-age=0
Cross-Origin-Resource-Policy: cross-origin
Content-Disposition:         inline; filename="<title>.html"
```

`sandbox allow-scripts` in the CSP is the load bearing part: it puts the
document into an **opaque origin even when the embedder forgets the `sandbox`
attribute**, so the guarantee does not depend on a client getting its markup
right. `allow-same-origin` is never sent — combined with `allow-scripts` it
would undo the whole sandbox.

`default-src 'none'` plus `connect-src 'none'` plus `form-action 'none'`
closes every path back to `/api/*`: no fetch, no XHR, no WebSocket, no form
post, no subresource, not even an image. An artifact is fully self contained
or it is broken.

An `svg` or `image` artifact is data, not a program: it gets `script-src
'none'` and a bare `sandbox` with no allowances at all.

## What the two renderers must do

The backend enforces the sandbox, but both clients still have to hold up their
end. These are the minimum requirements; anything weaker is a bug.

### Web app — `<iframe>`

```html
<iframe
  src="<contentUrl>"
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  loading="lazy"
  csp="sandbox allow-scripts"
></iframe>
```

- `sandbox` **must not** contain `allow-same-origin`. With `allow-scripts`
  together it would give the artifact a real origin and, on a same-origin
  deployment, access to the app's `localStorage` and its JWT.
- Do not add `allow-top-navigation`, `allow-modals`, `allow-popups` or
  `allow-downloads`. Links inside the artifact open nowhere; the canvas header
  offers "Open in browser" for that.
- Never inject the artifact through `srcdoc` or `innerHTML`. Both run the
  markup in the app's own origin and bypass every header above.
- Take `contentUrl` from `GET /api/artifacts/:id` immediately before mounting
  the frame; it expires after 10 minutes.

### Android app — `WebView`

Load the URL, do not hand the WebView the app's cookie jar:

```kotlin
val web = WebView(context)
web.settings.javaScriptEnabled = true          // artifacts are allowed to be interactive
web.settings.domStorageEnabled = false
web.settings.databaseEnabled = false
web.settings.allowFileAccess = false
web.settings.allowContentAccess = false
web.settings.allowFileAccessFromFileURLs = false
web.settings.allowUniversalAccessFromFileURLs = false
web.settings.javaScriptCanOpenWindowsAutomatically = false
web.settings.setGeolocationEnabled(false)
web.settings.mediaPlaybackRequiresUserGesture = true
web.settings.setSupportMultipleWindows(false)
CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
// No bridge into the app. Ever.
// web.addJavascriptInterface(...)  ← forbidden in R2 (SPEC: no two way channel)
```

- Use a **dedicated WebView instance** for the canvas, never the one that
  renders app UI, and do not seed it with the access token in any form: no
  `Authorization` header on the initial load, no token in the URL. Load the
  `contentUrl` with its capability token.
- Override `shouldOverrideUrlLoading` to return `true` for every navigation
  that is not the artifact URL itself, and hand the URL to the external
  browser. Navigation to other origins inside the canvas is blocked.
- If the app prefers to fetch the bytes itself (`Authorization: Bearer`), it
  must render them with `loadDataWithBaseURL(null, html, "text/html",
  "utf-8", null)`. A `null` base URL is what keeps the document in an opaque
  origin; passing the app origin here would recreate exactly the hole the CSP
  closes.
- `addJavascriptInterface` is out of scope for R2. The canvas is not a two way
  channel; a `postMessage` bridge with an allow list is a separate decision
  (SPEC 7.4b).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARTIFACT_FRAME_ANCESTORS` | `'self'` | CSP `frame-ancestors` of the content route. Set to the web app origin(s) when the web app runs on a different origin than the API. |
| `ARTIFACT_ORIGIN` | unset | Absolute origin prefixed onto `contentUrl`. Set when artifacts are served from a dedicated host, which adds a real cross origin boundary on top of the opaque origin the CSP already enforces. |
| `ARTIFACT_TOKEN_SECRET` | `JWT_SECRET` | Signing key of the capability token. Domain separated from the JWT key, so an artifact token never verifies as an access token. |

### Serving artifacts from a separate origin

The sandbox guarantee does **not** depend on this: the CSP `sandbox` directive
already forces an opaque origin, so an artifact has no access to the app origin
even when both are served by the same host and port. A separate origin is
defense in depth — a second, independent boundary that also holds if a browser
ever mishandles the CSP directive.

It is a deployment change plus two environment variables; no code change and no
second Node process. The artifact host is a plain reverse-proxy vhost in front
of the *same* backend, with only the content path exposed:

```caddy
# The app itself, unchanged.
app.example.com {
	reverse_proxy offtangent:3000
}

# The artifact host: same backend, one path, nothing else.
artifacts.example.com {
	@content path_regexp ^/api/artifacts/[0-9a-fA-F-]{36}/content$
	handle @content {
		reverse_proxy offtangent:3000
	}
	handle {
		respond 404
	}
}
```

```bash
ARTIFACT_ORIGIN=https://artifacts.example.com
ARTIFACT_FRAME_ANCESTORS='https://app.example.com'
```

What each part does:

- `ARTIFACT_ORIGIN` is prefixed onto `contentUrl` in `GET /api/artifacts/:id`,
  so both clients load the bytes from the artifact host without knowing
  anything about the deployment. Clients must use `contentUrl` verbatim and
  never rebuild it from their own base URL.
- `ARTIFACT_FRAME_ANCESTORS` replaces the default `'self'`, which would now
  mean "framed by the artifact host" and block the app. It becomes the app
  origin. `X-Frame-Options` is dropped automatically once this is set, because
  it cannot express an allow list and would block the embed on engines that
  still honour it.
- The vhost exposes only `/api/artifacts/<uuid>/content`. `/api/auth`,
  `/api/chat` and the rest of the API are not reachable on the artifact host,
  so a bug that ever softened the CSP still would not put an authenticated API
  next to the untrusted document.
- A sub**domain** (not a path, not a port) is the right granularity: the
  same-origin policy is scheme + host + port, but cookies are scoped by domain
  suffix. `artifacts.example.com` under the same registrable domain is enough
  for the origin boundary; a fully unrelated domain
  (`offtangent-artifacts.net`) additionally rules out any cookie that was set
  with `Domain=example.com`. Offtangent sets no such cookie today — the access
  token lives in the `Authorization` header — so the subdomain is sufficient.
  A different port on the same host is **not** sufficient for cookies and is
  not recommended.

Nothing in the API contract changes: same ids, same token, same headers. Only
the absolute prefix of `contentUrl` differs.
