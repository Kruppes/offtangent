/**
 * Architecture test for the secret boundary (plan 2026-09-26, risk R2,
 * verification V6).
 *
 * The boundary is only worth something if EVERY path that persists text or
 * hands it to a model passes it. That cannot be proven by unit tests on the
 * paths we know about — the real risk is the path someone adds next month.
 *
 * So this test enumerates the write sites in the source tree (`INSERT INTO
 * chat_messages`, the capture/decision/tool-call writers) and demands that
 * each one carries an explicit classification in {@link WRITE_SITES}. A new,
 * unclassified site fails the test with the question it has to answer: is the
 * text sealed, is it our own system text, or does it come back from a tool
 * behind the boundary?
 *
 * Classes:
 * - `sealed-user-input`: carries text a person sent. Must be sealed at the
 *   channel edge before it reaches this line.
 * - `system-text`: text this server writes itself (dividers, model-change
 *   notes, queue notices). No user secret can enter here.
 * - `model-text`: text the model produced, i.e. already downstream of a sealed
 *   prompt and of the tool boundary.
 * - `tool-text`: tool results/errors. Sealed by `withSecretBoundary`.
 * - `infrastructure`: schema/migration/FTS statements, no content of its own.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const PACKAGES = ['core', 'web-backend', 'telegram']

/** Statements that put text into a durable row a model or the user reads back. */
const WRITE_PATTERNS = [
  'INSERT INTO chat_messages',
  'UPDATE chat_messages SET content',
  // Metadata carries TEXT too since the voice-note fix (main 8da8332e stores
  // `metadata.voiceNoteScript`, the words that were actually spoken) and since
  // the interaction answer records its label. A row's metadata is read back
  // into the UI and, for the answer label, into the transcript, so it belongs
  // in this inventory just like `content`.
  'UPDATE chat_messages SET metadata',
  'INSERT INTO captures',
  'UPDATE captures SET',
  'INSERT INTO router_decisions',
  'UPDATE router_decisions SET',
  'INSERT INTO tool_calls',
]

type WriteClass = 'sealed-user-input' | 'system-text' | 'model-text' | 'tool-text' | 'infrastructure'

/**
 * Every known write site, keyed by `<package>/<file>#<nearest declaration>`.
 * Several statements inside one function share an entry on purpose: the
 * classification is a property of the function, not of the SQL string.
 */
const WRITE_SITES: Record<string, { class: WriteClass; why: string }> = {
  // ---------------------------------------------------------------- core
  'core/src/turn-runner.ts#saveChatMessage': {
    class: 'sealed-user-input',
    why: 'The shared row writer of every interactive turn (user, assistant, tool, system). `startTurn` seals the user text of the turn (user tier) before this runs, so the `user` row can only hold handles.',
  },
  'core/src/turn-runner.ts#updateChatMessage': {
    class: 'model-text',
    why: 'Rewrites an assistant row while it streams; the content is the model output of an already sealed prompt.',
  },
  'core/src/agent.ts#hasOwnContext': {
    class: 'system-text',
    why: 'Model-fallback marker row ("Modell (automatischer Fallback): a -> b"), written by AgentCore itself.',
  },
  'core/src/agent-runtime.ts#repaired': {
    class: 'system-text',
    why: 'The same fallback marker row inside the runtime turn loop. Provider and model ids only.',
  },
  'core/src/task-notification.ts#persistTaskResultMessage': {
    class: 'model-text',
    why: 'Task result/summary row. The task agent ran behind withSecretBoundary, so its text carries handles at worst.',
  },
  'core/src/task-notification.ts#persistTaskStatusUpdateMessage': {
    class: 'system-text',
    why: 'Status line about a task (name, status, duration), composed by the server.',
  },
  'core/src/eco-tool-freeze.ts#freezeEcoToolResult': {
    class: 'tool-text',
    why: 'Real Eco freeze: stores the verbatim tool result (eco_original) and its compacted projection. Runs in afterToolCall, i.e. after the tool already went through withSecretBoundary, so both texts only contain handles.',
  },
  'core/src/task-runner.ts#finalizeTaskFailure': {
    class: 'tool-text',
    why: 'Assistant and tool transcript rows of a task turn. The task tools are wrapped with withSecretBoundary, so tool args/results only contain handles.',
  },
  'core/src/voice-note.ts#storeVoiceNote': {
    class: 'model-text',
    why: 'Writes `metadata.voiceNote` and `metadata.voiceNoteScript` (the spoken script) onto a message row. The script is the summary of that very row, which was sealed on its way in, so it can only carry handles; the shortening round of the summary uses the same sealed source.',
  },
  'core/src/uploads.ts#cleanupExpiredUploads': {
    class: 'infrastructure',
    why: 'Expiry cleanup of upload rows (`cleanupExpiredUploads`): sets metadata to NULL, writes no text at all.',
  },
  'core/src/token-logger.ts#logToolCall': {
    class: 'tool-text',
    why: 'The tool_calls table. Input and output come from the wrapped tool: the boundary seals the result before it is logged.',
  },
  'core/src/strand-store.ts#insertCapture': {
    class: 'sealed-user-input',
    why: 'The capture writer. Every caller goes through CapturesService.createCapture, which seals the text (user tier) as its first statement.',
  },
  'core/src/strand-store.ts#updateCapture': {
    class: 'sealed-user-input',
    why: 'Rewrites text/metadata of an existing capture from values that were sealed on the way in (split, keep-as-one, mode metadata).',
  },
  'core/src/strand-store.ts#insertDecision': {
    class: 'sealed-user-input',
    why: 'router_decisions.part_text is a slice of the already sealed capture text; rationale/tags come from the router model.',
  },
  'core/src/strand-store.ts#updateDecision': {
    class: 'sealed-user-input',
    why: 'Updates state/part_text of a decision from the same sealed capture text.',
  },
  'core/src/strand-fork.ts#forkStrand': {
    class: 'model-text',
    why: 'Both rows of a fork: the seed row in the new strand and the "forked into" pointer row in the parent. The seed is the handoff the agent wrote (model output of an already sealed prompt, stored as a `user` row so the new turn reads it as its input), the pointer line is server text plus the model-written title. No text of a person enters here — a person cannot call `fork_strand`.',
  },
  'core/src/database.ts#initDatabase': {
    class: 'infrastructure',
    why: 'Migration probe row plus the FTS triggers/rebuild. Copies existing rows, adds no text of its own.',
  },
  'core/src/offtangent-schema.ts#before': {
    class: 'infrastructure',
    why: 'Table rebuild of `captures` during a migration: copies the existing rows column by column.',
  },
  // --------------------------------------------------------- web-backend
  'web-backend/src/routes/chat.ts#abort': {
    class: 'sealed-user-input',
    why: 'POST /api/chat/message. The handler seals req.body.content (user tier) into `text` before this INSERT and returns the handles as the additive `sealed` field.',
  },
  'web-backend/src/ws-chat.ts#saveUserMessage': {
    class: 'sealed-user-input',
    why: 'Called with parsed.content, which the socket handler seals (user tier) right after the auth branch, before the slash dispatch and before the turn starts.',
  },
  'web-backend/src/api/modules/captures/service.ts#writeMessage': {
    class: 'sealed-user-input',
    why: 'Files a capture (or one of its parts) as a user row in a strand; the text was sealed in createCapture.',
  },
  'web-backend/src/api/modules/captures/service.ts#rememberSelection': {
    class: 'system-text',
    why: 'captures.metadata only: the turn model/mode selection of this capture, no text of the capture itself.',
  },
  'web-backend/src/api/modules/captures/service.ts#rememberSplit': {
    class: 'system-text',
    why: 'captures.metadata only: bookkeeping of the split stage (model, latency, reason), no capture text.',
  },
  'web-backend/src/api/modules/captures/service.ts#writeConfirmationCard': {
    class: 'system-text',
    why: 'The doubt-band confirmation card the server composes itself (strand names and a question).',
  },
  'web-backend/src/api/modules/interactions/service.ts#recordAnswer': {
    class: 'sealed-user-input',
    why: 'Records the answer (value, label, timestamp) in the metadata of the message that carries the block. The label is the one `answer` sealed (user tier) before it was used anywhere, so the collapsed chip after a reload shows handles, not the typed secret.',
  },
  'web-backend/src/api/modules/interactions/service.ts#fileAnswerMessage': {
    class: 'sealed-user-input',
    why: 'The picked option label is sealed (user tier) in `answer` before it becomes a user row and starts a turn.',
  },
  'web-backend/src/api/modules/captures/service.ts#move': {
    class: 'system-text',
    why: 'Sets the `misfiled: true` flag in the metadata of the capture message when a capture is moved/undone (keyed by the nearest preceding declaration `move`). A boolean, no capture text.',
  },
  'web-backend/src/api/modules/strands/service.ts#patchStrandModel': {
    class: 'system-text',
    why: 'Model-change marker row ("Modell: a -> b") plus its metadata.',
  },
  'web-backend/src/bootstrap/runtime-composition.ts#wireAgentCoreEvents': {
    class: 'model-text',
    why: 'Session divider row; its content is the session summary a model wrote from an already sealed transcript.',
  },
  'web-backend/src/task-file-delivery.ts#deliverTaskFile': {
    class: 'system-text',
    why: 'Delivery note for a file a task produced (caption, file name, size).',
  },
  'web-backend/src/task-injection-response.ts#buildMetadata': {
    class: 'model-text',
    why: 'The assistant row of an injected task answer, produced by an agent that ran behind the boundary.',
  },
  // ------------------------------------------------------------ telegram
  'telegram/src/bot.ts#processQueuedMessage': {
    class: 'sealed-user-input',
    why: 'The Telegram user row. Typed text and voice transcripts are sealed in bufferMessage (user tier) before they are queued.',
  },
  'telegram/src/bot.ts#handleIncomingAttachment': {
    class: 'sealed-user-input',
    why: 'Attachment captions are sealed in handleIncomingAttachment before the row is written.',
  },
  'telegram/src/bot.ts#syncOutgoingMessageToWeb': {
    class: 'model-text',
    why: 'Mirrors an outgoing bot message into the web transcript; the text is the agent answer.',
  },
}

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

const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'try', 'do'])

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

function findWriteSites(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const pkg of PACKAGES) {
    const root = path.join(REPO_ROOT, 'packages', pkg, 'src')
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, 'utf-8')
      if (!WRITE_PATTERNS.some(pattern => text.includes(pattern))) continue
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        if (!WRITE_PATTERNS.some(pattern => line.includes(pattern))) return
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

describe('secret boundary: write-path inventory (R2/V6)', () => {
  const found = findWriteSites()

  it('classifies every write site that persists text', () => {
    const unclassified = [...found.entries()]
      .filter(([key]) => !(key in WRITE_SITES))
      .map(([key, hits]) => `${key} (${hits.join(', ')})`)
    expect(
      unclassified,
      'New write path(s) found. Add an entry to WRITE_SITES in secret-write-paths.test.ts and say which class it is: '
      + 'sealed-user-input (seal it with sealText at the channel edge), system-text, model-text, tool-text or infrastructure.',
    ).toEqual([])
  })

  it('has no stale classification', () => {
    const stale = Object.keys(WRITE_SITES).filter(key => !found.has(key))
    expect(stale, 'WRITE_SITES lists a site that no longer exists; remove the entry.').toEqual([])
  })

  it('states a reason for every classification', () => {
    for (const [key, entry] of Object.entries(WRITE_SITES)) {
      expect(entry.why.length, `${key} needs a reason`).toBeGreaterThan(20)
    }
  })

  it('keeps every user entry path sealed', () => {
    const sealedPaths = Object.entries(WRITE_SITES)
      .filter(([, entry]) => entry.class === 'sealed-user-input')
      .map(([key]) => key)
    for (const required of [
      'web-backend/src/routes/chat.ts#abort',
      'web-backend/src/ws-chat.ts#saveUserMessage',
      'web-backend/src/api/modules/captures/service.ts#writeMessage',
      'web-backend/src/api/modules/interactions/service.ts#fileAnswerMessage',
      'telegram/src/bot.ts#processQueuedMessage',
      'telegram/src/bot.ts#handleIncomingAttachment',
      'core/src/turn-runner.ts#saveChatMessage',
      'core/src/strand-store.ts#insertCapture',
      'core/src/strand-store.ts#insertDecision',
    ]) {
      expect(sealedPaths).toContain(required)
    }
  })

  it('seals the text at the edge of every entry path', () => {
    const edges: Array<[string, string]> = [
      ['packages/web-backend/src/routes/chat.ts', "sealText(rawText, { tier: 'user'"],
      ['packages/web-backend/src/ws-chat.ts', "sealText(parsed.content, { tier: 'user'"],
      ['packages/web-backend/src/api/modules/captures/service.ts', "sealText(body.text, { tier: 'user'"],
      ['packages/web-backend/src/api/modules/interactions/service.ts', "sealText(raw.label, { tier: 'user'"],
      ['packages/telegram/src/bot.ts', "sealText(text, { tier: 'user'"],
      ['packages/core/src/turn-runner.ts', "sealText(input.text, { tier: 'user'"],
    ]
    for (const [file, needle] of edges) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8')
      expect(text, `${file} must seal its input`).toContain(needle)
    }
  })

  it('wraps the tool list with the boundary where the agents are built', () => {
    for (const file of ['packages/core/src/agent-runtime.ts', 'packages/core/src/task-runner.ts']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8')
      expect(text, `${file} must wrap its tools`).toContain('withSecretBoundary(')
      expect(text, `${file} must redact the outgoing context`).toContain('redactMessages(')
    }
  })
})
