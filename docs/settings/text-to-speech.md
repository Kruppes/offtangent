# Text-to-Speech

Let the agent talk back in an actual human-sounding voice — used by the "play this message" speaker button in the web chat.

**URL:** `/settings?tab=tts`

## Enabled

Master toggle. When off, no speaker icons disappear from the UI.

```json
{ "tts": { "enabled": false } }
```

## Provider

Which backend generates the audio. Both options reference an entry you already configured on the [Providers](../web-ui/providers) page — the API key / base URL is read from there.

| Value      | Notes                                                                                                                                                                              |
|------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `openai`   | Uses an OpenAI API-Key provider from `providers.json`. Calls its `/v1/audio/speech` endpoint with one of OpenAI's TTS models. Also the type for any **self-hosted OpenAI-compatible** speech server (a provider whose base URL is not `api.openai.com`): that one streams and has a fallback, see [Streaming and fallback](#streaming-and-fallback-openai-compatible-endpoints). |
| `mistral`  | Uses a Mistral API-Key provider from `providers.json`. Synthesises with Mistral's Voxtral voices.                                                                                  |
| `deepgram` | Hosted Deepgram Aura voices. Standalone — does **not** use a provider entry. Uses the API key configured directly in the **Deepgram** card below (stored in `tts.deepgramApiKey`). |
| `gemini`   | Google Gemini TTS via the Interactions API. Uses a **Google** provider from `providers.json` (a Gemini API key). Speaks German natively and takes plain-language stage directions. |

The dropdown lists each matching provider as its own entry, e.g. `OpenAI (My OpenAI)` or `Mistral Voxtral (Mistral Main)`. If no matching provider is configured, the option appears `disabled`.

The selected provider's id is stored in `tts.providerId`; `tts.provider` stores only the backend type:

```json
{ "tts": { "provider": "openai", "providerId": "openai-main" } }
```

## OpenAI model

Shown when provider is `openai`. The model is sent to the selected provider's `/v1/audio/speech` endpoint.

| Value             | Notes                                                         |
|-------------------|---------------------------------------------------------------|
| `gpt-4o-mini-tts` | Newer, supports tone/style instructions. Recommended default. |
| `tts-1`           | Classic, fast, cheap.                                         |
| `tts-1-hd`        | Higher-fidelity version of `tts-1`.                           |

```json
{ "tts": { "openaiModel": "gpt-4o-mini-tts" } }
```

When the selected provider is a **self-hosted** OpenAI-compatible endpoint the
field is free text instead of this list, because such a server names its own
models. It is still validated in shape: letters, digits, `. _ : / -`, at most 80
characters (`TTS_MODEL_ID_PATTERN`), so a typo is a 400 and no URL or prose
ends up in the field.

### Streaming and fallback (OpenAI-compatible endpoints)

A device that starts playing on the first chunk gains nothing from a server
that buffers the whole clip. For the `openai` provider type the backend
therefore has two paths (`shouldStreamTts` in `packages/core/src/tts.ts`):

| Requested format | Path | Why |
|---|---|---|
| `wav`, `pcm` | **streamed**: response headers go out before the first sample exists, every chunk the endpoint produces leaves immediately (`Transfer-Encoding: chunked`, no `Content-Length`) | a later chunk never rewrites an earlier byte |
| `mp3`, `opus`, `flac` | **buffered** as before | frames and Ogg pages are muxed after the last sample |

`pcm` is raw 16 bit little endian mono without a container, `Content-Type:
audio/pcm`; it exists only on this provider type and only because a chunked
stream of headerless samples is the cheapest thing a small device can play
while it is still arriving. `sampleRate` is forwarded to the endpoint as
`sample_rate` when the endpoint is **self-hosted** (hosted OpenAI answers 400 to
the field, so it is never sent there) and echoed as `X-Tts-Sample-Rate` on the
primary path only.

Streaming applies to `POST /api/tts` and to `POST /api/speech/audio`; the web
chat keeps its saved format (usually `mp3` or `opus`) and is unaffected. Note
that an error after the headers have left cannot become a JSON error any more:
the connection is torn down and a warning `[tts] stream aborted after headers`
is logged.

**Fallback to hosted OpenAI.** When the configured endpoint does not answer,
the request is repeated against the hosted OpenAI API instead of failing with
a 500:

- *What counts as "does not answer":* a transport failure (refused connection,
  DNS, abort), no response **headers** within the budget, or a **5xx**. A 4xx
  is a wrong request and is not retried elsewhere, because repeating it would
  only hide the configuration error; an unsupported format is a 400 as well.
- *Header budget:* **3 s** for `wav`/`pcm` (`TTS_FIRST_BYTE_TIMEOUT_MS`, a
  streaming endpoint sends headers early and then speaks for half a minute)
  and **120 s** for `mp3`/`opus`/`flac` (`TTS_BLOCK_TIMEOUT_MS`, those
  containers are muxed after the last sample, so the headers arrive only when
  the whole text is spoken). A dead box is still noticed at once, a refused
  connection does not wait for the timer.
- *Which provider:* the first configured provider of type `openai` whose base
  URL really is `api.openai.com` and that carries a key, excluding the primary
  itself. Without one the original error is thrown and a warning names the
  primary.
- *What it asks for:* model **`gpt-4o-mini-tts`** (`TTS_FALLBACK_MODEL`), the
  configured voice if OpenAI knows it, otherwise **`nova`**
  (`TTS_FALLBACK_VOICE`), the same instructions and the same format. The
  requested `sampleRate` is **not** forwarded and not claimed: hosted OpenAI
  answers in its own rate.
- *What the client sees:* audio, in the format it asked for, plus the header
  **`X-Tts-Source: primary | fallback`** (exposed to browsers via
  `Access-Control-Expose-Headers`). The switch and its reason are logged as
  `[tts] primary voice "<name>" failed (…); falling back to OpenAI
  gpt-4o-mini-tts via "<name>"`.

The fallback exists only on the `openai` provider type. `mistral`, `deepgram`
and `gemini` fail with the provider's error as before.

## OpenAI voice

Shown when provider is `openai`. One of OpenAI's preset voices (`alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, …). The list is loaded live from the OpenAI catalog so the options stay in sync if OpenAI ships new voices.

```json
{ "tts": { "openaiVoice": "nova" } }
```

## OpenAI instructions

_Only shown for `gpt-4o-mini-tts`._ Free-form tone/style guidance for the voice model, e.g.:

```text
Speak calmly, with a slight Viennese accent, medium pace.
```

Leave empty for the neutral default.

```json
{ "tts": { "openaiInstructions": "" } }
```

## Mistral voice

Shown when provider is `mistral`. The UI splits the choice into two side-by-side dropdowns:

- **Speaker** — one of the available Voxtral speakers, annotated with language (e.g. `Nadia (German)`, `Theo (English)`).
- **Mood** — emotional color (`neutral`, `happy`, `serious`, …).

The list is fetched live from the Voxtral catalog when you open the panel. The two selections are combined into a single voice id and stored in `tts.mistralVoice`:

```json
{ "tts": { "mistralVoice": "nadia-neutral" } }
```

## Gemini model

Shown when provider is `gemini`. Any current Gemini TTS model id; the dropdown lists the known ones and keeps an unknown saved id selectable.

| Value                          | Notes                                                       |
|--------------------------------|-------------------------------------------------------------|
| `gemini-3.1-flash-tts-preview` | Current model, streaming-capable. Recommended default.      |
| `gemini-2.5-flash-preview-tts` | Previous generation, cheaper.                               |
| `gemini-2.5-pro-preview-tts`   | Previous generation, higher quality at about twice the cost.|

```json
{ "tts": { "geminiModel": "gemini-3.1-flash-tts-preview" } }
```

## Gemini voice

Shown when provider is `gemini`. One of Google's 30 prebuilt voices (`Charon`, `Kore`, `Puck`, `Zephyr`, …), each annotated with Google's one-word characterisation. `Charon` (informative) is the default and sounds neutral in German.

```json
{ "tts": { "geminiVoice": "Charon" } }
```

## Gemini style instruction

Shown when provider is `gemini`. Optional stage direction Gemini reads before the text, e.g. `Sprich ruhig, klar und in normalem Tempo:`. Gemini has no separate instructions field; the hint is prepended to the text with a blank line. Leave empty for the neutral default reading. Capped at 500 characters.

```json
{ "tts": { "geminiStyle": "" } }
```

### How the Gemini call works

- Endpoint `POST https://generativelanguage.googleapis.com/v1beta/interactions` with header `x-goog-api-key` and the pinned `Api-Revision: 2026-05-20`.
- Every request sends `store: false`. The Interactions API would otherwise retain the interaction (up to 55 days on the paid tier), and what gets read aloud is private chat content.
- Gemini returns raw 16-bit PCM at 24 kHz. Offtangent packages it in-process (no ffmpeg needed): **Opus** becomes an Ogg/Opus file (WASM libopus, 48 kbit/s), **WAV** a RIFF file. `mp3` and `flac` are refused with an error; the UI hides them when Gemini is selected and moves a saved `mp3`/`flac` choice to `opus`.
- Texts longer than 1500 characters are split at sentence boundaries, synthesized per chunk and joined as PCM before encoding, so the joins are inaudible.
- The level is normalised (RMS to −20 dBFS, peaks capped at −1 dBFS) so Gemini's rather quiet output matches other voice notes.

Where the voice is used: the web chat speaker button, `POST /api/tts`, Telegram voice replies, and the companion app's `POST /api/speech/audio` (which prefers the enabled cloud TTS over a local `voiceTelegram.ttsUrl` box).

## Deepgram API key

Shown when provider is `deepgram`. The API key used to authenticate against Deepgram. Stored encrypted at rest in `tts.deepgramApiKey`. Get a free key at [console.deepgram.com](https://console.deepgram.com).

The field is rendered as a password input. Once saved, it shows a masked preview (e.g. `dg_••••••abcd`) — leave the masked value untouched to keep the existing key.

```json
{ "tts": { "deepgramApiKey": "dg_..." } }
```

## Deepgram voice

Shown when provider is `deepgram`. Deepgram bundles voice and language into a single Aura model id (e.g. `aura-2-thalia-en` for an English voice, `aura-2-ophelia-de` for German), so picking a voice and picking a language is one decision.

The dropdown is pre-populated with a small list of common Aura voices. Click the **refresh** icon next to the dropdown to fetch the full, up-to-date voice catalog from your Deepgram account — useful when Deepgram releases new voices. Refreshing requires the API key to be saved first.

Stored in `tts.deepgramModel`:

```json
{ "tts": { "deepgramModel": "aura-2-thalia-en" } }
```

## Voice preview

A text field + play button at the bottom of each provider block. Enter any text, click the speaker icon, hear the current settings applied immediately — no need to save first. Stop playback by clicking the same button again.

## Audio format

Output container format used for the synthesized audio in the web chat.

| Value  | Notes                                                                                                                                |
|--------|--------------------------------------------------------------------------------------------------------------------------------------|
| `mp3`  | Universal default. Supports long-text chunking with Deepgram (see below). Not available with Gemini.                                 |
| `wav`  | Uncompressed, large. Supports long-text chunking with Deepgram (PCM is concatenated and wrapped in a single WAV header). Gemini: PCM wrapped in a WAV header. |
| `opus` | Small. Deepgram: limited to 2000 characters per request (see below). Gemini: Ogg/Opus built in-process, any length.                  |
| `flac` | Lossless. Deepgram only — limited to 2000 characters per request (see below). Not available with Gemini.                             |

```json
{ "tts": { "responseFormat": "mp3" } }
```

This setting is the default, not a lock. `POST /api/tts` accepts a per-request
`format` (and a `sampleRate` for WAV from a PCM provider), and falls back to
the `Accept` header when the body names none, so a device that can only play
WAV works against an instance set to Opus. `POST /api/speech/audio` takes the
same `format` field. Details and the provider matrix are in the
[Voice API](../reference/voice-api) reference.

### Deepgram long-text behavior

Deepgram's `/v1/speak` endpoint rejects any single request longer than
**2000 characters**. To make the “Read message aloud” button work for long
assistant replies, Offtangent transparently splits the input on sentence
boundaries and synthesizes each chunk separately, then concatenates the
result.

Which formats this works for depends on whether the audio container can be
safely concatenated byte-for-byte:

- **`mp3`** — frame-aligned; chunked output is concatenated directly.
- **`wav`** — Deepgram returns headerless PCM (`linear16`); chunks are
  concatenated as raw samples and wrapped in a single WAV header.
- **`opus`** and **`flac`** — use page/frame containers that **do not**
  survive naive concatenation. Inputs **≤ 2000 characters** still work
  normally; longer inputs are rejected with an actionable error asking you
  to switch to `mp3` or `wav` in **Settings → Text-to-Speech**.

The OpenAI and Mistral providers don't have this 2000-character limit and
are unaffected.
