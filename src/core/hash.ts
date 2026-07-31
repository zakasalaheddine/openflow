import { createHash } from 'node:crypto'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue }

export type HashInput = {
  nodeType: string
  config: Record<string, JsonValue>
  upstreamHashes: string[]
  modelId: string
  seed?: number
}

/**
 * JSON with object keys sorted at every depth and `undefined` values dropped.
 *
 * Key order must not matter: the same node serialised by the canvas and by the
 * MCP server would otherwise produce two hashes, and every cache hit would miss.
 * Dropping `undefined` means adding an optional config field does not invalidate
 * every run already in the database.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)

  return `{${entries.join(',')}}`
}

/**
 * One value doing three jobs: cache key, cost ledger row, and pre-baked demo
 * lookup. Do not split them.
 *
 * Hashing a canonical *structure* rather than concatenated strings is what
 * keeps fields from bleeding into each other — a prompt ending in the next
 * field's value can never forge another node's hash.
 */
export function inputHash(input: HashInput): string {
  const canonical = canonicalJson({
    nodeType: input.nodeType,
    config: input.config,
    upstreamHashes: input.upstreamHashes,
    modelId: input.modelId,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
  })

  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
