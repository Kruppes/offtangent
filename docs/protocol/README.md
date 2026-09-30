# Recorded protocol frames

The files in this directory are **recorded**, not written by hand. Each one is
the payload a running Offtangent backend sent over its websocket, captured by a
test that boots the real server, and both clients (web app, Android app) parse
exactly these bytes in their own tests.

The point is to make drift impossible in the one direction that hurts: a client
that agrees with a document instead of with the server. A renamed field breaks
the recording test on the backend side and the parsing test on the client side,
in the same commit.

## `canvas-view-updated.frame.json`

The `canvas_view_updated` frame of the global canvas: a living view of a strand
reached a new revision.

Recorded by `packages/web-backend/src/canvas-view-live.test.ts` from a real
`/ws/chat` socket, written by the background-task delivery path
(`deliverTaskFile`) — the case with no turn, no LLM and no channel streaming
chunks, which is precisely why the frame exists.

Re-record it after an intentional protocol change:

```bash
UPDATE_CANVAS_FIXTURE=1 npx vitest run packages/web-backend/src/canvas-view-live.test.ts
```

Then update the copy the Android app keeps under
`app/src/test/resources/protocol/` in the companion repository, and run both
client test suites. `artifactId` and `messageId` are volatile per run and are
stored as the placeholders `<artifactId>` / `<messageId>`; every other value is
part of the contract.

Consumers:

- backend: `packages/web-backend/src/canvas-view-live.test.ts`
- web app: `packages/web-frontend/app/composables/useStrandCanvas.test.ts`,
  `packages/web-frontend/app/composables/useChat.test.ts`
- Android app: `app/src/test/resources/protocol/canvas-view-updated.frame.json`
  (companion repository)
