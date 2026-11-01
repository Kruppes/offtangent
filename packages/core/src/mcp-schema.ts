/**
 * Strict, structurally bounded JSON Schema subset for remote MCP tool input
 * schemas (review finding P1-5).
 *
 * A remote `inputSchema` is untrusted: it is compiled by the argument
 * validator (regex `pattern` → catastrophic backtracking, `$ref` → external
 * or recursive resolution) and sent to the model verbatim. This module
 * REBUILDS the schema from a small allowlist of keywords instead of copying
 * it, so nothing the server invents survives:
 *
 * - kept: type, properties, required, items, enum, const, description,
 *   title, default (primitives), additionalProperties (boolean or schema),
 *   anyOf/oneOf (≤ 8 branches), numeric and length bounds;
 * - rejected (the whole tool is skipped): pattern, patternProperties,
 *   $ref/$dynamicRef/$recursiveRef/$defs/definitions, `properties` that are
 *   not an object of schemas, invalid `type`/`required`, depth > 8,
 *   > 512 schema nodes, > 128 properties per object;
 * - dropped silently: every other keyword (format, examples, $comment, …).
 *   Dropping only loosens client-side validation; the server still validates.
 */

export const SCHEMA_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 512,
  maxProperties: 128,
  maxEnum: 256,
  maxBranches: 8,
  maxStringChars: 1024,
  maxNameChars: 128,
})

const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const REJECT_KEYS = new Set([
  'pattern', 'patternProperties', '$ref', '$dynamicRef', '$recursiveRef', '$defs', 'definitions',
  '$anchor', '$dynamicAnchor', '$recursiveAnchor', 'dependentSchemas', 'unevaluatedProperties',
  'unevaluatedItems', 'if', 'then', 'else', 'not', 'allOf', 'propertyNames', 'contains',
])
const NUMERIC_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] as const
const COUNT_KEYS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'] as const

export class UnsafeSchemaError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe input schema: ${reason}`)
    this.name = 'UnsafeSchemaError'
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
    || (typeof v === 'string' && v.length <= SCHEMA_LIMITS.maxStringChars)
}

interface Ctx { nodes: number }

function rebuild(node: unknown, depth: number, ctx: Ctx): Record<string, unknown> | boolean {
  if (typeof node === 'boolean') return node
  if (!isRecord(node)) throw new UnsafeSchemaError('schema node is not an object')
  if (depth > SCHEMA_LIMITS.maxDepth) throw new UnsafeSchemaError('schema too deep')
  if (++ctx.nodes > SCHEMA_LIMITS.maxNodes) throw new UnsafeSchemaError('schema too large')
  for (const key of Object.keys(node)) {
    if (REJECT_KEYS.has(key)) throw new UnsafeSchemaError(`keyword "${key}" is not supported`)
  }
  const out: Record<string, unknown> = {}

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type]
    if (types.length === 0 || types.length > 7 || !types.every(t => typeof t === 'string' && JSON_TYPES.has(t))) {
      throw new UnsafeSchemaError('invalid "type"')
    }
    out.type = Array.isArray(node.type) ? [...types] : node.type
  }
  for (const key of ['description', 'title'] as const) {
    const v = node[key]
    if (typeof v === 'string') out[key] = v.slice(0, SCHEMA_LIMITS.maxStringChars)
  }
  if (node.default !== undefined && isPrimitive(node.default)) out.default = node.default
  if (node.const !== undefined) {
    if (!isPrimitive(node.const)) throw new UnsafeSchemaError('"const" must be a primitive')
    out.const = node.const
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > SCHEMA_LIMITS.maxEnum || !node.enum.every(isPrimitive)) {
      throw new UnsafeSchemaError('invalid "enum"')
    }
    out.enum = [...node.enum]
  }
  for (const key of NUMERIC_KEYS) {
    const v = node[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new UnsafeSchemaError(`invalid "${key}"`)
    out[key] = v
  }
  for (const key of COUNT_KEYS) {
    const v = node[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new UnsafeSchemaError(`invalid "${key}"`)
    out[key] = v
  }
  if (node.properties !== undefined) {
    if (!isRecord(node.properties)) throw new UnsafeSchemaError('"properties" must be an object of schemas')
    const entries = Object.entries(node.properties)
    if (entries.length > SCHEMA_LIMITS.maxProperties) throw new UnsafeSchemaError('too many properties')
    const props: Record<string, unknown> = {}
    for (const [name, sub] of entries) {
      if (name.length === 0 || name.length > SCHEMA_LIMITS.maxNameChars || name === '__proto__') {
        throw new UnsafeSchemaError('invalid property name')
      }
      if (!isRecord(sub) && typeof sub !== 'boolean') throw new UnsafeSchemaError(`property "${name}" is not a schema`)
      props[name] = rebuild(sub, depth + 1, ctx)
    }
    out.properties = props
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || !node.required.every(r => typeof r === 'string' && r.length <= SCHEMA_LIMITS.maxNameChars)
      || node.required.length > SCHEMA_LIMITS.maxProperties) {
      throw new UnsafeSchemaError('invalid "required"')
    }
    out.required = [...new Set(node.required as string[])]
  }
  if (node.additionalProperties !== undefined) {
    out.additionalProperties = rebuild(node.additionalProperties, depth + 1, ctx)
  }
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) throw new UnsafeSchemaError('tuple "items" is not supported')
    out.items = rebuild(node.items, depth + 1, ctx)
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const v = node[key]
    if (v === undefined) continue
    if (!Array.isArray(v) || v.length === 0 || v.length > SCHEMA_LIMITS.maxBranches) throw new UnsafeSchemaError(`invalid "${key}"`)
    out[key] = v.map(sub => rebuild(sub, depth + 1, ctx))
  }
  return out
}

/**
 * Rebuild a remote tool input schema into the safe subset. The root must be
 * an object schema. Throws {@link UnsafeSchemaError} when the schema uses a
 * rejected construct or exceeds the structural limits.
 */
export function buildSafeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema === undefined) return { type: 'object', properties: {} }
  if (!isRecord(schema)) throw new UnsafeSchemaError('root is not an object')
  if (schema.type !== 'object') throw new UnsafeSchemaError('root type must be "object"')
  const out = rebuild(schema, 0, { nodes: 0 }) as Record<string, unknown>
  if (out.properties === undefined) out.properties = {}
  return out
}
