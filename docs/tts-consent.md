# Explicit TTS consent

TTS uses the normal automatic data-policy gate unless an admin has explicitly confirmed the exact selected account, role, model and voice. A configured account alone is **not** consent. No policy metadata is changed: a `training=yes` provider remains `training=yes` in decisions and audit records.

## Confirmation

Saving a blocked TTS selection through the admin settings API returns HTTP 409 `model_consent_required`, with the provider name, actual synthesis URL, effective region/training policy and scope fingerprint. The web client displays these values and asks once. Only after acceptance does it retry the save with `modelConsentTokens`. The server recomputes the scope; stale tokens are rejected. Implicit provider lookup may be saved but never creates an approval and stays subject to the automatic runtime gate. Disabled read-aloud routes do not prevent saving; while disabled, a newly changed voice-note route still gets its own confirmation. Saving an already confirmed scope does not prompt again.

The scope includes provider ID/type/endpoint, effective model data policy, role (`tts`), model and voice/provider variant. Changing any of these invalidates the matching approval. China-origin and configured blocked-family prohibitions remain hard blocks in every gate mode; consent cannot override them, including a family ban added after approval. Returning to an already approved, unchanged scope may reuse that approval. Read-aloud and an inherited voice-note route share a scope only when the destination, model and voice really match. Distinct voice-note overrides require their own confirmation.

## Persistence and runtime

`config/model-consents.json` is a versioned, atomically replaced, owner-only consent ledger. Back it up before an intentional migration; do not commit live configuration or ledger data. Missing/malformed records fail closed. There is no revoke UI in this patch: an administrator can remove the matching record (or the entire ledger) after backing it up. Returning to an identical previously approved scope otherwise intentionally reuses persistent approval. The generic core helpers are available to other explicitly selected roles, but this patch connects only TTS; no other role is implicitly approved.

Gemini synthesis and its credential resolver use the selected account's configured endpoint, including custom endpoints; only an absent endpoint defaults to Google. A checked/confirmed custom destination is never silently replaced with Google's default endpoint. Provider presets with non-editable URLs continue to resolve to their canonical endpoint. Confirmation URLs omit embedded user/password and query/hash credentials; the fingerprint still binds the full effective endpoint.

Runtime consent applies only when the caller's provider account is explicitly selected. Automatic provider lookup, routing and hosted OpenAI fallback still call the automatic gate and cannot borrow TTS approval. Deepgram's standalone key path is unchanged; it does not receive a fictitious provider-account approval.

Cached read-aloud audio is keyed by the current provider/approval/policy/credential availability, including any automatic hosted OpenAI fallback candidates even for an official OpenAI primary. Revocation, endpoint/policy changes, missing keys and later hard family bans cannot be masked by an old cache hit. No credential value is embedded in cache key material.

A genuine denial is HTTP 403 `tts_policy_blocked`; an absent provider/key remains HTTP 503 `tts_unconfigured` in the speech API. Web and Android distinguish these cases. The Android read-aloud client keeps a policy denial visible instead of silently substituting device speech.

## Review / release

Review the fingerprint against the actual synthesis destination/model/voice and the server's recomputation of the confirmation token. Check that changed selections and automatic fallback stay blocked, keys are checked before consent, and no runtime/config load creates a grant. Keep scoped migration and deployment separate: storing approval does not activate code on a running older build. Run the full remote build/test gates and Android build before an independently approved release; do not self-deploy or restart the live host.
