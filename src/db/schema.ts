import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

const now = () => new Date().toISOString()

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  brandProfile: text('brand_profile'),
  brandProfileVersion: integer('brand_profile_version').notNull().default(1),
  settings: text('settings', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

/**
 * The project's asset library: uploaded images, video and text.
 *
 * Project-level rather than per-flow, which is what lets one product be
 * referenced from several campaigns — replace its files and every shot
 * downstream of it, in every flow, goes stale at once.
 *
 * Deliberately not the `assets` table: a row there is something a model
 * produced and a run paid for, and mixing authored input into it would corrupt
 * the cost ledger.
 */
export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  /** Stored paths. Empty for text sources. */
  files: text('files', { mode: 'json' }).notNull(),
  /** Content for text sources; null for image and video. */
  text: text('text'),
  notes: text('notes'),
  // Folded into the hash by planRun. Bumping it greys out everything downstream.
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

export const flows = sqliteTable('flows', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // The canvas is a view of this column, never a second source of truth.
  graphJson: text('graph_json', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().$defaultFn(now),
})

export const nodeRuns = sqliteTable(
  'node_runs',
  {
    id: text('id').primaryKey(),
    flowId: text('flow_id').notNull(),
    nodeId: text('node_id').notNull(),
    inputHash: text('input_hash').notNull(),
    status: text('status').notNull(),
    modelId: text('model_id').notNull(),
    // Persisted the instant fal accepts, so a crash cannot orphan a paid run.
    falRequestId: text('fal_request_id'),
    costCents: integer('cost_cents').notNull().default(0),
    outputRefs: text('output_refs', { mode: 'json' }),
    error: text('error'),
    attempt: integer('attempt').notNull().default(0),
    claimedAt: text('claimed_at'),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (table) => [
    index('node_runs_input_hash_idx').on(table.inputHash),
    index('node_runs_status_idx').on(table.status),
    index('node_runs_flow_node_idx').on(table.flowId, table.nodeId),
  ],
)

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  /**
   * The file on this machine. Stays authoritative even when the asset is also
   * hosted: ffmpeg and sharp read files, so the export path would otherwise
   * have to download every frame it was about to resize.
   */
  path: text('path').notNull(),
  /** Public URL when a hosted store is configured — what fal is given to fetch. */
  hostedUrl: text('hosted_url'),
  mime: text('mime').notNull(),
  width: integer('width'),
  height: integer('height'),
  // Cost one migration now; saves probing every file on disk when v2
  // sequencing arrives and needs durations it never recorded.
  durationMs: integer('duration_ms'),
  fps: integer('fps'),
  codec: text('codec'),
  sourceRunId: text('source_run_id'),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

export const exports = sqliteTable('exports', {
  id: text('id').primaryKey(),
  flowId: text('flow_id').notNull(),
  format: text('format').notNull(),
  assetId: text('asset_id').references(() => assets.id),
  specCheck: text('spec_check', { mode: 'json' }),
  path: text('path').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

/**
 * The chat thread. One row per model message, in order.
 *
 * Stored as ModelMessage JSON rather than rendered text: the next turn resends
 * the whole history to the model, and a tool call that has already run must be
 * in it or the model repeats the work.
 *
 * `seq` is the ordering column, not `createdAt`. The thread is replayed to the
 * model on every turn, and `onStepFinish` can write several rows inside one
 * millisecond — an ISO timestamp cannot tell those apart, and a history that
 * plays back out of order makes the model re-run tool calls it already ran.
 * An autoincrement integer is monotonic by construction, so it is the ordering
 * key and the primary key both; there is no separate `id` to keep in sync.
 */
export const messages = sqliteTable(
  'messages',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    flowId: text('flow_id').notNull(),
    /** 'user' | 'assistant' | 'tool' */
    role: text('role').notNull(),
    content: text('content', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (table) => [index('messages_flow_idx').on(table.flowId, table.seq)],
)

export type ChatMessage = typeof messages.$inferSelect

export type Source = typeof sources.$inferSelect
export type NodeRun = typeof nodeRuns.$inferSelect
export type Asset = typeof assets.$inferSelect
