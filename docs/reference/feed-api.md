# Feed API

Reference for `/api/feed` (Offtangent SPEC 2.9 and 6.4). The feed is the one
place for everything unsolicited: task results, task questions, cronjob
reports, heartbeat notices. It is strictly separated from the strand dialogue,
so background noise can neither bury the conversation nor flood the strand
list.

All endpoints are JWT protected like `/api/chat/*`
(`Authorization: Bearer <access token>`). Bodies are JSON. Errors are
`{ "error": "<message>", "code": "<machine code>" }`. Every read and write is
scoped to the calling user; a foreign item is a **404**, never a leak.

## Object

```json
{
  "id": "2c6f...", "kind": "cron_report", "title": "Morning report",
  "body": "Two new mails, nothing urgent", "agentId": "main",
  "taskId": "8b11...", "strandId": null,
  "createdAt": "2026-09-14T06:00:12.000Z", "readAt": null
}
```

| Field | Notes |
|---|---|
| `kind` | `task_result`, `task_question`, `cron_report`, `heartbeat`, `reminder`, `system` |
| `title` | short label, never empty (a blank title falls back to `Untitled`), at most 200 characters |
| `body` | the full result summary, or `null` |
| `taskId` | the background task this came from, `null` for items that have none |
| `strandId` | set when the same result was ALSO delivered into that strand, `null` for feed-only items |
| `readAt` | `null` while unread; the timestamp of the first `read` call afterwards |

## Where feed items come from

A background task result is routed by its own lineage, not by what the user
happens to have open:

| Task | Strand | Feed |
|---|---|---|
| started from a strand (trigger `user`/`agent` with an interactive session in its lineage) | yes, unchanged: injected into that strand | yes, `task_result` / `task_question` with `strandId` |
| cronjob, heartbeat, consolidation | no, and no interactive session is created for it | yes, `cron_report` / `heartbeat` / `system` (or `task_question`) |

A feed-only result is still persisted under the task's own (non strand)
session and still reaches Telegram; what it no longer does is start a chat turn
or mint a strand.

## Endpoints

`GET /api/feed?since_id=&limit=50&kind=&unread_only=` -> `{ "items": FeedItem[] }`

- without `since_id`: newest first, at most `limit` (default 50, max 200).
- with `since_id`: everything written AFTER that item, oldest first — the same
  cursor semantics as `GET /api/chat/history?since_id=`. Feed the last id back
  in to walk a gap in batches. **400** `invalid_since_id` for an unknown or
  foreign cursor.
- `kind` filters by one kind (**400** `invalid_kind`), `unread_only=1` hides
  read items. **400** `invalid_limit` for a non positive limit.

`POST /api/feed/:id/read` -> **204**

Idempotent: a second call keeps the original `readAt`. **404** for an unknown
or foreign item.

`POST /api/feed/read-all` -> **204**

Marks every unread item of the calling user read. Also idempotent.

`GET /api/feed/unread-count` -> `{ "count": 3 }`

`POST /api/feed/:id/ask` `{ "text": "which mails exactly?" }` -> **201**
`{ "capture", "decision" }`

Creates a capture that carries the feed item as context (the user's words
first, the item quoted below) and sends it through the ordinary router path, so
the answer lands in whichever strand the router picks — the feed item is not
pinned to a strand even when it carries one. `text` is optional; without it the
item's title becomes the question. The item is marked read. **400**
`invalid_text`, **404** unknown or foreign item, **503** `captures_unavailable`
when the capture service is not wired.

## WebSocket

A new item is pushed on `/ws/chat` as an additive frame; no existing frame
changes and clients that do not know the feed ignore it:

```json
{ "type": "feed_item", "item": { "id": "2c6f...", "kind": "cron_report", "...": "..." } }
```

The item is persisted before the frame is sent, so a client that reconnects and
re-reads `GET /api/feed` sees exactly what a client that stayed online was told.

## Push

A feed-only item does not ring the doorbell: a push payload addresses a strand
the app opens, and a feed-only item has none. A result that also enters a
strand rings exactly once, through the unchanged task doorbell.
