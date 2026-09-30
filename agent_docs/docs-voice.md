# Offtangent Docs — Voice & Tone

This document defines the writing voice for the **public docs** (`docs/`,
served via VitePress). It does **not** govern runtime agent responses (see
`/data/memory/SOUL.md` for that) or internal contributor docs in `agent_docs/`
(those stay neutral and technical).

## The core vibe

Offtangent's docs inherit their voice from Axiom, the upstream project, which
borrowed the spirit of the Rifleman's Creed via pi.dev:

> *"There are many coding agents, but this one is mine."*

Offtangent is not a product you *consume*. It's an agent you *own, shape, and keep*.
Every page should leave the reader with the feeling: **this is going to be
mine** — not *a* personal agent, but *my* personal agent.

## Pillars

1. **Ownership over consumption.**
   The reader runs the container. The reader owns the data. The reader edits
   the memory files. We write as if we're handing over keys, not selling a
   subscription.

2. **Craft over magic.**
   We don't hide what's happening. File-based memory is plain Markdown. Skills
   are folders. Cronjobs are cronjobs. The docs explain the machine, not a
   mystique.

3. **Direct over decorated.**
   Short sentences. Active voice. No hedging ("might possibly help you to…").
   No marketing superlatives ("revolutionary", "seamless", "unleash"). If a
   thing is one command, the sentence is one line.

4. **Second person, present tense.**
   "You run `docker compose up`. The agent writes to `MEMORY.md`. You edit it."
   Not "users can run…" or "the system will write…".

5. **Opinionated defaults, open seams.**
   We tell the reader how Offtangent does it and why — then show them where to pry
   it open. Every "here's the default" should be followed, eventually, by
   "here's how to change it".

## Words to avoid

| Don't use                        | Use instead / rephrase                         |
|----------------------------------|------------------------------------------------|
| "seamlessly", "effortlessly"     | just describe the steps                        |
| "powerful", "revolutionary"      | show the capability, don't claim it            |
| "users" (when addressing reader) | "you"                                          |
| "leverage", "utilize"            | "use"                                          |
| "simply" / "just" (as filler)    | drop it; if it's simple, the sentence shows it |
| "AI-powered X"                   | name the actual mechanism                      |
| "our platform" / "our solution"  | "Offtangent" or the concrete component         |

## Words that fit

- **yours**, **your own**, **shape**, **extend**, **own**
- **run**, **edit**, **write**, **persist**, **mount**, **swap**
- **file**, **folder**, **Markdown**, **container**, **volume**
- **skill**, **memory**, **cronjob**, **interface**

## The Creed move

Whenever a page introduces a major subsystem (memory, skills, interfaces,
providers), it's fair game to land one line that echoes the Creed — sparingly,
never twice on the same page. Examples of the move, not templates to copy:

- "There are many ways to store agent memory. This one is files."
- "Many skills ship in the image. The ones you write stay yours."
- "Pick any OpenAI-compatible provider. The agent doesn't care. You do."

If a page already reads as direct and owned, don't force it. The vibe is the
baseline; the Creed echo is a seasoning.

## Page structure

Prefer this shape for guide pages:

1. **One-sentence lede** — what this page gives the reader.
2. **The shortest working example** — a command, a file, a config block.
3. **How it actually works** — the mechanism, not the marketing.
4. **Where to pry it open** — extension points, overrides, escape hatches.
5. **Related** — links to adjacent pages.

## Headings

- Sentence case, not Title Case: "Memory files", not "Memory Files".
- Verbs where possible: "Write your first skill", not "Writing Skills (Guide)".
- No emoji in headings. (Emoji in callouts is fine, used sparingly.)

## Code blocks

- Always specify a language (` ```bash `, ` ```ts `, ` ```md `).
- Prefer complete, runnable snippets over fragments with `...`.
- Comments in code explain *why*, not *what*.

## Admonitions

VitePress containers (`::: tip`, `::: warning`, `::: danger`) are allowed but
should be rare. If every second paragraph is a callout, nothing is.

## Cross-linking

Every guide page links to at least one reference page, and vice versa.
Reference pages are terse; guide pages tell the story.

## Checklist before merging a docs change

- [ ] Reads in second person, present tense.
- [ ] No banned words (see table above).
- [ ] Every claim backed by a file path, command, or code block.
- [ ] Lede sentence would make sense as a tweet.
- [ ] At most one Creed echo, and only if it earns its place.
- [ ] Headings sentence-case; code blocks have language tags.
