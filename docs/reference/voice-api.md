# Voice API

Speech to text, text to speech, and how a spoken message keeps its recording.

## `POST /api/stt/transcribe`

`multipart/form-data`, JWT protected, field `file` with the audio. The provider
(whisper-url, OpenAI, Ollama, Deepgram) is a server setting, the caller only
uploads bytes. The language comes from `settings.json` (`language`), unless it
is `match`, `auto` or empty, in which case the provider decides.

```
POST /api/stt/transcribe
Authorization: Bearer <access token>
Content-Type: multipart/form-data

file=<recording.m4a>
```

```json
{ "transcript": "the spoken words", "rewritten": "The spoken words." }
```

`rewritten` only appears when the rewrite step is switched on.

### Keeping the recording

```
POST /api/stt/transcribe?keepAudio=1
```

`keepAudio` may also travel as a multipart field. Values `1`, `true` and `yes`
(any case) switch it on, everything else and the missing field mean off, which
is the behaviour Telegram and the web client rely on: **without the flag
nothing is written to disk.**

With the flag the recording is stored through the normal upload path
(`$DATA_DIR/uploads/<YYYY>/<MM>/<DD>/<key>-<name>`) and the answer carries its
descriptor:

```json
{
  "transcript": "the spoken words",
  "audio": {
    "kind": "file",
    "originalName": "recording.m4a",
    "storedName": "2b7c…-recording.m4a",
    "relativePath": "2026/09/14/2b7c…-recording.m4a",
    "urlPath": "/api/uploads/2026/09/14/2b7c…-recording.m4a",
    "mimeType": "audio/mp4",
    "size": 118422
  }
}
```

The file is written **after** a successful transcription, so a provider error
leaves nothing behind. No transcoding happens, the container the client
recorded in is the container that is stored.

`urlPath` is served by `/api/uploads`, which sits behind
`jwtHeaderOrQueryMiddleware`: a Bearer header or `?token=`, otherwise 401.

## Attaching a kept recording to a message

`POST /api/chat/message` (see [Threads API](./threads-api)) accepts an
additional field `attachments`: a JSON array of descriptors for uploads the
server **already** stored. That is what turns a dictation into one message
instead of two, the audio as the attachment and the transcript as the content,
without uploading the same bytes twice.

```
POST /api/chat/message
content=the spoken words
agentId=main
sessionId=<thread id>
clientMessageId=<uuid>
attachments=[{"relativePath":"2026/09/14/2b7c…-recording.m4a","mimeType":"audio/mp4","originalName":"recording.m4a"}]
```

Only `relativePath` is load bearing. It is normalized, refused when it escapes
the uploads directory and has to point at an existing file. Everything else is
re-derived server side: `size` from `stat`, `urlPath` and `previewUrl` from the
resolved path, `kind` from the sanitized `mimeType`, `originalName` from the
sanitized basename. A descriptor that cannot be resolved answers **400**, it is
never silently dropped.

Uploaded `files` and referenced `attachments` may be combined; together they
are capped at five, the same ceiling multer enforces for `files`. Referenced
attachments are listed first. A message with attachments and no text is valid.

The stored row is the usual one: `metadata` holds `{"files":[…]}`, and the
WebSocket frame that starts the turn repeats the descriptors with
`skipSave: true`.

## `POST /api/tts`

JWT protected. Turns text into audio with the provider from
[Settings, Text to Speech](../settings/text-to-speech). Markdown is stripped
before synthesis, the input is capped at 100.000 characters.

```
POST /api/tts
Authorization: Bearer <access token>
Content-Type: application/json
Accept: audio/wav, audio/*;q=0.9

{ "text": "Kurzer Testsatz.", "format": "wav", "sampleRate": 16000 }
```

| Field | Type | Meaning |
|---|---|---|
| `text` | string, required | What to speak. |
| `voice` | string | Overrides the configured voice for this call. |
| `format` | `mp3` \| `wav` \| `opus` \| `flac` | Container for this call only, overrides the saved `tts.responseFormat`. |
| `sampleRate` | integer 8000 to 48000 | Target rate for WAV from a PCM provider. |

The answer is the audio itself: `Content-Type` and the extension in
`Content-Disposition` follow the **effective** format, not the saved setting.
When the server actually resampled, it adds `X-Tts-Sample-Rate: <rate>`; when
it did not, the header is absent and the audio carries the provider rate
(24000 Hz for Gemini and Deepgram). Both headers are listed in
`Access-Control-Expose-Headers`.

### How the format is chosen

1. Body `format`, if present.
2. Otherwise the `Accept` header, if it names a concrete audio type:
   `audio/wav` (also `audio/x-wav`, `audio/wave`) picks `wav`, `audio/ogg` and
   `audio/opus` pick `opus`, `audio/mpeg` and `audio/mp3` pick `mp3`,
   `audio/flac` picks `flac`. The highest `q` value wins, `q=0` rejects a type,
   and `audio/*` or `*/*` alone expresses no preference.
3. Otherwise the saved `tts.responseFormat`.

That order lets a device that cannot set a body field (an ESP32 that sends
`Accept: audio/wav, audio/*;q=0.9`) get playable audio from a server whose
global setting is Opus, while the web UI keeps the saved format.

### Which provider can deliver what

| Provider | `mp3` | `wav` | `opus` | `flac` | `sampleRate` |
|---|---|---|---|---|---|
| `openai` | yes | yes | yes | yes | ignored |
| `mistral` | yes | yes | yes | yes | ignored |
| `deepgram` | yes | yes (from `linear16` PCM) | yes | yes | applied for `wav` |
| `gemini` | no | yes (PCM wrapped in a WAV header) | yes (Ogg/Opus) | no | applied for `wav` |

An unsupported pair is a **400** with a message naming the supported formats.
There is no silent fallback: a client that asked for WAV cannot play the Opus
it would otherwise receive. `sampleRate` outside 8000 to 48000, or not an
integer, is a 400 as well; a rate sent with a non-WAV format or a non-PCM
provider is ignored and no `X-Tts-Sample-Rate` header appears.

Resampling is linear interpolation over the 16-bit samples
(`packages/core/src/pcm-resample.ts`). It is meant for speech on small
speakers, not for archival quality.

### Sizing the audio

WAV is uncompressed: mono 16-bit at 16000 Hz is 32000 bytes per second, at
24000 Hz it is 48000 bytes per second. A client with a fixed buffer (the puck
holds 768 KiB) should ask for `sampleRate: 16000` and keep the text short.

## `POST /api/tts/preview`

JWT protected. Exists so a voice can be tried out **before** it is saved, so it
plays even while `tts.enabled` is off. Same `format`, `sampleRate` and
`Accept` handling as `POST /api/tts`, text capped at 1000 characters.

```
POST /api/tts/preview
Authorization: Bearer <access token>
Content-Type: application/json

{
  "text": "Hi, this is the server voice.",
  "format": "wav",
  "settings": { "provider": "gemini", "geminiVoice": "Kore", "geminiStyle": "Whisper:" }
}
```

`settings` is the unsaved form laid over the stored settings for this one
call. Allowed keys: `provider`, `providerId`, `openaiModel`, `openaiVoice`,
`openaiInstructions`, `mistralVoice`, `deepgramModel`, `responseFormat`,
`geminiModel`, `geminiVoice`, `geminiStyle`. Anything else, including
`deepgramApiKey`, is dropped; a wrong type or unknown provider is a **400**.
Because the stored settings are admin only, a non-admin sending `settings`
gets a **403**; without `settings` any user may preview the saved voice.

## `GET /api/tts/catalog`

JWT protected. Everything a client needs to render the Text to Speech form
without hardcoding lists:

```json
{
  "providers": ["openai", "mistral", "deepgram", "gemini"],
  "formats": ["mp3", "wav", "opus", "flac"],
  "formatsByProvider": { "gemini": ["opus", "wav"], "openai": ["mp3", "wav", "opus", "flac"], "...": [] },
  "openai": { "models": ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"], "voices": [{ "name": "alloy" }, { "name": "verse", "gpt4oOnly": true }] },
  "gemini": { "models": ["..."], "voices": [{ "name": "Charon", "style": "Informative" }], "defaultModel": "...", "defaultVoice": "Charon" },
  "accounts": [{ "id": "…", "name": "Google", "providerType": "google", "ttsProvider": "gemini" }]
}
```

`accounts` lists the configured provider accounts that can back a TTS
provider (id, name and type only, never a key); `ttsProvider` says which
`tts.provider` value the account belongs to (`google` accounts back `gemini`).
Mistral voices and Deepgram models stay dynamic (`GET /api/tts/voices`,
`GET /api/deepgram/models`).

### Playback in the browser

The web UI asks for a container the running browser can decode
(`packages/web-frontend/app/utils/ttsPlayback.ts`): the saved format when
`canPlayType` accepts it, otherwise the first of `mp3`, `wav`, `opus`, `flac`
the provider can build. Safari before 18.4 has no Ogg/Opus, so a Gemini setup
saved as `opus` is played there as WAV. A `play()` rejected with
`NotAllowedError` (autoplay policy) keeps the audio and turns the button into
"Play now"; a `NotSupportedError` or `MediaError` is shown as a format hint
instead of a silent dead button.

## `POST /api/speech/audio`

The companion app route ([Companion App](../guide/companion-app)) summarizes
first and then speaks the summary. It accepts the same optional `format` field:

```
POST /api/speech/audio
Authorization: Bearer <access token>
Content-Type: application/json

{ "messageId": 12345, "format": "wav" }
```

- `format` is one of `mp3`, `wav`, `opus`, `flac`; anything else is
  **400** `{ "error": "invalid_format" }`.
- It only reaches the **cloud** voice (`tts.enabled`). A provider that cannot
  build the container answers **400** `{ "error": "unsupported_format" }`.
- The fallback path to a local `voiceTelegram.ttsUrl` box ignores `format` and
  always answers `audio/ogg`, because that protocol has no format parameter.
- There is no `sampleRate` here; the app plays what the provider produces.

The `Content-Type` of the answer follows what was produced, next to the
existing `X-Speech-Language` and `X-Speech-Summary-Chars` headers.

## Retention

A kept recording is an upload like any other. `cleanupExpiredUploads` deletes
the files of every message older than `uploads.retentionDays` (default 30) and
clears that row's `metadata`; the transcript stays as the message content.
There is no separate audio retention and no special case.

One gap worth knowing: a recording kept by `keepAudio=1` that never reaches a
message (the client dies between the two calls) is not referenced by any row
and therefore not swept, because the sweep walks messages, not the upload tree.

## Telegram

Unchanged. A Telegram voice message is downloaded, transcribed and buffered as
`🎤 Voice: <transcript>`; the OGG is not stored and no descriptor exists for
it.
