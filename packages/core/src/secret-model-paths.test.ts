/**
 * Second architecture test of the secret boundary (plan 2026-09-26, step 1,
 * report T3 — the last open point of that report).
 *
 * `secret-write-paths.test.ts` guards everything that PERSISTS text. This file
 * guards the other direction: every place that hands text to a MODEL. A sealed
 * database is worthless if some background job sends the raw text to a cloud
 * model next to it.
 *
 * The call patterns are taken from the code, not from a wish list: the repo
 * talks to models through pi-ai's `completeSimple()`, through a `new PiAgent(`
 * loop, and through `embedTexts()` for vectors. There is no `.complete(`,
 * `.stream(`, `new Agent(`, `streamText(` or `generateText(` call site in
 * packages/{core,web-backend,telegram}/src — the negative test below keeps it
 * that way, so a future SDK style cannot slip in unclassified.
 *
 * Every hit must carry an entry in {@link MODEL_CALL_SITES} with one of:
 * - `redacted-context`: the messages pass `transformContext` →
 *   `redactMessages()` before they leave the process (the agent loops).
 * - `sealed-text`: the text comes out of a sealed source (a chat_messages row,
 *   a sealed capture, a model answer, a tool result behind
 *   `withSecretBoundary`), so it can only carry `{{secret:<slug>}}` handles.
 * - `no-user-text`: the prompt is composed by the server and contains no user
 *   text at all (health probes, loop detection over tool names).
 * - `wrapper`: the thin indirection itself (`pi-models.ts#completeSimple`),
 *   no text of its own.
 * - `unsealed-user-text`: user text that reaches a model WITHOUT the boundary.
 *   Only allowed for a site that is listed in {@link KNOWN_UNSEALED} with a
 *   reason; every other one fails the test.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const PACKAGES = ['core', 'web-backend', 'telegram']

/** How this code base calls a model. */
const MODEL_CALL_PATTERNS = ['completeSimple(', 'new PiAgent(', 'embedTexts(']

/**
 * Call shapes of other SDK styles. None of them exists here today; a new one
 * would be a model path nobody classified, so its appearance fails the test.
 */
const FOREIGN_CALL_PATTERNS = ['.complete(', '.stream(', 'new Agent(', 'streamText(', 'generateText(']

type CallClass =
  | 'redacted-context'
  | 'sealed-text'
  | 'no-user-text'
  | 'wrapper'
  | 'unsealed-user-text'
  /**
   * Text that a registered EXTERNAL service handed in over its own API and that
   * never touched a local chat, capture, memory row or agent context. No local
   * value can be in it, so there is nothing to unseal — but the site still owes
   * an entry in {@link KNOWN_EXTERNAL_TEXT} explaining why no local data can
   * reach it.
   */
  | 'external-service-text'

const MODEL_CALL_SITES: Record<string, { class: CallClass; why: string }> = {
  // ------------------------------------------------- the indirection itself
  'core/src/pi-models.ts#completeSimple': {
    class: 'wrapper',
    why: 'Declaration and delegation of the wrapper every non-agent call goes through. It adds no text; the callers below are what matters.',
  },
  // ----------------------------------------------------------- agent loops
  'core/src/agent-runtime.ts#constructor': {
    class: 'redacted-context',
    why: 'The interactive turn agent. Its transformContext runs redactMessages() as the last net before the request leaves, on top of the text being sealed at the channel edge already.',
  },
  'core/src/task-runner.ts#resolveApiKey': {
    class: 'redacted-context',
    why: 'The task agent. Tools are wrapped with withSecretBoundary and transformContext ends in redactMessages(), so neither the prompt nor a tool result can carry a raw value.',
  },
  'core/src/connectors/sub-agent.ts#executeRun': {
    class: 'redacted-context',
    why: 'The connector sub-agent (plan 2026-09-26, P2). Its transformContext ends in redactMessages(), and the model it may run on is restricted to a strictly local one by isStrictlyLocalModel — checked before the run and inside the stream function before every call, with no fallback to any other model.',
  },
  'core/src/task-runner.ts#runSmartDetection': {
    class: 'no-user-text',
    why: 'Loop detection over the tool-call history (tool names, call counts, argument fingerprints from the tracker), not over the conversation.',
  },
  // ------------------------------------------- background jobs on stored text
  'core/src/agent.ts#generateSessionSummary': {
    class: 'sealed-text',
    why: 'Session summary over the transcript read from chat_messages; those rows are sealed at the entry paths (see secret-write-paths.test.ts).',
  },
  'core/src/fact-extraction.ts#extractAndStoreFacts': {
    class: 'sealed-text',
    why: 'Fact extraction over the same stored transcript, so only handles can appear in the prompt.',
  },
  'core/src/project-assignment.ts#defaultCompletion': {
    class: 'sealed-text',
    why: 'Project assignment of a capture. The prompt is built from the capture text, which CapturesService seals before it is stored.',
  },
  'core/src/capture-router.ts#defaultCompletion': {
    class: 'sealed-text',
    why: 'Router decision over the sealed capture text (proven end to end in privacy-secret-wiring.test.ts: the canary never reaches the router model).',
  },
  'core/src/capture-split.ts#defaultCompletion': {
    class: 'sealed-text',
    why: 'Split stage over the same sealed capture text.',
  },
  'core/src/speech-summary.ts#defaultCompletion': {
    class: 'sealed-text',
    why: 'Voice summary of a strand; the prompt is assembled from stored, sealed rows. The shortening round for an over-long answer (main 8da8332e) is a SECOND call through this same function, so it passes the same data-policy gate and sees the same sealed source plus the model\'s own draft.',
  },
  'core/src/ask-agent-tool.ts#createAskAgentTool': {
    class: 'sealed-text',
    why: 'Cross-persona question. The question is written by a model that already ran behind the boundary, and the tool itself is wrapped by withSecretBoundary.',
  },
  'core/src/task-runner.ts#pumpQueue': {
    class: 'sealed-text',
    why: 'Result verification (`verifyResult`, keyed by the nearest preceding declaration `pumpQueue`). Task prompt and reported result both come from rows written behind the boundary.',
  },
  'web-backend/src/bootstrap/runtime-composition.ts#draftTaskPlan': {
    class: 'sealed-text',
    why: 'Plan draft for a confirmed task (`draftTaskPlan`). Its fallback to the active provider passes the model gate (F3). `input.prompt` is the task request as it was stored (the chat row was sealed at the edge) and buildChatContextBlock reads sealed chat_messages rows.',
  },
  // -------------------------------------------------------------- embeddings
  'core/src/memory-embeddings.ts#embedTexts': {
    class: 'wrapper',
    why: 'Declaration of the embedding helper itself: builds the /embeddings request for the callers below and carries no text of its own.',
  },
  'core/src/memory-embeddings.ts#embedMemoryBestEffort': {
    class: 'sealed-text',
    why: 'Vector for one memory fact. Facts are extracted from sealed transcripts, so a secret value cannot be in the text.',
  },
  'core/src/memory-embeddings.ts#searchMemoriesByEmbedding': {
    class: 'sealed-text',
    why: 'Embeds the search query, which comes from the agent (behind the boundary) or from an already sealed user message.',
  },
  'core/src/memory-embeddings.ts#backfillMemoryEmbeddings': {
    class: 'sealed-text',
    why: 'Backfill over the same fact rows.',
  },
  'core/src/memory-page-embeddings.ts#refreshWikiPageEmbeddings': {
    class: 'sealed-text',
    why: 'Embeds wiki pages from the memory tree — agent-written notes, not a live user message.',
  },
  // ------------------------------------------------------- no user text at all
  'core/src/provider-health.ts#performPiAiHealthCheck': {
    class: 'no-user-text',
    why: 'Health probe with the fixed prompt "Respond with OK only." and maxTokens 5.',
  },
  // ------------------------------------------------- inbound external service
  'core/src/isolated-inference.ts#defaultCompletion': {
    class: 'external-service-text',
    why: 'The isolated inference gateway (POST /v1/isolated/infer). The prompt is the server side profile prompt plus the `input` a registered service posted; it reads no chat, capture, memory, strand or agent context, so no local (sealable) value can enter it. See KNOWN_EXTERNAL_TEXT.',
  },
  // ------------------------------------------------------ documented exception
  'core/src/stt.ts#rewriteTranscript': {
    class: 'unsealed-user-text',
    why: 'Cleans up a raw speech transcript before the channel edge seals it. See KNOWN_UNSEALED.',
  },
}

/**
 * The only site that may hand unsealed user text to a model, with the reason
 * why that is defensible. Anything else with that class fails.
 */
const KNOWN_UNSEALED: Record<string, string> = {
  'core/src/stt.ts#rewriteTranscript': 'The transcript is the answer of the STT provider, which already received the spoken audio itself — '
    + 'sealing the text afterwards cannot take the value back from that provider. The rewrite runs on the same '
    + 'speech path and its model is subject to the data-policy gate (role `stt-rewrite`), and the channel edge '
    + '(ws-chat / REST / telegram bot) seals the transcript before it is stored or sent to the turn agent. '
    + 'Open point in the integration report: sealing before the rewrite call would still be an improvement.',
}

/**
 * Sites that may send text of an external service to a model, with the reason
 * why no local data can reach that prompt. Anything else with that class fails.
 */
const KNOWN_EXTERNAL_TEXT: Record<string, string> = {
  'core/src/isolated-inference.ts#defaultCompletion': 'The module imports only config, data-policy, pi-models and provider-config '
    + '(pinned by isolated-inference.test.ts), so it has no access to the database, to memory, to chats, strands, captures, '
    + 'connectors or tools. Its only input is the `input` string of the request, which the caller sends over HTTP; the system '
    + 'prompt belongs to the server side profile and the caller cannot set one. The model is chosen by the profile and still '
    + 'passes the data-policy gate, so region/training rules apply exactly as for every other call.',
}

const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'try', 'do', 'await'])

/** Nearest preceding declaration of a function/method for a line index. */
function enclosingName(lines: string[], index: number): string {
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:private\s+|public\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^{;]+)?\{\s*$/,
    /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
  ]
  for (let i = index; i >= 0; i--) {
    for (const pattern of patterns) {
      const match = pattern.exec(lines[i]!)
      if (match && !RESERVED.has(match[1]!)) return match[1]!
    }
  }
  return '<module>'
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...sourceFiles(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.fixture.ts')) {
      out.push(full)
    }
  }
  return out
}

function findCallSites(patterns: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const pkg of PACKAGES) {
    const root = path.join(REPO_ROOT, 'packages', pkg, 'src')
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, 'utf-8')
      if (!patterns.some(pattern => text.includes(pattern))) continue
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
        if (!patterns.some(pattern => code.includes(pattern))) return
        const rel = `${pkg}/${path.relative(path.join(REPO_ROOT, 'packages', pkg), file).replace(/\\/g, '/')}`
        const key = `${rel}#${enclosingName(lines, index)}`
        const hits = found.get(key) ?? []
        hits.push(`${rel}:${index + 1}`)
        found.set(key, hits)
      })
    }
  }
  return found
}

describe('secret boundary: model-call inventory (T3, second architecture test)', () => {
  const found = findCallSites(MODEL_CALL_PATTERNS)

  it('finds the model call sites at all', () => {
    // A refactor that renames the wrapper must not silently empty this test.
    expect(found.size).toBeGreaterThan(10)
  })

  it('classifies every place that hands text to a model', () => {
    const unclassified = [...found.entries()]
      .filter(([key]) => !(key in MODEL_CALL_SITES))
      .map(([key, hits]) => `${key} (${hits.join(', ')})`)
    expect(
      unclassified,
      'New model call site(s) found. Add an entry to MODEL_CALL_SITES in secret-model-paths.test.ts and state the class: '
      + 'redacted-context (goes through transformContext/redactMessages), sealed-text (gets sealed text only), '
      + 'no-user-text (server-composed prompt) or wrapper. A site that sends raw user text must be fixed, not classified.',
    ).toEqual([])
  })

  it('has no stale classification', () => {
    const stale = Object.keys(MODEL_CALL_SITES).filter(key => !found.has(key))
    expect(stale, 'MODEL_CALL_SITES lists a call site that no longer exists; remove the entry.').toEqual([])
  })

  it('states a reason for every classification', () => {
    for (const [key, entry] of Object.entries(MODEL_CALL_SITES)) {
      expect(entry.why.length, `${key} needs a reason`).toBeGreaterThan(20)
    }
  })

  it('allows unsealed user text only for the documented exception', () => {
    const unsealed = Object.entries(MODEL_CALL_SITES)
      .filter(([, entry]) => entry.class === 'unsealed-user-text')
      .map(([key]) => key)
    expect(
      unsealed.filter(key => !(key in KNOWN_UNSEALED)),
      'This site sends unsealed user text to a model. Seal it (sealText, tier "user") instead of classifying it.',
    ).toEqual([])
    for (const [key, reason] of Object.entries(KNOWN_UNSEALED)) {
      expect(reason.length, `${key} needs a reason in KNOWN_UNSEALED`).toBeGreaterThan(80)
      expect(MODEL_CALL_SITES[key]?.class).toBe('unsealed-user-text')
    }
  })

  it('allows external service text only for a documented inbound endpoint', () => {
    const external = Object.entries(MODEL_CALL_SITES)
      .filter(([, entry]) => entry.class === 'external-service-text')
      .map(([key]) => key)
    expect(
      external.filter(key => !(key in KNOWN_EXTERNAL_TEXT)),
      'This site sends text of an external caller to a model. Document in KNOWN_EXTERNAL_TEXT why no local data can reach it.',
    ).toEqual([])
    for (const [key, reason] of Object.entries(KNOWN_EXTERNAL_TEXT)) {
      expect(reason.length, `${key} needs a reason in KNOWN_EXTERNAL_TEXT`).toBeGreaterThan(80)
      expect(MODEL_CALL_SITES[key]?.class).toBe('external-service-text')
    }
    // Structural, not prose: this class exists for EXACTLY the isolated
    // inference endpoint. A new call site cannot be silenced with a paragraph,
    // it has to be discussed here.
    expect(
      Object.keys(KNOWN_EXTERNAL_TEXT).sort(),
      'external-service-text is reserved for the isolated inference gateway. A new entry needs a review, not a comment.',
    ).toEqual(['core/src/isolated-inference.ts#defaultCompletion'])
    // ... and the isolation that the reason above claims must still hold.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'packages/core/src/isolated-inference.ts'), 'utf-8')
    const imports = [...source.matchAll(/from '(\.[^']+)'/g)].map(m => m[1]).sort()
    expect(imports).toEqual(['./config.js', './data-policy.js', './pi-models.js', './provider-config.js'])
  })

  it('keeps both agent loops on the redacted context', () => {
    for (const [file, needle] of [
      ['packages/core/src/agent-runtime.ts', 'redactMessages('],
      ['packages/core/src/task-runner.ts', 'redactMessages('],
      ['packages/core/src/task-runner.ts', 'withSecretBoundary('],
      ['packages/core/src/agent-runtime.ts', 'withSecretBoundary('],
    ] as Array<[string, string]>) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8')
      expect(text, `${file} must keep ${needle}`).toContain(needle)
    }
  })

  it('has no model call through an unclassified SDK style', () => {
    const foreign = [...findCallSites(FOREIGN_CALL_PATTERNS).entries()]
      .map(([key, hits]) => `${key} (${hits.join(', ')})`)
    expect(
      foreign,
      'A model is called through a shape this inventory does not know. Either extend MODEL_CALL_PATTERNS and '
      + 'classify the site, or route the call through completeSimple().',
    ).toEqual([])
  })
})
