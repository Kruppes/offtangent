# Boards API

Reference for boards: `/api/boards` (read side) and the agent tool
`publish_board` (write side).

A **board** is a long-lived, overwritable object an agent publishes: one
current state per `key`, rendered by the client according to its `kind`. It is
the counterpart to the feed, which is an append-only log. A daily digest, a
dashboard, a monitor — anything where the user wants *the current state*, not
one chat message per run — is a board.

The backend is deliberately generic: it stores a key, a kind, a title, a
summary, a JSON payload and optional numeric series. It does not know what any
board *means*. The only kind-specific code in the whole backend is a payload
check for `portfolio_digest.v1` and for `html_view.v1` (see below): both
contracts are published, and a malformed payload would render as an empty card
or, for `html_view.v1`, as an empty document.

All endpoints are JWT protected (`Authorization: Bearer <access token>`).
Errors are `{ "error": "<message>", "code": "<machine code>" }`. Every read and
write is scoped to the calling user; a foreign board is a **404**, never a
leak and never a 403.

## Concepts

| Term | Meaning |
|---|---|
| `key` | stable id of the board per user, `^[a-z0-9][a-z0-9-]{1,39}$` (2–40 chars). Publishing again with the same key overwrites the board. |
| `kind` | renderer contract of the payload, `^[a-z0-9_]+\.v[0-9]+$` (e.g. `portfolio_digest.v1`). Bump the version when the payload shape changes. A client that does not know a kind falls back to rendering `summary` plus the raw payload. |
| `revision` | starts at 1, `+1` on every publish. The previous state is kept as a revision; the last **30** revisions per board survive, older ones are pruned. |
| `series` | numeric history points per board: one value per (series name, calendar day). The last write of a day wins, so a rerun corrects the day instead of appending. |
| `asOf` | the timestamp the data refers to (not the write time). `updatedAt` is the write time. |

## Object

```json
{
  "key": "portfolio",
  "kind": "portfolio_digest.v1",
  "title": "Portfolio",
  "icon": "📈",
  "agentId": "main",
  "revision": 7,
  "summary": "Up 1.0% today.",
  "asOf": "2026-09-25T20:00:00Z",
  "updatedAt": "2026-09-25T20:00:03.412Z",
  "payload": { "schema_version": "portfolio_digest.v1", "…": "…" }
}
```

`payload` is returned as a JSON **object**, never as a string. The list route
omits `payload` entirely (a board can carry 256 KB; a chooser does not need
it).

## Endpoints

`GET /api/boards` -> `{ "boards": BoardSummary[] }`

- every board of the calling user, newest `updatedAt` first, **without**
  `payload`.

`GET /api/boards/:key` -> `Board`

- the current state including `payload`. **404** `board_not_found` for an
  unknown key, a foreign board and a malformed key.
- for `kind: "html_view.v1"` the response additionally carries a `content`
  block (see [`html_view.v1`](#html-view-v1)); every other kind is unchanged.

`GET /api/boards/:key/content?t=<board token>` -> the HTML document

- `html_view.v1` only, and the **only** way a client gets the document bytes.
  Not JWT protected: the credential is the short-lived capability token from
  the `content.url` of the board response, because an `<iframe>` cannot send an
  `Authorization` header and the access token must never appear in a URL that
  skill-written markup can read. An `Authorization: Bearer` header is accepted
  too (programmatic clients); `?token=<access token>` is **not**.
- **401** `board_unauthorized` without a valid token, with a token for another
  board, for another revision or with an expired token. **404** for a board of
  another kind or another user, **410** `board_content_gone` when the stored
  payload carries no readable document.
- the response ships the sandbox headers of the [Artifacts
  API](./artifacts-api) verbatim (same module, same CSP with `sandbox
  allow-scripts`, `default-src 'none'`, `connect-src 'none'`, `form-action
  'none'`, `frame-ancestors`, `no-store`).

`GET /api/boards/:key/revisions/:revision/content?t=<board token>` -> the HTML document of that revision

- same rules, and it serves the document **as it was published** in that
  revision. A token minted for the current state does not open a revision and
  vice versa.

`GET /api/boards/:key/revisions` -> `{ "revisions": [{ "revision", "asOf", "summary", "createdAt" }] }`

- newest first, at most the retained 30.

`GET /api/boards/:key/revisions/:revision` -> `Board`

- the stored state of that revision: the same shape as the board, with the
  revision's own `payload`, `summary`, `revision` and `asOf` plus `createdAt`.
  `kind`, `title`, `icon`, `agentId` and `updatedAt` come from the current
  board row, so a client picks the same renderer for history as for the
  current state. **404** `board_revision_not_found` for an unknown or
  non-numeric revision.

`GET /api/boards/:key/series?series=total_eur,cash_eur&days=90` -> `{ "series": { "<name>": [{ "day", "value", "meta"? }] } }`

- `series` is required, comma separated or repeated, at most 10 names of at
  most 64 chars (**400** `invalid_series`).
- `days` defaults to 90 and is clamped to **400** days; `days=0` or a
  non-integer is **400** `invalid_days`.
- points come oldest first; a series nobody ever wrote is an empty array, not
  a missing key. `meta` is only present when the point has one.

`DELETE /api/boards/:key` -> **204**

- **admin only** (**403** `forbidden` otherwise), deletes the board, all its
  revisions and all its series. Idempotent in the sense that a second call is
  a **404**. An admin deletes only their *own* boards — the route is scoped by
  user like every other one.

## WebSocket

Every publish emits two frames on the chat socket:

```json
{ "type": "feed_item", "item": { "kind": "board_update", "boardKey": "portfolio", "…": "…" } }
{ "type": "board_updated", "key": "portfolio", "revision": 7, "asOf": "2026-09-25T20:00:00Z" }
```

`board_updated` is flat: `key`, `revision` and `asOf` sit directly on the
frame, there is no nested `board` object.

A deduped publish (see `dedupe_key`) still emits `board_updated` — the board
did move — but no second `feed_item`.

## Feed and push

A publish writes exactly one feed item of kind `board_update`:

| Field | Value |
|---|---|
| `title` | the board title |
| `body` | the board summary (may be `null`) |
| `boardKey` | the board's key |
| `notify` | what the publisher asked for |

With `notify: true` the backend rings the FCM doorbell with
`{ "type": "feed_item", "feedItemId": "…", "kind": "board_update", "boardKey": "…" }`
(see [Push API](./push-api)). Every other feed-only path stays silent, exactly
as before. `GET /api/feed?kind=board_update` lists board cards only.

## The `publish_board` tool

The only way to write a board. Available to personas in chat turns, background
tasks and cronjobs. The owner is taken from the running task/strand — there is
no user parameter, because that would be a cross-user write primitive.

```jsonc
publish_board({
  key: "portfolio",              // required, ^[a-z0-9][a-z0-9-]{1,39}$
  kind: "portfolio_digest.v1",   // required, ^[a-z0-9_]+\.v[0-9]+$
  title: "Portfolio",            // required, 1–80 chars
  icon: "📈",                     // optional, ≤ 16 chars
  summary: "Up 1.0% today.",     // optional Markdown, ≤ 2000 chars
  payload: { /* … */ },          // required object, ≤ 256 KB serialized (1 MB for html_view.v1)
  as_of: "2026-09-25T20:00:00Z", // optional ISO 8601, defaults to now
  notify: false,                 // optional, default false
  dedupe_key: "run-2026-09-25-evening", // optional, ≤ 128 chars
  series: [                      // optional, ≤ 500 points and ≤ 256 KB serialized per call
    // series name: ^[A-Za-z0-9_:.-]{1,64}$ (no comma, no whitespace)
    // meta: optional object, ≤ 4 KB serialized per point
    { series: "total_eur", day: "2026-09-25", value: 1250, meta: { slot: "evening" } }
  ]
})
```

Behaviour:

- **Overwrite + revision.** The board is replaced, `revision` is incremented,
  the previous state is kept. Revisions beyond the last 30 are pruned.
- **Dedupe.** With a repeated `dedupe_key` the board is still updated (and a
  `board_updated` frame is sent), but no second feed card and no second
  doorbell are produced; the result reports `deduped: true` and the id of the
  original card. The key is scoped to the board: the backend stores it as
  `<board key>:<dedupe_key>`, so the same run id published to two different
  boards produces one card per board.
- **Errors are tool errors.** Every validation failure comes back as a tool
  error with a readable reason (`key must match …`, `payload must be at most
  262144 bytes serialized`, …). The tool never throws, so a publishing cronjob
  gets a reason instead of a stack trace.
- **A failed announcement does not lose the board.** If the feed/push side
  fails, the board is stored and the tool says so (`announceFailed: true`)
  instead of inviting a second publish.

### `portfolio_digest.v1`

The one kind with a payload check, applied only when `kind` is exactly
`portfolio_digest.v1`. Required:

```jsonc
{
  "schema_version": "portfolio_digest.v1",
  "run_id": "run-2026-09-25-evening",
  "slot": "evening",
  "as_of": "2026-09-25T20:00:00Z",
  "overview": {
    "securities_eur": 1000,
    "cash_eur": 250,
    "total_eur": 1250,
    "day": { "delta_eur": 12.5, "delta_pct": 1.01 }
  },
  "digest": "Alpha Corp up, Beta Industries flat."
}
```

Unknown fields are stored and ignored by the check, so the payload can grow
(movers, positions, alerts, …) without a backend change. Any other `kind`
accepts any JSON object.

### `html_view.v1`

A board whose payload **is** a self-contained HTML document. Use it when a
skill has to show something no built-in renderer can draw (a wheel diagram, a
floor plan, a small interactive tool) and inventing a payload schema plus a web
and an Android renderer for it would be absurd. The skill ships the finished
page; the clients only frame it.

```jsonc
publish_board({
  key: "front-wheel",
  kind: "html_view.v1",
  title: "Front wheel",
  summary: "Round 3: spread down to 8 %.",
  payload: {
    html: "<!doctype html><html>…</html>", // required, the whole document
    supports_theme: true,   // optional: the page reads ?theme=dark|light
    aspect_ratio: 1,        // optional: width / height, 0.1 … 10
    min_height_px: 360      // optional: 80 … 4000, used when no ratio is given
  }
})
```

Payload rules (validated; a failure is a tool error, nothing is published):

| Field | Rule |
|---|---|
| `html` | required, non-empty string, **≤ 1 000 000 bytes UTF-8**. The whole payload may be up to 1 MB serialized for this kind (256 KB for every other kind), because here the payload carries the renderer, not just the data for one. |
| `supports_theme` | optional boolean. `true` means the page reads `theme=dark` / `theme=light` from its own URL query and styles itself accordingly. |
| `aspect_ratio` | optional number `0.1 … 10` (width / height). The client sizes the frame from its own width. |
| `min_height_px` | optional integer `80 … 4000`. Used when there is no ratio. |
| `schema_version` | optional, must be `"html_view.v1"` when present. |

What the document must be:

- **Self-contained.** No network at all: no CDN, no web font, no external
  image, no `fetch`, no WebSocket, no form post. Inline CSS, inline SVG and
  inline `<script>` only; images as `data:` URLs.
- **Stateless.** `localStorage`, `sessionStorage`, cookies and IndexedDB are
  unavailable (opaque origin). State that must survive belongs in the payload
  of the next publish.
- **Self-sizing.** The page gets a frame of a width it does not choose; it
  cannot resize it. Use a responsive layout, `viewBox` on SVG, and give a
  `min_height_px` or an `aspect_ratio` hint.
- **Theme aware, optionally.** Either honour `prefers-color-scheme` (the client
  passes its theme through to the frame) or set `supports_theme: true` and read
  `?theme=`. Doing both is the safest.

How it is delivered (identical to a canvas artifact, see
[Artifacts API](./artifacts-api)):

1. `GET /api/boards/:key` returns, next to the payload, a `content` block:

```json
{
  "content": {
    "url": "/api/boards/front-wheel/content?t=b1.front-wheel.0.1.1790000000.<sig>",
    "expiresAt": "2026-09-26T10:10:00.000Z",
    "embed": {
      "iframeSandbox": "allow-scripts",
      "iframeReferrerPolicy": "no-referrer",
      "separateOrigin": false,
      "denies": ["same-origin", "cookies", "localStorage", "network", "top-navigation"]
    },
    "supportsTheme": true,
    "aspectRatio": 1,
    "minHeightPx": 360
  }
}
```

2. The client loads that URL **as the `src` of a sandboxed frame** (web:
   `<iframe :src>` with the `sandbox` attribute from `embed`, never `srcdoc`;
   Android: a `WebView` with JavaScript on, file and content access off, DOM
   storage off). It never injects the HTML into its own DOM.
3. The response's `Content-Security-Policy` carries `sandbox allow-scripts`
   (and never `allow-same-origin`), so the document lands in an **opaque
   origin** even if a client forgets an attribute: no app origin, no cookies,
   no storage, no access token, no network, no top-level navigation.
4. The token is minted per board (and per revision for history), lives 10
   minutes and is not an access token; the access token never appears in a URL
   the document could read.

Consequences worth knowing before you build on it:

- A board page cannot call the API, not even `/api/boards`. It is a picture
  with behaviour, not a client.
- Links inside the document do not navigate the app. Give the user a
  self-contained page instead of links.
- History works like every other board: opening revision *n* fetches
  `/revisions/n/content`, so an older revision shows the document of that
  round.
- The frame reloads when the board is republished; nothing in the page
  survives, since the URL and the token change.

### `news_digest.v2`

A daily news digest: one row per story, every story carrying its own verdict
sentence and its own set of sources. Checked in
`packages/core/src/board-news-digest.ts`, applied only when `kind` is exactly
`news_digest.v2`.

```jsonc
publish_board({
  key: "ai-news",
  kind: "news_digest.v2",
  title: "AI news",
  summary: "Two model releases and a cheaper speech stack.",
  payload: {
    schema_version: "news_digest.v2", // optional, must match when present
    profile: "example",               // optional, which digest profile ran
    date: "2026-09-28",               // optional, the day the digest covers
    generated_at: "2026-09-28T07:04:00+02:00", // optional
    window_hours: 30,                 // optional number
    headline: "Two model releases and a cheaper speech stack.", // required
    categories: { frontier: "Frontier", tts_stt: "Speech" }, // optional id → label
    items: [{                          // required, 1 … 20 entries
      story_id: "example-model-3",     // required, stable across days
      rank: 1,                         // optional number, drives the order
      status: "new",                   // optional: new | update
      delta: "The licence now allows commercial use.", // optional, only useful for updates
      title: "Example Lab releases model 3", // required
      take: "Real progress on context, but the pricing page hides the limits.", // required
      summary: "A longer context window at the same price.", // required
      verdict: "hot",                  // required: hot | relevant | watch | hype
      category: "frontier",            // optional, id into `categories`
      score: 88,                       // optional number
      critique: "Benchmarks compare only against its own predecessor.", // optional
      relevance: "Worth a day on the agent loop.", // optional
      action: { kind: "try", text: "Run the coding loop against it." }, // optional
      source_count: 4,                 // optional, may exceed sources.length
      sources: [{                      // required, 1 … 20 entries
        name: "Example Lab blog",      // required
        url: "https://example.com/post", // required, https:// only
        type: "primary",               // optional, free text
        published_at: "2026-09-27"     // optional string
      }],
      tags: ["models"]                 // optional, ≤ 12 strings
    }],
    quick_hits: [{                     // optional, ≤ 20 entries
      title: "Example toolkit 2.0",    // required
      url: "https://example.org/toolkit", // required, https:// only
      source: "Example Org",           // optional
      note: "Minor release."           // optional
    }],
    stats: {                           // optional
      sources_checked: 31,
      sources_failed: ["Example Feed"],
      candidates: 191,
      clusters: 64
    }
  }
})
```

Rejected (the tool answers with the reason, nothing is stored):

| Rule | Reason |
|---|---|
| `schema_version` present and not `news_digest.v2` | the kind and the payload must agree |
| `headline` missing/empty or longer than 240 chars | the head of the board would be empty |
| `items` missing, not an array, empty or longer than 20 | a digest without a story is not a digest |
| an item without `story_id`, `title`, `take`, `summary` | the list row and the detail view need all four |
| `verdict` other than `hot`, `relevant`, `watch`, `hype` | every client has a pill shape for exactly these four |
| `status` present and not `new`/`update` | two states, nothing else |
| an item with no source, or more than 20 | a claim without a source is not publishable |
| a source without `name` or `url` | a row needs a label and a target |
| any `url` that does not start with `https://` | no `http://`, no `javascript:`, no `data:` |
| `quick_hits` longer than 20, a hit without `title`/`url` | same rules as a source |
| `categories` not an object, or a label that is not a string / longer than 120 | the map is the label source of the clients |
| wrong types (`rank`, `score`, `window_hours`, `stats.*` non-numeric, `tags` not an array, `published_at` not a string, …) | a renderer cannot recover from them |
| text past the caps (title 180, take 280, summary 840, critique 960, relevance 480, delta 280, action.text 320, quick hit title 200, names 120) | roughly twice the producer's own limits |

Accepted on purpose, because a client can degrade gracefully: an unknown
`category` (also one missing from `categories`), an unknown source `type`, an
unknown `action.kind`, a `status: "update"` without `delta`, extra fields
anywhere. The backend never rewrites a payload — it only accepts or rejects.

**Renderer.** Web renders `app/components/board/NewsDigestBoard.vue` through
the tolerant parser `app/utils/newsDigest.ts` and the view model
`app/composables/useNewsDigestView.ts`. The layout follows the binding design
spec of the news board: a divided list with
hairlines instead of cards, no filter chips and no disclosure; each row shows
rank, verdict pill, category label, optional `UPDATE`, title, `take` and a
source line (`4 sources · 2 firsthand`, or a `no firsthand source` warning).
`summary`, `critique` and `relevance` never reach the list DOM — they belong to
the detail view, which is route state: `?date=YYYY-MM-DD&story=<story_id>` is
shareable and back-navigable, ←/→ page through the day, Esc returns. The day
line `‹ Mon 28 Sep 2026 ›` reads the revision API, so older days (including
`news_digest.v1` revisions) open in the same renderer. `score`, `tags` and
`stats` are not displayed except for the footer statistics. A broken item is
skipped instead of failing the page, a non-https URL is shown as text instead
of a link, and a payload with nothing renderable falls back to the generic
board. All external links carry `target="_blank" rel="noopener noreferrer"`.

**Colour and type.** The board uses exactly seven roles mapped onto the shell
theme (`surface`, `surfaceContainer`, `outlineVariant`, `onSurface`,
`onSurfaceVariant`, `primary`, `onPrimary`); there is no literal colour in the
board code. Type is Manrope at 12/14/16/18/22 px expressed in rem, weights 400
and 600 only, so a text zoom scales the type; spacing stays in px on the 4
grid. `prefers-reduced-motion` is respected.

**Label language.** The digest taxonomy (verdicts, source types, action kinds)
and the section labels are English in every locale and in every client — only
the payload content carries the language of the digest, and content elements
are marked `lang="de"` with `hyphens: auto` while the interface is `lang="en"`.
The German locale therefore repeats the English labels instead of translating
them. Category labels come from the payload (`categories`), not from the
locale files.

### `news_digest.v1` (legacy)

The first digest format, still accepted so older revisions of a board keep
working; new digests are published as `news_digest.v2`. Same envelope, with
these differences:

| v1 | v2 |
|---|---|
| `id` per item | `story_id` (stable across days) |
| no `take` | `take` required (the one-sentence verdict of the list row) |
| `is_update: true` | `status: "update"` plus optional `delta` |
| no `categories` map, ids translated by the client | `categories` map in the payload |
| no `published_at` on a source | optional `published_at` |
| caps: headline 440, title 280, summary/critique 1400, relevance 900, action.text 440 | tighter caps, see above |

Everything else is identical: `verdict` is one of the same four values, sources
are 1 … 20 per item with `https://` URLs only, `quick_hits` ≤ 20, and unknown
categories, source types and action kinds are accepted. The web renderer reads
both formats through the same parser: a v1 revision simply shows no `take`
line, and its category ids are labelled from a built-in fallback table — the
renderer never invents a `take` from the summary.

## Storage

| Table | Contents |
|---|---|
| `boards` | one current row per (`user_id`, `key`) with the payload |
| `board_revisions` | the previous states, pruned to the last 30 per board |
| `board_series` | one row per (`user_id`, `key`, `series`, `day`) |

`feed_items` carries the board columns `notify`, `dedupe_key`, `board_key`
plus a partial unique index on (`user_id`, `dedupe_key`); for board cards the
stored key is `<board key>:<dedupe_key>`. Deleting a board
deletes its revisions and series; the feed cards it produced stay (the feed is
a log).
