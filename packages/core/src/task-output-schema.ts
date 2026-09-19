/**
 * task-output-schema.ts: `output_schema` for delegations (SPEC 11.6).
 *
 * A JSON schema for the SUMMARY part of the task result. The runner
 * validates the final message; on failure it sends exactly one correction
 * turn with the validation errors verbatim, then accepts or fails. Hermes'
 * best single idea per the orchestrator comparison; Harness-Bench
 * (arXiv:2605.27922) names the failure it prevents, plausible reasoning
 * that decouples from a checkable output contract.
 */

import { Check, Errors } from 'typebox/value'

export type OutputSchemaCheck =
  | { ok: true; value: unknown }
  | { ok: false; errors: string[] }

const MAX_SCHEMA_CHARS = 20000

/** Parse and sanity check a schema string passed by the caller. */
export function parseOutputSchema(raw: unknown): { ok: true; schema: Record<string, unknown>; serialized: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: false, error: 'no schema' }
  let schema: unknown = raw
  if (typeof raw === 'string') {
    if (raw.length > MAX_SCHEMA_CHARS) return { ok: false, error: `output_schema is longer than ${MAX_SCHEMA_CHARS} characters` }
    try {
      schema = JSON.parse(raw)
    } catch (err) {
      return { ok: false, error: `output_schema is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, error: 'output_schema must be a JSON object' }
  }
  const s = schema as Record<string, unknown>
  if (s.type !== undefined && s.type !== 'object') {
    return { ok: false, error: 'output_schema must describe an object (type: "object")' }
  }
  const serialized = JSON.stringify(s)
  if (serialized.length > MAX_SCHEMA_CHARS) return { ok: false, error: `output_schema is longer than ${MAX_SCHEMA_CHARS} characters` }
  return { ok: true, schema: s, serialized }
}

function stripFence(text: string): string {
  const t = text.trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return m ? m[1].trim() : t
}

/**
 * Find the JSON object in a SUMMARY. Accepts a bare object, a fenced
 * block, or prose followed by one fenced or bare object.
 */
export function extractJsonObject(summary: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates: string[] = []
  const stripped = stripFence(summary)
  candidates.push(stripped)
  const fence = summary.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence) candidates.push(fence[1].trim())
  const first = summary.indexOf('{')
  const last = summary.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(summary.slice(first, last + 1))
  for (const c of candidates) {
    if (!c.startsWith('{')) continue
    try {
      return { ok: true, value: JSON.parse(c) }
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: 'SUMMARY contains no parseable JSON object' }
}

/** Validate a SUMMARY against the schema. Errors are human readable, one per line. */
export function checkOutputAgainstSchema(schema: Record<string, unknown>, summary: string): OutputSchemaCheck {
  const extracted = extractJsonObject(summary)
  if (!extracted.ok) return { ok: false, errors: [extracted.error] }
  try {
    if (Check(schema as never, extracted.value)) return { ok: true, value: extracted.value }
    const errors: string[] = []
    for (const e of Errors(schema as never, extracted.value)) {
      const err = e as { instancePath?: string; path?: string; message?: string }
      const where = err.instancePath || err.path || '/'
      errors.push(`${where}: ${err.message ?? 'invalid'}`)
      if (errors.length >= 20) break
    }
    return { ok: false, errors: errors.length ? errors : ['value does not match output_schema'] }
  } catch (err) {
    return { ok: false, errors: [`output_schema could not be evaluated: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

/** The one correction turn, errors verbatim. */
export function buildSchemaCorrectionPrompt(serializedSchema: string, errors: string[]): string {
  return [
    'Your final SUMMARY does not satisfy the required output_schema. This is the only correction round.',
    '',
    'Validation errors:',
    ...errors.map(e => `- ${e}`),
    '',
    'Required schema (JSON Schema):',
    serializedSchema,
    '',
    'Report your final result again in the STATUS/SUMMARY format. The SUMMARY must be exactly one JSON object that satisfies the schema, optionally inside a ```json fence, with no other prose.',
  ].join('\n')
}

/** Instruction block appended to a task system prompt when a schema is set. */
export function buildOutputSchemaInstruction(serializedSchema: string): string {
  return `<output_schema>
Your SUMMARY must be exactly one JSON object that satisfies this JSON Schema. Put it inside a \`\`\`json fence. No prose outside the fence. The parent validates it and allows one correction round only.

${serializedSchema}
</output_schema>`
}
