/**
 * strand-fork-tool.ts — `fork_strand`, the one way an agent branches the
 * strand it is talking in.
 *
 * The rules that are not obvious from the schema:
 *
 *  - the parent strand is NEVER a parameter. It is the strand the call runs in
 *    (the live interactive strand, or the strand a background task belongs
 *    to), and the owner comes from that strand too. A tool argument for either
 *    would be a cross-strand / cross-user write primitive,
 *  - every failure is a tool error (`isError: true`), never a throw: a model
 *    that asked for something impossible must get a readable reason back,
 *  - `run_agent: true` is a request, not a guarantee. It is downgraded to a
 *    dormant fork when the current run was itself started by a fork (the
 *    cascade brake in `isForkStartedRun`) or when no turn starter is wired
 *    (background tasks). The result says so in plain words instead of
 *    pretending a run started,
 *  - at most {@link MAX_FORKS_PER_TURN} forks per run, counted per turn / per
 *    task run by {@link ForkBudget}.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import {
  ForkBudget,
  ForkStrandError,
  forkStrand,
  isForkStartedRun,
  MAX_FORK_DEPTH,
  MAX_FORKS_PER_TURN,
  type ForkSessionManagerLike,
  type StrandFork,
} from './strand-fork.js'

export interface ForkStrandToolOptions {
  db: Database
  /** Numeric user id of the running strand / task owner (`users.id`). */
  getCurrentToolUserId: () => number | undefined
  /** The strand the call runs in: the live strand, or the task's strand. */
  getCurrentStrandId: () => string | null
  /** Session manager of the runtime; `null` when the core is not up. */
  getSessions: () => ForkSessionManagerLike | null
  /**
   * Scope the per-run fork budget is counted in: the live turn id for an
   * interactive run, the task id for a background run. A scope that cannot be
   * resolved falls back to the strand id, which is still far better than no
   * limit at all.
   */
  getForkScope?: () => string | null
  /** Shared budget, injectable so a test can use a tighter limit. */
  budget?: ForkBudget
  /**
   * Start the first turn in the new strand (`run_agent: true`). Absent means
   * no run is possible; the tool then creates the fork dormant and says so.
   */
  startTurn?: (input: { userId: number; strandId: string; agentId: string; text: string }) => void
  /**
   * Tell the clients a strand appeared (WebSocket frame). Optional so the
   * core side is testable alone.
   */
  announce?: (fork: StrandFork & { userId: number }) => void
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
    details: { error: true, message },
  }
}

export const FORK_STRAND_TOOL_NAME = 'fork_strand'

export function createForkStrandTool(options: ForkStrandToolOptions): AgentTool {
  const budget = options.budget ?? new ForkBudget()

  return {
    name: FORK_STRAND_TOOL_NAME,
    label: 'Fork Strand',
    description:
      'Branch the current strand into a NEW parallel strand (a fork in the path, not a cut). '
      + 'The new strand starts with `seed` only — the condensed handoff you write yourself — so the side topic '
      + 'stops paying for the history of this strand, and this strand stops paying for the side topic. '
      + 'The fork keeps a link in both directions: the new strand records where it came from, and this strand '
      + 'gets a visible "forked into" row with the new strand id. '
      + 'Fork when the conversation has genuinely diverged: a second topic with its own questions and its own '
      + 'lifetime (a privacy discussion inside an integration strand), a side path you will come back to, '
      + 'or when the user asks for it ("make that its own strand"). '
      + 'Do NOT fork a short aside you can answer in one sentence, a clarification of the current topic, '
      + 'or something you have not actually discussed yet — a fork with an empty seed is just an empty strand. '
      + 'Write `seed` as a handoff for a reader who cannot see this strand: what it is about, what was decided, '
      + 'what is open, what happens next. Set `run_agent: true` only when the new strand should start working '
      + 'immediately; default is a dormant strand the user opens when they want to. '
      + `At most ${MAX_FORKS_PER_TURN} forks per turn, at most ${MAX_FORK_DEPTH} levels deep.`,
    parameters: Type.Object({
      title: Type.String({
        description: 'Title of the new strand, short and specific (at most 80 chars), e.g. "Privacy: Gmail scopes".',
      }),
      seed: Type.String({
        description:
          'The text the new strand starts with: your own condensed handoff (goal, state, decisions, open points, '
          + 'next step). Not a copy of the transcript — this is the whole token win. At most 8000 characters.',
      }),
      run_agent: Type.Optional(Type.Boolean({
        description:
          'Start a turn in the new strand right away with the seed as its first message (default false). '
          + 'Leave it false when the fork is a place to continue later; the user opens it when they want to.',
      })),
      include_parent_summary: Type.Optional(Type.Boolean({
        description:
          'Append the stored summary of this strand to the seed (default false). Only useful when the new strand '
          + 'really needs the background of the whole strand, not just your handoff.',
      })),
      inherit_project: Type.Optional(Type.Boolean({
        description:
          'Keep the project of this strand on the fork (default true). Set false when the side path belongs '
          + 'nowhere or somewhere else; the user can move it later.',
      })),
    }),
    execute: async (_toolCallId, params) => {
      const userId = options.getCurrentToolUserId()
      if (userId === undefined || userId === null) {
        return errorResult('fork_strand needs a user context (running strand or task) and found none')
      }
      const parentStrandId = options.getCurrentStrandId()
      if (!parentStrandId) {
        return errorResult(
          'fork_strand needs the strand it runs in and found none — it cannot fork from outside a strand',
        )
      }
      const sessions = options.getSessions()
      if (!sessions) return errorResult('fork_strand needs the session manager and it is not available')

      const args = (params ?? {}) as {
        title?: unknown
        seed?: unknown
        run_agent?: unknown
        include_parent_summary?: unknown
        inherit_project?: unknown
      }

      const scope = options.getForkScope?.() ?? parentStrandId
      if (!budget.take(scope)) {
        return errorResult(
          `fork_strand already created ${MAX_FORKS_PER_TURN} strands in this run — the limit exists so a loop `
          + 'cannot fill the list. Collect the rest in one fork or wait for the next turn.',
        )
      }

      const notes: string[] = []
      let wantsRun = args.run_agent === true
      if (wantsRun && !options.startTurn) {
        wantsRun = false
        notes.push('no turn could be started from this context, the strand was created dormant')
      }
      if (wantsRun && isForkStartedRun(options.db, parentStrandId)) {
        wantsRun = false
        notes.push(
          'this run was itself started by a fork, so the new strand was created dormant (no cascade of automatic runs)',
        )
      }

      let fork: StrandFork
      try {
        fork = forkStrand({
          db: options.db,
          sessions,
          userId,
          parentStrandId,
          title: args.title as string,
          seed: args.seed as string,
          includeParentSummary: args.include_parent_summary === true,
          inheritProject: args.inherit_project !== false,
          autoRun: wantsRun,
        })
      } catch (err) {
        // Nothing was created, so the run keeps its budget (see ForkBudget.refund).
        budget.refund(scope)
        if (err instanceof ForkStrandError) return errorResult(`${err.message} (${err.code})`)
        return errorResult(`failed to fork the strand: ${(err as Error).message}`)
      }

      try {
        options.announce?.({ ...fork, userId })
      } catch (err) {
        notes.push(`the strand list was not notified live (${(err as Error).message})`)
      }

      if (wantsRun && options.startTurn) {
        try {
          options.startTurn({ userId, strandId: fork.strandId, agentId: fork.agentId, text: fork.seedText })
        } catch (err) {
          notes.push(`the first turn could not be started (${(err as Error).message}), the strand exists`)
        }
      }

      const state = fork.autoRun ? 'a turn is starting there' : 'the seed is stored, no turn was started'
      const noteText = notes.length > 0 ? ` Note: ${notes.join('; ')}.` : ''
      return {
        content: [{
          type: 'text' as const,
          text: `Forked "${fork.title}" off this strand (new strand ${fork.strandId}, depth ${fork.depth}); `
            + `${state}. This strand now carries a "forked into" row pointing at it.${noteText}`,
        }],
        details: {
          strandId: fork.strandId,
          title: fork.title,
          parentStrandId: fork.parentStrandId,
          forkedAt: fork.forkedAt,
          forkedFromMessageId: fork.forkedFromMessageId,
          depth: fork.depth,
          projectId: fork.projectId,
          seedMessageId: fork.seedMessageId,
          noticeMessageId: fork.noticeMessageId,
          runStarted: fork.autoRun,
          forksLeftInThisRun: budget.remaining(scope),
        },
      }
    },
  }
}
