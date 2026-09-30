export type TurnPhase = 'waiting' | 'thinking' | 'working' | 'writing' | 'done' | 'aborted' | 'error' | 'disconnected'
export interface TurnProgress { phase: TurnPhase; startedAt: number; endedAt?: number }
export function isTurnActive(turn?: TurnProgress): boolean { return !!turn && turn.endedAt === undefined }
/** Times are client observation times: the wire carries no turn-start timestamp. */
export function advanceTurn(previous: TurnProgress | undefined, type: string, now: number): TurnProgress | undefined {
  if (previous?.phase === 'aborted' && type !== 'send' && type !== 'turn_replay_start') return previous
  const phase: TurnPhase | undefined = ({ send: 'waiting', queued: 'waiting', thinking: 'thinking', tool_call_start: 'working', tool_call_end: 'working', text: 'writing', turn_replay_start: 'waiting', done: 'done', error: 'error', stop: 'aborted', disconnect: 'disconnected' } as Record<string, TurnPhase>)[type]
  if (!phase) return previous
  const ended = ['done', 'error', 'aborted', 'disconnected'].includes(phase)
  if (ended && !previous) return undefined
  return { phase, startedAt: previous && isTurnActive(previous) ? previous.startedAt : now, ...(ended ? { endedAt: now } : {}) }
}
export function elapsedTurnSeconds(turn: TurnProgress, now: number): number {
  return Math.max(0, Math.floor(((turn.endedAt ?? now) - turn.startedAt) / 1000))
}
