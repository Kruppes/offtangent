/**
 * Endpoints behind the context panel (W4b). All read-only GETs:
 *
 *   GET /api/strands/:id/context         counters of the last request (StrandContextReport)
 *   GET /api/strands/:id/delete-preview  what belongs to the strand: facts, summaries, tool calls
 *   GET /api/projects                    names for the strand's projectId
 *
 * The delete preview is the only endpoint that lists the facts linked to one
 * strand; it is a pure read (the delete itself is a separate DELETE).
 */
export const STRAND_CONTEXT_PATH = (id: string) => `/api/strands/${encodeURIComponent(id)}/context`
export const STRAND_FACTS_PREVIEW_PATH = (id: string) => `/api/strands/${encodeURIComponent(id)}/delete-preview`
export const PROJECTS_PATH = '/api/projects'
