# Strand content

> Build-wave notes for the strand transcript UI. Contributor material, moved here from `docs/`
> because it documents frontend decisions, not user-facing behavior. The REST contracts
> themselves live in `docs/reference/strands-api.md` and `docs/reference/projects-api.md`.

The product owner requested a readable strand transcript without weakening session ownership.

## Ownership and lifecycle

- `resolveFrameSession` is a pure function: an explicit session wins; only an explicit persona may fall back to that persona's last active strand. Unattributed frames are dropped. Feed frames and connection pongs are processed separately, never appended to the transcript.
- Task result notifications currently can lack both identifiers. They are intentionally not guessed into an open strand. Persisted history and the session-bound task tree provide catch-up.
- History requests cannot overwrite the transcript after navigation to another strand.
- Progress follows existing `queued`, `thinking`, `tool_call_start`, `tool_call_end`, `text`, `done`, `error`, and replay frames. The initial waiting state starts on local send; timestamps measure client-observed elapsed time, not server CPU time.
- The existing `/stop` command stops all of the current user's turns. The button explicitly names that scope. A local stop request freezes the clock even without an attributed acknowledgement or terminal frame; it is labelled **Stop requested**, not falsely confirmed by the server. Disconnect also freezes the clock without claiming completion. No new protocol or endpoint was introduced.

## Presentation

Adjacent tool calls collapse into one keyboard-operable group. Individual results remain expandable. Live tool durations use observed timestamps; completed historic calls without timing data do not invent durations. Code fences expose language and a copy button; inline code remains distinct. Attachments retain authenticated image preview, full-screen viewing, and download.

Persona initials and labels use the authenticated client persona catalogue; validated persona color is a border accent, not a low-contrast text color. Transcript loading, failure, empty entry, and content remain distinct.

## Tasks and interactive content

Task activity remains keyed by originating strand; children derive their indentation from the parent chain. Input and output tokens are directional, costs appear when supplied, and task details use the existing incremental timeline cursor rather than reloading the entire history. The transcript loads completed tasks too, so a fresh visit does not lose completed cards. Provider/model enrichment is separately cached and cannot overwrite live usage. Single-task pages are accessible to members; the existing backend ownership checks remain authoritative, while the administrative task list stays restricted.

Artifacts use an opaque-origin iframe (`sandbox="allow-scripts"`, never `allow-same-origin`), credentialless/no-referrer embedding and restrictive document CSP. App credentials are never placed in its document. HTML/SVG/PNG are the backend-supported artifact kinds. No message listener or application bridge is added.

Interaction cards use the shared contract's rendered types (`choice` and `confirm`); its reserved `multi`, `handover` and `schedule` kinds retain the contract's readable numbered-list fallback. They use only the shared contract's actual block types and post with a client interaction identifier. Existing/stale answers are handled server-authoritatively; answered blocks collapse to a chip. The text alternative remains visible. Telegram fallback remains the existing backend behavior, not a new frontend-only block format.

## Verification scope

Frontend unit/render gates, typecheck, build, lint and secret scan are mandatory. Live evidence and screenshots are recorded separately from source, with credentials excluded. Read-only audit found historical unattended task results in interactive sessions; these are not secretly filtered from persisted history. This UI work neither rewrites those rows nor proves that historical backend producers never contaminated a strand.

Unattributed command replies and binding errors are also not guessed into a strand. This is a backend attribution limitation, not an excuse to weaken isolation; strand header model controls use the existing explicit REST contracts.
