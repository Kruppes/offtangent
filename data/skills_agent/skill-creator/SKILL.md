---
name: skill-creator
version: 1.0.1
description: Create or update an agent skill — a SKILL.md file under /data/skills_agent/<name>/ that captures a reusable workflow you can load on demand later. Use when the user asks to "save this as a skill", "create a skill", "remember this workflow", or when you spot a recurring pattern across conversations that's worth extracting.
---

# Skill Creator

Agent skills are how you teach yourself new workflows in Offtangent. They live as plain Markdown files on disk and get auto-discovered on the next message — no restart, no code change.

This skill walks you through creating them correctly the first time, so the file you write actually shows up in `<available_skills>`, gets routed to when relevant, and doesn't fail validation.

## Where skills live in Offtangent

| Type | Directory | Who writes it | Editable from chat? |
|---|---|---|---|
| **Agent-created** (this skill creates these) | `/data/skills_agent/<name>/` | You, at runtime | **Yes** — write_file/edit_file |
| Built-in (shipped with Offtangent) | `/data/skills_agent/<name>/` (seeded from `/app/skills_agent_defaults/` on container start) | The Offtangent project | Technically yes, but they get auto-overwritten on update unless you set `managed: false` |
| User-installed | `/data/skills/<owner>/<name>/` | The user, via the web UI installer | No — managed via Settings → Skills |

→ **Always write to `/data/skills_agent/<name>/SKILL.md`.** Never write to `/data/skills/` (user space) or `/app/skills_agent_defaults/` (read-only image).

## When to create a skill

Create one when **all** of these are true:
- The workflow is **reusable** — you'd follow roughly the same steps in multiple future conversations.
- It has **structure** — there's a clear sequence of tool calls, conventions, or decision points that benefit from being written down.
- It's **about *how* to do something**, not *what is known* about something.

### Skill vs. wiki vs. tool

| Need | Right home |
|---|---|
| "How do I ingest a podcast transcript and distill it into a wiki page?" — a workflow | **Skill** |
| "What does our deployment architecture look like?" — knowledge | **Wiki page** under `/data/memory/wiki/` |
| "Read a file from disk." — atomic operation | **Built-in tool** (`read_file`) — already exists, don't reinvent |
| "Remember that the user prefers German." — a fact | **User profile** under `/data/memory/users/<username>.md` |

### When NOT to create a skill

- One-off task ("rename this file"). Just do it.
- Already covered by a built-in tool (`web_fetch`, `shell`, `read_file`, …). Skills *use* tools, they don't replace them.
- Pure knowledge with no workflow ("Project X uses Postgres"). That's a wiki page.
- The user explicitly said "don't save this".

If in doubt, **ask the user first.** Skills are the agent's long-term memory of *how to work* — wrong skills create lasting friction.

## Anatomy of a SKILL.md

Two parts: YAML frontmatter (the contract with the runtime) and a Markdown body (what you read when the skill activates).

```markdown
---
name: my-skill
description: One or two sentences explaining when to use this skill. This is the routing signal — the agent only sees this in the prompt index, so be specific about triggers.
# Optional fields below — omit if not needed
version: 1.0.0
required_env_vars: [SOME_API_KEY]
requires_toolsets: [web_fetch]
platforms: [linux, macos]
---

# Skill Title

Body content — instructions, operations, tool sequences, examples.
```

### Required frontmatter

- **`name`** — must match `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`:
  - Lowercase only
  - Alphanumeric + hyphens
  - Must start and end with alphanumeric (no leading/trailing hyphen)
  - 1–64 characters
  - Examples ✓: `code-reviewer`, `nitter`, `daily-summary`, `pdf2md`
  - Examples ✗: `My-Skill` (uppercase), `-foo` (leading hyphen), `web__fetch` (double-special), `a really long name` (spaces)
  - The directory name **must equal** the `name` field.

- **`description`** — the routing signal. The agent reads only the description in the prompt; it doesn't read the body until it decides this skill is relevant. Rules of thumb:
  - **Specific triggers**: name the kinds of user requests that should activate this skill ("Use when the user asks to summarize a YouTube video").
  - **Concrete domain**: say what it operates on ("YouTube transcripts via yt-dlp", not "video stuff").
  - **One or two sentences** — long enough to be unambiguous, short enough to skim.
  - Bad: *"A skill for handling things related to RSS."*
  - Good: *"Fetch and summarize RSS feeds. Use when the user asks to check feeds, summarize new entries from a feed URL, or set up a recurring digest."*

### Optional frontmatter (Offtangent-specific)

- **`version`** — semver string (`1.0.0`). Only meaningful for built-in skills (the entrypoint uses it for auto-update). Agent-created skills can include it for your own bookkeeping but it has no runtime effect.

- **`required_env_vars`** — list of env-var names the skill needs. Missing vars **don't hide** the skill — they annotate it in the prompt with `⚠ requires: VAR_NAME` so you can warn the user instead of silently failing. Use this when the skill calls an external API.

- **`requires_toolsets`** — list of built-in tool names the skill depends on (e.g. `web_fetch`, `web_search`, `shell`, `transcribe_audio`). If the user has disabled any of these, the skill is **hidden entirely** from the prompt to avoid noise.

- **`platforms`** — list of `linux`, `macos`, `windows`. Production Offtangent always runs on Linux (Docker), so this is rarely needed. Only set it if the skill calls platform-specific binaries (e.g. `pbcopy`, `xdg-open`).

- **`managed: false`** — opt-out for built-in skills only. Don't set this on agent-created skills.

### The body

The body is what you'll read when the skill activates. Treat it as **instructions for yourself in a future conversation**, not prose. Strong skills:

1. **Open with one line** stating what the skill does and which `/data/...` paths it touches.
2. **Use absolute paths** (`/data/memory/wiki/`, `/workspace/`) — never relative.
3. **Break work into named operations** (e.g. `## Ingest`, `## Query`, `## Lint`). Each operation = explicit numbered steps with tool sequences.
4. **Show the exact tool calls**: `web_fetch → write_file → list_files → edit_file`. Don't make future-you invent the workflow from a description.
5. **Include 1–2 worked examples** with realistic inputs.
6. **End with edge cases and "when *not* to use this skill"**.

If the skill ships helper files (scripts, templates, prompt fragments) in its directory, reference them with the `{baseDir}` placeholder. The runtime substitutes it for the skill's actual directory when you `read_file` the SKILL.md:

```markdown
Run the import script: `bash {baseDir}/scripts/import.sh <url>`
Use the template in `{baseDir}/templates/report.md`.
```

`{baseDir}` only resolves when reading the SKILL.md itself. Inside helper files you read separately, the placeholder is not substituted — write absolute paths there.

## Operations

### Create — Write a new skill

1. **Slugify the name.** If the user said "Wiki Auditor", the directory and `name` field both become `wiki-auditor`. Lowercase, hyphens for word boundaries, no special characters.

2. **Choose the directory.** Always `/data/skills_agent/<name>/`. If a directory with that name already exists, **stop and check**: is this an update to an existing skill? An overwrite? A name collision? Ask the user before clobbering.

3. **Draft the frontmatter.** Required: `name`, `description`. Add gating fields only if the skill genuinely needs them — every gate is a chance to be hidden when you'd actually want to use it.

4. **Draft the body.** Pull the actual workflow from the conversation. If you're extracting a pattern you noticed across conversations, restate the pattern explicitly in the first sentence.

5. **Write the file** with `write_file`:
   ```
   write_file /data/skills_agent/<name>/SKILL.md
   ```
   No need to `mkdir` — `write_file` creates parent directories.

6. **Confirm to the user.** Show the `name`, `description`, and `location`. Mention that it will appear in `<available_skills>` from the **next message** onward (no restart). The agent's listing is sorted by `lastUsed`, so brand-new skills appear at the top until something else gets used.

### Update — Modify an existing skill

1. `read_file /data/skills_agent/<name>/SKILL.md` first — never overwrite blind.
2. Use `edit_file` for targeted changes. Reserve `write_file` (full overwrite) for major rewrites.
3. If the change is a behavior change visible to the user, mention what changed.
4. Don't touch built-in skills (those with `version:` and shipped in the project repo) without asking — your edits will be reverted on the next container update unless you set `managed: false`. If you do need to override a built-in, the safer path is usually a *new* skill that supersedes it.

### Test — Sanity-check before declaring done

After writing, verify:
- Filename and directory match the `name` field exactly.
- Frontmatter parses as valid YAML (no tabs, balanced quotes, lists in `[a, b]` or `- item` form).
- Description doesn't start with "A skill for…" or "This skill…" — start with the verb (*Fetch*, *Maintain*, *Ingest*).
- The body uses absolute paths only.
- If you used `{baseDir}`, you actually ship a file at that path.
- If you set `required_env_vars`, the env var name is exactly what your skill body references.

## Examples

### Minimal skill — no gating, no helpers

```markdown
---
name: standup-summarizer
description: Summarize a Slack standup channel into a 5-bullet daily digest. Use when the user pastes a chunk of standup messages and asks for a summary, blockers, or action items.
---

# Standup Summarizer

Distill raw standup messages into a structured daily summary.

## Steps

1. Read the pasted standup text from the user message.
2. Extract for each person:
   - What they did yesterday
   - What they're doing today
   - Blockers (if any)
3. Output:
   - **Yesterday:** 1-line bullets per person
   - **Today:** 1-line bullets per person
   - **Blockers:** flat bullet list with person attribution
   - **Action items:** anything that needs follow-up, with owner
4. Keep total length under 15 bullets — drop fluff aggressively.

## When NOT to use this skill

- The user asks for a *weekly* roll-up — that's a different workflow with different aggregation.
- Only one person's update was pasted — just answer directly.
```

### Skill with gating — needs an env var and a tool

```markdown
---
name: github-issue-triager
description: Read a GitHub issue, classify it (bug/feature/question), suggest labels, and draft a triage comment. Use when the user pastes a GitHub issue URL or asks to triage open issues in a repo.
required_env_vars: [GITHUB_TOKEN]
requires_toolsets: [web_fetch]
---

# GitHub Issue Triager

Classify and respond to GitHub issues using the GitHub REST API.

## Steps

1. Extract the `<owner>/<repo>#<number>` from the URL.
2. `web_fetch https://api.github.com/repos/<owner>/<repo>/issues/<number>` with the `Authorization: Bearer $GITHUB_TOKEN` header.
3. Classify:
   - **bug** — describes broken behavior with reproduction steps
   - **feature** — proposes new functionality
   - **question** — asks how to use existing functionality
   - **needs-info** — none of the above clearly fits, ask for clarification
4. Suggest 2–4 labels.
5. Draft a 3–5 sentence triage comment in the user's language.

## Output format

```
**Classification:** <label>
**Suggested labels:** label1, label2
**Triage comment:**
<draft>
```

## When NOT to use this skill

- Closed issues — point that out, don't triage.
- Pull requests — different workflow (use a `pr-reviewer` skill if one exists).
```

### Skill with a helper script

```markdown
---
name: pdf2md
description: Convert a PDF in /workspace to clean Markdown. Use when the user uploads a PDF and asks to convert, summarize, or extract text from it.
requires_toolsets: [shell]
---

# PDF to Markdown

Convert a PDF file to Markdown using the bundled extraction script.

## Steps

1. Verify the PDF exists: `ls /workspace/<filename>.pdf`
2. Run the extractor: `bash {baseDir}/scripts/extract.sh /workspace/<filename>.pdf > /workspace/<filename>.md`
3. Read the resulting Markdown and answer the user's actual question.

The extractor strips headers/footers, preserves headings, and converts tables to Markdown tables.
```

In this case, you'd `write_file` two files:
- `/data/skills_agent/pdf2md/SKILL.md` (the file above)
- `/data/skills_agent/pdf2md/scripts/extract.sh` (the helper script)

## After creating

- The skill is live on the **next user message**. You don't need to restart anything.
- It appears in `<available_skills>` with the description you wrote.
- The first time you actually `read_file` its SKILL.md, the runtime records the timestamp in `/data/skills_agent/.usage.json`. The 10 most-recently-used skills float to the top of the prompt; older ones are reachable via `list_agent_skills`.
- You can list all your created skills any time with `list_agent_skills`.

## Common mistakes to avoid

- **Vague descriptions.** "Helps with code" routes nowhere. Name the trigger and the domain.
- **Wrong directory.** Writing to `/data/skills/foo/SKILL.md` (user-space) instead of `/data/skills_agent/foo/SKILL.md`. Only the latter is your space.
- **Mismatched name and folder.** `name: foo-bar` in a folder called `foo_bar/` → won't load.
- **Over-gating.** Setting `requires_toolsets: [web_fetch]` on a skill that doesn't actually call `web_fetch` will hide the skill the moment a user disables web fetching, for no real reason.
- **Treating the body as documentation.** It's an instruction set for future-you. Use imperative steps and explicit tool calls, not narrative explanation.
- **Recreating built-in tools.** A skill called `read-file` that wraps `read_file` adds nothing. Skills compose tools into workflows; they don't proxy them.
- **Editing a built-in skill in place.** Your edit will get reverted on the next image update unless you also set `managed: false`. If you want to keep the change, add `managed: false` to the frontmatter — but understand you'll then miss future improvements to that skill.

## Paths summary

- Agent-created skills (write here): `/data/skills_agent/<name>/SKILL.md`
- Helper files for a skill: `/data/skills_agent/<name>/<anything>` — referenced from SKILL.md via `{baseDir}/<anything>`
- Usage tracking (do not edit): `/data/skills_agent/.usage.json`
- Built-in skill defaults (read-only image): `/app/skills_agent_defaults/<name>/`
- User-installed skills (do not write here): `/data/skills/<owner>/<name>/`
