# Companion App (Android)

There is a native Android client for Offtangent. It is a thin client: it holds no model, no memory and no logic of its own, and it talks to the same REST and WebSocket API as the web UI. Everything it shows lives on your instance.

::: warning Source not public, build on request
The app's repository is **not** public and the app is **not** in any app store. A built package is provided on request — ask the maintainer by opening an issue on the [Offtangent repository](https://github.com/Kruppes/offtangent).
:::

::: danger What this page can and cannot tell you
The app's sources are not in this repository, so **nothing here is verified against the app's implementation.** Everything below is derived from the server side: the endpoints the backend exposes, the contracts its tests pin down, and the code comments that name the companion app as the consumer.

Read the feature list as *"the server supports this and it exists for the app"*, not as *"the shipped app does this in this build"*. Where the two disagree, the app wins and this page is wrong. Nothing about the app's UI, its offline behaviour, its release history or its actual feature completeness is claimed here, because none of it is checkable from this repository.
:::

## What the server offers it

Each bullet names the endpoint it rests on, so you can check the claim yourself.

- **Capture on the move.** A text field that posts to `POST /api/captures` without asking which strand the thought belongs to. The router files it, the app shows where it went, and the filing is reversible.
- **Voice recording with server-side transcription.** `POST /api/stt/transcribe` takes the raw audio and returns the transcript; the provider (whisper-url, OpenAI, Ollama, Deepgram) is a server setting and the caller only uploads bytes. Transcription therefore happens **on your instance**, whatever the app does locally. Captures carry `source: "android"` and, for spoken ones, `kind: "voice"` — both values are exercised in the backend's capture tests.
- **Spoken output.** `POST /api/speech/summary` turns a long written answer into a few spoken sentences in the language of the source; `POST /api/speech/audio` returns the spoken audio for the same content when a TTS voice is configured: the enabled cloud TTS from [Settings → Text-to-Speech](../settings/text-to-speech) (Ogg/Opus with Gemini), otherwise a local `voiceTelegram.ttsUrl` service. An optional `format` field in the body picks the container for one call on the cloud path, see [Voice API](../reference/voice-api). A written answer full of tables, paths and hashes is unusable read aloud, so the server condenses it first.
- **Push notifications.** The app registers its FCM token with `POST /api/push/devices` and gets a doorbell when a turn finishes, a task reports back, or a background task asks a question.
- **A tray for unsorted captures.** `GET /api/captures?status=unsorted` (and `needs_review`) is the queue of things the router could not place confidently. You file or dismiss them when you have a minute, not at the moment the thought arrived.
- **Reading and answering strands.** The strand list, the now set and live turns over the same WebSocket the web UI consumes. Backend comments name the companion app as a consumer of the thread/strand routing, and `/api/personas/client` exists specifically as the non-admin persona list a native client can read.

## The API it runs against

Nothing in the app is a private protocol. Each of these reference pages describes an endpoint the app uses, and the same endpoints are available to any other client you might write:

| Area | Reference |
|---|---|
| Login, access/refresh tokens, device sessions | [Auth API](../reference/auth-api) — see the *Client checklist (native apps)* section |
| Posting captures, the tray, apply/undo/dismiss | [Captures API](../reference/captures-api) |
| Strand list, now set, tags, per-strand model pin | [Strands API](../reference/strands-api) |
| Recording upload and transcription | [Voice API](../reference/voice-api) |
| Push device registration and doorbell payloads | [Push API](../reference/push-api) |

Authentication is the ordinary JWT flow: `POST /api/auth/login` with a `deviceName`, `Authorization: Bearer <access token>` on every call, `?token=<access token>` for `/api/uploads` and the WebSocket handshake, and a serialized refresh on `401`. Parallel refreshes with the same refresh token trip replay detection and kill the session — that is deliberate. Registered devices are listed and revocable under `GET /api/auth/sessions`.

## Pointing the app at your instance

1. Have your instance reachable over **HTTPS** from the phone. That normally means a reverse proxy with a real certificate in front of the container; the app is a normal HTTPS client and will not accept a self-signed setup for you.
2. On first start, enter the **server URL** of your instance (e.g. `https://offtangent.example.com`).
3. Log in with an account **on that instance** — the same credentials you use in the web UI. There is no hosted account, no sign-up, no central directory. The app has no default server.
4. Give the device a recognisable name at login so you can identify and revoke it later under `GET /api/auth/sessions`.

## What has to be running on the server

| Feature | Requirement |
|---|---|
| Everything | A reachable HTTPS URL for the instance, and a user account on it. |
| Voice capture | A configured speech-to-text provider — see [Settings → Speech-to-Text](../settings/speech-to-text). Without it, recording has nothing to transcribe with. |
| Spoken output | A configured TTS endpoint — see [Settings → Text-to-Speech](../settings/text-to-speech). Without one, `POST /api/speech/audio` answers **503** `tts_unconfigured`; the text summary still works. |
| Push notifications | Optional. Mount a Firebase service account JSON and point `FCM_SERVICE_ACCOUNT_FILE` at it ([Environment Variables](../reference/env-vars), [Push API](../reference/push-api)). Missing or unreadable means push is simply off; nothing else changes. |

### A note on push and privacy

By default a doorbell carries **no message content** — only routing information and short labels — and the app fetches the actual text through the authenticated API afterwards. Google's servers see that something happened, not what. `PUSH_PREVIEW_CHARS` lets you trade that away deliberately: a positive value (capped at 300) adds an excerpt of a finished turn and replaces the persona label with the strand title, both of which then pass through Google. Task results, questions and failed turns never carry an excerpt regardless of the setting.

## Limits to expect

- **Android only.** The push device registry accepts `android`, `ios` and `web` as platform values (`ALLOWED_PLATFORMS` in the push schema), and defaults to `android`. That the Android client is the only native one that exists is a statement about the project, not something this repository proves.
- **No offline mode is documented here.** The app is a client of your instance; when the instance is unreachable, assume the app is too. Whether it queues captures locally is an app-side question this repository cannot answer.
- **Versions are not tracked in this repository.** The app sends an `appVersion` string when registering for push (free text, up to 64 characters), but its release history lives with the app, not here.
- **Feature parity with the web UI is not guaranteed.** The backend serves both, but which endpoints a given app build actually calls is not visible from here.

If you want the same functionality without a native app, the web UI is a normal responsive web app and works in a mobile browser; Telegram is a third route — see the [Telegram Bot](./telegram) guide.
