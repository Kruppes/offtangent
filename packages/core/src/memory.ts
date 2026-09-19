import fs from 'node:fs'
import path from 'node:path'
import { getWorkspaceDir } from './workspace.js'
import { getConfigDir, getDefaultTimezone, getDocsPath, getReadmePath, loadMultiPersonaSettings } from './config.js'
import { loadPersona, getPersonaDir, listPersonaIds } from './persona-loader.js'
import type { PersonaContext } from './persona-loader.js'
import { loadHeuristics } from './heuristics.js'
import { budgetRecentMemory, DAILY_SEPARATOR } from './recent-memory.js'
import type { DailyMemoryEntry } from './recent-memory.js'
import { SYSTEM_PROMPT_CACHE_MARKER } from './prompt-cache.js'

const SOUL_TEMPLATE = `# Soul

You are Offtangent, a helpful AI assistant.

## Personality
- Friendly and professional
- Concise but thoughtful
- Proactive in suggesting solutions

## Guidelines
- Always be honest about limitations
- Ask for clarification when needed
- Respect user privacy
`

const MEMORY_TEMPLATE = `# Agent Memory

This file contains core memories, learned lessons, and technical instructions.
The agent can read and write this file to persist important information across sessions.

## Learned Lessons

(none yet)

## Important Notes

(none yet)
`

const AGENTS_TEMPLATE = `# Agent Contract

This file defines how the agent should behave, communicate, and execute tasks.
Both the user and the agent can edit this file. The agent reads it on every conversation.

## Communication Rules

- Be concise and direct — no filler, no hedging
- Use plain, declarative sentences over rhetorical questions
- When explaining decisions, state what changed and why — skip preamble
- Use markdown formatting (headings, lists, code blocks) for clarity
- In external-facing text (emails, messages to others): avoid em-dashes (—) — use commas, periods, or rephrase instead

## Execution Rules

- Be resourceful before asking — read files, check context, search first. Come back with answers, not questions.
- Ask before making destructive changes (deleting files, dropping data, overwriting important config)
- Be cautious with external actions (sending messages, emails, anything public-facing) — always confirm first
- Be autonomous with internal actions (reading, organizing, analyzing)
- When making code changes, explain the reasoning briefly
- Prefer small, verifiable changes over large rewrites
- If a task is ambiguous, ask one clarifying question rather than guessing
- When multiple approaches exist, state the tradeoff and recommend one
- When you notice a reusable pattern across conversations, suggest creating a skill for it — but ask the user first

## Anti-Hallucination Rules

- Say "I don't know" when you don't have enough information — never fill gaps with plausible fiction
- Cite sources for factual claims — if you can't find a source, retract the claim
- Use direct quotes when grounding facts from documents — don't paraphrase-drift
- For creative tasks (brainstorming, writing, ideation): these constraints relax
- For research, analysis, and anything forwarded to others: strict mode

## Memory Rules

- Write learned facts, project context and session notes to the daily memory file
- MEMORY.md is the curated core and has one writer: the scheduled consolidation. Edit it directly only when the user explicitly asks for it
- Write user-specific information (name, location, preferences, interests, work context) to the user's profile file — not to MEMORY.md
- When you update the user's profile, replace the outdated line in place instead of appending a second version
- Don't store ephemeral details (one-time commands, temporary paths) in core memory

## Red Lines

- Never share sensitive information from memory files with third parties
- Never execute destructive commands without explicit confirmation
- Never fabricate information — say "I don't know" when uncertain
- Never override user instructions with your own judgment on important decisions
- Never send half-baked replies to messaging surfaces (Telegram, etc.)
- Never act as the user's voice in group conversations without explicit instruction
`

const USER_PROFILE_TEMPLATE = `# User Profile — {username}

## Basic Info
- Name: (not set)
- Location: (not set)

## Preferences

(none yet)

## Notes

(none yet)
`

const SOURCES_README_TEMPLATE = `# Sources

<!-- This directory holds the immutable raw material the wiki is built on. -->
<!-- Sources are what you read. The wiki is what you learned. -->
<!-- Never edit existing source files. Only add new ones. -->

This is the **sources layer** of the memory system. Unlike \`wiki/\`, files here
are treated as archival raw material: articles, transcripts, papers, podcast
notes. Wiki pages cite these files so factual claims remain verifiable.

## Subfolders (create on first use)

- \`articles/\` — web articles, blog posts, documentation snapshots
- \`youtube/\` — YouTube transcripts
- \`podcasts/\` — podcast notes and transcripts
- \`papers/\` — research papers, PDFs converted to markdown
- \`notes/\` — longer conversation snippets or hand-captured notes

## Filename pattern

\`<yyyy-mm-dd>-<slug>.md\` — lowercase, hyphens instead of spaces.

## Frontmatter

Each source file should start with YAML frontmatter:

\`\`\`markdown
---
source_type: article | youtube | podcast | paper | note
url: https://...
author: ...
captured: YYYY-MM-DD
---

# Title

<raw body — do not edit later>
\`\`\`

## Rules

- **Immutable**: never rewrite an existing file. If the source itself changes, add a new dated entry.
- **Cite from the wiki**: wiki pages that rely on a source should link to it in a \`## Sources\` / \`## Quellen\` section.
- **Orphaned sources are a lint signal**, not an error — they just flag material that has not been distilled yet.
`

const HEARTBEAT_TEMPLATE = `# Heartbeat Tasks

<!-- Define periodic tasks here. The agent will execute them during each heartbeat cycle. -->
<!-- Both the user and the agent can edit this file. -->
<!-- If this file has no actionable content, the heartbeat will skip automatically. -->
`

const TASKS_TEMPLATE = `# Background Task Guidelines

<!-- These guidelines are injected into every background task's system prompt. -->
<!-- They apply to tasks created via create_task, cronjob runs with action_type="task", -->
<!-- heartbeat-spawned tasks, and consolidation-spawned tasks. -->
<!-- Both the user and the agent can edit this file. Keep it tight — every line ships in every task prompt. -->

- Work independently for as long as possible
- Prefer acting over asking when the next step is clear and low-risk
- Make reasonable assumptions, but record important assumptions in your final report
- Only pause with a question if you truly cannot proceed without user input, missing access, or an irreversible decision
- Read relevant files and tool results before changing anything
- Do not overwrite, discard, or ignore user changes or unrelated local work
- Keep edits focused on the requested outcome; avoid unnecessary refactors or extra features
- Verify meaningful work when practical, and report the actual result honestly
- If you reference files, commands, URLs, test output, or errors, include the concrete details rather than vague summaries
- When finished, your final message must contain ALL your actual findings, data, and results
- Do NOT just describe what you did — include the full content of your work
`

const CONSOLIDATION_TEMPLATE = `# Memory Consolidation Rules

<!-- These rules guide the nightly memory consolidation process. -->
<!-- The consolidation agent reads this file to decide what to promote, update, or ignore. -->
<!-- You can customize these rules to match your preferences. -->

## Memory Architecture

The memory system has several tiers. Each piece of information should live in exactly one place.

| File / Directory | Purpose |
|---|---|
| MEMORY.md | Long-term core memory: learned lessons, recurring patterns, technical notes |
| users/*.md | Per-user profiles: name, preferences, communication preferences, work context |
| wiki/*.md | Wiki pages: project notes, concepts, architecture, key decisions, references |
| sources/**/*.md | Immutable raw source material (articles, transcripts, papers). Never edited, only added to. Wiki pages cite these. |
| daily/*.md | Ephemeral daily logs (source for consolidation, never modified) |

## What to promote to MEMORY.md

- Recurring patterns and lessons learned across multiple sessions
- Technical decisions and their rationale
- General preferences that apply across all projects
- Important facts that should persist across sessions
- Corrections to previously stored information
- Keep each entry a distilled rule of 1-2 lines. No incident narratives, dates, PR numbers, or step-by-step postmortems — move such detail to a wiki page and keep only the rule here.

## What to update in user profiles (users/*.md)

- Discovered preferences and communication preferences (e.g. likes bullet lists, prefers German)
- Work context changes (role, current focus areas)
- Personal details the user has shared (name, location, timezone)
- Skills and expertise areas
- Do NOT store language or timezone if they are already in the central settings
- Profiles describe the CURRENT state, not history. Collapse resolved threads (finished applications, completed projects, fixed issues) to their end state; move chronological detail to a wiki page or drop it.

## What to update in wiki pages (wiki/*.md)

- New project discoveries and context
- Architecture changes and design decisions
- Key dependencies, integration points, and tech stack
- Project status changes and milestones
- Concepts, references, and evergreen knowledge worth preserving
- Create a new wiki page when a previously unknown project or concept is discussed repeatedly
- For wiki page conventions (frontmatter, filenames, cross-links), load the wiki skill

## What to archive under sources/ (immutable raw material)

The \`sources/\` directory is the raw material the wiki is distilled from. Unlike
wiki pages, source files are **never edited** — only added to. Wiki pages cite
source files so their factual claims stay verifiable.

- Archive an external source whenever you ingest substantive new material: an article, a YouTube transcript, a podcast note, a paper, a long conversation snippet worth preserving verbatim.
- Layout: \`sources/articles/\`, \`sources/youtube/\`, \`sources/podcasts/\`, \`sources/papers/\`, \`sources/notes/\`. Create subfolders on first use.
- Filename: \`<yyyy-mm-dd>-<slug>.md\` (lowercase, hyphens).
- Frontmatter keys: \`source_type\`, \`url\`, \`author\`, \`captured\`.
- Body is the raw captured text — do not interpret or summarize in the source file.
- The corresponding wiki page should add a \`## Sources\` (or \`## Quellen\`) section linking to the archived file.
- Do NOT archive trivial conversation context, one-off chats, or material already captured elsewhere.
- Never rewrite an existing source file. If a source changes, add a new dated entry.

## What to ignore

- One-off questions with no lasting value
- Casual small talk without personal details
- Temporary debugging sessions (unless a reusable lesson was learned)
- Information that is already captured in the correct file
- Redundant or duplicate information

## General Principles

- **Be selective**: Only promote information with clear long-term value.
- **No duplication**: Each fact lives in exactly one place. Move, don't copy.
- **Merge & refine**: If similar information exists, update it rather than adding a duplicate.
- **Remove outdated info**: If daily entries contradict existing memory, update or remove the old entry.
- **Prune every run**: merge near-duplicate entries, collapse resolved threads to their end state, and delete lessons that are already covered by AGENTS.md or a wiki page.
- **Size budgets**: MEMORY.md ≤ ~80 lines, each user profile ≤ ~60 lines. Both are injected into every system prompt. When a file exceeds its budget, compact it in the same run: move episodic detail to the wiki or delete it.
- **Preserve structure**: Keep existing markdown structure. Add new sections if needed.
- **Be concise**: Use bullet points and short descriptions. Core memory should be scannable.
- **Daily files are read-only**: Never modify daily log files — they are append-only source material.
- **Sources are read-only**: Never modify files under \`sources/\` — they are the immutable archival layer.

## Wiki lint: content gaps, source coverage, oversized pages

During consolidation, also run these checks on the wiki and report findings
(append to \`/data/memory/wiki/log.md\` as a short lint section, do not auto-create pages; daily files are read-only):

- **Content gaps** — surface topics the wiki implies but does not cover:
  - Concepts, people, projects, or tools referenced repeatedly across multiple wiki pages but without a dedicated page of their own.
  - Open questions or TODO markers inside wiki pages ("unclear", "to verify", "TODO").
  - Topics discussed across multiple daily files but never promoted to the wiki.
  - Report as suggestions. Do NOT auto-create pages — the user decides what to research next.
- **Source coverage** — keep factual claims verifiable:
  - Wiki pages that make factual claims (dates, numbers, quotes, attributed statements) but have no \`## Sources\` / \`## Quellen\` section → flag them.
  - Files in \`sources/\` that are not cited by any wiki page → flag as orphaned source (either stale raw material or a candidate for ingest).
- **Oversized pages** — flag wiki pages longer than ~500 lines as split candidates. Do NOT split during lint; splitting (hub page + subpages, see the wiki skill) is reserved for the weekly compaction run.
`



export function getMemoryDir(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'memory')
}

// =============================================================================
// Scoped per-persona memory roots (RC5, multi-persona bleeding 2026-07-24)
//
// When multi-persona mode is enabled (and multiPersona.scopedMemory is not
// explicitly disabled), every non-main persona gets its own memory root at
// /data/agents/<id>/memory/ mirroring the global /data/memory/ structure
// (MEMORY.md, daily/, users/, wiki/, sources/). Main keeps /data/memory/
// unchanged. This stops persona session summaries, daily notes and core
// memory from bleeding into main's system prompt and vice versa.
// =============================================================================

/**
 * Whether scoped per-persona memory roots are active.
 * Requires multiPersona.enabled AND multiPersona.scopedMemory (default true).
 * Safe fallback: disabled when settings cannot be read.
 */
export function isScopedAgentMemoryEnabled(): boolean {
  try {
    const settings = loadMultiPersonaSettings()
    return settings.enabled && settings.scopedMemory !== false
  } catch {
    return false
  }
}

/**
 * Memory root for a persona: /data/agents/<agentId>/memory
 * (next to the persona's IDENTITY.md/SOUL.md/... files).
 */
export function getAgentMemoryDir(agentId: string, agentsBaseDir?: string): string {
  return path.join(getPersonaDir(agentId, agentsBaseDir), 'memory')
}

export interface ResolveAgentMemoryDirOptions {
  /** Returned for main / non-scoped agents (callers usually default this to getMemoryDir()). */
  fallbackMemoryDir?: string
  /** Base directory containing persona dirs (tests only; default /data/agents). */
  agentsBaseDir?: string
  /** Force-enable/disable scoping, bypassing settings (tests / DI). */
  scopedAgentMemory?: boolean
}

/**
 * Resolve the memory directory an agent's memory reads/writes must target.
 *
 * - main (or no agentId): the fallback dir (typically undefined → global /data/memory)
 * - persona with scoped memory enabled: /data/agents/<id>/memory
 * - persona with scoped memory disabled: the fallback dir (legacy shared behavior)
 */
export function resolveAgentMemoryDir(
  agentId?: string | null,
  options?: ResolveAgentMemoryDirOptions,
): string | undefined {
  if (agentId && agentId !== 'main') {
    const scoped = options?.scopedAgentMemory ?? isScopedAgentMemoryEnabled()
    if (scoped) {
      return getAgentMemoryDir(agentId, options?.agentsBaseDir)
    }
  }
  return options?.fallbackMemoryDir
}

/**
 * Idempotently create the memory roots for all personas found under
 * /data/agents/ (MEMORY.md, daily/, users/, wiki/, sources/ — same structure
 * as the global memory dir, so all read/write helpers work unchanged).
 * No-op when scoped memory is disabled. Never overwrites existing files.
 *
 * Called at startup (runtime-composition) and lazily by assembleSystemPrompt.
 * Returns the list of ensured roots.
 */
export function ensurePersonaMemoryRoots(options?: {
  agentsBaseDir?: string
  scopedAgentMemory?: boolean
}): string[] {
  const enabled = options?.scopedAgentMemory ?? isScopedAgentMemoryEnabled()
  if (!enabled) return []

  const roots: string[] = []
  for (const agentId of listPersonaIds(options?.agentsBaseDir)) {
    const root = getAgentMemoryDir(agentId, options?.agentsBaseDir)
    ensureMemoryStructure(root)
    roots.push(root)
  }
  return roots
}

/**
 * Get the users profile directory path
 */
export function getUserProfileDir(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  return path.join(dir, 'users')
}

/**
 * Ensure a user profile file exists, creating it from template if missing.
 * Pre-fills username.
 */
export function ensureUserProfile(username: string, memoryDir?: string): string {
  const usersDir = getUserProfileDir(memoryDir)
  const profilePath = path.join(usersDir, `${username}.md`)

  if (!fs.existsSync(usersDir)) {
    fs.mkdirSync(usersDir, { recursive: true })
  }

  if (!fs.existsSync(profilePath)) {
    const content = USER_PROFILE_TEMPLATE
      .replaceAll('{username}', username)
    fs.writeFileSync(profilePath, content, 'utf-8')
  }

  return profilePath
}

/**
 * Read a user's profile file. Creates it from template if missing.
 */
export function readUserProfile(username: string, memoryDir?: string): string {
  const profilePath = ensureUserProfile(username, memoryDir)
  return fs.readFileSync(profilePath, 'utf-8')
}

export function getDefaultAgentsRulesContent(): string {
  return AGENTS_TEMPLATE
}

export function getDefaultHeartbeatContent(): string {
  return HEARTBEAT_TEMPLATE
}

export function getDefaultConsolidationContent(): string {
  return CONSOLIDATION_TEMPLATE
}

export function getDefaultTasksGuidelinesContent(): string {
  return TASKS_TEMPLATE
}

export function ensureMemoryStructure(memoryDir?: string): void {
  const dir = memoryDir ?? getMemoryDir()
  const dailyDir = path.join(dir, 'daily')
  const usersDir = path.join(dir, 'users')
  const wikiDir = path.join(dir, 'wiki')
  const legacyProjectsDir = path.join(dir, 'projects')

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true })
  }

  if (!fs.existsSync(usersDir)) {
    fs.mkdirSync(usersDir, { recursive: true })
  }

  // Migrate projects/ → wiki/ if projects/ exists and wiki/ does not
  if (fs.existsSync(legacyProjectsDir) && !fs.existsSync(wikiDir)) {
    fs.renameSync(legacyProjectsDir, wikiDir)
    console.log('[axiom] Migrated memory/projects/ to memory/wiki/')
  } else if (!fs.existsSync(wikiDir)) {
    fs.mkdirSync(wikiDir, { recursive: true })
  }

  // Seed immutable sources/ layer (raw material for the wiki)
  ensureSourcesDir(dir)

  const soulPath = path.join(dir, 'SOUL.md')
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, SOUL_TEMPLATE, 'utf-8')
  }

  const memoryPath = path.join(dir, 'MEMORY.md')
  if (!fs.existsSync(memoryPath)) {
    // Migrate legacy AGENTS.md to MEMORY.md if it exists
    const legacyPath = path.join(dir, 'AGENTS.md')
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, memoryPath)
    } else {
      fs.writeFileSync(memoryPath, MEMORY_TEMPLATE, 'utf-8')
    }
  }
}

/**
 * Ensure the config directory structure exists with all default files.
 * Migrates files from /data/memory/ to /data/config/ if they exist in the old location.
 *
 * The legacy migration only runs when operating on the real config directory.
 * `getMemoryDir()` resolves from `DATA_DIR` and ignores the `configDir`
 * argument, so a caller passing an explicit directory (tests, tooling) would
 * otherwise reach into the live `/data/memory` and try to *move* real files
 * into that directory. Across filesystems that fails with EXDEV, which merely
 * hides the problem instead of preventing it; on a single filesystem the live
 * files would actually be moved away. Scope the migration accordingly.
 */
export function ensureConfigStructure(configDir?: string): void {
  const dir = configDir ?? getConfigDir()

  // Only migrate when this is the real config dir, never for an injected one.
  const isRealConfigDir = path.resolve(dir) === path.resolve(getConfigDir())
  const legacyDir = getMemoryDir()

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Migrate AGENTS.md from memory dir to config dir if needed
  const agentsPath = path.join(dir, 'AGENTS.md')
  if (!fs.existsSync(agentsPath)) {
    const legacyPath = path.join(legacyDir, 'AGENTS.md')
    if (isRealConfigDir && fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, agentsPath)
      console.log('[config] Migrated AGENTS.md from memory/ to config/')
    } else {
      fs.writeFileSync(agentsPath, AGENTS_TEMPLATE, 'utf-8')
    }
  }

  // Migrate HEARTBEAT.md from memory dir to config dir if needed
  const heartbeatPath = path.join(dir, 'HEARTBEAT.md')
  if (!fs.existsSync(heartbeatPath)) {
    const legacyPath = path.join(legacyDir, 'HEARTBEAT.md')
    if (isRealConfigDir && fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, heartbeatPath)
      console.log('[config] Migrated HEARTBEAT.md from memory/ to config/')
    } else {
      fs.writeFileSync(heartbeatPath, HEARTBEAT_TEMPLATE, 'utf-8')
    }
  }

  // Create CONSOLIDATION.md if missing
  const consolidationPath = path.join(dir, 'CONSOLIDATION.md')
  if (!fs.existsSync(consolidationPath)) {
    fs.writeFileSync(consolidationPath, CONSOLIDATION_TEMPLATE, 'utf-8')
  }

  const tasksPath = path.join(dir, 'TASKS.md')
  if (!fs.existsSync(tasksPath)) {
    fs.writeFileSync(tasksPath, TASKS_TEMPLATE, 'utf-8')
  }
}

/**
 * Ensure the sources/ directory exists with a README explaining the layer.
 * Idempotent: does NOT overwrite an existing README (so user edits are preserved).
 * Subfolders (articles/, youtube/, ...) are NOT auto-created — they are added on first use.
 */
export function ensureSourcesDir(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const sourcesDir = path.join(dir, 'sources')

  if (!fs.existsSync(sourcesDir)) {
    fs.mkdirSync(sourcesDir, { recursive: true })
  }

  const readmePath = path.join(sourcesDir, 'README.md')
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, SOURCES_README_TEMPLATE, 'utf-8')
  }

  return sourcesDir
}

/**
 * Ensure the wiki directory exists, creating it if needed.
 * Also handles migration from legacy projects/ directory.
 */
export function ensureWikiDir(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const wikiDir = path.join(dir, 'wiki')
  const legacyProjectsDir = path.join(dir, 'projects')

  // Migrate projects/ → wiki/ if projects/ exists and wiki/ does not
  if (fs.existsSync(legacyProjectsDir) && !fs.existsSync(wikiDir)) {
    fs.renameSync(legacyProjectsDir, wikiDir)
    console.log('[axiom] Migrated memory/projects/ to memory/wiki/')
  } else if (!fs.existsSync(wikiDir)) {
    fs.mkdirSync(wikiDir, { recursive: true })
  }

  return wikiDir
}

/**
 * @deprecated Use ensureWikiDir instead. Kept for backward compatibility.
 */
export function ensureProjectsDir(memoryDir?: string): string {
  return ensureWikiDir(memoryDir)
}

/**
 * Parse aliases from YAML frontmatter in a project note.
 * Expects format:
 * ```
 * ---
 * aliases: [Alias1, alias-2]
 * ---
 * ```
 */
export function parseProjectAliases(content: string): string[] {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return []

  const frontmatter = fmMatch[1]
  // Match aliases: [val1, val2, ...] or aliases: val
  const aliasMatch = frontmatter.match(/^aliases:\s*\[([^\]]*)\]/m)
  if (aliasMatch) {
    return aliasMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  }

  // Single value: aliases: something
  const singleMatch = frontmatter.match(/^aliases:\s*(.+)$/m)
  if (singleMatch) {
    const val = singleMatch[1].trim()
    return val.length > 0 ? [val] : []
  }

  return []
}

/**
 * List all wiki pages in the wiki/ directory with their aliases.
 */
export function listWikiPages(memoryDir?: string): Array<{ filename: string; aliases: string[] }> {
  const wikiDir = ensureWikiDir(memoryDir)

  if (!fs.existsSync(wikiDir)) return []

  const files = fs.readdirSync(wikiDir).filter(f => f.endsWith('.md')).sort()
  return files.map(filename => {
    const content = fs.readFileSync(path.join(wikiDir, filename), 'utf-8')
    return { filename, aliases: parseProjectAliases(content) }
  })
}

/**
 * @deprecated Use listWikiPages instead. Kept for backward compatibility.
 */
export function listProjectNotes(memoryDir?: string): Array<{ filename: string; aliases: string[] }> {
  return listWikiPages(memoryDir)
}

/**
 * Read the SOUL.md personality file
 */
export function readSoulFile(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const soulPath = path.join(dir, 'SOUL.md')
  if (!fs.existsSync(soulPath)) {
    ensureMemoryStructure(dir)
  }
  return fs.readFileSync(soulPath, 'utf-8')
}

/**
 * Read the MEMORY.md core memory file
 */
export function readMemoryFile(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const memoryPath = path.join(dir, 'MEMORY.md')
  if (!fs.existsSync(memoryPath)) {
    ensureMemoryStructure(dir)
  }
  return fs.readFileSync(memoryPath, 'utf-8')
}

/**
 * Write the MEMORY.md core memory file
 */
export function writeMemoryFile(content: string, memoryDir?: string): void {
  const dir = memoryDir ?? getMemoryDir()
  ensureMemoryStructure(dir)
  const memoryPath = path.join(dir, 'MEMORY.md')
  fs.writeFileSync(memoryPath, content, 'utf-8')
}

// Legacy aliases for backward compatibility
export const readAgentsFile = readMemoryFile
export const writeAgentsFile = writeMemoryFile

/**
 * Read the AGENTS.md rules file (from config directory).
 * Falls back to template if the file/directory cannot be created.
 */
export function readAgentsRulesFile(configDir?: string): string {
  const dir = configDir ?? getConfigDir()
  const agentsPath = path.join(dir, 'AGENTS.md')
  try {
    if (!fs.existsSync(agentsPath)) {
      ensureConfigStructure(dir)
    }
    return fs.readFileSync(agentsPath, 'utf-8')
  } catch {
    return AGENTS_TEMPLATE
  }
}

/**
 * Write the AGENTS.md rules file (to config directory)
 */
export function writeAgentsRulesFile(content: string, configDir?: string): void {
  const dir = configDir ?? getConfigDir()
  ensureConfigStructure(dir)
  const agentsPath = path.join(dir, 'AGENTS.md')
  fs.writeFileSync(agentsPath, content, 'utf-8')
}

/**
 * Read the HEARTBEAT.md file (from config directory).
 * Falls back to template if the file/directory cannot be created.
 */
export function readHeartbeatFile(configDir?: string): string {
  const dir = configDir ?? getConfigDir()
  const heartbeatPath = path.join(dir, 'HEARTBEAT.md')
  try {
    if (!fs.existsSync(heartbeatPath)) {
      ensureConfigStructure(dir)
    }
    return fs.readFileSync(heartbeatPath, 'utf-8')
  } catch {
    return HEARTBEAT_TEMPLATE
  }
}

/**
 * Write the HEARTBEAT.md file (to config directory)
 */
export function writeHeartbeatFile(content: string, configDir?: string): void {
  const dir = configDir ?? getConfigDir()
  ensureConfigStructure(dir)
  const heartbeatPath = path.join(dir, 'HEARTBEAT.md')
  fs.writeFileSync(heartbeatPath, content, 'utf-8')
}

/**
 * Read the CONSOLIDATION.md file (from config directory).
 * Falls back to template if the file/directory cannot be created.
 */
export function readConsolidationFile(configDir?: string): string {
  const dir = configDir ?? getConfigDir()
  const consolidationPath = path.join(dir, 'CONSOLIDATION.md')
  try {
    if (!fs.existsSync(consolidationPath)) {
      ensureConfigStructure(dir)
    }
    return fs.readFileSync(consolidationPath, 'utf-8')
  } catch {
    return CONSOLIDATION_TEMPLATE
  }
}

/**
 * Write the CONSOLIDATION.md file (to config directory)
 */
export function writeConsolidationFile(content: string, configDir?: string): void {
  const dir = configDir ?? getConfigDir()
  ensureConfigStructure(dir)
  const consolidationPath = path.join(dir, 'CONSOLIDATION.md')
  fs.writeFileSync(consolidationPath, content, 'utf-8')
}

export function readTasksGuidelinesFile(configDir?: string): string {
  const dir = configDir ?? getConfigDir()
  const tasksPath = path.join(dir, 'TASKS.md')
  try {
    if (!fs.existsSync(tasksPath)) {
      ensureConfigStructure(dir)
    }
    return fs.readFileSync(tasksPath, 'utf-8')
  } catch {
    return TASKS_TEMPLATE
  }
}

export function writeTasksGuidelinesFile(content: string, configDir?: string): void {
  const dir = configDir ?? getConfigDir()
  ensureConfigStructure(dir)
  const tasksPath = path.join(dir, 'TASKS.md')
  fs.writeFileSync(tasksPath, content, 'utf-8')
}

/**
 * Get the path for today's daily memory file
 */
export function getDailyFilePath(date?: Date, memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const d = date ?? new Date()
  const dateStr = d.toISOString().split('T')[0] // YYYY-MM-DD
  return path.join(dir, 'daily', `${dateStr}.md`)
}

/**
 * Ensure a daily memory file exists, creating it with a header if needed
 */
export function ensureDailyFile(date?: Date, memoryDir?: string): string {
  const filePath = getDailyFilePath(date, memoryDir)
  const dir = path.dirname(filePath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(filePath)) {
    const d = date ?? new Date()
    const dateStr = d.toISOString().split('T')[0]
    fs.writeFileSync(filePath, `# Daily Memory — ${dateStr}\n\n`, 'utf-8')
  }

  return filePath
}

/**
 * Read a daily memory file
 */
export function readDailyFile(date?: Date, memoryDir?: string): string {
  const filePath = ensureDailyFile(date, memoryDir)
  return fs.readFileSync(filePath, 'utf-8')
}

/**
 * Append content to a daily memory file
 */
export function appendToDailyFile(content: string, date?: Date, memoryDir?: string): void {
  const filePath = ensureDailyFile(date, memoryDir)
  fs.appendFileSync(filePath, content, 'utf-8')
}

/**
 * Read recent daily files (for context injection)
 */
export function readRecentDailyEntries(days: number = 3, memoryDir?: string): DailyMemoryEntry[] {
  const dir = memoryDir ?? getMemoryDir()
  const dailyDir = path.join(dir, 'daily')

  if (!fs.existsSync(dailyDir)) {
    return []
  }

  const now = new Date()
  const entries: DailyMemoryEntry[] = []

  for (let i = 0; i < days; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    const filePath = path.join(dailyDir, `${dateStr}.md`)

    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim()
      if (content && content !== `# Daily Memory — ${dateStr}`) {
        entries.push({ date: dateStr, path: filePath, content })
      }
    }
  }

  return entries
}

/**
 * Recent daily notes as one string, newest first. Unbudgeted — the system
 * prompt uses {@link readRecentDailyEntries} plus `budgetRecentMemory()`
 * instead; this stays for callers that want the raw material.
 */
export function readRecentDailyFiles(days: number = 3, memoryDir?: string): string {
  return readRecentDailyEntries(days, memoryDir).map(e => e.content).join(DAILY_SEPARATOR)
}

/**
 * Compute the current date, time and timezone for prompt injection.
 *
 * Split intentionally: the `date` is day-granular and safe to embed in the
 * cached system-prompt prefix, whereas `time` is minute-granular and must NOT
 * go into the system prompt — it would invalidate provider prompt caches every
 * minute. The minute-level time is appended to each user message instead (see
 * `formatCurrentTimeContext`).
 */
function getCurrentDateTimeParts(timezone?: string): { date: string; time: string; tz: string } {
  const tz = timezone || getDefaultTimezone()
  const now = new Date()
  const date = now.toLocaleDateString('en-CA', { timeZone: tz })
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })
  return { date, time, tz }
}

/**
 * Build the per-message current-time context appended to each user message.
 * Kept out of the (cached) system prompt so the prompt-cache prefix stays
 * stable across turns — only this small, always-fresh block changes per turn,
 * which the providers treat as new (uncached) content anyway.
 */
export function formatCurrentTimeContext(timezone?: string): string {
  const { time, tz } = getCurrentDateTimeParts(timezone)
  return `<current_time>Current time: ${time} (${tz})</current_time>`
}

/**
 * Assemble the full system prompt from all memory tiers
 */
/**
 * Minimal skill info for system prompt injection (progressive disclosure)
 */
export interface SkillPromptEntry {
  name: string
  description: string
  location: string
  /**
   * Optional warning to surface alongside the skill in the system prompt listing.
   * Used e.g. when a skill declares `required_env_vars` that are not currently set
   * ("⚠ requires: VAR_NAME"). The skill is still listed so the agent can inform
   * the user instead of failing silently.
   */
  warning?: string
}

/**
 * Which builtin web tools are enabled (mirrors BuiltinToolsConfig from web-tools).
 * Only the `enabled` flag is needed for prompt generation.
 */
export interface BuiltinToolsPromptConfig {
  webSearch?: { enabled?: boolean }
  webFetch?: { enabled?: boolean }
  stt?: { enabled?: boolean }
}

/**
 * Per-model entry surfaced in the system prompt's `<available_providers>`
 * block. Only models that carry a description or are the active/task default
 * are rendered, so the description doubles as the opt-in gate for agent
 * model routing.
 */
export interface AvailableProviderModelPromptEntry {
  id: string
  description?: string
  isDefaultAgentModel?: boolean
  isDefaultTaskModel?: boolean
}

/**
 * Self-identification of the running installation (`instanceIdentity` in
 * settings.json). Rendered as `<runtime_instance>` at the very top of the
 * prompt so the agent knows which instance it lives in before any retained
 * upstream branding (`<axiom_docs>`, `axiom.db`, `@axiom/*`) can mislead it.
 */
export interface RuntimeInstanceIdentity {
  name?: string | null
  notes?: string | null
}

/**
 * Build the `<runtime_instance>` block, or `null` when no instance name is
 * configured. An unset/empty name keeps the prompt byte-identical for
 * installations that never opted in.
 */
export function formatRuntimeInstanceBlock(identity?: RuntimeInstanceIdentity | null): string | null {
  const name = typeof identity?.name === 'string' ? identity.name.trim() : ''
  if (!name) return null
  const notes = typeof identity?.notes === 'string' ? identity.notes.trim() : ''
  const line = `You are running inside the "${name}" instance.${notes ? ` ${notes}` : ''}`
  return `<runtime_instance>\n${line}\n</runtime_instance>`
}

export function assembleSystemPrompt(options?: {
  memoryDir?: string
  configDir?: string
  baseInstructions?: string
  /**
   * Self-identification of this installation (settings `instanceIdentity`).
   * Rendered first, in every prompt profile and for every persona. Omitted
   * or empty name → no block.
   */
  instanceIdentity?: RuntimeInstanceIdentity | null
  /**
   * Number of recent daily memory files to inject (default 3). Set to a
   * lower value (or 0) for slim prompt profiles on slow/local providers.
   */
  recentDays?: number
  /**
   * Include the `<wiki_pages>` listing (default true). Slim prompt profiles
   * disable it to save tokens; the agent can still read wiki files on demand.
   */
  includeWikiPages?: boolean
  /**
   * Include the `<axiom_docs>` discovery block (default true). Slim prompt
   * profiles disable it to save tokens.
   */
  includeAxiomDocs?: boolean
  language?: string
  timezone?: string
  channel?: string
  skills?: SkillPromptEntry[]
  agentSkillsOverflowCount?: number
  currentUser?: { username: string }
  builtinTools?: BuiltinToolsPromptConfig
  agentSkillsDir?: string
  /**
   * Configured LLM providers and their enabled models with per-model
   * metadata (description, default flags). Only models that carry a
   * description or are the active/task default are rendered, so the agent
   * can route background tasks to annotated models.
   */
  availableProviders?: Array<{ name: string; models: AvailableProviderModelPromptEntry[] }>
  /** Agent ID for multi-persona support. When set (and not 'main') and persona files exist, they override global files. */
  agentId?: string
  /** Base directory containing persona dirs (tests only; default /data/agents). */
  agentsBaseDir?: string
  /**
   * Force-enable/disable scoped per-persona memory, bypassing settings
   * (tests / DI). When undefined, resolved from multiPersona settings.
   */
  scopedAgentMemory?: boolean
}): string {
  const recentDays = options?.recentDays ?? 3

  // RC5 (multi-persona bleeding): non-main personas with scoped memory
  // enabled read/write their OWN memory root (/data/agents/<id>/memory/)
  // instead of the shared global memory dir. This scopes <core_memory>,
  // <recent_memory> (dailies), wiki pages, user profiles and the
  // <memory_paths> the LLM is told to write to. Main is unchanged.
  const isPersona = !!options?.agentId && options.agentId !== 'main'
  const scopedAgentMemory = isPersona
    && (options?.scopedAgentMemory ?? isScopedAgentMemoryEnabled())
  const memoryDir = scopedAgentMemory
    ? getAgentMemoryDir(options!.agentId!, options?.agentsBaseDir)
    : options?.memoryDir

  // Ensure structure exists (for scoped personas this idempotently
  // bootstraps /data/agents/<id>/memory/ with MEMORY.md, daily/, users/, wiki/)
  ensureMemoryStructure(memoryDir)

  // Load persona context if agentId is specified (non-'main'). Persona files
  // in /data/agents/<id>/ override the corresponding global files.
  let persona: PersonaContext | null = null
  if (isPersona) {
    persona = loadPersona(options!.agentId!, {
      baseDir: options?.agentsBaseDir,
      // When scoping is forced on (tests/DI), persona files must load even
      // if the settings file is not available in the environment.
      skipFeatureCheck: options?.scopedAgentMemory === true ? true : undefined,
    })
  }

  const sections: string[] = []

  // 0. Which installation this is. Rendered before everything else so the
  // agent never has to infer its identity from retained upstream names.
  // Independent of prompt profile and persona; absent when not configured.
  const runtimeInstance = formatRuntimeInstanceBlock(options?.instanceIdentity)
  if (runtimeInstance) {
    sections.push(runtimeInstance)
  }

  // 1. Personality from SOUL.md (persona overrides global)
  const soul = persona?.soul ?? readSoulFile(memoryDir)
  sections.push(`<personality>\n${soul.trim()}\n</personality>`)

  // 1b. Identity from IDENTITY.md (persona-only, not in global)
  if (persona?.identity) {
    sections.push(`<identity>\n${persona.identity.trim()}\n</identity>`)
  }

  // 2. Base technical instructions (if any)
  if (options?.baseInstructions) {
    sections.push(`<instructions>\n${options.baseInstructions.trim()}\n</instructions>`)
  }

  // 2b. Tool hints from persona TOOLS.md (persona-only addition)
  if (persona?.tools) {
    sections.push(`<tool_hints>\n${persona.tools.trim()}\n</tool_hints>`)
  }

  // 3. Agent rules from AGENTS.md (persona overrides global)
  const agentsRules = persona?.agents ?? readAgentsRulesFile(options?.configDir)
  sections.push(`<agent_rules>\n${agentsRules.trim()}\n</agent_rules>`)

  // SPEC 11.5: the system prompt is a stable prefix followed by a dynamic
  // tail. Everything that changes daily or on consolidation (MEMORY.md,
  // recent daily context, user profile, wiki page list, skills list) goes
  // into `tail` and is appended after the constant blocks, so the cached
  // prefix survives a summary write or a consolidation run.
  const tail: string[] = []

  // 4. Core memory from MEMORY.md (persona memory is additional, not replacing)
  const agents = readMemoryFile(memoryDir)
  tail.push(`<core_memory>\n${agents.trim()}\n</core_memory>`)

  // 4b. Agent-specific memory (from persona MEMORY.md, additive)
  if (persona?.memory) {
    tail.push(`<agent_memory>\n${persona.memory.trim()}\n</agent_memory>`)
  }

  // 5. Recent daily context, capped by a character budget (token audit
  // 2026-09-17 §1.6: this block was unlimited and cost up to 85k tokens per
  // turn). Newest day first, older days cut first, every cut named with the
  // file it came from so the agent can read the rest on demand.
  const heuristics = loadHeuristics()
  const dailyEntries = readRecentDailyEntries(recentDays, memoryDir)
  const budgeted = budgetRecentMemory(dailyEntries, {
    maxChars: heuristics.recentMemory.maxChars,
    dailyDir: path.join(memoryDir ?? getMemoryDir(), 'daily'),
    warnFactor: heuristics.recentMemory.warnFactor,
  })
  if (budgeted.text) {
    tail.push(`<recent_memory>
These are summarized session notes from recent days. They are condensed — for full conversation details, use the read_chat_history tool.

${budgeted.text}
</recent_memory>`)
  }

  // 6. User profile injection (persona USER.md overrides global user profile)
  if (persona?.user) {
    tail.push(`<user_profile>\n${persona.user.trim()}\n</user_profile>`)
  } else if (options?.currentUser?.username) {
    const profileContent = readUserProfile(options.currentUser.username, memoryDir)
    tail.push(`<user_profile>\n${profileContent.trim()}\n</user_profile>`)
  } else {
    const usersPath = getUserProfileDir(memoryDir)
    tail.push(`<user_profiles_path>${usersPath}</user_profiles_path>`)
  }

  // 7. Available tools overview
  {
    const toolLines: string[] = [
      '- **shell**: Execute shell commands and return stdout/stderr. Use sudo for privileged operations.',
      '- **read_file**: Read the contents of a file at a given path.',
      '- **write_file**: Write content to a file. Creates parent directories if needed.',
      '- **edit_file**: Edit a file using exact oldText→newText replacements. Prefer this over write_file for partial changes — it saves tokens and reduces errors.',
      '- **list_files**: List files and directories at a given path.',
    ]

    // Web tools (enabled by default unless explicitly disabled)
    if (options?.builtinTools?.webSearch?.enabled !== false) {
      toolLines.push('- **web_search**: Search the web for information. Returns results with title, URL, and snippet.')
    }
    if (options?.builtinTools?.webFetch?.enabled !== false) {
      toolLines.push('- **web_fetch**: Fetch a web page and extract its text content. Use after web_search to read actual page contents.')
    }

    // Task & scheduling tools
    toolLines.push(
      '- **create_task**: Start a background task for complex, long-running work.',
      '- **resume_task**: Resume a paused task by sending it a message.',
      '- **list_tasks**: List background tasks with their status.',
      '- **create_cronjob**: Create a recurring scheduled task.',
      '- **edit_cronjob**: Edit an existing cronjob.',
      '- **remove_cronjob**: Remove a cronjob.',
      '- **list_cronjobs**: List all cronjobs.',
      '- **get_cronjob**: Get the full configuration (including complete prompt) of a single cronjob by ID.',
      '- **create_reminder**: Create a one-time reminder delivered at a specific time.',
    )

    // STT tool (only when enabled)
    if (options?.builtinTools?.stt?.enabled) {
      toolLines.push('- **transcribe_audio**: Transcribe an audio file from the workspace to text. Supports mp3, wav, ogg, webm, m4a, flac. Use after downloading audio (e.g., with yt-dlp via shell).')
    }

    // Chat history and fact memory
    toolLines.push('- **read_chat_history**: Read past chat messages from the database with datetime/source/role filters. Supports a query parameter for full-text search on message content and tool call inputs/outputs.')
    toolLines.push('- **search_memories**: Search the agent\'s fact memory for previously learned information from past conversations. Use when the user asks about past decisions, preferences, or details.')

    // Provider quota (admin-only; the tool itself enforces the role check)
    toolLines.push('- **provider_quota**: Check the subscriber usage quota of configured LLM providers (utilization per window, reset times, plan). Only available to admin users.')

    // Agent skills tool (only useful when there are more skills than shown in the prompt)
    if (options?.agentSkillsOverflowCount && options.agentSkillsOverflowCount > 10) {
      toolLines.push(`- **list_agent_skills**: Browse all ${options.agentSkillsOverflowCount} self-created agent skills (only the 10 most recent are shown in the available_skills block).`)
    }

    sections.push(`<available_tools>\nYou have the following tools available. Use the right tool for the job.\n\n${toolLines.join('\n')}\n</available_tools>`)
  }

  // 7b. Configured LLM providers — lets the agent route background tasks to
  // an annotated model. Only models with a description or the active/task
  // default are listed; the description is the user's opt-in gate for agent
  // autonomy (no description + not a default → hidden from the agent).
  if (options?.availableProviders && options.availableProviders.length > 0) {
    const providerLines: string[] = []
    for (const provider of options.availableProviders) {
      for (const model of provider.models) {
        const isRoutable =
          Boolean(model.description) ||
          model.isDefaultAgentModel === true ||
          model.isDefaultTaskModel === true
        if (!isRoutable) continue

        const labels: string[] = []
        if (model.isDefaultAgentModel) labels.push('default agent model')
        if (model.isDefaultTaskModel) labels.push('default task model')
        if (model.description) labels.push(model.description)
        const suffix = labels.join('. ')
        providerLines.push(
          suffix ? `- ${provider.name} — ${model.id}: ${suffix}` : `- ${provider.name} — ${model.id}`,
        )
      }
    }

    if (providerLines.length > 0) {
      sections.push(`<available_providers>
Configured LLM providers and their enabled models. When the user asks for a task or cronjob with a specific model or provider, pass it through to \`create_task\` / \`create_cronjob\` / \`edit_cronjob\` via their \`provider\` and/or \`model\` parameters. If the user names only a model (e.g. "run this with kimi-k2.6"), pass it as \`model\` — the tool will auto-detect the provider from this list.

For background tasks, you may choose the most appropriate model based on the descriptions below. Prefer cost-effective models for simple work; use stronger models for complex coding or research. When a description indicates a model is suited for a specific task type (e.g. "Textverarbeitung wie Twitter/Reddit Digest"), prefer that model for matching tasks.

${providerLines.join('\n')}
</available_providers>`)
    }
  }

  // 8. Wiki pages (LLM-maintained knowledge base).
  // Skipped entirely when the prompt profile disables it (slim profiles for
  // slow/local providers) — the agent can still read wiki files on demand.
  const wikiPages = options?.includeWikiPages === false ? [] : listWikiPages(memoryDir)
  if (wikiPages.length > 0) {
    const pageLines = wikiPages.map(n => {
      const aliasStr = n.aliases.length > 0 ? ` (aliases: ${n.aliases.join(', ')})` : ''
      return `- ${n.filename}${aliasStr}`
    }).join('\n')
    tail.push(`<wiki_pages>
The wiki is the agent's structured knowledge base. Maintain and organize it autonomously: add new pages, extend existing ones, merge duplicates, fix stale entries, and keep cross-links healthy without asking for permission. When discussing a topic covered by a wiki page, load it with read_file for context. Use write_file or edit_file to create or update wiki pages when you learn something worth preserving. Raw source material for the wiki lives under sources/ — wiki pages can cite it in a ## Sources section.

For non-trivial wiki work (ingesting a new source, creating a new page, running a lint pass, or auditing structure), load the built-in \`wiki\` agent skill first by reading ${options?.agentSkillsDir ?? '/data/skills_agent'}/wiki/SKILL.md — it contains the canonical conventions (frontmatter, filenames, cross-links, ## Sources/Quellen) and the ingest/query/lint workflows.

Only ask the user when you hit a genuine contradiction (new information conflicts with an existing page) that you cannot resolve on your own — then present the options (A vs. B) and let the user decide. Routine edits, additions, and reorganization do not require confirmation.

${pageLines}
</wiki_pages>`)
  }

  // 9. Memory and config file paths for agent self-access
  const dir = memoryDir ?? getMemoryDir()
  const cfgDir = options?.configDir ?? getConfigDir()
  const today = new Date().toISOString().split('T')[0]
  sections.push(`<memory_paths>
You can read and write your memory and config files directly using read_file, write_file, and edit_file tools.
When modifying existing files, prefer edit_file (targeted oldText/newText replacements) over write_file (full rewrite) to save tokens and reduce errors.

Memory files:
- SOUL.md: ${path.join(dir, 'SOUL.md')}
- MEMORY.md: ${path.join(dir, 'MEMORY.md')}
- Daily memory directory: ${path.join(dir, 'daily/')} (today's file is named in the current_date block)
- User profiles directory: ${path.join(dir, 'users/')}
- Wiki pages directory: ${path.join(dir, 'wiki/')}
- Sources directory (immutable raw material): ${path.join(dir, 'sources/')}

Config files:
- AGENTS.md (agent rules): ${path.join(cfgDir, 'AGENTS.md')}
- HEARTBEAT.md (heartbeat tasks): ${path.join(cfgDir, 'HEARTBEAT.md')}
- CONSOLIDATION.md (consolidation rules): ${path.join(cfgDir, 'CONSOLIDATION.md')}
- TASKS.md (background task guidelines): ${path.join(cfgDir, 'TASKS.md')}
</memory_paths>`)

  // 9b. Axiom documentation (read-only, shipped with the image).
  // We deliberately do NOT enumerate topic→file routes here — they drift
  // every time the docs are reorganized. Instead we point at the three
  // top-level directories and let the agent discover via list_files +
  // filename matching, which costs one extra tool call but never lies.
  // Skipped when the prompt profile disables it (slim profiles).
  if (options?.includeAxiomDocs !== false) {
    const readmePath = getReadmePath()
    const docsPath = getDocsPath()
    sections.push(`<axiom_docs>
Offtangent's user-facing documentation is shipped with the image. When the user asks how to set up, configure, or use Offtangent (providers, memory, skills, tasks, tools, web UI, telegram, env vars, settings, file paths, …), read the relevant .md file directly instead of guessing.

- Main README (entry point with links): ${readmePath}
- Concept docs (architecture, mental models): ${path.join(docsPath, 'concepts/')}
- User guide (setup, configuration, usage): ${path.join(docsPath, 'guide/')}
- Reference (env vars, settings.json schema, file paths): ${path.join(docsPath, 'reference/')}

Discovery: use list_files on the directory and read the file whose name matches the topic; follow .md cross-links when a topic spans multiple files. Always read the full file before answering. Do not write to these files — they are managed in the source tree, not in user data.
</axiom_docs>`)
  }

  // 10. Agent skill creation pointer.
  // The full format/conventions guide lives in the built-in `skill-creator`
  // agent skill (data/skills_agent/skill-creator/SKILL.md) so it is loaded
  // on demand instead of paying its token cost on every turn.
  if (options?.agentSkillsDir) {
    sections.push(`<agent_skills>
You can create new reusable agent skills under ${options.agentSkillsDir}/<skill-name>/SKILL.md. They are auto-discovered on the next message and appear in the available_skills block.

For the format, naming rules, gating fields, and worked examples, load the built-in **skill-creator** skill (listed in the available_skills block) before writing a new SKILL.md.
</agent_skills>`)
  }

  // 11. Available skills (progressive disclosure)
  if (options?.skills && options.skills.length > 0) {
    const skillEntries = options.skills.map(s => {
      const warningTag = s.warning ? `\n    <warning>${s.warning}</warning>` : ''
      return `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.location}</location>${warningTag}\n  </skill>`
    }).join('\n')
    let overflowNote = ''
    if (options?.agentSkillsOverflowCount && options.agentSkillsOverflowCount > 10) {
      overflowNote = `\n\nYou have ${options.agentSkillsOverflowCount} self-created agent skills in total (only the 10 most recent are shown above). Use \`list_agent_skills\` to browse all of them.`
    }

    tail.push(`<available_skills>
The following skills provide specialized capabilities you can load on demand.
When the user's request materially matches a skill's description, load that skill before continuing.
To load a skill, use the read_file tool to read <location>/SKILL.md, then follow that file's instructions.
Treat this as a strong routing rule: do not answer from memory when a matching skill should be used first.
Do not claim to be using a skill unless you actually loaded its SKILL.md in the current conversation.

${skillEntries}${overflowNote}
</available_skills>`)
  }

  // 12. Task system instructions.
  // The full guide (when to use what, prompt-writing, injection handling,
  // cron expressions, attached_skills, …) lives in the built-in
  // `tasks-and-cronjobs` agent skill so it is loaded on demand instead of
  // paying its token cost on every turn. Two things stay inline:
  //   1. The hard SAFETY rule (never spawn OS-level schedulers) — must
  //      apply *before* the agent has a chance to load any skill.
  //   2. The `<task_injection>` trigger — so the agent knows to load the
  //      skill when one arrives instead of responding ad-hoc.
  sections.push(`<task_system>
Background tasks (create_task), cronjobs (create_cronjob, edit_cronjob, remove_cronjob, list_cronjobs, get_cronjob), and reminders (create_reminder) are listed in the available_tools block. For when to use which, how to write task prompts, how to handle <task_injection> messages, how to route follow-up answers into paused tasks (resume_task), and cron expression / action_type / attached_skills conventions, load the **tasks-and-cronjobs** built-in skill (in the available_skills block).

SAFETY: NEVER use OS-level schedulers (system crontab, launchd, at, or shell-spawned long-running processes via nohup / & / background loops). Always use the built-in cronjob and task tools instead.

When you receive a <task_injection> block (signalling a background-task result with status="completed|failed|question"), load the tasks-and-cronjobs skill before responding to it.
</task_system>`)

  // 12b. Canvas artifacts (SPEC 7.4b, R2). Without this block no model ever
  // uses the canvas, so it is part of the prompt and not of an optional
  // skill: the decision "artifact or text" has to be made while answering.
  sections.push(`<canvas>
You can hand the user an artifact: a self-contained HTML page, an SVG diagram or a small interactive tool. Write it as a fenced \`\`\`html (or \`\`\`svg) block in your message; the server extracts it into a canvas the user can open, full screen, and reopen from the strand later. An optional title goes after the language, e.g. \`\`\`html Rendite-Rechner.

Send an artifact when the content is visual, tabular beyond four columns, interactive, or something the user will want to open again later. Keep it in text when one paragraph or one code/snippet block answers the question.

Always write a one or two sentence text summary next to the artifact and never delete the fenced block from your message: Telegram and the plain web view show the text and the raw block, and a message that is only an artifact reads as empty there.

Artifact constraints, because the canvas runs the page in a locked-down sandbox:
- Everything must be inline. No <script src>, no external stylesheet, no web font, no CDN, no image URL, no fetch/XHR/WebSocket — the sandbox blocks all network access and the page will silently break.
- No cookies, no localStorage, no access to the app: the artifact is an isolated document, not part of the UI.
- Keep it under 2 MB. A larger block is not stored as an artifact.
- Charts: draw them yourself with inline SVG or canvas, do not load a chart library.
</canvas>`)

  // 13. Workspace directory
  const workspaceDir = getWorkspaceDir()
  sections.push(`<workspace>\nYour working directory is ${workspaceDir}. All shell commands execute in this directory by default.\nAll relative paths in read_file, write_file, and list_files resolve against this directory.\nUse this directory for cloning repos, creating files, and all file operations.\n</workspace>`)

  // Cache breakpoint (token audit 2026-09-17 §2.2): everything above is
  // stable across turns, everything below changes when the agent writes to its
  // own memory. `buildStreamFn` strips this marker before sending and, for
  // Anthropic models, turns it into a second `cache_control` breakpoint so a
  // daily-file write only invalidates the tail instead of the whole prompt.
  sections.push(SYSTEM_PROMPT_CACHE_MARKER)

  // Dynamic tail (SPEC 11.5): memory, daily context, user profile, wiki
  // list, skills list. Appended here, behind every constant block.
  sections.push(...tail)

  // 14. Current date (date only — kept at day-granularity so the cached
  // system-prompt prefix stays stable across turns. The precise minute-level
  // time is appended to each user message instead via formatCurrentTimeContext(),
  // which avoids invalidating provider prompt caches every minute.)
  // The path of today's daily file lives here, not in <memory_paths>: it
  // carries the date and would otherwise rotate a line inside the stable,
  // cached prefix once a day.
  const { date, tz } = getCurrentDateTimeParts(options?.timezone)
  sections.push(`<current_date>\nCurrent date: ${date} (${tz})\nToday's daily file: ${path.join(dir, 'daily', `${today}.md`)}\n</current_date>`)

  // 15. Language setting (placed near the end for recency: "respond in X" hits
  // the model right before it processes the user message).
  if (options?.language) {
    const lang = options.language.trim()
    if (lang.toLowerCase() === 'match' || lang.toLowerCase() === "match user's language") {
      sections.push(`<language>\nRespond in the same language that the user writes in. Match the user's language automatically.\n</language>`)
    } else {
      sections.push(`<language>\nAlways respond in ${lang}.\n</language>`)
    }
  }

  // 16. Channel context
  if (options?.channel === 'telegram') {
    sections.push(`<channel_context>
You are communicating with the user through Telegram. You ARE the Telegram bot — messages the user sends arrive directly to you, and your responses are sent back to the user automatically. Do not tell the user to use the Telegram Bot API, curl commands, or any external tools to communicate. Just respond naturally to their messages.
Keep responses concise and well-formatted for Telegram (use Markdown sparingly, avoid very long messages).
</channel_context>`)
  }

  return sections.join('\n\n')
}
