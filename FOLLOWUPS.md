# Follow-ups

Known holes that were found while building something else, written down
instead of built. Newest first.

## From the OAuth 401 retry and the model indicator (2026-09-24)

Incident 24.09. 11:49 UTC: a turn on `claude-fable-5-1` died with
`401 authentication_error "invalid x-api-key"` and `cause=non_retryable`,
while the strand header named `gpt-6-astra`, the model that had just become
the global default. Two independent bugs, both fixed on
`fix/oauth-401-retry-and-model-indicator`. What was found next to them and
deliberately not built:

* **The 401 classification is textual.** `isAuthError()` in
  `packages/core/src/turn-retry.ts` matches the error string pi-ai hands up
  (401, `authentication_error`, `invalid x-api-key`, `invalid_token`). pi-ai
  does not expose a structured status code on the chunk, so a provider that
  words its auth failure differently still ends the turn terminally. A typed
  error channel from pi-ai would make this exact.
* **A deferred global swap is dropped when the persona never takes another
  turn.** The pending provider is kept in memory and applied at the start of
  the next turn of that persona; a restart before that loses it, and the next
  turn then resolves the model from the settings anyway. Good enough, but it
  means "the global model change applied everywhere" is only true after every
  persona has taken one turn.
* **A provider fallback (`mode:fallback`) is deferred the same way.** A persona
  that is mid turn when the primary provider dies keeps the primary for the
  rest of that turn. That turn is already failing over inside the runner, so
  nothing was built to force the swap earlier.
* **The recovery is per provider id, not per credential.** Forced refreshes
  are throttled to one per provider per 60 s
  (`FORCED_OAUTH_REFRESH_MIN_INTERVAL_MS`). Two personas on the same provider
  share that window: the second turn retries with whatever the first refresh
  produced instead of asking again. That is intentional (a rotated refresh
  token must never be presented twice), but it means a burst of turns can see
  one stale retry.
* **`recoverOAuthAfterAuthFailure` returns true even when the refresh throws.**
  A refresh failure is not proof that the stored token is bad, and the incident
  showed a 401 on a credential that worked a minute later. Cost: one wasted
  extra call per turn in the genuinely-revoked case.
* **No metric or audit row for the recovery.** It only logs
  (`[axiom] Provider <id> rejected the access token ...`). How often the retry
  saves a turn is not answerable from the database.
* **`runningTurnModel` is only on `GET /api/strands/:id`.** The strand list,
  the WebSocket frames and the chat view do not carry it, so the header re-reads
  the strand when a turn starts or ends instead of being pushed the model. A
  `turn_start` frame carrying the frozen model would remove that round trip.
* **The companion app still shows the effective model.** It lives in its own
  repo and was not touched; its strand header has the same
  display-versus-reality gap until it reads the new field.
* **Turns started outside the web composition root have no frozen model.**
  `resolveStartModel` is wired in `runtime-composition.ts`. A standalone
  `ws-chat.ts` runner (tests, embedded use) and the Telegram bot's own runner
  fall back to the explicit per-turn pin, so `runningTurnModel` stays null
  there.

## From model policy roles (2026-09-19)

`GET/PUT /api/model-policy` + `GET /api/model-policy/resolve` ship, the five
legacy-backed roles are read through one function, and the Settings page has a
"Models" tab. Found next to it and deliberately not built:

* **The companion app has no Models screen.** The policy is web + API only.
  Android Settings still shows the global model switch, which is the `default`
  role — the roles themselves are invisible there.
* **The legacy fields stay.** `sessionSummaryProviderId`,
  `factExtraction.providerId`, `memoryConsolidation.providerId`,
  `stt.rewrite.providerId` and `tasks.loopDetection.smartProvider` are still
  written by `PUT /api/settings` and still shown in the settings UI. Removing
  them needs a migration that moves the value into `modelPolicy.roles` and a
  release note; until then two places can say different things (the role wins).
* **`PUT /api/model-policy` replaces the whole block.** No PATCH semantics: a
  client that sends a partial `roles` map deletes every role it omits. The web
  UI always sends the full map, another client has to as well.
* **No audit trail.** A role change is not logged the way persona changes are
  (`[personas-audit]`). Who moved consolidation off Opus is not answerable.
* **The resolve route re-implements the task chain declaratively.** It reads
  the same settings keys as `runtime-composition.ts` but is a second
  description of the same order; if the real chain changes, this explanation
  can drift. A shared step-list producer in core would fix it.
* **No live model-existence check.** Validation is against
  `providers.json.enabledModels`, so a model that the provider silently retired
  still validates. Same tradeoff as the rest of the model configuration.

## From the TTS preview and catalog (2026-09-19)

`POST /api/tts/preview` now honours the unsaved form, `GET /api/tts/catalog`
serves the lists, and the web client negotiates a playable container. Found
next to it (adversarial review) and deliberately not built:

* **`providerId` is not checked against `provider`.** Admin-only, and the
  same hole exists in `PUT /api/settings`: a `providerId` pointing at a
  Deepgram account while `provider` is `openai` sends that account's key to
  the OpenAI endpoint. Validate in the settings schema (account exists and
  its type backs the provider) and reuse in `parsePreviewSettings`.
* **No length limits on `openaiInstructions` / `geminiStyle`.** The schema
  accepts any string; the preview text is capped at 1000 characters but the
  style prefix is not. A 500-character cap in the schema would be parity.
* **Provider error messages reach the client as `500 {error}`.** Same as
  `POST /api/tts`; a generic message plus server log would be tidier.
* **iOS Safari user activation.** The chat and the preview create the
  `Audio` element after `await fetch`, which older WebKit treats as outside
  the gesture. The blocked path (second click, "Play now") covers it, but a
  synchronous element creation plus early `play()` would make it one tap.
* **`useTts` keeps `audioElement`/`blockedIndex` in module scope** (pre
  existing). Two chat views share one player and unmount does not clean up.

## From native Gemini TTS (2026-09-18)

Gemini joined the cloud TTS dispatcher (`packages/core/src/tts.ts`,
`gemini-tts.ts`, `ogg-opus.ts`) and `POST /api/speech/audio` now prefers the
enabled cloud voice over the local `voiceTelegram.ttsUrl` box. Found next to
it and not built:

* ~~**`task-agent-notice.test.ts` is a time bomb.**~~ Fixed on 2026-09-19: fixtures
  derive their timestamps from `Date.now()` (`FIXTURE_NOW`), the stale test asks
  from three days after that.
* **The local TTS box is now a fallback only.** `voiceTelegram.ttsUrl`,
  `packages/telegram/src/tts-client.ts` and the Mac `~/tts-service` become
  dead weight once a cloud voice is enabled. Remove after the Gemini path has
  run in production for a while.
* **No streaming.** Gemini 3.1 supports SSE audio deltas; the speech endpoint
  still waits for the full file. Only worth it once a consumer can play a
  partial Ogg stream.
* **Gemini `mp3`/`flac` refuse instead of transcoding.** Deliberate (no
  ffmpeg in the container). A WASM MP3 encoder would close the gap if anyone
  needs it.
* **Preview model ids.** `SETTINGS_TTS_GEMINI_MODELS` will go stale when
  Google promotes 3.1 TTS to GA; the schema accepts any non-empty id, so the
  UI list is the only thing to refresh.

## From the cutover gaps: task reply and read state (2026-09-18)

`POST /api/tasks/:id/reply` and the server side strand read state
(`POST /api/strands/:id/read`, `unread` / `lastActivityAt`) were built. What
was found next to them and deliberately not built:

* **No WebSocket frame carries strand list rows.** `ChatEvent` in
  `packages/web-backend/src/chat-event-bus.ts` has frames for turns, tasks,
  captures, the now set (`now_set_changed`) and project suggestions, but none
  that says "this strand changed in the list". `unread` therefore only moves
  when a client pulls `GET /api/strands`. An unread badge that reacts live
  needs a new frame (e.g. `strand_activity` with `{ strandId, lastActivityAt,
  unread }`), emitted where a non-user message is persisted — a design
  decision, not a patch, so it was not invented here.
* **The read state rides only on the two strand reads.** `GET /api/strands`
  and `GET /api/strands/:id` carry `lastActivityAt` / `unread`;
  `GET /api/now`, `PATCH /api/strands/:id` and `GET /api/threads` return the
  same rows without them. That is the minimum the contract asked for, but it
  means a client cannot badge the now set without a second call. Widening it
  is one `withReadState(...)` call per endpoint plus a contract change.
* **`unread` ignores who was talking to whom.** The marker is per strand, not
  per user: a strand shared between two users (possible via the sessions
  table, unused today) would share one read marker. A per-user marker needs
  its own table and was not built for a single-user install.
* **Running `npx tsc -b` at the repo root emits compiled `.js`/`.d.ts` next
  to every source file.** The root `tsconfig.json` has `rootDir: src` but the
  default include pattern picks up `packages/**`, so a build invoked that way
  fails with TS6059 AND litters the workspace (2.4k untracked files, and the
  Nuxt build then dies with "Identifier ApiError has already been declared").
  `npm run build` is the only correct entry point; the root tsconfig should
  either exclude `packages/` or be removed.

## From the now-set size setting (2026-09-15)

The size of the now set is the setting `offtangent.nowSetMax` (integer 1–12,
default 4) instead of the constant `NOW_SET_MAX`. `GET /api/now` and
`PUT /api/now` report the value in force as `max`. What was found next to it
and deliberately not built:

* **No web UI consumes the now set.** Nothing under
  `packages/web-frontend/app/` calls `/api/now` or renders `nowRank`; the now
  set exists only in the API and in the mobile app. The new `max` field
  therefore has no web consumer yet — the settings input was added (Settings →
  Agent → Now set size), but a now-set surface that reads `max` and greys out
  "add" at the limit still has to be built wherever the set is shown. The
  mobile app has to start reading `max` instead of assuming 4; until it does,
  a size above 4 is accepted by the backend and silently ignored by that
  client.
* **The setting is global, not per user.** `settings.json` has no per-user
  layer, so every user of an instance shares one now-set size. Single-user
  installs (what this instance is) do not notice; a multi-user install would
  want the value on the user row.
* **A size change fires no live-reload hook.** The value is read per request,
  so a save applies to the next call — but no `now_set_changed` frame is
  broadcast when the size alone changes, so an open client keeps showing the
  old limit until it refetches `/api/now`.
* **`docs/offtangent/SPEC.md` does not exist in this repo.** The SPEC chapters
  are referenced from code comments ("SPEC 2.8", "SPEC 6.2") but the document
  itself is not tracked here, so the now-set chapter could not be updated. The
  user-facing equivalents were updated instead:
  `docs/reference/strands-api.md`, `docs/reference/settings.md`,
  `docs/settings/agent.md`. If the SPEC lives outside the repo, its now-set
  chapter still has to be pulled along by hand.

## From sub-task ownership and incremental timelines (2026-09-15)

A sub-task now answers 200 for the human who started the chain, and
`GET /api/tasks/:id/events` takes a `since` cursor. What was found next to it
and deliberately not built:

* **A task stopped from the app is called `failed`, with the reason "Killed
  by user from web UI".** `TasksService.killTask` writes that text into
  `error_message` and `result_summary`, and the app's detail screen shows it
  verbatim under "What went wrong" — for a stop the user asked for, from a
  phone, where there is no web UI. Two separate things are wrong: the wording
  ("web UI" is not where the request came from) and the status (`failed` is
  the same state a crashed task lands in, so a deliberate stop cannot be told
  apart from a breakage in any list). Fixing it properly means either a
  `cancelled`/`stopped` status — which touches the CHECK constraint on
  `tasks.status`, every status filter, the app, the frontend and the task
  tree — or, cheaper, an honest message that names the caller. Both deserve
  their own pass and their own decision; this one was about ownership.
* **No client uses `since` yet.** The app (0.9.4) polls the timeline every
  15 s without the parameter and therefore still downloads the whole run each
  time; the web frontend's `useTaskEvents` does the same on its single load
  (where it does not matter). The endpoint change is deliberately
  backwards-compatible, so nothing breaks — but the traffic only drops once
  the app sends `nextSince` back. That is the app-side follow-up.
* **The task-parent walk is still a walk.** Ownership of a sub-task is
  derived at request time by climbing `tasks.trigger_source_id` and then the
  session lineage — up to 8 hops, each a small indexed read. It is cheap and
  bounded, but it is the same derived-not-stored answer the item below asks
  about: a stored `tasks.owner_user_id`, written at insert time and inherited
  from the parent task, would answer ownership with one column read and would
  also unlock the list endpoint.
* **`sessions.parent_session_id` of a sub-task stays NULL.** The honest fix
  for the lineage (background task tools pass `parentSessionId = null`) was
  again not taken, for the reason recorded below: it would change where a
  sub-task's RESULT is delivered. The ownership walk works around that
  missing edge, it does not repair it — so anything else that relies on
  session lineage (result routing, strand attribution) is unchanged.

## From task tokens in the strand view (2026-09-15)

Tokens, cache and cost of a task now ride the task tree DTO and the
`task_started` / `task_progress` / `task_finished` frames, a running task
emits a progress frame every 30 s, and the four single-task endpoints check
ownership. What was found next to it and deliberately not built:

* **`GET /api/tasks` (the list) still returns every user's tasks, with the
  full prompt.** Measured against the live instance on 2026-09-15 with a
  minted `userId:2, role:user` token: `GET /api/tasks/:id` and
  `.../events` answered **200** for a task belonging to user 1 (both are 404
  now). The list endpoint was left untouched: it paginates in SQL
  (`buildTaskFilterClause` + `COUNT(*)`), so filtering by owner after the
  fact would return short pages and a wrong `total`. Doing it right means an
  owner join inside the query — the lineage is a recursive walk over
  `sessions.parent_session_id`, so it needs either a recursive CTE in the
  list query or a denormalized `tasks.owner_user_id` column maintained at
  insert time. The second is the honest fix and wants its own pass (plus a
  backfill for 3803 existing rows). Until then a non-admin user can still
  read every task's name, prompt and result through the list.
* **A task's owner is derived, not stored.** `resolveTaskOwnerUserId`
  (`packages/core/src/task-ownership.ts`) walks `tasks.session_id` up
  `sessions.parent_session_id` to the root session and reads
  `session_user` / `user_id`. Measured on the live database: 355 tasks
  resolve to user 1, 10 to user 2, 1 to user 3 — and **3437 resolve to
  nobody** (cronjob / heartbeat / consolidation roots have
  `session_user = NULL`). Those unresolvable tasks are admin-only now, which
  is right for system work but would hide a user's task if a future code
  path ever creates one without lineage. A stored `owner_user_id` would end
  the guessing for good.
* **`tasks.statusUpdates` is dead configuration on the live install.** The
  production `settings.json` carries only the legacy
  `statusUpdateIntervalMinutes: 10`, which migrates the interval but leaves
  `enabled: false` — so `onStatusUpdate` (chat message + Telegram ping) never
  fires and, before this change, `task_progress` never fired either. The new
  progress ticker is independent of that flag on purpose; the flag itself
  should probably be exposed in the Settings UI or dropped.
* **Nothing evicts a `task_progress` frame for a client that is not in the
  strand.** Frames are broadcast per user and carry `sessionId`, so a client
  showing another strand receives a frame every 30 s per running task and
  drops it. With four parallel tasks that is eight useless frames a minute
  per connection. Cheap today, but a per-session subscription would be the
  real answer if waves get bigger.

## From outgoing attachments (2026-09-15)

A file the agent sends now survives every turn kind (interactive, background
task, task-injection reaction), the placement of a live `attachment` frame
follows the row the backend wrote, and the path is pinned end to end
(tool → row → history API). What was found next to it and deliberately not
built:

* **A task-injection reaction still sends no file to Telegram.** When the
  reaction to a finished task is delivered to Telegram
  (`resolvedBot.sendFormattedMessage` in `runtime-composition.ts`), only the
  text goes. The file is now on the row and on the bus, but the Telegram leg of
  the injection path never learned about uploads — unlike a normal turn, which
  goes through `sendAssistantResponseToTelegram(chatId, text, uploads)`. Same
  shape of fix as the caption item below, same reason it is not in this pass.
* **Three writers, one invariant.** `TurnTranscript` (core), `deliverTaskFile`
  and now `TaskInjectionTranscript` each write `metadata.files` on their own.
  They agree today because three tests say so, not because the code makes
  disagreement impossible. A shared "write the assistant row" helper would, but
  it crosses the core/web-backend boundary and is a refactor, not a fix.

* **The web client never shows a file's caption.** `send_file_to_user` puts
  `caption` on the descriptor, it is persisted in `metadata.files` and it rides
  the frame, but `ChatAttachments.vue` renders name and size only, and the
  frontend's `ChatAttachment` type does not even declare the field. Cheap to
  add, but it changes the look of every attachment card, incoming ones
  included — so it wants its own pass (and a decision whether an incoming file
  should grow a caption too).
* **Old rows keep their files only in the tool result.** Measured on the live
  database (read-only): of the `send_file_to_user` tool rows, 87 from 2026-07
  have no assistant row carrying `metadata.files` at all, while 2026-08 (137)
  and 2026-09 (51) do — the oldest persisted one is from 2026-08-17 11:53:43.
  For those old turns the descriptor exists only inside the `tool` row
  (`metadata.toolResult.details.uploadedFile`). A
  backfill is possible and was deliberately NOT run: for every `tool` row with
  `toolName = 'send_file_to_user'`, find the next assistant row of the same
  session, and set `metadata.files` when the row has no metadata of its own and
  the file still exists under `DATA_DIR/uploads`. It must be done on a copy
  first — the ambiguous case (assistant row already carries other metadata,
  e.g. `kind: 'thinking'`) has to be skipped, not merged blindly. Retention
  (`cleanupExpiredUploads`) deletes files older than 30 days anyway, which is
  what makes this low value.
* **An aborted turn drops the file it already sent.** `TurnTranscript.discard()`
  clears `uploads` together with the rows of the failed attempt, so a retryable
  provider error after a successful `send_file_to_user` leaves the bytes in the
  uploads dir with no row pointing at them (the live frame was already sent).
  The retried turn usually calls the tool again, which is why this has not
  surfaced; a correct fix would carry uploads across attempts instead of
  discarding them.

## From strand task visibility (2026-09-15)

The strand now shows what works for it — the running turn, the delegated tasks
and their sub-tasks, recursively, live and on catch-up. What was deliberately
left out or found on the way:

* **`task_completed` / `task_failed` / `task_question` still carry no
  `sessionId`.** `broadcastTaskEvent` in `task-outcome.ts` was left untouched on
  purpose: adding the strand id there changes which chat the result card shows
  up in (today it renders in every open strand, because `isForeignFrame` lets a
  frame without a session through), and that is a behaviour change that belongs
  in its own pass with its own test. The activity panel does not need it — it
  reads the new `task_finished` frame.
* **`hasLiveTaskForStrand` (strand-delete.ts) still only matches
  `tasks.session_id = strandId`.** A task's `session_id` is its OWN session, so
  the busy guard mostly does not fire for delegated tasks — a strand can be
  deleted while a wave runs under it. `buildStrandTaskTree(db, strandId)` now
  answers that question correctly and cheaply (≈1ms); wiring it into the guard
  is a one-liner that was not done here because it makes DELETE and archive
  refuse in cases they accepted before, and that deserves its own verification.
* **A max-duration abort emits two `task_finished` frames.** The runner calls
  `notifyTaskComplete` twice on that path (abort, then the finishing agent run),
  so the strand sees `failed` and then `completed` for the same task id. The
  client is an upsert keyed by task id, so the last frame wins and nothing
  duplicates — but the underlying double notification is older than this work
  and still there.
* **Sub-task session lineage stays broken on purpose.** Background task tools
  still pass `null` as `parentSessionId`, so `sessions.parent_session_id` ends
  at the first task generation. The tree reads `tasks.trigger_source_id`
  instead. Fixing the lineage would also change where a sub-task's RESULT is
  delivered (`resolveTaskStrandOrigin` would suddenly resolve a strand for
  every sub-task and inject its summary as a turn), which is a routing change,
  not a visibility change.
* **No browser-rendered proof of the panel.** No headless browser exists in the
  build sandbox, so the frontend is covered by unit tests over the reducer plus
  the production build — not by a screenshot of the rendered tree.
* **The app does not show the tree yet.** The contract (endpoint + three
  frames) is what the Android follow-up consumes.

## From persona management (2026-09-15)

R1 of SPEC 13 shipped: the persona record (colour, badge, display name,
`is_default`, `archived`), the structured editor over the existing markdown,
archive plus hard delete with a cascade preview and a `persona_busy` guard. The
rest of chapter 13 was deliberately left out.

* **No persona creation by interview (SPEC 13.9).** A blank SOUL.md is still a
  wall, and the create dialog asks four fields of somebody who does not yet know
  what a good role sentence looks like. The API is ready for it — an interview
  would produce exactly the `fields` object that `POST /api/personas` already
  takes — but the interview itself is a conversation design problem, not an
  endpoint, and guessing at it would have burned the budget for the parts that
  are mechanically verifiable.
* **No feedback driven refinement (SPEC 13.10).** Nothing watches whether a
  persona's answers got worse after an edit, and nothing proposes a correction.
* **No knowledge layer / watch topics (SPEC 13.11).**
* **No `persona_rules` table (SPEC 13.4).** The editor writes the subjects a
  persona owns into a fenced block in IDENTITY.md, so the information is
  captured and inspectable — but the router does not read it as a prior yet, and
  there is no "always send this kind of thing to X" from the routing card. The
  block is the seed for that table when it comes; migrating it is a read of a
  markdown list, not a re-entry job for the user.
* **No revisions with diff and restore (SPEC 13.6).** Deliberately dropped after
  a look at the cost: a copy of the files per write is cheap, but restore needs a
  list UI, a diff renderer and a decision about what happens to the record (does
  restoring a revision also restore a colour?). Half of that is UI work that
  would have pushed the delete safety out of this pass. A bad edit is currently
  recoverable only from the audit log line plus the user's memory, which is the
  honest gap here.
* **No "reassign strands and facts to another persona" on delete (SPEC 13.5).**
  Only archive and hard delete exist. The hard delete deliberately does NOT
  cascade into strands, messages or facts — they keep the dead persona's id and
  stay readable — which means a deleted persona can leave rows pointing at an id
  that no longer resolves. Those rows render with the raw id today. Reassign is
  the proper fix; the preview already counts exactly the rows it would move.
* **`'main'` still appears as a literal in ~160 places** across core and the web
  backend (session defaults, memory scoping, task routing, Telegram fallbacks).
  This pass replaced it in the persona surfaces that a user can reach — the
  persona list order, the client projection, the delete guard, the Telegram
  single-bot binding — and introduced `getDefaultPersonaId(db)` as the one way
  to ask. Sweeping the remaining literals is a separate, mechanical change that
  wants its own test pass: several of them are session-id defaults where the
  wrong value silently mixes two personas' history.
* **Starter templates (SPEC 13.2 #3) are not offered.** Creating a persona
  writes the same German template files it always did. Three one-tap templates
  (generalist, maker, money person) are a create-dialog feature and need copy
  that somebody has to write.
* **The archived flag is not enforced in the turn path.** `archived` hides a
  persona from the pickers and from `/api/personas/client`, but nothing stops a
  turn that names the id directly (an old client, a cronjob with a pinned
  `agent_id`) from running as it. SPEC 13.5 says "no new turns"; that guard
  belongs in the turn runner and was out of scope here.

## From decoupling the answer from the band (2026-09-15)

* **A note still disappears into a strand without a word.** The product owner
  asked for the opposite: *"notes sollten immer eine bestätigung erfordern"* —
  every `note` filing should offer "only note this" / "answer it" instead of
  going quiet. **Deliberately not built here, because the mechanism it needs
  does not exist yet.** SPEC 7.4c specifies interactive blocks (a fenced
  ```` ```offtangent ```` JSON body of kind `confirm`, answered through
  `POST /api/interactions` with `clientMessageId`, `409 already_answered`,
  `410 stale`), but there is no `/api/interactions` route in
  `packages/web-backend/src/api/modules/`, no block parser in
  `packages/web-frontend`, and the SPEC chapter itself lives only on the
  `feat/offtangent-spec` branch. Writing a `confirm` fence today would produce
  a message that renders as raw JSON in the web UI and in Telegram — worse than
  the silence it replaces. **The scoped follow-up, in order:**
  1. `POST /api/interactions` per SPEC 7.4c, with the block state kept in
     `chat_messages.metadata` (no schema change): `{ blocks: { b1: { value,
     answeredAt } } }`. `409` when the id already carries a value, `410` when
     the referenced capture or strand is gone.
  2. A renderer for the `offtangent` fence in `useMarkdown`/the message
     component, and a numbered-list fallback for Telegram (7.11).
  3. Only then: write a `confirm` block instead of nothing when a `note`
     capture is filed. The server side of step 3 is already there —
     `answerLater()` in the captures service is the shared, idempotent "answer
     this capture after the fact" path that the "Beantworten" option would
     call, and it is the same function the `needs_review` confirmation uses.
  The existing doubt band (`askBack`, prose, no buttons) is the cheap
  precursor of this and already covers the weak-address case; step 3 would
  widen it from "might be addressed at you" to every note and give it taps.
* **SPEC 4.4 no longer describes what the code does.** The band table on
  `feat/offtangent-spec` says the turn runs in the High row only. Since an
  `ask` is answered in the Medium band too, the Medium row needs to read
  *"decision applied, capture status `needs_review`, turn runs when
  `intent='ask'` — the band is about where the capture goes, not about whether
  an answer is owed"*. Not edited from here on purpose: that branch is 30
  commits of docs ahead of `main` and nothing else in this change touches it.
* **An undo during a running turn still deletes the question.** `move()`
  decides between a true move and a `misfiled` badge with `answerExists()`,
  which cannot see a turn that has not written its assistant row yet, so an
  undo in that window removes the user row from under a running turn. The
  service now knows better (the in-memory `answering` set in
  `createCapturesService`), but wiring it into `move()` changes undo semantics
  for the high band as well, which is a decision of its own. Pre-existing, not
  made worse, only more reachable now that the medium band answers too.
* **`syntheticProposal()` still hard-codes `intent: 'note'`, on purpose.**
  Giving it an address heuristic of its own would duplicate
  `guardAddressedNote`, which already runs on every router result including
  the synthetic ones and has the finer `none`/`weak`/`strong` distinction. The
  route test *"answers a synthetic proposal too: the first capture of an empty
  instance"* pins that the path works without the duplication.

## From the doubt band (2026-09-14)

* **A weak capture is asked about every single time.** The doubt band has no
  memory and no rate limit: three captures with a question mark in one evening
  write three questions and ring three times (the push coalescing window only
  covers 10 s per strand, and these are usually different strands). Deliberately
  not built — nobody knows yet how often the band fires in practice, and the
  marker (`rationale LIKE 'capture guard: a note that may address%'`) is there
  to count it. If it turns out to be noisy, the cheapest fix is a per-user
  budget (at most N questions per hour, the rest filed in silence), not a
  cleverer classifier.
* **The question is written, not streamed.** `askBack` inserts the `assistant`
  row and rings, but it broadcasts no chat frame, so a web client that has the
  strand open right now sees it only after a reload (the phone gets the
  doorbell and re-fetches the strand head anyway). A live frame would need
  `sessionId` on the fallback branch of the `chatEventBus` forwarder in
  `ws-chat.ts`, which today drops it — a `text` event without a strand id would
  land in whatever thread is open, which is worse than the delay.
* **A reply that arrives as a capture can be asked about again.** The intended
  path ("ja, mach mal") is an ordinary message in the strand, and that starts a
  turn. But if the app sends the reply as a NEW capture without a strand id and
  the router files it back into the same strand, the doubt band sees "mach" and
  asks again: the question row is deliberately not an `assistant` answer for
  `isLiveDialog`, so that guard does not upgrade it. A reply detector (a
  capture that lands in a strand whose last row is a question of ours) would
  close it.
* **The band cannot see a second person politeness form or an unmarked
  request** — same blind spot as the strong band below, one band lower.

## From the text backstop (2026-09-14)

* **The backstop reads words, not intent.** ~~`looksAddressed` upgrades a
  `note` to an `ask` on a second person word, a request verb or a question
  mark.~~ **Closed (2026-09-14):** `looksAddressed` is gone,
  `addressStrength` in `packages/core/src/capture-router.ts` returns
  `none`/`weak`/`strong` and counts marker CLASSES (second person, imperative,
  politeness particle, question mark). Only two classes upgrade the intent;
  one class keeps the `note` and makes the service ask back in the strand.
  "Termin beim Zahnarzt am Montag?", "Bitte nicht vergessen: Müll rausstellen",
  "Ich mach das morgen" and "Ihr Auto muss zum TÜV" are all `weak` now: they
  cost one short question instead of a full unsolicited answer. What is left is
  the noise of that question itself, see the doubt band above.
* **The polite "Sie" is not detected.** Lowercased it is
  indistinguishable from "sie" (she/they), and the capitalisation of a voice
  transcript proves nothing. A capture in the polite form without a question
  mark and without a request verb ("Sie haben da noch einen Fehler drin")
  therefore stays a `note` and is filed in silence. Fixing it needs either the
  original capitalisation treated as evidence (unreliable) or a verb
  agreement check ("haben Sie", "können Sie"), which is a real parser.
* **Only the router path has the backstop.** `guardAddressedNote` runs in
  `createCapture` for captures without a strand. `apply`, `undo` and the
  explicit `strandId` path below do not call it, so a `note` that addresses
  the persona still stays silent there — and gets no question either.
* **`apply` on an unsorted capture keeps the stored intent.** Confirming or
  re-targeting a `note` capture by hand files it into whatever strand the user
  picks, live dialog or not, without running either guard. Less painful than
  the routing path (the user is looking at the capture at that moment), but the
  same silence.
* **`POST /api/captures` with an explicit `strandId` and no `intent` defaults
  to `note`.** A client that posts into a strand and forgets the field gets a
  silent filing; both guards deliberately stay out of that path because an
  intent the client states (or defaults into) is the client's business (SPEC
  4.1, "explicit beats heuristic"). Worth revisiting when the app side is
  known — the honest fix is the app sending the field, not the server
  overruling it.

## From the intent guard (2026-09-14)

* **A `new_strand` cannot be guarded by history.** ~~`guardNoteIntoLiveDialog`
  only fires when the target strand already holds an `assistant` message.~~
  **Closed for the text half (2026-09-14):** `guardAddressedNote` +
  `addressStrength` now upgrade a `note` to an `ask` from the capture's text
  alone, independent of the action, so the incident's shape (`new_strand` +
  `note` + "schau dir das bitte an") gets its answer. What is left is the
  silent half: a capture that opens a new strand, expects something and says so
  in none of the recognised words (see the backstop section above) still rests
  on `ROUTER_INTENT_RULES`.
* **A sub-0.7 append into a live dialog escapes the guard.** SPEC 4.4 turns
  that append into a `new_strand` inside `runRouter`, so the capture service
  only ever sees the fresh strand and the `note` survives.
  **Half closed (2026-09-14):** when the text addresses the persona, the
  backstop catches it after the fact, because it does not look at the action at
  all. Still open for a text without markers: the evidence is there
  (`alternatives[0]` holds the proposed dialog strand), letting the guard read
  it would close the rest, at the price of coupling the two guards.

## From the feed (2026-09-14)

* **A reminder never reaches the feed.** `feed_items` knows the kind
  `reminder`, and SPEC 2.9 names reminders as feed content, but the cronjob
  reminder path (`onInjection` in `bootstrap/runtime-composition.ts`) still
  only broadcasts a `reminder` frame and sends Telegram. It was left alone
  because it pollutes no strand today (it writes into its own reused `task`
  session), so wiring it is a pure gain, not a fix. Four lines plus a test seam
  the composition currently does not offer.
* **Sub-task results go to the feed, not to the strand the chain started in.**
  `resolveTaskStrandOrigin` walks `sessions.parent_session_id`, and a task
  spawned inside a background task has none (`getParentSessionId: () => null`,
  see the attachment follow-up below). Its result is therefore feed-only even
  when the whole chain began in a strand. Fixing the missing lineage hop fixes
  the feed routing for free.
* **A feed-only result does not ring.** `PushDoorbell` addresses a strand the
  app opens; a feed item has none, so cronjob and heartbeat results now reach
  the phone through Telegram and the feed, but not as a push. A `feed` doorbell
  kind (payload pointing at the feed tab instead of a strand) needs the app
  side, which is a separate task.
* **Only the result path writes to the feed.** Progress ticks
  (`task_status_update`) of a background task are now confined to the task's
  own session instead of leaking into whatever strand is open, but they are not
  feed items either. If "what is running right now" should be visible outside a
  strand, it needs its own surface (or a `system` item per task start).

## From task attachments (2026-09-14)

* **`?preview=1` is not a thumbnail endpoint.** The descriptor of an image
  carries `previewUrl: ".../file.png?preview=1&w=400&h=300"`, and
  `packages/web-backend/src/uploads.ts` answers that with an **HTML page**
  embedding the image, not with scaled image bytes. A client that wants a
  thumbnail therefore downloads the full file: a 6 MB screenshot costs 6 MB to
  show at 280 dp. The honest fix is a real scaling endpoint (or `?thumb=1`
  returning image bytes); changing what `preview=1` returns would break the
  viewer that uses it today. Deliberately not built with the attachment work.
* **A task started by another task has no strand of its own.**
  `backgroundTaskToolsOptions` sets `getParentSessionId: () => null`, so a
  sub-task's session has no lineage, and neither its result report nor its
  files can be tied back to the strand the whole chain started in. Both land
  where `resolveInjectionSessionId` points (the strand the user is in), which
  is visible but not necessarily the right one. A `parentSessionId` that
  survives one more hop would fix report and file in one move.
* **Telegram drops the caption of an agent-sent file.** `send_file_to_user`
  now carries `caption` on the upload descriptor (frame + row metadata), but
  `sendUploadToTelegram` still calls `sendPhoto`/`sendDocument` without one.
  Passing it through needs Telegram's 1024-character cap handled, otherwise a
  long caption turns into a failed send instead of a truncated one.
* ~~**A live `attachment` frame glues itself to the last assistant bubble.**~~
  Fixed on 2026-09-15 (`applyAttachmentFrame` in `useChat.ts` plus `messageId`
  on the frame). See "From outgoing attachments" below.

## From TTS format per request (2026-09-19)

* **`POST /api/tts/preview` still ignores the format.** The preview route takes
  `text` and `voice` only and always synthesizes with the saved
  `tts.responseFormat`. That is fine for the settings page (it previews the
  saved configuration) but means a UI that wants to audition WAV at 16 kHz has
  to call `POST /api/tts` instead. Deliberately left alone to keep the change
  inside the request path the clients use.
* **The local `voiceTelegram.ttsUrl` protocol has no format parameter.** The
  fallback path of `POST /api/speech/audio` therefore ignores the new `format`
  field and keeps answering `audio/ogg`. A client asking for WAV on an instance
  without a cloud voice gets Ogg, which it may not be able to play. Making that
  visible would need either a capability field in `GET /api/tts/settings` or a
  415 on that path; both are bigger than this change.
* **Linear interpolation aliases when downsampling.** `resamplePcm` has no low
  pass filter. For 24 kHz to 16 kHz speech on a small speaker the artefacts sit
  above the voice band, but anything that wants quality (music, archival) needs
  a windowed sinc or a real resampler first.
* **No streaming.** WAV at 16 kHz is 32 kB per second and the whole clip is
  built in memory before the first byte goes out, so a 60 second answer is a
  ~2 MB buffer plus the provider latency before playback starts. A chunked
  response (or a per-sentence endpoint) would cut the time to first sound for
  the puck considerably.

## From turn queue per persona (2026-09-19)

* **The WEB frontend ignores `blockedBy`.** `packages/web-frontend/app/composables/
  useChat.ts` only reads `frame.position` (`case 'queued'`), knows no
  `turn_queued`, `blockedBy` or `pendingTurn` (grep: zero hits in
  `packages/web-frontend/app`). The Android companion consumes all of it
  already (`ChatFrameParser`: `"queued", "turn_queued" ->` with
  `blockedBy.toDomain()`; `PendingTurnDto { queued, position, blockedBy }` for
  `turn` and `pendingTurn`), so in the browser the wait stays invisible until
  the same line is built there.
* **`pendingTurn` only exists on the strand DETAIL endpoint.** The app reads it
  as `pendingTurn ?: strand.pendingTurn`, so `{ strand: { pendingTurn } }`
  fits, but `GET /api/strands` (list) and `GET /api/threads` never carry it. A
  home screen that wants to badge waiting strands has to fetch each detail.
* **`turn_queued` is broadcast once, never withdrawn.** There is no
  `turn_started` counterpart; a client has to clear its notice on the first
  turn frame (or `done`/`error`) of that strand. A client that misses those
  keeps a stale "waits behind X" until it refetches `GET /api/strands/:id`.
* **Only the first waiting turn of a strand is reported.** `pendingPositionOf`
  returns the first match, so two queued turns of the same strand look like
  one. Rare (the UI blocks a second send), but a batch importer would see it.
* **The concurrency limit is global, not per user.** `AXIOM_TURN_CONCURRENCY`
  (default 3) caps the whole process; one user with three busy personas can
  make a second user's turn wait for a slot — without any notice, because a
  semaphore wait is deliberately not reported as `blockedBy`. Per-user fairness
  would need a second, per-user semaphore.
* **Turns of two personas now really run in parallel.** Everything they touch
  per persona (AgentRuntime, SessionManager slots keyed `userId:agentId`,
  agent memory dirs) is separated, and SQLite writes are synchronous, but the
  provider rate limits are not: three parallel turns on one provider key can
  produce 429s where the old serialization hid them. Worth watching before
  raising the default.
* **`getPendingMessageCount()` without an argument is now a process-wide sum**
  and no longer says how long anyone waits. Only `ws-chat.ts`'s legacy fallback
  path uses it; it should go once every core in the field has `describeQueue`.
