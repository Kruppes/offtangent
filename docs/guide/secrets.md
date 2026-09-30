# Secrets

Passwords, tokens, PINs and card numbers do not belong in a model prompt. The
agent therefore keeps a small store of **sealed secrets**: the value stays on
your server, everything else — the transcript, the model request, the logs, the
Telegram copy — only ever sees a **handle** like

```text
{{secret:router-password-1}}
```

A handle is a name for a value, not the value. You can read it, copy it, paste
it into another message, and show it in a screenshot without giving anything
away.

## What is detected

When you send a message, the server scans the text **before** it is stored,
before a model sees it, and before a tool runs:

- **Token shapes** — provider keys, personal access tokens, JWTs, PEM private
  key blocks, access keys, `https://user:password@host` URLs, card numbers that
  pass the Luhn check.
- **What you say about a value** — a line like "the PIN is 4711" or
  "password: hunter2-correct-horse" is recognised by its context word, so a
  human-chosen password without any token shape is caught too.

Anything recognised is replaced by a handle, and the handle is what gets stored.
The original text is not kept anywhere.

Values you file yourself through **Settings → Secret handles** are sealed the
same way; they simply skip the detector because you already told the server what
they are.

## How the model sees it

The model receives the message with the handle in place of the value:

> Alice: log into the router with <code v-pre>{{secret:router-password-1}}</code> and check the
> DHCP lease list

The model can reason about it, pass it on, and write it into a command. It never
receives the characters of the value, so nothing it sends to a provider can leak
them — not in a prompt, not in a summary, not in a tool argument echoed back.

## Only the shell tool resolves a handle

A handle turns back into a value at exactly one place: the **shell tool**, at
the moment the command is executed. <code v-pre>curl -u alice:{{secret:router-password-1}}</code>
therefore works, while the command line kept in the transcript and in the tool
log still shows the handle.

Every other tool receives the handle as literal text. That is deliberate: a tool
that posts a message, writes a file, or asks a model would carry the value out
of the server again.

## Use the form, not dictation

Reading a secret into the chat works, but it is the weaker path: the value
travels through the browser, and speech transcription happens before the sealing
step, so a spoken value exists as text for a moment.

The reliable way is **Settings → Secret handles → Add a secret**:

1. Paste the value into the password field (there is a show/hide toggle).
2. Pick the kind, e.g. `password` or `github-token`.
3. Optionally give it a name — otherwise a name is derived from the kind.
4. Store it. The answer is the handle, never the value again.

From then on you write the handle into prompts, tasks and cronjobs.

## Blind spots

Be aware of what the boundary cannot see:

- **Images and PDFs** — a screenshot of a password, a scanned contract, a photo
  of a card: the detector reads text, not pixels. Attachments are passed to the
  model as-is.
- **Audio** — a value you speak is transcribed first and sealed only after that,
  so the transcript step sees it.
- **Files you point the agent at** — `read_file` output *does* pass the tool
  boundary (structural `strong` tier plus every already known value), but not
  the context rules a chat message gets: a password in a file that has no shape
  and was never sealed is not recognised.
- **A value you paste in pieces** — split across two messages, neither half
  looks like a secret.
- **A tool that encodes its output** — `… | base64` hides a value from every
  pattern. Once the value has been sealed once it is known and redacted from
  then on; see [Password-manager CLIs](#password-manager-clis).

So: for anything that matters, use the form. If a value did reach a model,
rotate it — that is cheaper than hoping.

## Grenzen (limits of the boundary)

The boundary is about **storage and model context**. It is not a data-loss
firewall, and these are the sharp edges. They are deliberate, not oversights —
each one has a concrete reason.

- **A resolved handle can leave the machine.** The `shell` tool substitutes
  <code v-pre>{{secret:…}}</code> with the plaintext, and a shell command can talk to any host:
  `curl -d "$(…)" https://example.com`, `ssh`, `git push`, a DNS lookup. Nothing
  inspects the *egress* of a resolved value. The boundary guarantees that the
  value is not stored in the chat log and not sent to a model — not that a
  command cannot carry it somewhere. Binding a handle to specific hosts (a
  handle usable only against `router.lan`, for example) is planned; until then
  the trust model for `shell` is unchanged: whatever you let the agent run, it
  can run with your secrets.
- **Transformation defeats known-value redaction.** Redaction is a literal
  search for known strings. `base64`, `gzip`, `rev`, a per-character split or
  `${VAR:0:8}` all produce text that contains no known value, so nothing is
  replaced. The vault-CLI path is fail-closed for exactly this reason (see
  above), but for arbitrary commands the rule holds: a value that is
  re-encoded is invisible to the index.
- **Indirection can hide the vault CLI.** The detector reads the command text,
  including quoted parts and `sh -c`, `bash -c`, `eval` and `xargs` pipelines.
  It does not evaluate the shell: `B=bw; $B get password x`, a wrapper script
  `/data/bin/get-pw.sh` that calls `bw` internally, or a command assembled from
  variables are not recognised as vault invocations, and their output is only
  covered by the ordinary structural detection. Conversely the text scan is
  conservative: `grep -r "bw get password" docs/` fires, because a quoted
  pattern is indistinguishable from a quoted command. The output of that one
  command is then sealed — noise in the safe direction.
- **Values shorter than six characters are not replaced globally.** The form
  refuses to store them (`value_too_short`), and a shorter value that is
  already in the store is not searched for in tool output or messages: a
  four-digit PIN would rewrite every port number, date and line number that
  happens to contain those digits. Resolving such a value **through its
  handle** keeps working; only the global search-and-replace has this floor.
- **Background jobs can be skipped instead of downgraded.** A background job
  without its own model (session summary, fact extraction, memory
  consolidation, plan verification) falls back to the active chat model. That
  fallback is an automatic model choice and passes the model gate. If the
  active provider is blocked by the data policy, the job is **skipped** and an
  audit entry is written under `<role>:fallback:active_provider` — it is never
  moved to a different model nobody chose. In mode `audit` the run is allowed
  and recorded. See [Models and the data policy](./models.md).

## Password-manager CLIs

A vault password has no shape. `ghp_…` and a PEM block are recognisable, a good
password is just characters — so the detector cannot see it, and the known-value
list cannot know it the first time it appears. Reading an entry from a
password manager would therefore put the plaintext into the model context.

The boundary closes that by looking at the **command** instead of the output.
When a `shell` call runs a Bitwarden-compatible CLI (the `bw` command word, also
behind `export PATH=…;`, `&&`, `|`, `` ` ``, `$(…)`, wrappers such as `timeout`,
or as an absolute path like `/data/bin/bw`), its output is treated as
secret-bearing before anything else happens:

| What you run | What the model gets |
| --- | --- |
| `bw get item <id>`, `bw list items` (JSON) | the same JSON, with the secret fields replaced by handles |
| `bw get password\|totp\|notes\|attachment <id>` | one handle for the whole output |
| `bw unlock`, `bw login`, `bw generate`, anything with `--raw` | one handle for the whole output (this is how a session key is captured) |
| `bw export …` | a notice — an export never enters the context |
| output piped through `jq`, `python`, `sed`, … | fail closed: every line that is not a known harmless status line becomes <code v-pre>{{secret:redacted}}</code> |

The fields sealed inside JSON are `login.password`, `login.totp`, `notes`,
`fields[].value` for hidden fields (`type: 1`), `card.number`, `card.code`,
`identity.ssn`, `identity.passportNumber`, `identity.licenseNumber`,
`sshKey.privateKey` and `passwordHistory[].password`. Item names, ids,
usernames, URIs, folders and visible custom fields stay readable, so the agent
can still tell entries apart.

Handles get a speaking slug from item name and field, e.g.
<code v-pre>{{secret:vw-router-login-password}}</code>, and are stored with kind and source
`vaultwarden`, so they show up in **Settings → Secret handles** like any other
sealed value. They behave like any other handle afterwards: a later
<code v-pre>curl -u user:{{secret:vw-router-login-password}}</code> resolves to the real value
inside the shell tool, and the value is redacted in every later output — an
`echo` of it, a config file that contains it, a log line.

Limits, on purpose:

- **Transformed output loses its labels.** Once the output went through `jq` or
  a script, the boundary can no longer tell an item name from a password, so it
  redacts whole lines. Ask the CLI for the field you need instead of reshaping
  its JSON.
- **A tool can obfuscate its own output.** `bw get password … | base64` produces
  a string the boundary has never seen and cannot match. What helps is the
  second pass: after the value has been sealed once, it is a known value and is
  redacted wherever it turns up later, in any command.
- **Other password managers** are not detected by name yet; only the
  Bitwarden-compatible `bw` CLI is. Everything else falls back to structural
  detection plus known values.

## Credential files

Values that only exist in a file are known values too. The boundary reads the
directory that holds `secrets.json` and `<DATA_DIR>/secrets` (override with
`SECRET_FILE_DIRS`) and takes:

- `KEY=VALUE` lines from env files (quotes and `export` are handled),
- a PEM private-key block as a whole,
- a file that contains a single token on one line (session keys).

Those values are redacted **opaquely**: they turn into <code v-pre>{{secret:redacted}}</code>,
they never become a handle and nothing is written to the store — reading a
credentials file must not create new secrets. `cat secrets/service.env`
therefore shows the keys but not the values. The list is re-read when a file's
size or modification time changes.

Not covered: subdirectories, JSON credential bundles (`settings.json` lives in
the same directory, and treating every JSON string as a secret would redact
prose), binary keystores, and values shorter than the minimum length.

## Renaming and deleting

- **Renaming** is only possible while the handle is not yet referenced in a
  stored message, tool call, capture or routing decision. Old text is not
  rewritten, so a rename would break every reference — the UI refuses it with a
  clear message instead.
- **Deleting** always works. Text that still contains the handle simply stops
  resolving: the shell tool then passes the handle through unchanged and the
  command fails, which is the safe direction.

## Where the values live

Sealed values are encrypted with the server's `ENCRYPTION_KEY` and stored next
to the encrypted environment variables in `config/secrets.json` — not in the
database, which is copied around as a backup. Identical values are stored once
and share a handle.

That deduplication uses an **HMAC-SHA256 under a key derived from
`ENCRYPTION_KEY`** (own context string), not a plain hash of the value. A plain
hash in the file would let anyone holding a copy of `secrets.json` test a
*candidate* value ("is the PIN 4711?") without the key — a guessing oracle for
everything with low entropy. The API answer of `POST /api/secrets/handles`
deliberately does not say whether a value was already stored either; a new and
a duplicate value produce the same response shape. An entry written before this
change (plain SHA-256) is recognised once and rewritten in the new form, so no
value ends up stored twice.

A detail with operational consequences: the dedup hash **cannot be reproduced
on another instance**. Restoring a `secrets.json` onto an instance with a
different `ENCRYPTION_KEY` makes the values undecryptable anyway; a key change
without a re-seal leaves stale hashes, and the next seal of the same value
creates a second entry instead of matching the old one.

Known values are collected from `secrets.json`, the provider config,
credential-looking `process.env` names and the secret files. The two scanning
parts of that — the filesystem walk (`readdir` + `stat`) and the pass over all
of `process.env` — are checked **at most once every five seconds**, because they
run on every redaction pass. A secret file you edit by hand or an env var set at
runtime therefore takes effect after at most five seconds; restarting makes it
immediate. The `stat` of `secrets.json` and `providers.json` is *not* throttled,
so a value sealed in one channel is redacted in every other channel right away —
that is the case where a delay would be a hole rather than a latency.

What the boundary costs, measured with `node scripts/bench-secret-boundary.mjs`
(not part of the test suite; synthetic data, 50 known values including a PEM
block): `redactKnown` 0.9 ms on 1 MB and 4.2 ms on 5 MB of tool output,
`detectSecrets` in the `strong` tier 9.7 ms on 1 MB and 91.0 ms on 5 MB, and
`sealSystemText` 0.8 ms on a 100 KB system prompt. The system prompt is sealed on
every `buildSystemPrompt()` call since the task-channel fix, so that last number
was the one to check — at well under a millisecond it needs **no result cache**,
and not keeping one also means no plaintext system prompt lingers in a cache map.
The five-second throttles are what make the hot path cheap: 10 000
`secretFilesSignature()` calls over 20 secret files cost 0.5 ms throttled versus
636.9 ms when every call stats again, and 2000 `redactKnown()` passes over a 4 KB
text cost 38.9 ms instead of 181.3 ms (file scan per call) plus 79.1 ms (env scan
per call) — roughly a sixfold drop on the hot path.

See also: [Secrets API](/reference/secrets-api) for the REST contract.
