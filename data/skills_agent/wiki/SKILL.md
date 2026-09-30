---
name: wiki
version: 1.2.1
description: Maintain and search the user's LLM wiki (knowledge base of Markdown pages). Use this skill for ingesting new sources, querying the wiki, and wiki maintenance/linting.
---

# Wiki Skill

The wiki lives at `/data/memory/wiki/`. It is a collection of LLM-maintained Markdown files — a user knowledge base following the Karpathy pattern.

## Three-Layer Architecture

| Layer | Path | Mutability | Purpose |
|---|---|---|---|
| Sources (raw) | `/data/memory/sources/` | Immutable — add only | Archived raw material: articles, transcripts, papers |
| Wiki (distilled) | `/data/memory/wiki/` | LLM-maintained | Summary pages, concepts, cross-references |
| Schema / rules | `/data/config/CONSOLIDATION.md` + this skill | Editable | How the wiki operates |

Rule of thumb: **Sources are what you read. Wiki is what you learned.** Never edit sources; always cite them from wiki pages.

## Wiki Structure

Each wiki page is a `.md` file under `/data/memory/wiki/`. Pages can have YAML frontmatter. Existing pages may still use partial frontmatter and should be migrated gradually when touched.

```markdown
---
aliases: [short-name, abbreviation]
type: concept
status: active
created: 2026-05-05
updated: 2026-05-05
---

# Page Title

Page content...
```

## Frontmatter Specification

Supported frontmatter fields:

| Field | Type | Required | Description |
|---|---|---:|---|
| `aliases` | list | no | Alternative filename / search terms |
| `type` | string | yes | One of `project`, `concept`, `source-summary`, `synthesis`, `comparison`, `redirect`, `index`, `log` |
| `status` | string | no | One of `active`, `stale`, `archived` |
| `created` | date | no | ISO 8601 creation date |
| `updated` | date | no | ISO 8601 date; update on every substantive page change |
| `redirect` | string | no | For redirect pages: target page filename |

Migration rule: all existing pages should be migrated to this schema gradually when they are touched for normal maintenance. Do **not** mass-update every existing page solely to satisfy the schema unless explicitly asked.

## Page Types

- `project`: Project page (e.g., Offtangent, Pi Agent, Mainsail).
- `concept`: Concept/technology (e.g., LLM ecosystem, productivity).
- `source-summary`: Summary of a single source.
- `synthesis`: Answer to a query / cross-synthesis of multiple sources.
- `comparison`: Direct comparison of two or more topics.
- `redirect`: Alias/redirect to another page.
- `index`: Index/hub page: the wiki root `index.md` or the `index.md` of a topic folder.
- `log`: Audit trail (exactly one page: `log.md`).

## Query-to-Wiki Promotion

Valuable answers should not disappear in chat. If a query answer contains a synthesis, comparison, analysis, or new insight that goes beyond isolated facts, save it as a new wiki page with `type: synthesis` or `type: comparison`.

Promote an answer when **both** conditions hold:

1. The answer is at least 3 paragraphs long.
2. It synthesizes multiple sources/pages **or** contains an explicit new insight that should remain useful later.

Promotion workflow:

1. Choose a descriptive filename (`lowercase-hyphenated.md`).
2. Add frontmatter (`type: synthesis` or `comparison`, `status: active`, `created`, `updated`, aliases if useful).
3. Preserve the core answer as a concise evergreen page; remove chat-only phrasing.
4. Add cross-links to relevant existing wiki pages and sources.
5. Update `index.md` and append an `update` or `create` entry to `log.md`.

## Page Size and Splitting

When a page grows beyond **500 lines**, evaluate whether some subsections should become their own pages. Do not split mechanically; split only when the extracted material is a reusable unit of knowledge.

Good split candidates are repeated, standalone concepts that are linked or referenced from many other pages.

Splitting process:

1. Create the new page with complete frontmatter.
2. Move the detailed content to the new page.
3. Keep a short summary on the original page and link to the new page.
4. Update `index.md`.
5. Append a `create` or `update` entry to `log.md`.

### Topic folders (hub + subpages)

When a topic accumulates 2–3+ related pages, or one page keeps growing past the split threshold, convert it into a topic folder:

- `wiki/<topic>/index.md` — hub page (`type: index`): short overview plus links to all subpages
- `wiki/<topic>/<subtopic>.md` — the detailed subpages

Rules:

1. The hub is the single entry point: the root `wiki/index.md` links to `wiki/<topic>/index.md`, not to individual subpages.
2. Subpages cross-link through the hub; the hub carries only summaries, never the full detail.
3. When converting an existing flat page, leave a `type: redirect` page at the old filename pointing to the new hub so old links keep working.
4. **Pages written to by other automation** (e.g. digest cronjobs appending inline comment blocks or tracking frontmatter): never move or rename the file. Keep it at its existing path as the hub — preserve frontmatter and automation-written blocks — and extract only the body sections into subpages.
5. Log the conversion in `log.md`.

## Schema Maintenance

Update this `SKILL.md` when wiki conventions evolve. Good triggers:

- A new convention has been applied manually several times and proved useful.
- Lint repeatedly flags the same structural problem.
- The user explicitly asks for a new rule.

How to update the schema/rules:

1. Edit `SKILL.md` directly with `edit_file` (or equivalent focused file editing).
2. Keep the change narrow and operational.
3. Append an `update` entry to `/data/memory/wiki/log.md` describing the rule change.

## Operations

### Ingest — Add a new source

Goal: extract knowledge from an external source (URL, file, conversation context), **archive the raw material** under `sources/`, and distill the knowledge into the wiki.

**Steps:**

1. **Fetch the raw source.** `web_fetch` the URL, read the transcript, or capture the conversation snippet.

2. **Archive the raw source under `sources/`** (skip only if the content is trivial or already archived):
   - Choose subfolder: `articles/`, `youtube/`, `podcasts/`, `papers/`, `notes/`
   - Filename: `<yyyy-mm-dd>-<slug>.md` (lowercase, hyphens)
   - First block: YAML frontmatter with `source_type`, `url`, `author`, `captured`
   - Body: the raw text as received — no interpretation, no editing
   - **Never modify an existing source file.** If the source itself changes, add a new dated file.

3. **List existing wiki pages** via `list_files /data/memory/wiki/`:
   - Which pages already exist?
   - Is there an existing page that should be extended?

4. **Extract the essential knowledge** from the source:
   - Facts, concepts, decisions, dependencies
   - No duplication of existing knowledge
   - Focus on evergreen knowledge (durably useful, not ephemeral)

5. **Decide: create a new page or extend an existing one?**
   - New page: when it covers a new topic, project, or concept
   - Existing page: when the knowledge belongs to an existing page

6. **Write the page:**
   - Filename: `topic-name.md` (lowercase, hyphens instead of spaces)
   - First heading `# Title` (clear and precise)
   - Structure: headings, bullet lists, code blocks where appropriate
   - Cross-links: reference related wiki pages (`[Page Name](page-name.md)`)
   - **Add a `## Sources` section** citing the `sources/...` file you just archived, so the page remains verifiable.

**Example — ingest a web article:**
```
1. web_fetch the URL
2. write_file /data/memory/sources/articles/2026-04-17-<slug>.md (raw text, with frontmatter)
3. list_files /data/memory/wiki/
4. Extract relevant knowledge, identify duplicates
5. write_file or edit_file /data/memory/wiki/topic.md with distilled knowledge + ## Sources pointing to the archived source
```

**Example — ingest context from a conversation:**
```
1. list_files /data/memory/wiki/
2. Check whether a matching page exists
3. If yes: edit_file to add a section
4. If no: write_file to create a new page
(No sources/ archive needed when the "source" is just conversational context.)
```

---

### Query — Search the wiki

Goal: search the wiki for knowledge relevant to a current task.

**Steps:**

1. `list_files /data/memory/wiki/` — list all pages
2. Scan filenames: which pages might be relevant?
3. Read relevant pages with `read_file`
4. If a page links to others (`[Name](file.md)`): read those too

**Tips:**
- Broad topics: read multiple pages, then synthesize
- Specific questions: read one or two targeted pages
- If no matching page exists: inform the user and offer to create one

**When to use the wiki:**
- Before answering technical questions about known projects or systems
- For recurring topics (tools, workflows, configurations)
- When the user asks "how do we normally do X?"

---

### Lint — Wiki health check

Goal: audit the wiki for quality — find contradictions, orphaned pages, missing links, **and surface content gaps the wiki implies but does not cover**.

**Steps:**

1. **Triage before reading everything:**
   ```
   read_file /data/memory/wiki/index.md
   list_files /data/memory/wiki/
   shell: wc -l /data/memory/wiki/*.md /data/memory/wiki/*/*.md
   ```
   For small wikis (< ~20 pages) read every page. For larger wikis read fully only the pages that are relevant to recent changes, oversized, or flagged by earlier lint reports — do not burn tokens re-reading the whole wiki every run.

2. **Find contradictions:**
   - Same facts described differently across pages?
   - Outdated information that should be corrected?
   - Duplicates (same knowledge on multiple pages)?

3. **Identify orphaned pages:**
   - Which pages are not linked from any other page?
   - Are they still valuable as standalone documents?

4. **Find missing cross-links:**
   - Concepts mentioned on page A for which page B exists — but no link?
   - Add cross-links with `edit_file`

5. **Surface content gaps** (Karpathy/AI-Maker-Lab pattern):
   - Which concepts, people, projects, or tools are **referenced repeatedly across pages but have no dedicated page**?
   - Which pages contain TODO markers, "unclear", "to verify", or open questions?
   - Which topics are discussed in daily files across multiple sessions but never promoted to a wiki page?
   - List these as **suggested next research directions** — do not auto-create pages, just propose.

6. **Check source coverage:**
   - Wiki pages that make factual claims but have no `## Sources` section — flag them.
   - `sources/` files with no inbound wiki reference — either unused raw material or candidate for ingest.

7. **Check page size and staleness:**
   - Pages longer than ~500 lines → flag as split candidates (see "Page Size and Splitting"; do not split during lint).
   - Pages whose `updated` frontmatter is older than 6 months (or missing on a long-untouched page) → set `status: stale` so the next maintenance pass reviews them.
   - Pages with `status: archived` → remove their entries from `index.md`.

8. **Write a lint report:**
   - Append findings to `/data/memory/wiki/log.md` (never to daily files; daily logs are read-only source material):
     ```
     append to /data/memory/wiki/log.md
     ## [YYYY-MM-DD] lint | Wiki Lint Report — YYYY-MM-DD

     ### Findings
     - ...
     ```

9. **Apply fixes:**
   - Apply obvious corrections directly (edit_file)
   - Only when certain — no speculative changes
   - Gap suggestions are reported only, not auto-resolved

**Lint report format (append to `wiki/log.md`):**
```markdown
## [2025-01-15] lint | Wiki Lint Report — 2025-01-15

### Contradictions
- `project-x.md` and `architecture.md` describe the database structure differently

### Orphaned pages
- `old-service.md` — not linked from anywhere, consider deleting?

### Missing cross-links
- `deployment.md` mentions Docker but no link to `docker.md`

### Outdated information
- `setup.md` still references Node 16, current version is Node 20

### Content gaps (suggested next research)
- `llm-ecosystem.md` mentions Qwen3.6 repeatedly but no dedicated `qwen.md`
- Multiple daily entries reference "news crawler" but no wiki page exists

### Source coverage
- `project-x.md` makes release-date claims but has no ## Sources section
- `sources/articles/2026-04-17-foo.md` archived but not cited from any wiki page

### Oversized / stale pages
- `llm-ecosystem.md` — 780 lines, split candidate (topic folder?)
- `old-tooling.md` — `updated` 8 months ago, marked `status: stale`
```

**Log rotation:** `log.md` keeps only the ~10 most recent reports. When appending a new one, delete the oldest entries beyond that.

---

## Filename conventions

- Lowercase: `my-project.md` not `MyProject.md`
- Hyphens instead of spaces: `api-design.md`
- Descriptive and unambiguous: `offtangent-deployment.md` rather than `deployment.md` when multiple projects exist
- No special characters except `-` and `_`

## Formatting conventions

- Frontmatter uses only the fields from the specification above — do not invent fields; `type` is required
- Exactly one `# Title` heading per page (the first line after the frontmatter); all sections use `##` and below
- At most one consecutive blank line anywhere in the file

## Quality principles (after Karpathy)

1. **Each piece of knowledge lives in exactly one place** — no copy-paste between pages, use cross-links instead
2. **Short and precise** — wiki pages are reference material, not prose
3. **Always current** — correct outdated info, don't just add new info on top
4. **Interlinked** — wiki pages should reference each other to form a network
5. **Evergreen** — ephemeral info belongs in daily files, not the wiki

## Paths

- Wiki directory: `/data/memory/wiki/`
- Sources directory (immutable raw material): `/data/memory/sources/`
- Wiki index: `/data/memory/wiki/index.md`
- Wiki log / lint reports: `/data/memory/wiki/log.md`
- Today's daily file: `/data/memory/daily/YYYY-MM-DD.md` (read-only source material; do not write lint reports there)
- Always use absolute paths
