# Secrets

API keys, bot tokens, and any other sensitive value the agent needs at runtime — stored in `/data/config/secrets.json` and injected into the container.

**URL:** `/settings?tab=secrets`

> **Write-only from the UI's perspective.** Offtangent never returns existing secret values — the list shows a masked preview (e.g. `sk-••••••1234`). To change a secret, type the new value; the old one is overwritten.

## What lives here

Typical entries that *do* belong here:

| Key                | Used by                                                                                       |
|--------------------|-----------------------------------------------------------------------------------------------|
| `GH_TOKEN`         | `gh` CLI tool (also raises the GitHub API rate limit when the skill installer fetches skills) |
| `<ANY_CUSTOM_VAR>` | Any user-installed skill that reads `process.env.<…>`                                         |

## Adding a secret

Two fields at the bottom of the panel:

- **Key** — uppercase letters, digits, and underscores only, must start with a letter. Regex: `^[A-Z][A-Z0-9_]*$`. Examples: `OPENAI_API_KEY`, `MY_CUSTOM_TOKEN_2`.
- **Value** — the secret itself. Masked by the password input.

Click **Save** to persist. Invalid keys (or duplicates of an existing one) are rejected inline with a message.

## Editing an existing secret

Click the ✎ icon next to a secret to reveal an inline input, type the new value, click **Save**. The previous value is overwritten, not appended.

## Deleting a secret

Click the 🗑 icon. A confirmation dialog shows the key name; confirming removes the entry from `secrets.json`. Anything referencing that key will fall back to its default behavior (e.g. the OpenAI provider will refuse to start if its key is gone).

## Where they end up

- Written to `/data/config/secrets.json` (mode `0600`, chowned to the container user).
- Never logged, never returned via API, never included in the system prompt.
- Available to provider modules and tools via the runtime secrets accessor.

Also readable from `$SECRET_NAME`-style environment variables at container start — see [Environment Variables](../reference/env-vars) for the precedence rules between env vars and `secrets.json`.

## Backup & rotation

`/data/config/secrets.json` is part of the normal `/data` volume. Back up the volume and you have your secrets. Rotate a key by saving the new value in the UI; the change takes effect immediately on the next request that uses it.
