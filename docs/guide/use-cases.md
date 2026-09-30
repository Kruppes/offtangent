# What Offtangent Is For

Offtangent is a self-hosted agent backend for people whose thoughts do not arrive in the order a chat window wants them.

A linear chat asks you to decide, before you type, which thread a thought belongs to. That question is cheap if you were already thinking about that thread. It is expensive if the thought arrived sideways, in the middle of something else, and will be gone in twenty seconds. Offtangent inverts it: every input is a **capture**, accepted without a destination. A small router model proposes where it belongs — appending to an existing **strand** or opening a new one — and the filing is visible and reversible with one tap. A capture that fits nowhere is still kept.

That is the product core, and it is why the ADHD angle in the README is not a marketing line: several parallel, half-finished threads are treated as the normal case, not as a failure to focus.

## Scenarios

### 1. Capture a thought on the move, find it sorted later

You are walking, driving, or falling asleep. You open the companion app, hold the record button, say the thing, and put the phone away. The recording goes to the server, is transcribed there, and becomes a capture. The router files it; if it is unsure, the capture waits in the tray until you look at it. Later, at a desk, you find the thought in the strand it belongs to instead of in a scrollback you would have had to search.

Mechanism: [Companion App](./companion-app), [Speech-to-Text](../settings/speech-to-text), [Voice API](../reference/voice-api), [Captures API](../reference/captures-api).

### 2. Several working roles on one instance

One instance can host several personas, each with its own SOUL, memory, skills and — optionally — its own model. A reviewing persona that reads drafts harshly, a support persona that answers in a different register, a research persona that only gathers and cites. They do not share a personality and they do not share memory; they share the box, the providers and the API.

This is not multi-user. It is one person with several working modes, and it exists because switching context by changing the system prompt in a single agent loses everything that mode had learned.

Mechanism: [Personas](../concepts/personas), [Personas API](../reference/personas-api).

### 3. Recurring work as a cronjob

Work that has to happen on a schedule rather than when you remember it: a morning digest, a weekly check of a feed, a nightly consolidation of memory files, a reminder that fires once. A cronjob can run a plain prompt or spawn a full background task with its own model.

Mechanism: [Tasks & Cronjobs](../concepts/tasks-and-cronjobs), [Web UI → Cronjobs](../web-ui/cronjobs).

### 4. Longer research as a background task

Some questions need twenty tool calls and fifteen minutes. Running them in the chat means staring at a spinner. `create_task` hands the work to an isolated agent instance with its own time budget, its own model and a chosen slice of context (`context_mode`: clean, selected or fork), and an `output_schema` when you need the answer in a fixed shape. You get a report when it is done; meanwhile the chat stays usable.

Mechanism: [Tasks & Cronjobs](../concepts/tasks-and-cronjobs), [Web UI → Tasks](../web-ui/tasks), [Tasks API](../reference/tasks-api).

### 5. Knowledge that grows in one strand over weeks

A strand is a thread of thought that lives over time, not a session that ends when you close the tab. Old turns are not deleted: they are compressed into digests that keep their message id, so the agent can reload the original with `recall_message` instead of having lost it. Alongside that, atomic facts with provenance go into a fact store and daily notes accumulate into longer-lived Markdown memory.

The practical effect: a project you touch every few days does not require you to re-explain it every time.

Mechanism: [Captures and Strands](../concepts/captures-and-strands), [Memory System](../concepts/memory), [Strands API](../reference/strands-api).

## What Offtangent is not

Being clear about this saves you an evaluation:

- **Not a team chat.** Multiple user accounts exist for device and access management, not for collaboration. There are no shared channels, no mentions, no presence. The unit of work is one person's thinking.
- **Not a ticket system.** Strands have tags, a now set and project grouping, but no assignees, no states, no SLAs, no workflow engine. If you need work items that other people pick up, use a tracker.
- **Not multi-tenant SaaS.** One instance is one installation for one owner. Keys, memory files, the database and the personas all live in a single `/data` volume with no tenant isolation. Do not put strangers on the same instance.
- **Not an IDE replacement.** The agent has `shell`, `read_file` and `write_file` and can genuinely work in a repository, but there is no editor, no language server, no debugger and no diff review UI. It complements a coding environment; it does not replace one.
- **Not a model.** Offtangent provides no inference of its own. You bring a provider — see [Models and Providers](./models).

## Where to start

- [Quickstart](./quickstart) — running with Docker.
- [Models and Providers](./models) — what to connect, and what a model must be able to do.
- [Core Concepts](../concepts/) — how the machinery underneath actually works.
