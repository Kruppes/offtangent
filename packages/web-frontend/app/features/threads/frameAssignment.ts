/** Never infer ownership from the currently displayed strand. Session wins;
 * only an explicitly identified persona may use its last known strand. */
export function resolveFrameSession(
  frame: { sessionId?: string; agentId?: string },
  lastActiveByPersona: Readonly<Record<string, string>>,
): string | null {
  if (frame.sessionId?.trim()) return frame.sessionId
  if (!frame.agentId?.trim()) return null
  const value = Object.hasOwn(lastActiveByPersona, frame.agentId) ? lastActiveByPersona[frame.agentId] : undefined
  return typeof value === 'string' && value.trim() ? value : null
}
