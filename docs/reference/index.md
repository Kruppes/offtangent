# Reference

Authoritative reference material for Offtangent's configuration surface.

- [**Environment Variables**](./env-vars) — Every `process.env.*` Offtangent reads at startup.
- [**`settings.json`**](./settings) — Schema and defaults for the runtime settings file.
- [**File Paths**](./file-paths) — Layout of `/data`, `/workspace`, and `/app` inside the container.
- [**Auth API**](./auth-api) — Login, refresh token rotation, logout, sessions, and protected uploads.
- [**Threads API**](./threads-api) — Named parallel conversations per persona: endpoints, shapes, ordering, lifecycle.
- [**Projects API**](./projects-api) — Projects light: grouping threads into buckets, shapes, validation, detach-on-delete.
- [**Tasks API**](./tasks-api) — Reading a task and its timeline: who owns a task, and incremental timeline reads with `since`.
- [**Captures API**](./captures-api) - Captures and the router: filing proposals, confidence bands, apply and undo, the router model chain, WebSocket frames.
- [**Strands API**](./strands-api) - Strands, tags, the now set and resurfacing.
- [**Feed API**](./feed-api) - The feed: everything unsolicited (task results, cronjob reports, heartbeats), read state, and asking about an item.
- [**Uploads API**](./uploads-api) - Storing files and the upload descriptors that captures and chat accept as attachments.
- [**Artifacts API**](./artifacts-api) - The canvas: how an artifact is extracted from a message, how it is stored, and the sandbox both renderers have to honour.
- [**Voice API**](./voice-api) - Speech to text, keeping the spoken recording and attaching it to the message that carries its transcript.
- [**Push API**](./push-api) - Device registration for the companion app and the FCM doorbell the backend sends.
- [**Model Policy API**](./model-policy-api) - The model roles: reading and writing `modelPolicy.roles`, validation against the configured providers, and the resolve route that explains which step decided.
- [**Memory View API**](./memory-view-api) - The structured memory view: wiki tree, facts per node, graph, fact provenance and conflicts.
- [**Personas API (client)**](./personas-api) — The non-admin persona list clients use to label chats.
